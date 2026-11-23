/**
 * Market expiry evaluated against the observed ledger context (Issue #920).
 *
 * A deadline is a ledger timestamp, not a browser timestamp. The UI only ever
 * has an *observation* of that ledger (a contract read or the read index) plus
 * the browser's wall clock. Those two can disagree: the tab can be backgrounded
 * for minutes, the index can lag, and a user's clock can be skewed. Treating
 * `Date.now()` as the ledger therefore promises eligibility the contract may
 * reject with `ChallengeWindowClosed`.
 *
 * This module keeps one pure decision:
 *
 *  1. `status` is the best estimate from the browser clock (what the countdown
 *     shows), but it is labelled as an estimate.
 *  2. `estimateStale` says the underlying observation or the clock comparison
 *     is no longer trustworthy.
 *  3. `challengeable` is deliberately conservative: it is only true when the
 *     observation is fresh, the clocks agree, and the 60-second challenge lock
 *     window has not started. A stale estimate never promises eligibility.
 *
 * Soroban state remains authoritative; this only keeps the browser honest about
 * how much it actually knows.
 */

import type { VSCacheFreshness } from "./vs-freshness";

/**
 * Mirrors `VS_CHALLENGE_LOCK_SECONDS` in `lib/contract.ts` / `types.rs`.
 * Duplicated here so this module stays framework-free and cheap to unit test.
 */
export const DEFAULT_CHALLENGE_LOCK_SECONDS = 60;

/**
 * How long an observation may be used for an expiry decision before the UI must
 * say it may be stale. Three 10-second detail polls: anything older means the
 * tab missed refreshes (backgrounding, SSE outage, offline).
 */
export const MARKET_EXPIRY_MAX_OBSERVATION_AGE_MS = 30_000;

/**
 * Allowed disagreement between this browser's clock and the clock that stamped
 * the observation. Real network transit is sub-second, so a larger gap means
 * one of the clocks is wrong.
 */
export const MARKET_EXPIRY_CLOCK_SKEW_TOLERANCE_MS = 5_000;

export type ExpiryContextSource = "ledger" | "index" | "sample" | "local_draft";

/**
 * One read of the ledger context. `receivedAtMs` is the browser clock when the
 * snapshot arrived; `serverNowMs` is the server clock at snapshot generation,
 * derived from the freshness metadata (both fields are server-produced).
 */
export interface ExpiryObservation {
  source: ExpiryContextSource;
  receivedAtMs: number;
  serverNowMs?: number | null;
  freshness?: VSCacheFreshness | null;
}

export type MarketExpiryStatus = "open" | "closing_soon" | "expired" | "unknown";

export type MarketExpiryStaleReason =
  | "missing_deadline"
  | "no_ledger_observation"
  | "index_stale"
  | "observation_too_old"
  | "clock_skew";

export interface MarketExpiry {
  /** Best estimate from the browser clock; `unknown` when the deadline is unusable. */
  status: MarketExpiryStatus;
  /** Unix seconds, or null when the deadline is unusable. */
  deadlineUnix: number | null;
  /** Seconds until the deadline at evaluation time, or null when unknown. */
  secondsRemaining: number | null;
  /** True when the estimate or the observation is no longer trustworthy. */
  estimateStale: boolean;
  /** Why the estimate is stale; null when it is trustworthy. */
  staleReason: MarketExpiryStaleReason | null;
  /**
   * Conservative eligibility: fresh observation, agreeing clocks, an open
   * market and more than the challenge-lock window left. Never derived from the
   * browser clock alone.
   */
  challengeable: boolean;
  /** Age of the observation at evaluation time, or null when unknown. */
  observationAgeMs: number | null;
  /** Browser clock minus server clock at observation time, or null when unknown. */
  clockSkewMs: number | null;
  source: ExpiryContextSource;
}

export interface EvaluateMarketExpiryArgs {
  deadlineUnix: number | null | undefined;
  /** Browser wall clock in milliseconds. */
  nowMs: number;
  observation?: ExpiryObservation | null;
  /** On-chain claim state, when known. */
  marketState?: "open" | "accepted" | "resolved" | "cancelled" | null;
  challengeLockSeconds?: number;
  maxObservationAgeMs?: number;
  clockSkewToleranceMs?: number;
}

function sanitizeDeadline(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
}

/**
 * Build an observation from the freshness metadata returned with a read.
 *
 * `lastUpdatedAt` and `ageMs` are both produced by the server, so adding them
 * reconstructs the server's clock at the moment the snapshot was generated —
 * the closest thing to a ledger-issued timestamp available in the browser.
 */
export function observationFromFreshness(
  freshness: VSCacheFreshness | null | undefined,
  receivedAtMs = Date.now(),
): ExpiryObservation {
  if (!freshness) {
    return { source: "ledger", receivedAtMs, serverNowMs: null, freshness: null };
  }

  const updatedAtMs = freshness.lastUpdatedAt
    ? Date.parse(freshness.lastUpdatedAt)
    : NaN;
  const hasServerAge =
    typeof freshness.ageMs === "number" && Number.isFinite(freshness.ageMs);
  const serverNowMs =
    Number.isFinite(updatedAtMs) && hasServerAge
      ? updatedAtMs + Math.max(0, freshness.ageMs as number)
      : null;

  return {
    source: freshness.source === "index" ? "index" : "ledger",
    receivedAtMs,
    serverNowMs,
    freshness,
  };
}

export function evaluateMarketExpiry({
  deadlineUnix,
  nowMs,
  observation,
  marketState = null,
  challengeLockSeconds = DEFAULT_CHALLENGE_LOCK_SECONDS,
  maxObservationAgeMs = MARKET_EXPIRY_MAX_OBSERVATION_AGE_MS,
  clockSkewToleranceMs = MARKET_EXPIRY_CLOCK_SKEW_TOLERANCE_MS,
}: EvaluateMarketExpiryArgs): MarketExpiry {
  const source = observation?.source ?? "local_draft";
  const deadline = sanitizeDeadline(deadlineUnix);

  if (deadline === null) {
    return {
      status: "unknown",
      deadlineUnix: null,
      secondsRemaining: null,
      estimateStale: true,
      staleReason: "missing_deadline",
      challengeable: false,
      observationAgeMs: null,
      clockSkewMs: null,
      source,
    };
  }

  const nowSec = Math.floor(nowMs / 1000);
  const secondsRemaining = deadline - nowSec;

  // Boundary matches the contract: `now + LOCK > deadline` is rejected, so
  // exactly LOCK seconds remaining is still challengeable.
  const status: MarketExpiryStatus =
    secondsRemaining <= 0
      ? "expired"
      : secondsRemaining < challengeLockSeconds
        ? "closing_soon"
        : "open";

  const observationAgeMs = observation
    ? Math.max(0, nowMs - observation.receivedAtMs)
    : null;

  const clockSkewMs =
    observation?.serverNowMs != null &&
    Number.isFinite(observation.serverNowMs)
      ? Math.round(observation.receivedAtMs - observation.serverNowMs)
      : null;

  let staleReason: MarketExpiryStaleReason | null = null;

  if (!observation || source === "local_draft") {
    // A draft deadline has never been observed on a ledger.
    staleReason = "no_ledger_observation";
  } else if (source !== "sample") {
    if (
      observation.freshness?.source === "index" &&
      observation.freshness.status === "stale"
    ) {
      staleReason = "index_stale";
    } else if (
      observationAgeMs !== null &&
      observationAgeMs > maxObservationAgeMs
    ) {
      staleReason = "observation_too_old";
    } else if (
      clockSkewMs !== null &&
      Math.abs(clockSkewMs) > clockSkewToleranceMs
    ) {
      staleReason = "clock_skew";
    }
  }

  const estimateStale = staleReason !== null;
  const marketAcceptsChallenges =
    marketState === null || marketState === "open" || marketState === "accepted";

  return {
    status,
    deadlineUnix: deadline,
    secondsRemaining,
    estimateStale,
    staleReason,
    challengeable: !estimateStale && status === "open" && marketAcceptsChallenges,
    observationAgeMs,
    clockSkewMs,
    source,
  };
}
