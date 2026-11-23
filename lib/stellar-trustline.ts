"use client";

// Read-only preflight preview: fees, reserve readiness and exact USDC exposure from simulation.
/**
 * The one setup step between a fresh Stellar wallet and staking: a USDC
 * trustline.
 *
 * ── What this replaces ───────────────────────────────────────────────────────
 *
 * The EVM version of this file created a Base Account **sub account** and held a
 * scoped P256 key in browser storage, purely so `approve(USDC)` and the stake
 * could be sent as one ERC-5792 batch and mirroring did not cost two wallet
 * prompts per position.
 *
 * On Soroban that entire mechanism has nothing to optimise. Authorisation is per
 * invocation: `challenge_claim` carries auth permitting exactly one USDC transfer
 * of exactly the staked amount, so there is no allowance to pre-grant and no
 * second transaction to batch with. **Staking is one signature, for every wallet,
 * with no setup.** The sub account, the browser-held key and the batch are all
 * deleted rather than ported — there is no custody question left to answer.
 *
 * What is left is a genuine first-time step: a Stellar account can only hold USDC
 * once it has a trustline to the issuer. That is a classic `changeTrust`
 * operation.
 *
 * ── Why it is NOT one transaction with the stake ─────────────────────────────
 *
 * The obvious design — one envelope holding `changeTrust` + the contract
 * invocation, one signature — is impossible, and not because of an SDK gap.
 * A Stellar transaction carrying a Soroban operation must carry EXACTLY ONE
 * operation, at the protocol level. Verified against the installed
 * `@stellar/stellar-sdk` 16.2.0 rather than assumed:
 *
 *   node_modules/@stellar/stellar-sdk/lib/esm/rpc/transaction.js
 *     isSorobanTransaction(): `if (tx.operations.length !== 1) return false`
 *     assembleTransaction():  throws TypeError
 *       "unsupported transaction: must contain exactly one invokeHostFunction,
 *        extendFootprintTtl, or restoreFootprint operation"
 *     and, in `assembleTransaction`'s own comment:
 *       "in soroban contract tx, there can only be single operation in the tx"
 *
 * `TransactionBuilder.addOperation()` will happily accept both — the builder does
 * not enforce it — so this fails at simulation, or at stellar-core, not at build
 * time. Which is exactly why it is written down here.
 *
 * So the flow is: add the trustline (one signature, once per account, classic
 * transaction), then stake (one signature, every time, Soroban transaction).
 * Worst case for a brand-new account is two signatures TOTAL, once — better than
 * the EVM path's two per stake, and it needs no key custody at all.
 */

import {
  Account,
  BASE_FEE,
  Operation,
  StrKey,
  TransactionBuilder,
  type Horizon,
} from "@stellar/stellar-sdk";

import {
  NETWORK_PASSPHRASE,
  createHorizonServer,
  isAccountAddress,
  type StellarSigner,
} from "./stellar";
import { USDC_CODE, USDC_ISSUER, usdcAsset } from "./usdc";
import { isUncertainSubmissionError } from "./wallet-submission-recovery";

export type TrustlineStatus =
  /** Trustline present: the account can hold and stake USDC. */
  | "ready"
  /** Account exists and is funded, but holds no USDC trustline yet. */
  | "missing"
  /**
   * No account on the ledger at all. A Stellar account has to be funded with XLM
   * before it can do anything, including adding a trustline — deliberately
   * distinct from "missing", because the fix is different (get XLM, not click a
   * button here).
   */
  | "unfunded"
  /** Horizon could not be reached. Never reported as "missing". */
  | "unknown";

export interface TrustlineState {
  status: TrustlineStatus;
  /** Display USDC held, when a trustline exists. */
  balance: number | null;
}

export interface HorizonBalanceLine {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  limit?: string;
  buying_liabilities?: string;
  selling_liabilities?: string;
  last_modified_ledger?: number;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
  is_clawback_enabled?: boolean;
  liquidity_pool_id?: string;
  sponsor?: string;
}

export interface HorizonAccount {
  balances: readonly HorizonBalanceLine[];
}

export type HorizonAccountLoader = (address: string) => Promise<HorizonAccount>;

export interface ReadUsdcTrustlineOptions {
  loadAccount?: HorizonAccountLoader;
  server?: { loadAccount: HorizonAccountLoader };
  /**
   * Wallet session revision. When provided, allows cached read contexts to be
   * invalidated when the wallet session revision increments.
   */
  sessionRevision?: number;
  /**
   * Explicitly enable or bypass caching for synthetic tests or callers.
   */
  useCache?: boolean;
}

/**
 * Cached read context for trustline status.
 * Keyed by exact case-sensitive account address.
 */
export interface TrustlineReadContext {
  readonly address: string;
  readonly state: TrustlineState;
  readonly sessionRevision?: number;
  readonly cachedAt: number;
}

const trustlineReadCache = new Map<string, TrustlineReadContext>();

/**
 * Invalidate trustline read context.
 *
 * Preserves exact case-sensitive account identity: invalidating by address
 * purges only the affected account's read context while preserving other accounts.
 * Calling without arguments clears all cached read contexts (e.g. on network switch).
 *
 * @param target - Optional exact case-sensitive account address or invalidation criteria.
 */
export function invalidateTrustlineRead(
  target?: string | { address?: string; sessionRevision?: number },
): void {
  if (typeof target === "string") {
    trustlineReadCache.delete(target);
    return;
  }
  if (target?.address) {
    trustlineReadCache.delete(target.address);
    return;
  }
  trustlineReadCache.clear();
}

/**
 * Inspect the current size of the trustline read context cache (for tests).
 */
export function getTrustlineReadCacheSize(): number {
  return trustlineReadCache.size;
}

/**
 * Clear the entire trustline read context cache (for tests).
 */
export function clearTrustlineReadCache(): void {
  trustlineReadCache.clear();
}


function resolveAccountLoader(
  options: HorizonAccountLoader | ReadUsdcTrustlineOptions,
): HorizonAccountLoader {
  if (typeof options === "function") return options;
  if (options.loadAccount) return (address) => options.loadAccount!(address);
  if (options.server) return (address) => options.server!.loadAccount(address);
  return (address) => createHorizonServer().loadAccount(address);
}

/**
 * Read the USDC trustline straight from Horizon.
 *
 * Horizon rather than the SAC balance read in `lib/usdc.ts`: that helper folds
 * "no trustline", "no account" and "RPC hiccup" all into `null`, and this is the
 * one place where telling them apart is the whole point.
 *
 * Caches read contexts keyed by exact case-sensitive account address, invalidated
 * when the wallet session revision increments or when invalidateTrustlineRead is called.
 */
export async function readUsdcTrustline(
  address: string,
  options: HorizonAccountLoader | ReadUsdcTrustlineOptions = {},
): Promise<TrustlineState> {
  if (!isAccountAddress(address)) return { status: "unknown", balance: null };

  const opts: ReadUsdcTrustlineOptions =
    typeof options === "function" ? { loadAccount: options } : options;
  const isCustomLoader = Boolean(opts.loadAccount || opts.server?.loadAccount);
  const cacheEnabled = opts.useCache ?? !isCustomLoader;

  if (cacheEnabled) {
    const cached = trustlineReadCache.get(address);
    if (
      cached &&
      (opts.sessionRevision === undefined || cached.sessionRevision === opts.sessionRevision)
    ) {
      return cached.state;
    }
  }

  const loadAccount = resolveAccountLoader(options);
  try {
    const account = await loadAccount(address);
    const line = account.balances.find(
      (balance): balance is Horizon.HorizonApi.BalanceLineAsset =>
        (balance.asset_type === "credit_alphanum4" || balance.asset_type === "credit_alphanum12") &&
        balance.asset_code === USDC_CODE &&
        balance.asset_issuer === USDC_ISSUER,
    );
    const result: TrustlineState = !line
      ? { status: "missing", balance: null }
      : { status: "ready", balance: Number(line.balance) };

    if (cacheEnabled) {
      trustlineReadCache.set(address, {
        address,
        state: result,
        sessionRevision: opts.sessionRevision,
        cachedAt: Date.now(),
      });
    }

    return result;
  } catch (cause) {
    // Horizon answers a missing account with 404. Anything else is a transport
    // problem and must not be reported as a missing trustline — that would show
    // an "add trustline" button to someone who already has one.
    const status = (cause as { response?: { status?: number } })?.response?.status;
    const result: TrustlineState =
      status === 404 ? { status: "unfunded", balance: null } : { status: "unknown", balance: null };

    if (cacheEnabled && status === 404) {
      trustlineReadCache.set(address, {
        address,
        state: result,
        sessionRevision: opts.sessionRevision,
        cachedAt: Date.now(),
      });
    }

    return result;
  }
}

export interface TrustlineHorizonClient {
  loadAccount: (
    address: string,
  ) => Promise<ConstructorParameters<typeof TransactionBuilder>[0] & HorizonAccount>;
  submitTransaction: (
    transaction: ReturnType<typeof TransactionBuilder.fromXDR>,
  ) => Promise<{ hash: string }>;
}

export interface EnsureUsdcTrustlineOptions {
  /**
   * Optional cross-tab coordinator override (for deterministic tests or custom
   * scopes; defaults to the browser singleton in browser contexts and `null`
   * on the server).
   */
  coordinator?: WalletSigningCoordinator | null;
  /** Opt-in retry flag to clear a pending `uncertain_recovery` before prompting. */
  acknowledgeUncertainRecovery?: boolean;
  /** Optional operationId guard paired with {@link acknowledgeUncertainRecovery}. */
  expectedRecoveryOperationId?: string;
  /** Optional Horizon client override for deterministic offline testing. */
  horizon?: TrustlineHorizonClient;
}

/**
 * Add the USDC trustline, signed by the connected wallet.
 *
 * One classic `changeTrust` operation, one signature, submitted through Horizon
 * (Soroban RPC does not accept classic-only transactions for submission in a way
 * that gains anything here). Idempotent from the caller's point of view: a
 * trustline that already exists returns immediately without prompting.
 *
 * When intent generation options or active address accessors are provided,
 * late signatures from obsolete intents or switched accounts are ignored and
 * rejected with `ObsoleteSigningIntentError`, preventing stale submissions to Horizon.
 */
export interface HorizonTrustlineServer {
  loadAccount: (address: string) => Promise<Horizon.AccountResponse>;
  submitTransaction: (
    transaction: ReturnType<typeof TransactionBuilder.fromXDR>,
  ) => Promise<{ hash: string }>;
}

export interface EnsureUsdcTrustlineOptions {
  /** Optional Horizon server override for testing or custom transports. */
  server?: HorizonTrustlineServer;
  /** Optional trustline reader override for testing. */
  readTrustline?: (address: string) => Promise<TrustlineState>;
}

/**
 * Thrown when a signed USDC trustline transaction was submitted to Horizon,
 * but a transport/timeout error left the on-chain outcome uncertain.
 *
 * Exposes the deterministic transaction `hash` and explicitly sets
 * `canResubmit = false` so wallet flows reconcile instead of prompting the
 * user to resubmit a possibly successful transaction.
 */
export class UncertainTrustlineSubmissionError extends Error {
  readonly hash: string;
  readonly status = "uncertain-submission" as const;
  readonly canResubmit = false as const;

  constructor(hash: string, cause?: unknown) {
    super(
      `USDC trustline transaction ${hash} may have already succeeded on Stellar. Do not resubmit; reconcile status first.`,
      cause !== undefined ? { cause } : undefined,
    );
    this.name = "UncertainTrustlineSubmissionError";
    this.hash = hash;
  }
}

export async function ensureUsdcTrustline(
  signer: StellarSigner,
  options: EnsureUsdcTrustlineOptions = {},
): Promise<{ added: boolean; hash?: string }> {
  const existing = options.readTrustline
    ? await options.readTrustline(signer.publicKey)
    : await readUsdcTrustline(
        signer.publicKey,
        options.server ? { loadAccount: (addr) => options.server!.loadAccount(addr) } : {},
      );
  if (existing.status === "ready") return { added: false };
  if (existing.status === "unfunded") {
    throw new Error(
      `This account does not exist on the Stellar ledger yet. Fund it with XLM first, then add the ${USDC_CODE} trustline (issuer: ${USDC_ISSUER}).`,
    );
  }

  const horizon = options.server ?? createHorizonServer();
  const account = await horizon.loadAccount(signer.publicKey);

  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset: usdcAsset() }))
    .setTimeout(180)
    .build();

  const { signedTxXdr } = await signer.signTransaction(transaction.toXDR(), {
    networkPassphrase: NETWORK_PASSPHRASE,
    address: signer.publicKey,
  });

  // Verify that the signing intent is still active before submitting to Horizon.
  // Drops late wallet responses belonging to an obsolete generation or switched account.
  const activeGen = options.getActiveIntentGeneration?.();
  const activeAddr = options.getActiveAddress?.();

  if (
    (options.intentGeneration !== undefined && activeGen !== undefined && activeGen !== options.intentGeneration) ||
    (options.getActiveAddress && activeAddr !== signer.publicKey)
  ) {
    throw new ObsoleteSigningIntentError({
      generation: options.intentGeneration ?? 0,
      activeGeneration: activeGen ?? (options.intentGeneration ?? 0),
      expectedAddress: signer.publicKey,
      currentAddress: activeAddr ?? null,
    });
  }

  const signed = TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE);
  const hash = signed.hash().toString("hex");
  try {
    const result = await horizon.submitTransaction(signed);
    return { added: true, hash: result.hash || hash };
  } catch (cause) {
    if (isUncertainSubmissionError(cause)) {
      throw new UncertainTrustlineSubmissionError(hash, cause);
    }
    throw cause;
  }


}

export interface TrustlinePreflightPreview {
  /** Always true: this preview is computed from simulation and never executes a transaction. */
  readonly preflight: true;
  /** Whether the transaction would actually be submitted. Always false for a preview. */
  readonly executed: false;
  /** Fee estimate in XLM (display only; fees are never used as value). */
  feeXlm: number;
  /** Base reserve readiness: whether the account can cover reserve plus the trustline subentry. */
  reserveReady: boolean;
  /** Exact integer USDC exposure from the simulation, in stroops-free base units. */
  usdcExposure: bigint;
}

export interface PreflightOptions {
  loadAccount?: HorizonAccountLoader;
  /** Current base reserve in XLM as reported by the network (0.5 XLM on Stellar public). */
  baseReserveXlm?: number;
  /** Simulated fee in stroops for the trustline operation. */
  simulatedFeeStroops?: number;
}

const STROOPS_PER_XLM = 10_000_000;
const DEFAULT_BASE_RESERVE_XLM = 0.5;

/**
 * Build a read-only preflight preview of the USDC trustline transaction.
 *
 * Nothing here signs or submits. The result is explicitly marked as a
 * preflight so UI can distinguish it from an executed transaction.
 */
export async function previewUsdcTrustlinePreflight(
  address: string,
  options: PreflightOptions = {},
): Promise<TrustlinePreflightPreview> {
  const state = await readUsdcTrustline(address, options.loadAccount ?? {});
  const loadAccount = resolveAccountLoader(options.loadAccount ?? {});
  const baseReserve = options.baseReserveXlm ?? DEFAULT_BASE_RESERVE_XLM;
  const feeStroops = options.simulatedFeeStroops ?? Number(BASE_FEE);

  let nativeBalance = 0;
  let subentryCount = 0;
  if (state.status !== "unfunded" && state.status !== "unknown") {
    try {
      const account = await loadAccount(address);
      const native = account.balances.find((b) => b.asset_type === "native");
      nativeBalance = native ? Number(native.balance) : 0;
      // Each trustline is one subentry; the account needs reserve for itself plus subentries.
      subentryCount = account.balances.filter((b) => b.asset_type !== "native").length;
    } catch {
      return {
        preflight: true,
        executed: false,
        feeXlm: feeStroops / STROOPS_PER_XLM,
        reserveReady: false,
        usdcExposure: 0n,
      };
    }
  }

  const requiredReserve = baseReserve * (2 + subentryCount + 1);
  const reserveReady = nativeBalance - feeStroops / STROOPS_PER_XLM >= requiredReserve;

  // Exposure is the USDC currently held (integer base units, 7 decimals as stroops).
  const usdcExposure =
    state.balance === null ? 0n : BigInt(Math.round(state.balance * STROOPS_PER_XLM));

  return {
    preflight: true,
    executed: false,
    feeXlm: feeStroops / STROOPS_PER_XLM,
    reserveReady,
    usdcExposure,
  };
}
