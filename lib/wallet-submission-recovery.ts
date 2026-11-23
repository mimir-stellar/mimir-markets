/**
 * Uncertain-submission recovery state and bounded reconciliation for Stellar
 * wallet flows.
 *
 * When a signed Stellar transaction is submitted and the transport times out,
 * drops, or confirmation polling exhausts its budget, the transaction may have
 * already landed on the ledger. Asking the user to resubmit risks duplicate
 * payments or conflicting sequence errors.
 *
 * This module models the recovery state machine:
 *  - Records the deterministic 64-hex-char transaction hash.
 *  - Blocks resubmission (`canResubmit: false`) while the outcome is uncertain,
 *    reconciling, or confirmed.
 *  - Provides a bounded reconciliation action (`reconcileUncertainSubmission`)
 *    that queries chain status up to `maxAttempts` times (clamped to a safe
 *    upper bound) and transitions to `"confirmed"`, `"failed"`, or remains
 *    `"uncertain"` with `reconciliationExhausted: true` (still without asking
 *    the user to resubmit).
 */

import { waitForTransaction, type WaitForTransactionOptions } from "./stellar";

export const DEFAULT_MAX_RECONCILIATION_ATTEMPTS = 3;
export const MIN_RECONCILIATION_ATTEMPTS = 1;
export const MAX_RECONCILIATION_ATTEMPTS = 10;
export const DEFAULT_RECONCILIATION_TIMEOUT_MS = 10_000;

const TX_HASH_PATTERN = /^[0-9a-f]{64}$/i;

export type UncertainSubmissionStatus =
  | "uncertain"
  | "reconciling"
  | "confirmed"
  | "failed";

export type ReconciliationProbeResult = "succeeded" | "failed" | "pending";

export interface UncertainSubmissionState {
  /** Deterministic 64-character lowercase hex Stellar transaction hash. */
  hash: string;
  /** Human-readable action label (e.g. "payment", "stake", "trustline"). */
  action: string;
  /** Current recovery lifecycle status. */
  status: UncertainSubmissionStatus;
  /**
   * Explicitly false whenever the transaction might have succeeded on-chain
   * (`"uncertain"`, `"reconciling"`, `"confirmed"`). Only `true` once
   * reconciliation proves the transaction definitively failed on-chain.
   */
  canResubmit: boolean;
  /** Number of bounded reconciliation checks performed so far. */
  attempts: number;
  /** Maximum reconciliation attempts permitted for this submission. */
  maxAttempts: number;
  /** True when `attempts >= maxAttempts` and status is still `"uncertain"`. */
  reconciliationExhausted: boolean;
  /** User-facing recovery guidance that avoids prompting resubmission while uncertain. */
  guidance: string;
  /** Epoch milliseconds when the uncertain submission was recorded. */
  recordedAt: number;
  /** Last transport error message encountered during reconciliation, if any. */
  lastError: string | null;
}

export interface CreateUncertainSubmissionParams {
  hash: string;
  action?: string;
  maxAttempts?: number;
  now?: number;
}

export interface ReconcileUncertainSubmissionOptions {
  /**
   * Probe function that checks the authoritative chain status for `hash`.
   * Defaults to `waitForTransaction` against Soroban RPC.
   */
  checkTransaction?: (hash: string) => Promise<ReconciliationProbeResult>;
  /** Optional Soroban RPC options passed to the default `waitForTransaction` probe. */
  waitOptions?: WaitForTransactionOptions;
  /** Per-attempt timeout in milliseconds (bounded; defaults to 10s). */
  timeoutMs?: number;
}

function clampMaxAttempts(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_RECONCILIATION_ATTEMPTS;
  }
  return Math.min(
    MAX_RECONCILIATION_ATTEMPTS,
    Math.max(MIN_RECONCILIATION_ATTEMPTS, Math.floor(value)),
  );
}

export function normalizeTransactionHash(hash: string): string {
  const normalized = hash.trim().toLowerCase();
  if (!TX_HASH_PATTERN.test(normalized)) {
    throw new Error(
      `Invalid Stellar transaction hash "${hash}": expected a 64-character hex string.`,
    );
  }
  return normalized;
}

function uncertainGuidance(hash: string, action: string, exhausted: boolean): string {
  if (exhausted) {
    return `Transaction ${hash} for ${action} is still unconfirmed after reaching the reconciliation limit. Do not resubmit yet; verify the hash on the Stellar explorer first.`;
  }
  return `Transaction ${hash} for ${action} may have already succeeded on Stellar. Do not resubmit; check status to reconcile.`;
}

/**
 * Create an initial uncertain-submission recovery state for a signed/submitted
 * transaction hash. Resubmission is explicitly disabled until reconciliation
 * proves a definitive on-chain failure.
 */
export function createUncertainSubmission(
  params: CreateUncertainSubmissionParams,
): UncertainSubmissionState {
  const hash = normalizeTransactionHash(params.hash);
  const action = params.action?.trim() || "transaction";
  const maxAttempts = clampMaxAttempts(params.maxAttempts);

  return {
    hash,
    action,
    status: "uncertain",
    canResubmit: false,
    attempts: 0,
    maxAttempts,
    reconciliationExhausted: false,
    guidance: uncertainGuidance(hash, action, false),
    recordedAt: params.now ?? Date.now(),
    lastError: null,
  };
}

/**
 * Returns `true` when it is safe to submit a new payment/transaction.
 * Returns `false` whenever an uncertain, reconciling, or already-confirmed
 * submission is active so callers never ask users to resubmit a possibly
 * successful payment.
 */
export function canResubmitPayment(state: UncertainSubmissionState | null): boolean {
  if (!state) return true;
  return state.canResubmit;
}

/**
 * Classify whether a submission error leaves the transaction outcome uncertain
 * (e.g. network drop, timeout, 5xx gateway error, 408/429) versus a definitive
 * rejection (e.g. Horizon 400 `tx_failed`/`tx_bad_seq`, or user wallet rejection).
 */
export function isUncertainSubmissionError(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") {
    return typeof cause === "string" && /timeout|network|fetch|econnreset|etimedout/i.test(cause);
  }

  const err = cause as {
    message?: string;
    name?: string;
    code?: string | number;
    response?: { status?: number };
  };

  const status = err.response?.status;
  if (typeof status === "number") {
    if (status === 408 || status === 429 || status >= 500) {
      return true;
    }
    // 4xx (other than 408/429) such as Horizon 400 tx_failed / tx_bad_seq is a
    // definitive rejection by the ledger or RPC.
    if (status >= 400 && status < 500) {
      return false;
    }
  }

  const message = typeof err.message === "string" ? err.message : "";
  if (/reject|denied|cancel|user declined|tx_failed|tx_bad_seq|op_underfunded/i.test(message)) {
    return false;
  }

  if (
    err.name === "AbortError" ||
    err.name === "TimeoutError" ||
    /timeout|timed out|network|fetch failed|econnreset|etimedout|socket hang up|504|502|503|unavailable/i.test(
      message,
    ) ||
    (typeof err.code === "string" &&
      /ETIMEDOUT|ECONNRESET|ECONNABORTED|ENETUNREACH|EAI_AGAIN/i.test(err.code))
  ) {
    return true;
  }

  return false;
}

async function defaultCheckTransaction(
  hash: string,
  waitOptions?: WaitForTransactionOptions,
): Promise<ReconciliationProbeResult> {
  const result = await waitForTransaction(hash, waitOptions);
  if (result.succeeded) return "succeeded";
  if (result.pending) return "pending";
  return "failed";
}

function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Reconciliation check timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Execute one bounded reconciliation check for an uncertain submission.
 *
 * - Terminal states (`"confirmed"`, `"failed"`) are returned unchanged.
 * - Once `attempts >= maxAttempts`, no further network probe is executed and
 *   `reconciliationExhausted` is set to `true` while keeping `canResubmit: false`.
 * - Transport errors or `"pending"` responses keep the state `"uncertain"` with
 *   `canResubmit: false` so the user is never prompted to resubmit a possibly
 *   successful payment.
 */
export async function reconcileUncertainSubmission(
  state: UncertainSubmissionState,
  options: ReconcileUncertainSubmissionOptions = {},
): Promise<UncertainSubmissionState> {
  if (state.status === "confirmed" || state.status === "failed") {
    return state;
  }

  if (state.attempts >= state.maxAttempts) {
    return {
      ...state,
      status: "uncertain",
      canResubmit: false,
      reconciliationExhausted: true,
      guidance: uncertainGuidance(state.hash, state.action, true),
    };
  }

  const nextAttempts = state.attempts + 1;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RECONCILIATION_TIMEOUT_MS;
  const probe =
    options.checkTransaction ??
    ((hash: string) => defaultCheckTransaction(hash, options.waitOptions));

  try {
    const outcome = await runWithTimeout(probe(state.hash), timeoutMs);

    if (outcome === "succeeded") {
      return {
        ...state,
        status: "confirmed",
        canResubmit: false,
        attempts: nextAttempts,
        reconciliationExhausted: false,
        guidance: `Transaction ${state.hash} for ${state.action} is confirmed on Stellar.`,
        lastError: null,
      };
    }

    if (outcome === "failed") {
      return {
        ...state,
        status: "failed",
        canResubmit: true,
        attempts: nextAttempts,
        reconciliationExhausted: false,
        guidance: `Transaction ${state.hash} for ${state.action} failed on Stellar. You may safely try again.`,
        lastError: null,
      };
    }

    const exhausted = nextAttempts >= state.maxAttempts;
    return {
      ...state,
      status: "uncertain",
      canResubmit: false,
      attempts: nextAttempts,
      reconciliationExhausted: exhausted,
      guidance: uncertainGuidance(state.hash, state.action, exhausted),
      lastError: null,
    };
  } catch (cause) {
    const exhausted = nextAttempts >= state.maxAttempts;
    const message =
      cause instanceof Error ? cause.message : "Could not check transaction status.";

    return {
      ...state,
      status: "uncertain",
      canResubmit: false,
      attempts: nextAttempts,
      reconciliationExhausted: exhausted,
      guidance: uncertainGuidance(state.hash, state.action, exhausted),
      lastError: message,
    };
  }
}
