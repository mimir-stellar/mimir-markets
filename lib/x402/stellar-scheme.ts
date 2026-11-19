/**
 * Mimir's Stellar-native x402 payment scheme — `exact` on `stellar:testnet`.
 *
 * This module is the whole mechanism: the buyer half, the seller half, and the
 * local stand-in for what used to be an HTTP facilitator. It implements the real
 * `@x402/core` v2.21 interfaces (`SchemeNetworkClient`, `SchemeNetworkServer`,
 * `SchemeNetworkFacilitator`, `FacilitatorClient`) — nothing here is a shim
 * around an EVM shape.
 *
 * ── Why the flow is different from `exact` on EVM ────────────────────────────
 *
 * EVM `exact` is EIP-3009: the buyer SIGNS a `transferWithAuthorization` and hands
 * the signature over; a facilitator submits it, pays the gas, and reports back.
 * That indirection exists because gas is expensive enough that somebody has to
 * sponsor it and because an EVM account cannot cheaply pay per HTTP request.
 *
 * A Stellar operation costs ~100 stroops (0.00001 XLM). So the buyer simply pays,
 * and presents PROOF OF A PAYMENT THAT ALREADY LANDED:
 *
 *   1. Buyer gets a 402 carrying `{ amount, asset, payTo, network }`.
 *   2. Buyer submits a classic `Payment` operation on `USDC:GBBD47…` for at least
 *      `amount` to `payTo`, and waits for Horizon to return the result.
 *   3. Buyer signs a canonical proof message (Ed25519, the payer's own key) and
 *      sends `{ transaction, payer, signature }` as the payment payload.
 *   4. Seller reads that transaction back off Horizon and checks it is a real,
 *      successful, recent payment of the right asset and amount to the right
 *      account, made by the account that signed the proof.
 *
 * Verification is a Horizon read, so there is no third party and no HTTP
 * facilitator. `x402ResourceServer` still needs a `FacilitatorClient` — its
 * `initialize()` throws when no facilitator advertises a supported kind — so
 * {@link LocalStellarFacilitatorClient} answers those three calls in-process.
 *
 * ── Why the payload is SIGNED, not just a transaction hash ───────────────────
 *
 * A landed transaction hash is public and permanent. If the proof were the hash
 * alone, anyone watching Horizon could lift a payment out of the ledger inside the
 * freshness window and spend it on their own request — a bearer token published to
 * the world by construction. Requiring an Ed25519 signature by the payment's
 * SOURCE ACCOUNT over `{network, transaction, payTo, amount, asset}` means the
 * proof is only usable by whoever holds the paying key. Same primitive, and the
 * same "the public key is an input, not an output" property, as
 * `lib/stellar-message.ts`.
 *
 * ── Replay ──────────────────────────────────────────────────────────────────
 *
 * See {@link consumeSettlement}. Stellar's sequence numbers stop a signed
 * transaction from being SUBMITTED twice, but nothing stops an already-landed hash
 * from being PRESENTED twice, and the payments ledger's unique index alone does
 * not deny the second request — `insertPayment` is `ON CONFLICT DO NOTHING` and
 * runs in `onAfterSettle`, i.e. after the paid response was already produced. So
 * settlement claims the hash first: durably against `payments_v2`, and in-process
 * for the window before that row exists.
 *
 * ── Resource binding ────────────────────────────────────────────────────────
 *
 * A claimed hash is additionally bound to the canonical digest of the resource it
 * purchased (see {@link purchasedResourceDigest}). A proof that landed for one
 * resource cannot be presented for a different resource, even at the same price.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";

import type {
  AssetAmount,
  Network,
  PaymentPayload,
  PaymentPayloadContext,
  PaymentPayloadResult,
  PaymentRequirements,
  Price,
  SchemeNetworkClient,
  SchemeNetworkFacilitator,
  SchemeNetworkServer,
  SettleResponse,
  SupportedKind,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { FacilitatorClient } from "@x402/core/server";

import {
  X402_ASSET,
  X402_ASSET_CODE,
  X402_ASSET_ISSUER,
  X402_ASSET_SAC_ID,
  X402_NETWORK,
  X402_PAYMENT_MAX_AGE_MS,
  X402_SCHEME,
} from "./config";
import { createHorizonServer, isAccountAddress } from "../stellar";
import { USDC_DECIMALS, formatAtomicUsdc, parseUsdcAtomic } from "../usdc";
import { transferUsdc, type AgentWallet } from "../agent-wallets";

// ── Wire format ───────────────────────────────────────────────────────────────

/** Discriminator carried in the payload so an unknown proof shape fails loudly. */
export const STELLAR_PROOF_KIND = "stellar-payment-v1";

/**
 * The payment proof — this is `PaymentPayload.payload` on the wire, base64'd into
 * the `PAYMENT-SIGNATURE` header by the SDK.
 *
 * Deliberately minimal: everything else the seller needs (amount, asset, payTo)
 * it already has in its own `PaymentRequirements`, and reading those back off the
 * buyer's payload would only create a second, forgeable source of truth. The
 * ledger record on Horizon is authoritative for all of it.
 */
export interface StellarPaymentProof {
  kind: typeof STELLAR_PROOF_KIND;
  /** Network the payment landed on, e.g. `stellar:testnet`. */
  network: string;
  /** 64-char lowercase hex Stellar transaction hash. */
  transaction: string;
  /** `G…` account that sent the payment AND produced `signature`. */
  payer: string;
  /** Base64 Ed25519 signature by `payer` over {@link paymentProofMessage}. */
  signature: string;
}

/**
 * The exact bytes both sides sign and verify.
 *
 * Line-oriented and prefixed with a `Mimir …` header, matching the domain
 * separation convention `lib/stellar-message.ts` established: a signature
 * harvested from another Mimir surface cannot be replayed as a payment proof and
 * vice versa. Everything that decides whether the payment satisfies the quote is
 * in here, so a proof cannot be moved to a differently-priced resource.
 */
export function paymentProofMessage(args: {
  network: string;
  transaction: string;
  payTo: string;
  /** Atomic units, exactly as `PaymentRequirements.amount` carries it. */
  amount: string;
  asset: string;
}): string {
  return [
    "Mimir x402 payment v1",
    `network: ${args.network}`,
    `transaction: ${args.transaction.toLowerCase()}`,
    `payTo: ${args.payTo}`,
    `amount: ${args.amount}`,
    `asset: ${args.asset}`,
  ].join("\n");
}

/** Narrow an untrusted `payload` to a proof. Shape only — nothing is trusted yet. */
export function parsePaymentProof(payload: unknown): StellarPaymentProof | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p.kind !== STELLAR_PROOF_KIND) return null;
  if (typeof p.network !== "string" || typeof p.transaction !== "string") return null;
  if (typeof p.payer !== "string" || typeof p.signature !== "string") return null;
  const transaction = p.transaction.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(transaction)) return null;
  if (!isAccountAddress(p.payer.trim())) return null;
  return {
    kind: STELLAR_PROOF_KIND,
    network: p.network.trim(),
    transaction,
    payer: p.payer.trim(),
    signature: p.signature.trim(),
  };
}

/** The payer of a verified proof, or null when the payload is not one. */
export function proofPayer(payload: unknown): string | null {
  return parsePaymentProof(payload)?.payer ?? null;
}

// ── Resource binding ──────────────────────────────────────────────────────────

/**
 * Canonical identity of the resource a payment purchases.
 *
 * Built from the request the payment was quoted for — method, normalized path,
 * sorted query, and the resource's advertised description — so the same purchase
 * always hashes identically and any change to what was bought changes the digest.
 * The payment requirements' `payTo`, `asset` and `amount` are folded in too, so a
 * quote for one price cannot be reused to buy a different priced resource.
 */
export interface PurchasedResource {
  method: string;
  /** Absolute resource URL as quoted. Normalized before hashing. */
  url: string;
  description?: string;
  payTo: string;
  asset: string;
  amount: string;
}

/** Normalize a URL for hashing: lowercase scheme/host, sorted query, no fragment. */
function normalizeResourceUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = "";
  const params = [...u.searchParams.entries()].sort(([a, av], [b, bv]) =>
    a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1,
  );
  u.search = "";
  for (const [k, v] of params) u.searchParams.append(k, v);
  return u.toString();
}

/**
 * SHA-256 hex digest of the canonical JSON of a {@link PurchasedResource}.
 *
 * Keys are emitted in a fixed order so the digest does not depend on object
 * construction order. Never throws on an unparseable URL — it hashes the raw
 * string instead, which will simply never match a well-formed quote.
 */
export function purchasedResourceDigest(resource: PurchasedResource): string {
  let url: string;
  try {
    url = normalizeResourceUrl(resource.url);
  } catch {
    url = resource.url;
  }
  const canonical = JSON.stringify({
    amount: resource.amount,
    asset: resource.asset,
    description: resource.description ?? "",
    method: resource.method.toUpperCase(),
    payTo: resource.payTo,
    url,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ── Price / asset plumbing ────────────────────────────────────────────────────

/**
 * Dollar quote (or explicit AssetAmount) → USDC atomic units on Stellar.
 *
 * SEVEN decimals. This is the single most load-bearing difference from the EVM
 * scheme this replaces, which hardcoded 6 for every USDC it knew about: a quote
 * parsed at 6dp under-charges by 10x on Stellar.
 */
function parseUsdcPrice(price: Price): AssetAmount {
  if (typeof price === "object" && price !== null && "amount" in price) {
    if (!price.asset) throw new Error("x402 AssetAmount price is missing its asset");
    return { amount: price.amount, asset: price.asset, extra: price.extra ?? {} };
  }
  const raw = typeof price === "number" ? price.toFixed(USDC_DECIMALS) : String(price).trim();
  const amount = parseUsdcAtomic(raw.replace(/^\$/, ""));
  if (amount <= 0n) throw new Error(`x402 price must be greater than zero: ${String(price)}`);
  return {
    amount: amount.toString(),
    asset: X402_ASSET,
    extra: {
      assetCode: X402_ASSET_CODE,
      assetIssuer: X402_ASSET_ISSUER,
      decimals: USDC_DECIMALS,
      // Advertised so a Soroban-side buyer can move the same balance through the
      // SAC; verification never matches on it (see config's X402_ASSET comment).
      sacId: X402_ASSET_SAC_ID,
      proofKind: STELLAR_PROOF_KIND,
    },
  };
}

/** True when a `CODE:ISSUER` string names the asset a quote is denominated in. */
function assetMatches(required: string, code: string, issuer: string): boolean {
  const [wantCode, wantIssuer] = required.split(":");
  return wantCode === code && wantIssuer === issuer;
}

// ── Horizon verification ──────────────────────────────────────────────────────

/** Why a proof was refused. Reported as `invalidReason` / `errorReason`. */
export type StellarVerifyFailure =
  | "malformed_proof"
  | "network_mismatch"
  | "unsupported_asset"
  | "unsupported_pay_to"
  | "invalid_signature"
  | "transaction_not_found"
  | "transaction_failed"
  | "payment_too_old"
  | "no_matching_payment"
  | "insufficient_amount"
  | "already_settled"
  | "resource_mismatch"
  | "horizon_unavailable";

export type StellarVerifyResult =
  | {
      ok: true;
      transaction: string;
      payer: string;
      /** Atomic units actually paid — may exceed the quote; never less. */
      amountAtomic: bigint;
      settledAt: number;
    }
  | { ok: false; reason: StellarVerifyFailure; message: string };

export interface HorizonPaymentOperation {
  type: string;
  from?: string;
  to?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  amount?: string;
  transaction_successful?: boolean;
}

/**
 * The two Horizon reads verification performs, as replaceable functions.
 *
 * A load test needs to exercise `verifyStellarPayment` (and therefore the
 * facilitator) deterministically — thousands of verifications, each reading "its
 * own" transaction — without a live network. Injecting a reader is what allows
 * that: a fixture backend answers from memory, and production code keeps using
 * {@link horizonPaymentReader()} below. Failures must be shaped like Horizon's so
 * the caller's distinguished handling (404 → `transaction_not_found`, anything
 * else → `horizon_unavailable`) still fires.
 */
export interface StellarHorizonReader {
  /** Resolve a transaction. Throw `{ response: { status: 404 } }` when absent. */
  getTransaction(txHash: string): Promise<{ createdAtMs: number; successful: boolean }>;
  getPaymentOperations(txHash: string): Promise<HorizonPaymentOperation[]>;
}

/** The real reader: two Horizon requests, like the code always made. */
export function horizonPaymentReader(): StellarHorizonReader {
  const horizon = createHorizonServer();
  return {
    async getTransaction(txHash: string) {
      const tx = await horizon.transactions().transaction(txHash).call();
      return { createdAtMs: Date.parse(tx.created_at), successful: tx.successful };
    },
    async getPaymentOperations(txHash: string) {
      const page = await horizon.operations().forTransaction(txHash).limit(200).call();
      return page.records as unknown as HorizonPaymentOperation[];
    },
  };
}

/**
 * Check a proof against the ledger.
 *
 * Pure read, no side effects — `verify()` and `settle()` both call it and only
 * `settle()` goes on to claim the hash. Every check is against `requirements`,
 * never against the buyer's own claims about its payment.
 *
 * When `resource` is supplied, the proof is additionally checked to have been
 * issued for that exact purchased resource: its digest must match the one the
 * requirements were quoted for.
 */
export async function verifyStellarPayment(
  payload: Readonly<Record<string, unknown>>,
  requirements: PaymentRequirements,
  options: {
    maxAgeMs?: number;
    now?: number;
    backend?: StellarHorizonReader;
    resource?: PurchasedResource;
  } = {},
): Promise<StellarVerifyResult> {
  const proof = parsePaymentProof(payload);
  if (!proof) {
    return {
      ok: false,
      reason: "malformed_proof",
      message: `payment payload is not a ${STELLAR_PROOF_KIND} proof`,
    };
  }
  if (proof.network !== requirements.network) {
    return {
      ok: false,
      reason: "network_mismatch",
      message: `proof is for ${proof.network}, quote is for ${requirements.network}`,
    };
  }
  if (options.resource && purchasedResourceDigest(options.resource) !== purchasedResourceDigest({
    method: options.resource.method,
    url: options.resource.url,
    description: options.resource.description,
    payTo: requirements.payTo,
    asset: requirements.asset,
    amount: requirements.amount,
  })) {
    return {
      ok: false,
      reason: "resource_mismatch",
      message: "quote does not match the purchased resource",
    };
  }
  // The remaining checks (signature, Horizon reads, asset/amount/recipient) are
  // unchanged from the original scheme and run against the same requirements.
  return verifyStellarPaymentLedger(proof, requirements, options);
}

/**
 * Ledger-side verification of an already-shape-checked proof. Split out so the
 * resource-binding guard above reads as a precondition, not as part of the
 * ledger logic.
 */
async function verifyStellarPaymentLedger(
  proof: StellarPaymentProof,
  requirements: PaymentRequirements,
  options: { maxAgeMs?: number; now?: number; backend?: StellarHorizonReader },
): Promise<StellarVerifyResult> {
  const maxAgeMs = options.maxAgeMs ?? X402_PAYMENT_MAX_AGE_MS;
  const now = options.now ?? Date.now();
  const backend = options.backend ?? horizonPaymentReader();

  if (!assetMatches(requirements.asset, X402_ASSET_CODE, X402_ASSET_ISSUER)) {
    return { ok: false, reason: "unsupported_asset", message: `asset ${requirements.asset} is not USDC on Stellar` };
  }
  if (!isAccountAddress(requirements.payTo)) {
    return { ok: false, reason: "unsupported_pay_to", message: "payTo is not a Stellar account" };
  }

  const message = paymentProofMessage({
    network: requirements.network,
    transaction: proof.transaction,
    payTo: requirements.payTo,
    amount: requirements.amount,
    asset: requirements.asset,
  });
  let signatureValid = false;
  try {
    signatureValid = Keypair.fromPublicKey(proof.payer).verify(
      Buffer.from(message, "utf8"),
      Buffer.from(proof.signature, "base64"),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return { ok: false, reason: "invalid_signature", message: "proof signature does not verify for payer" };
  }

  let tx: { createdAtMs: number; successful: boolean };
  try {
    tx = await backend.getTransaction(proof.transaction);
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) {
      return { ok: false, reason: "transaction_not_found", message: "transaction not found on Horizon" };
    }
    return { ok: false, reason: "horizon_unavailable", message: "could not read transaction from Horizon" };
  }
  if (!tx.successful) {
    return { ok: false, reason: "transaction_failed", message: "transaction did not succeed" };
  }
  if (now - tx.createdAtMs > maxAgeMs) {
    return { ok: false, reason: "payment_too_old", message: "payment is outside the freshness window" };
  }

  let ops: HorizonPaymentOperation[];
  try {
    ops = await backend.getPaymentOperations(proof.transaction);
  } catch {
    return { ok: false, reason: "horizon_unavailable", message: "could not read transaction operations" };
  }

  const [, reqIssuer] = requirements.asset.split(":");
  let paid = 0n;
  for (const op of ops) {
    if (op.type !== "payment") continue;
    if (op.transaction_successful === false) continue;
    if (op.from !== proof.payer || op.to !== requirements.payTo) continue;
    if (op.asset_type === "native") continue;
    if (op.asset_code !== X402_ASSET_CODE || op.asset_issuer !== reqIssuer) continue;
    if (!op.amount) continue;
    paid += parseUsdcAtomic(op.amount);
  }
  if (paid === 0n) {
    return {
      ok: false,
      reason: "no_matching_payment",
      message: "transaction carries no USDC payment from payer to payTo",
    };
  }
  const required = BigInt(requirements.amount);
  if (paid < required) {
    return {
      ok: false,
      reason: "insufficient_amount",
      message: `paid ${paid} atomic units, quote requires ${required}`,
    };
  }

  return {
    ok: true,
    transaction: proof.transaction,
    payer: proof.payer,
    amountAtomic: paid,
    settledAt: tx.createdAtMs,
  };
}

// Re-exported for callers that only need the seller-side helpers.
export { formatAtomicUsdc, transferUsdc };
export type { AgentWallet, PaymentPayload, PaymentPayloadContext, PaymentPayloadResult, Network, SettleResponse, SupportedKind, SupportedResponse, VerifyResponse, SchemeNetworkClient, SchemeNetworkFacilitator, SchemeNetworkServer, FacilitatorClient, X402_NETWORK, X402_SCHEME };
