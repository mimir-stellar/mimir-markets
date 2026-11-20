/**
 * Durable fulfillment receipts for paid x402 responses.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────
 *
 * `@x402/next` runs verify → handler → settle → respond. Settlement claims the
 * transaction hash (see `consumeSettlement` in ./stellar-scheme.ts), so once it
 * returns, the buyer's payment is spent. If the response is then lost on the way
 * back (a dropped connection, a client timeout, a serverless freeze), the buyer
 * has paid, holds nothing, and every retry with the same proof is refused as
 * `already_settled`. The only way forward was to pay again.
 *
 * ── What a receipt is ────────────────────────────────────────────────────────
 *
 * When a payment settles, a receipt binds the spent transaction hash to the
 * CANONICAL RESOURCE DIGEST of the request it paid for (method, path and sorted
 * query, see {@link canonicalResourceDigest}). The binding is first-writer-wins
 * and never rewritten, so a payment is consumed by exactly one resource.
 *
 * A later request presenting the same proof is then a redelivery, not a replay,
 * only when all of these hold:
 *
 *  - the proof still verifies against the ledger and is signed by the payer
 *    (so a hash lifted off Horizon is still useless to anyone else);
 *  - the request's digest equals the receipt's (the payment cannot be moved to
 *    another resource, or to different query parameters);
 *  - the payer equals the receipt's payer;
 *  - it arrives within `X402_REDELIVERY_WINDOW_MS` of settlement and within
 *    `X402_REDELIVERY_MAX` redeliveries.
 *
 * A redelivery re-runs the handler for the same resource and settles WITHOUT a
 * new charge and without a second revenue row: the original transaction is the
 * only payment, and `payments_v2` is keyed by it.
 *
 * ── Storage ──────────────────────────────────────────────────────────────────
 *
 * Durable in `x402_fulfillment_receipts` when `DATABASE_URL` is set, mirrored in
 * a bounded in-process map either way, the same degradation the payments ledger
 * and the replay set already accept. Soroban and Horizon stay authoritative for
 * the payment itself; the receipt only records which resource it bought.
 */

import { createHash } from "node:crypto";

import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import type { VerifyContext } from "@x402/core/server";

import {
  X402_PAYMENT_MAX_AGE_MS,
  X402_REDELIVERY_MAX,
  X402_REDELIVERY_WINDOW_MS,
} from "./config";
import {
  parsePaymentProof,
  verifyStellarPayment,
  type StellarHorizonReader,
} from "./stellar-scheme";

/** The payload as the server hooks hand it over (deeply readonly). */
type HookPaymentPayload = PaymentPayload | VerifyContext["paymentPayload"];

// ── Canonical resource digest ────────────────────────────────────────────────

export const RESOURCE_DIGEST_VERSION = "Mimir x402 resource v1";

export interface CanonicalResource {
  network: string;
  method: string;
  /** Request path, e.g. `/api/premium/price`. */
  path: string;
  /** Query parameters; order and repeated keys are normalised. */
  query?: URLSearchParams | Record<string, string | readonly string[]> | string;
}

function canonicalQuery(query: CanonicalResource["query"]): string {
  if (!query) return "";
  const params =
    query instanceof URLSearchParams
      ? query
      : typeof query === "string"
        ? new URLSearchParams(query.startsWith("?") ? query.slice(1) : query)
        : (() => {
            const p = new URLSearchParams();
            for (const [key, value] of Object.entries(query)) {
              for (const v of Array.isArray(value) ? value : [value as string]) p.append(key, v);
            }
            return p;
          })();
  return [...params.entries()]
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function canonicalPath(path: string): string {
  const trimmed = path.trim() || "/";
  const collapsed = trimmed.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

/** The exact text a resource digest is computed over. */
export function canonicalResourceText(resource: CanonicalResource): string {
  return [
    RESOURCE_DIGEST_VERSION,
    `network: ${resource.network}`,
    `method: ${resource.method.trim().toUpperCase()}`,
    `path: ${canonicalPath(resource.path)}`,
    `query: ${canonicalQuery(resource.query)}`,
  ].join("\n");
}

/** SHA-256 (lowercase hex) of {@link canonicalResourceText}. */
export function canonicalResourceDigest(resource: CanonicalResource): string {
  return createHash("sha256").update(canonicalResourceText(resource), "utf8").digest("hex");
}

/**
 * The canonical resource of the HTTP request an x402 hook is running for, or
 * null when the transport context carries no request (never guess one).
 */
export function resourceFromTransport(network: string, transportContext: unknown): CanonicalResource | null {
  const request = (transportContext as {
    request?: { path?: string; method?: string; adapter?: { getUrl?: () => string; getMethod?: () => string } };
  } | undefined)?.request;
  if (!request) return null;
  const method = request.method ?? request.adapter?.getMethod?.() ?? "GET";
  let path = request.path ?? "";
  let query = "";
  const url = request.adapter?.getUrl?.();
  if (url) {
    try {
      const parsed = new URL(url);
      path = path || parsed.pathname;
      query = parsed.search;
    } catch {
      /* keep the path the transport reported */
    }
  }
  if (!path) return null;
  return { network, method, path, query };
}

// ── Receipts ─────────────────────────────────────────────────────────────────

export interface FulfillmentReceipt {
  network: string;
  /** Lowercase Stellar transaction hash: the payment this receipt is for. */
  transaction: string;
  /** Request path, for operators. The digest is what binding compares. */
  resource: string;
  resourceDigest: string;
  payer: string;
  /** Atomic USDC the quote settled for (string; never a float). */
  amountAtomic: string;
  settledAt: number;
  /** Redeliveries served after the first fulfilment. */
  redeliveries: number;
  lastDeliveredAt: number;
}

export interface FulfillmentReceiptStore {
  get(network: string, transaction: string): Promise<FulfillmentReceipt | null>;
  /**
   * Insert if absent. Returns the receipt that is now bound to the transaction:
   * the new one, or the earlier binding when one already existed.
   */
  bind(receipt: FulfillmentReceipt): Promise<{ receipt: FulfillmentReceipt; created: boolean }>;
  /** Count one redelivery. */
  noteRedelivery(network: string, transaction: string, at: number): Promise<void>;
}

function receiptKey(network: string, transaction: string): string {
  return `${network}|${transaction.toLowerCase()}`;
}

export const RECEIPTS_IN_MEMORY_MAX = 4096;

/** Bounded in-process store. The only store without a database. */
export function memoryReceiptStore(max = RECEIPTS_IN_MEMORY_MAX): FulfillmentReceiptStore & { size(): number; clear(): void } {
  const receipts = new Map<string, FulfillmentReceipt>();
  return {
    size: () => receipts.size,
    clear: () => receipts.clear(),
    async get(network, transaction) {
      const found = receipts.get(receiptKey(network, transaction));
      return found ? { ...found } : null;
    },
    async bind(receipt) {
      const key = receiptKey(receipt.network, receipt.transaction);
      const existing = receipts.get(key);
      if (existing) return { receipt: { ...existing }, created: false };
      const stored = { ...receipt, transaction: receipt.transaction.toLowerCase() };
      receipts.set(key, stored);
      while (receipts.size > max) {
        const oldest = receipts.keys().next().value as string;
        receipts.delete(oldest);
      }
      return { receipt: { ...stored }, created: true };
    },
    async noteRedelivery(network, transaction, at) {
      const existing = receipts.get(receiptKey(network, transaction));
      if (!existing) return;
      existing.redeliveries += 1;
      existing.lastDeliveredAt = at;
    },
  };
}

/**
 * Durable store over `x402_fulfillment_receipts`, mirrored in memory.
 *
 * A database failure never fails a paid request: binding falls back to the
 * in-process mirror and the lookup to whatever the mirror holds, like
 * `settledInLedger` does for the replay set.
 */
export function durableReceiptStore(mirror = memoryReceiptStore()): FulfillmentReceiptStore {
  async function db() {
    const mod = await import("../db");
    return mod.isDbConfigured() ? mod : null;
  }
  const warn = (what: string, error: unknown) =>
    console.warn(`[x402] fulfillment receipt ${what} failed, using in-process only:`,
      error instanceof Error ? error.message : error);

  return {
    async get(network, transaction) {
      const local = await mirror.get(network, transaction);
      if (local) return local;
      try {
        const mod = await db();
        return mod ? await mod.getFulfillmentReceipt(network, transaction) : null;
      } catch (error) {
        warn("lookup", error);
        return null;
      }
    },
    async bind(receipt) {
      try {
        const mod = await db();
        if (mod) {
          const bound = await mod.bindFulfillmentReceipt(receipt);
          await mirror.bind(bound.receipt);
          return bound;
        }
      } catch (error) {
        warn("write", error);
      }
      return mirror.bind(receipt);
    },
    async noteRedelivery(network, transaction, at) {
      await mirror.noteRedelivery(network, transaction, at);
      try {
        const mod = await db();
        if (mod) await mod.noteFulfillmentRedelivery(network, transaction, at);
      } catch (error) {
        warn("redelivery count", error);
      }
    },
  };
}

let _store: FulfillmentReceiptStore | null = null;

export function defaultReceiptStore(): FulfillmentReceiptStore {
  return (_store ??= durableReceiptStore());
}

/** Test seam: swap the process store (pass null to restore the default). */
export function setReceiptStore(store: FulfillmentReceiptStore | null): void {
  _store = store;
}

// ── Binding at settlement ────────────────────────────────────────────────────

export interface BindArgs {
  network: string;
  transaction: string;
  payer: string;
  amountAtomic: string | bigint;
  resource: CanonicalResource;
  now?: number;
  store?: FulfillmentReceiptStore;
}

/**
 * Bind a just-settled payment to the resource it bought. First binding wins;
 * `created: false` with a different digest means the payment was already spent
 * on another resource.
 */
export async function bindFulfillment(args: BindArgs): Promise<{ receipt: FulfillmentReceipt; created: boolean }> {
  const now = args.now ?? Date.now();
  const store = args.store ?? defaultReceiptStore();
  return store.bind({
    network: args.network,
    transaction: args.transaction.toLowerCase(),
    resource: canonicalPath(args.resource.path),
    resourceDigest: canonicalResourceDigest(args.resource),
    payer: args.payer,
    amountAtomic: args.amountAtomic.toString(),
    settledAt: now,
    redeliveries: 0,
    lastDeliveredAt: now,
  });
}

// ── Reconciling a repeated proof ─────────────────────────────────────────────

export type RedeliveryRefusal =
  | "no_receipt"
  | "resource_mismatch"
  | "payer_mismatch"
  | "redelivery_window_closed"
  | "redelivery_limit_reached"
  | "proof_invalid";

export type RedeliveryDecision =
  | { ok: true; receipt: FulfillmentReceipt; payer: string }
  | { ok: false; reason: RedeliveryRefusal; message: string };

export interface RedeliveryOptions {
  store?: FulfillmentReceiptStore;
  backend?: StellarHorizonReader;
  now?: number;
  windowMs?: number;
  maxRedeliveries?: number;
}

/**
 * Decide whether a proof whose payment already settled may receive its
 * response again. Read-only: nothing is counted until {@link redeliverySettle}.
 */
export async function decideRedelivery(
  paymentPayload: HookPaymentPayload,
  requirements: PaymentRequirements,
  resource: CanonicalResource | null,
  options: RedeliveryOptions = {},
): Promise<RedeliveryDecision> {
  const proof = parsePaymentProof(paymentPayload.payload);
  const store = options.store ?? defaultReceiptStore();
  const receipt = proof ? await store.get(requirements.network, proof.transaction) : null;
  if (!proof || !receipt) {
    return { ok: false, reason: "no_receipt", message: "no fulfilled payment matches this proof" };
  }

  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? X402_REDELIVERY_WINDOW_MS;
  const maxRedeliveries = options.maxRedeliveries ?? X402_REDELIVERY_MAX;

  if (!resource || canonicalResourceDigest(resource) !== receipt.resourceDigest) {
    return {
      ok: false,
      reason: "resource_mismatch",
      message: `${receipt.transaction} paid for a different resource`,
    };
  }
  if (now - receipt.settledAt > windowMs) {
    return {
      ok: false,
      reason: "redelivery_window_closed",
      message: `${receipt.transaction} settled more than ${Math.round(windowMs / 1000)}s ago`,
    };
  }
  if (receipt.redeliveries >= maxRedeliveries) {
    return {
      ok: false,
      reason: "redelivery_limit_reached",
      message: `${receipt.transaction} has already been redelivered ${receipt.redeliveries} time(s)`,
    };
  }

  // Re-check the proof itself: the payer's signature over this quote and the
  // landed payment. The freshness window is extended by the redelivery window,
  // since the payment is by construction older than at first settlement.
  const verified = await verifyStellarPayment(paymentPayload.payload, requirements, {
    backend: options.backend,
    now,
    maxAgeMs: X402_PAYMENT_MAX_AGE_MS + windowMs,
  });
  if (!verified.ok) {
    return { ok: false, reason: "proof_invalid", message: verified.message };
  }
  if (verified.payer !== receipt.payer) {
    return { ok: false, reason: "payer_mismatch", message: `${receipt.transaction} was paid by another account` };
  }
  return { ok: true, receipt, payer: verified.payer };
}

/** The verify result a redelivery is admitted with, or null to verify normally. */
export async function redeliveryVerify(
  paymentPayload: HookPaymentPayload,
  requirements: PaymentRequirements,
  transportContext: unknown,
  options: RedeliveryOptions = {},
): Promise<VerifyResponse | null> {
  const decision = await decideRedelivery(
    paymentPayload,
    requirements,
    resourceFromTransport(requirements.network, transportContext),
    options,
  );
  if (!decision.ok) return null;
  return {
    isValid: true,
    payer: decision.payer,
    extra: { transaction: decision.receipt.transaction, redelivery: true },
  } as VerifyResponse;
}

/** Marks settle results that are redeliveries, so revenue is not booked twice. */
const redeliveredResults = new WeakSet<object>();

export function isRedelivery(result: SettleResponse): boolean {
  return redeliveredResults.has(result);
}

/**
 * The settle result for a redelivery (no new charge), or null to settle
 * normally. Counts the redelivery.
 */
export async function redeliverySettle(
  paymentPayload: HookPaymentPayload,
  requirements: PaymentRequirements,
  transportContext: unknown,
  options: RedeliveryOptions = {},
): Promise<SettleResponse | null> {
  const decision = await decideRedelivery(
    paymentPayload,
    requirements,
    resourceFromTransport(requirements.network, transportContext),
    options,
  );
  if (!decision.ok) return null;
  const store = options.store ?? defaultReceiptStore();
  await store.noteRedelivery(requirements.network, decision.receipt.transaction, options.now ?? Date.now());
  const result: SettleResponse = {
    success: true,
    transaction: decision.receipt.transaction,
    network: requirements.network,
    payer: decision.payer,
    // The amount the original settlement booked; nothing new is charged.
    amount: decision.receipt.amountAtomic,
  } as SettleResponse;
  redeliveredResults.add(result);
  return result;
}
