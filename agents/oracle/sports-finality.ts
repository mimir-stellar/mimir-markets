/**
 * Sports finality detection for the oracle.
 *
 * Pure and deterministic: `now` (epoch seconds) is injected so grace-window
 * boundaries are testable without touching the clock. Evidence text is read
 * with small, explicit heuristics — no LLM, no network — so the oracle's
 * "is the match over?" decision is pinned by tests rather than a model's mood.
 *
 * Sports betting closes at kickoff, so a claim can expire while the match is
 * still live. Settle only once the evidence shows a final result, unless we're
 * past `SPORTS_SETTLE_GRACE_SECS` past the deadline, at which point a data
 * outage must not lock funds forever.
 *
 * Evidence acquisition failures are reported as bounded codes so decision
 * journals can record why evidence was unusable. Dependency failures never
 * produce a settled verdict: they defer (skip-and-retry) unless the grace
 * window has elapsed.
 *
 * Settlement intents: before a settlement transaction is signed, the oracle
 * persists a durable intent binding the canonical verdict and evidence digest
 * to an attempt. On restart, an uncertain (unacknowledged) submission must be
 * reconciled against that intent before any new settlement action is produced,
 * so a crash between signing and recording can never produce a duplicate or
 * contradictory verdict.
 */

import { createHash } from "node:crypto"

export const SPORTS_SETTLE_GRACE_HOURS_DEFAULT = 12

/** Grace window in seconds, honoring SPORTS_SETTLE_GRACE_HOURS (default 12h). */
export const SPORTS_SETTLE_GRACE_SECS =
  Math.max(1, Number(process.env.SPORTS_SETTLE_GRACE_HOURS ?? SPORTS_SETTLE_GRACE_HOURS_DEFAULT)) * 3600

/** Bounded evidence failure classes recorded in decision journals. */
export type EvidenceFailureClass = 'unavailable' | 'stale' | 'malformed' | 'unsupported'

export const EVIDENCE_FAILURE_CLASSES: readonly EvidenceFailureClass[] = [
  'unavailable',
  'stale',
  'malformed',
  'unsupported',
]

/** Claim fields the check needs. */
export interface SportsClaim {
  /** Settlement deadline, epoch seconds. */
  deadline: number
}

/** Structured evidence snapshot as fetched by the oracle. */
export interface SportsEvidence {
  /** Raw evidence text, if the fetch succeeded. */
  text?: string
  /** Epoch seconds at which the evidence was produced, if known. */
  observedAt?: number
  /** Evidence sport/feed identifier, if known. */
  feed?: string
  /** Set when acquisition itself failed (transport error, timeout, etc.). */
  fetchError?: boolean
}

export interface FinalityDecision {
  final: boolean
  /** Present whenever evidence was unusable; absent when evidence was read. */
  failureClass?: EvidenceFailureClass
  /** Short, bounded reason suitable for journals. */
  reason: string
}

/** Maximum age (seconds) of evidence before it is considered stale. */
export const SPORTS_EVIDENCE_MAX_AGE_SECS = 6 * 3600

/**
 * True when the oracle should treat the sports event as final and settle.
 *
 *   - past the grace window → true (never lock funds on an outage)
 *   - evidence shows a concluded match → true
 *   - evidence shows live / upcoming / postponed → false (defer)
 *   - anything unrecognised → false (defer; the safe default)
 */
export function isSportsEventFinal(claim: SportsClaim, evidenceText: string, now: number): boolean {
  const pastGrace = now > claim.deadline + SPORTS_SETTLE_GRACE_SECS
  if (pastGrace) return true
  return eventLooksFinal(evidenceText)
}

/**
 * Evaluate finality from structured evidence, classifying acquisition failures.
 * Dependency failures defer rather than settle, except past the grace window.
 */
export function evaluateSportsFinality(
  claim: SportsClaim,
  evidence: SportsEvidence,
  now: number,
): FinalityDecision {
  const pastGrace = now > claim.deadline + SPORTS_SETTLE_GRACE_SECS

  if (evidence.fetchError) {
    return {
      final: pastGrace,
      failureClass: 'unavailable',
      reason: pastGrace ? 'unavailable-past-grace' : 'unavailable-defer',
    }
  }
  if (evidence.text === undefined || evidence.text === null) {
    return {
      final: pastGrace,
      failureClass: 'malformed',
      reason: pastGrace ? 'malformed-past-grace' : 'malformed-defer',
    }
  }
  if (evidence.observedAt !== undefined && now - evidence.observedAt > SPORTS_EVIDENCE_MAX_AGE_SECS) {
    return {
      final: pastGrace,
      failureClass: 'stale',
      reason: pastGrace ? 'stale-past-grace' : 'stale-defer',
    }
  }
  if (evidence.feed !== undefined && !SUPPORTED_FEEDS.has(evidence.feed)) {
    return {
      final: pastGrace,
      failureClass: 'unsupported',
      reason: pastGrace ? 'unsupported-past-grace' : 'unsupported-defer',
    }
  }

  const final = isSportsEventFinal(claim, evidence.text, now)
  return { final, reason: final ? 'evidence-final' : 'evidence-not-final' }
}

/** Feeds whose text format the heuristics understand. */
const SUPPORTED_FEEDS: ReadonlySet<string> = new Set(['scores', 'sports-results'])

const NOT_FINAL_MARKERS = /\bpostponed\b|\bdelayed\b|\bsuspended\b|\bupcoming\b|\bscheduled\b|\btbd\b/i
const FINAL_MARKERS = /\bfinal\s*score\b|\bfinal\b|full.?time|\bft\b/i
const LIVE_MARKERS = /\blive\b|\bin progress\b|\bquarter\b|\bhalftime\b|half.?time|\bminute\b/i

/** Heuristic read of the evidence text: is the event conclusively over? */
function eventLooksFinal(text: string): boolean {
  if (text.trim().length === 0) return false
  if (NOT_FINAL_MARKERS.test(text)) return false
  if (FINAL_MARKERS.test(text)) return true
  if (LIVE_MARKERS.test(text)) return false
  return false
}

// ---------------------------------------------------------------------------
// Settlement intents
// ---------------------------------------------------------------------------

/** Lifecycle of a persisted settlement intent. */
export type IntentStatus = "pending" | "submitted" | "confirmed" | "failed"

/** A durable record binding a canonical verdict and evidence digest to an attempt. */
export interface SettlementIntent {
  /** Stable identifier: digest of (claimId, verdict, evidenceDigest). */
  intentId: string
  claimId: string
  verdict: "yes" | "no" | "void"
  evidenceDigest: string
  /** Monotonic attempt counter for this intent. */
  attempt: number
  status: IntentStatus
  /** Transaction hash once a submission was made (may be known before confirmation). */
  txHash?: string
  createdAt: number
  updatedAt: number
}

/** Persistence boundary. Implementations must make `save` durable before returning. */
export interface IntentStore {
  get(intentId: string): Promise<SettlementIntent | undefined>
  save(intent: SettlementIntent): Promise<void>
  listUncertain(claimId: string): Promise<SettlementIntent[]>
}

/**
 * Reconciliation boundary: asks the chain (source of truth) whether a
 * submitted transaction landed. Returns "confirmed", "absent" (never landed
 * and safe to retry), or "unknown" (cannot decide; must not resubmit).
 */
export interface ChainReconciler {
  reconcile(intent: SettlementIntent): Promise<"confirmed" | "absent" | "unknown">
}

/** Canonical JSON form of a value for digesting: sorted keys, no whitespace. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`)
  return `{${entries.join(",")}}`
}

/** SHA-256 hex digest of the canonical evidence payload. */
export function digestEvidence(evidence: unknown): string {
  return createHash("sha256").update(canonicalize(evidence)).digest("hex")
}

/** Deterministic intent identifier over the verdict and evidence binding. */
export function deriveIntentId(claimId: string, verdict: string, evidenceDigest: string): string {
  return createHash("sha256")
    .update(canonicalize({ claimId, verdict, evidenceDigest }))
    .digest("hex")
}

/**
 * Prepare a settlement action. Reconciles any uncertain prior submissions for
 * the claim first; only when none of them landed (or none exist) does it return
 * a fresh pending intent to sign. If a prior submission is still unknown, it
 * throws rather than risk a duplicate settlement.
 *
 * Returns the intent to sign, or the already-confirmed intent when the verdict
 * has already landed (idempotent no-op).
 */
export async function prepareSettlement(
  store: IntentStore,
  reconciler: ChainReconciler,
  input: { claimId: string; verdict: "yes" | "no" | "void"; evidence: unknown },
  now: number,
): Promise<{ action: "sign" | "already-settled"; intent: SettlementIntent }> {
  for (const uncertain of await store.listUncertain(input.claimId)) {
    const outcome = await reconciler.reconcile(uncertain)
    if (outcome === "unknown") {
      throw new Error(`settlement for claim ${input.claimId} is uncertain (intent ${uncertain.intentId}); refusing to resubmit`)
    }
    if (outcome === "confirmed") {
      await store.save({ ...uncertain, status: "confirmed", updatedAt: now })
    } else {
      await store.save({ ...uncertain, status: "failed", updatedAt: now })
    }
  }

  const evidenceDigest = digestEvidence(input.evidence)
  const intentId = deriveIntentId(input.claimId, input.verdict, evidenceDigest)
  const existing = await store.get(intentId)
  if (existing?.status === "confirmed") {
    return { action: "already-settled", intent: existing }
  }

  const attempt = (existing?.attempt ?? 0) + 1
  const intent: SettlementIntent = {
    intentId,
    claimId: input.claimId,
    verdict: input.verdict,
    evidenceDigest,
    attempt,
    status: "pending",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await store.save(intent)
  return { action: "sign", intent }
}

/** Record that a transaction was submitted for a pending intent (before awaiting its result). */
export async function markSubmitted(
  store: IntentStore,
  intent: SettlementIntent,
  txHash: string,
  now: number,
): Promise<SettlementIntent> {
  const updated: SettlementIntent = { ...intent, status: "submitted", txHash, updatedAt: now }
  await store.save(updated)
  return updated
}

/** Record the terminal outcome of a submitted intent. */
export async function markOutcome(
  store: IntentStore,
  intent: SettlementIntent,
  outcome: "confirmed" | "failed",
  now: number,
): Promise<SettlementIntent> {
  const updated: SettlementIntent = { ...intent, status: outcome, updatedAt: now }
  await store.save(updated)
  return updated
}