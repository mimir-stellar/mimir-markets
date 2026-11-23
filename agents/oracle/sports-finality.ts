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

/** Maximum number of evidence items retained in a manifest. */
export const SPORTS_EVIDENCE_MANIFEST_MAX_ITEMS = 20

/** Maximum length of a retained source reference string. */
export const SPORTS_EVIDENCE_SOURCE_REF_MAX_LEN = 256

/** Grace window in seconds, honoring SPORTS_SETTLE_GRACE_HOURS (default 12h). */
export const SPORTS_SETTLE_GRACE_SECS =
  Math.max(1, Number(process.env.SPORTS_SETTLE_GRACE_HOURS ?? SPORTS_SETTLE_GRACE_HOURS_DEFAULT)) * 3600;

/**
 * Bounded oracle retry budget per unresolved claim. Evidence acquisition
 * retries are counted separately from transaction reconciliation so a flaky
 * evidence source cannot exhaust the settlement retry budget (and vice versa).
 */
export const ORACLE_EVIDENCE_RETRY_BUDGET_DEFAULT = 3
export const ORACLE_SETTLEMENT_RETRY_BUDGET_DEFAULT = 3

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
  id?: number;
  /** Settlement deadline, epoch seconds. */
  deadline: number;
}

export type SportsFinalityReason =
  | "grace_window_expired"
  | "concluded"
  | "in_progress"
  | "postponed_or_upcoming"
  | "empty_evidence"
  | "unrecognized";

export interface SportsFinalityOptions {
  /**
   * Reviewed evidence timestamp (epoch ms or epoch seconds).
   * Binds the evaluated policy version to the evidence snapshot.
   */
  evidenceTimestamp?: number;
  /**
   * Configured grace window in hours. Defaults to SPORTS_SETTLE_GRACE_HOURS env or 12.
   */
  graceHours?: number;
  /**
   * Policy identity. Defaults to SPORTS_FINALITY_POLICY_ID ("sports-finality").
   */
  policyId?: string;
  /**
   * Base policy version. Defaults to SPORTS_FINALITY_BASE_VERSION ("v1").
   */
  baseVersion?: string;
}

export interface SportsFinalityPolicyVersionOptions {
  policyId?: string;
  baseVersion?: string;
  graceHours?: number;
  evidenceTimestamp: number;
}

/**
 * Format the applied sports finality policy version, binding it to the
 * reviewed evidence timestamp while keeping the policy identity visible across
 * configuration changes.
 */
export function formatSportsFinalityPolicyVersion(options: SportsFinalityPolicyVersionOptions): string {
  const policyId = options.policyId ?? SPORTS_FINALITY_POLICY_ID;
  const baseVersion = options.baseVersion ?? SPORTS_FINALITY_BASE_VERSION;
  const graceHours = options.graceHours ?? getSportsSettleGraceHours();
  const ts = options.evidenceTimestamp;

  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) {
    throw new Error(`Invalid evidence timestamp: must be a positive finite number, received ${ts}`);
  }

  const configTag = graceHours !== SPORTS_SETTLE_GRACE_HOURS_DEFAULT ? `:g${graceHours}h` : "";
  return `${policyId}:${baseVersion}${configTag}@${ts}`;
}

export interface ParsedSportsFinalityPolicyVersion {
  policyId: string;
  baseVersion: string;
  graceHours?: number;
  evidenceTimestamp: number;
}

export function parseSportsFinalityPolicyVersion(versionStr: string): ParsedSportsFinalityPolicyVersion {
  if (typeof versionStr !== "string" || !versionStr.includes("@")) {
    throw new Error(`Invalid sports finality policy version string: ${versionStr}`);
  }
  const [prefix, tsStr] = versionStr.split("@");
  const evidenceTimestamp = Number(tsStr);
  if (!Number.isFinite(evidenceTimestamp) || evidenceTimestamp <= 0) {
    throw new Error(`Invalid evidence timestamp in policy version: ${tsStr}`);
  }

  const parts = prefix.split(":");
  if (parts.length < 2) {
    throw new Error(`Invalid policy version format: missing base version in ${versionStr}`);
  }

  const policyId = parts[0];
  const baseVersion = parts[1];
  let graceHours: number | undefined;

  if (parts.length > 2) {
    const configPart = parts[2];
    const match = configPart.match(/^g(\d+)h$/);
    if (match) {
      graceHours = Number(match[1]);
    }
  }

  return { policyId, baseVersion, graceHours, evidenceTimestamp };
}

export interface SportsFinalityDecision {
  /** True when the oracle should treat the sports event as final and settle. */
  final: boolean;
  /** Heuristic or grace reasoning behind the decision. */
  reason: SportsFinalityReason;
  /** Identity of the applied policy (e.g. "sports-finality"). */
  policyId: string;
  /** Applied policy version bound to the reviewed evidence timestamp and configuration. */
  policyVersion: string;
  /** Reviewed evidence timestamp (epoch ms or epoch seconds). */
  evidenceTimestamp: number;
  /** Applied grace window in seconds. */
  graceSecs: number;
  /** Timestamp when the evaluation was computed. */
  evaluatedAt: number;
  /** Optional claim id for correlation. */
  claimId?: number;
}

const MAX_RECORDED_DECISIONS = 200;
const recordedDecisions: SportsFinalityDecision[] = [];

export function recordSportsFinalityDecision(decision: SportsFinalityDecision): SportsFinalityDecision {
  if (recordedDecisions.length >= MAX_RECORDED_DECISIONS) {
    recordedDecisions.shift();
  }
  recordedDecisions.push(decision);
  return decision;
}

export function getRecordedSportsFinalityDecisions(): readonly SportsFinalityDecision[] {
  return [...recordedDecisions];
}

export function clearRecordedSportsFinalityDecisions(): void {
  recordedDecisions.length = 0;
}

const NOT_FINAL_MARKERS = /\bpostponed\b|\bdelayed\b|\bsuspended\b|\bupcoming\b|\bscheduled\b|\btbd\b/i;
const FINAL_MARKERS = /\bfinal\s*score\b|\bfinal\b|full.?time|\bft\b/i;
const LIVE_MARKERS = /\blive\b|\bin progress\b|\bquarter\b|\bhalftime\b|half.?time|\bminute\b/i;

function evaluateEvidenceText(text: string): { final: boolean; reason: SportsFinalityReason } {
  if (text.trim().length === 0) {
    return { final: false, reason: "empty_evidence" };
  }
  if (NOT_FINAL_MARKERS.test(text)) {
    return { final: false, reason: "postponed_or_upcoming" };
  }
  if (FINAL_MARKERS.test(text)) {
    return { final: true, reason: "concluded" };
  }
  if (LIVE_MARKERS.test(text)) {
    return { final: false, reason: "in_progress" };
  }
  return { final: false, reason: "unrecognized" };
}

/**
 * Evaluate sports finality and record the applied policy version with the decision.
 *
 * Pure and deterministic:
 * - `now` is epoch seconds.
 * - Options allow binding an explicit reviewed evidence timestamp.
 * - Policy identity remains visible even if grace configuration changes.
 */
export function evaluateSportsFinality(
  claim: SportsClaim,
  evidenceText: string,
  now: number,
  options?: SportsFinalityOptions,
): SportsFinalityDecision {
  const policyId = options?.policyId ?? SPORTS_FINALITY_POLICY_ID;
  const baseVersion = options?.baseVersion ?? SPORTS_FINALITY_BASE_VERSION;
  const graceHours = options?.graceHours ?? getSportsSettleGraceHours();
  const graceSecs = graceHours * 3600;

  const rawTimestamp = options?.evidenceTimestamp ?? (now > 0 ? now * 1000 : Date.now());
  if (typeof rawTimestamp !== "number" || !Number.isFinite(rawTimestamp) || rawTimestamp <= 0) {
    throw new Error(
      `Invalid evidence timestamp: must be a positive finite number, received ${options?.evidenceTimestamp}`,
    );
  }
  const evidenceTimestamp = rawTimestamp;

  const policyVersion = formatSportsFinalityPolicyVersion({
    policyId,
    baseVersion,
    graceHours,
    evidenceTimestamp,
  });

  const pastGrace = now > claim.deadline + graceSecs;
  let final: boolean;
  let reason: SportsFinalityReason;

  if (pastGrace) {
    final = true;
    reason = "grace_window_expired";
  } else {
    const textEval = evaluateEvidenceText(evidenceText);
    final = textEval.final;
    reason = textEval.reason;
  }

  const decision: SportsFinalityDecision = {
    final,
    reason,
    policyId,
    policyVersion,
    evidenceTimestamp,
    graceSecs,
    evaluatedAt: now > 0 ? now : Math.floor(Date.now() / 1000),
    claimId: claim.id,
  };

  recordSportsFinalityDecision(decision);
  return decision;
}

/**
 * Snapshot of the claim state a verdict was reviewed against (#814).
 *
 * A revision is the tuple of fields that change when a claim is edited in a way
 * that invalidates a previously-reviewed decision:
 *   - `state`       — "open" / "active" / "resolved" / "cancelled"
 *   - `deadline`    — moved when a claim is extended or shortened
 *   - `resolvedAt`  — nonzero once the claim has been resolved on chain
 *
 * These are the fields `submitSettlementWithRetry` already re-reads before
 * signing; this interface lets the sports-finality path carry them through
 * unchanged, so a domain rule cannot produce a verdict that bypasses the
 * revision check that runs immediately before the signer.
 */
export interface ReviewedClaimRevision {
  state: string
  deadline: number
  resolvedAt: number
}

/** True when `current` differs from `reviewed` in any revision-bearing field. */
export function revisionChanged(
  reviewed: ReviewedClaimRevision | undefined,
  current: ReviewedClaimRevision,
): boolean {
  if (reviewed === undefined) return false
  if (reviewed.state !== current.state) return true
  if (reviewed.deadline !== current.deadline) return true
  if (reviewed.resolvedAt !== current.resolvedAt) return true
  return false
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

/**
 * Classify evidence text into a coarse finality state for operator reporting.
 * Mirrors `eventLooksFinal` so the report and the settle decision never disagree.
 */
export type EvidenceFinalityState = 'final' | 'not_final' | 'unknown'

export function classifyEvidenceFinality(text: string): EvidenceFinalityState {
  if (text.trim().length === 0) return 'unknown'
  if (NOT_FINAL_MARKERS.test(text)) return 'not_final'
  if (FINAL_MARKERS.test(text)) return 'final'
  if (LIVE_MARKERS.test(text)) return 'not_final'
  return 'unknown'
}

/** Heuristic read of the evidence text: is the event conclusively over? */
function eventLooksFinal(text: string): boolean {
  return classifyEvidenceFinality(text) === 'final'
}

/** Why a claim is still unresolved after exhausting its retry budget. */
export type RetryBudgetExhaustedReason = "evidence" | "settlement"

/** Per-claim retry counters, kept separate for evidence vs. settlement. */
export interface ClaimRetryBudget {
  claimId: string
  evidenceAttempts: number
  settlementAttempts: number
  evidenceBudget: number
  settlementBudget: number
}

/** Outcome of consuming one retry from a claim's budget. */
export type RetryBudgetDecision =
  | { allowed: true; budget: ClaimRetryBudget }
  | { allowed: false; reason: RetryBudgetExhaustedReason; budget: ClaimRetryBudget }

/** Create a fresh retry budget for a claim, honoring optional overrides. */
export function createClaimRetryBudget(
  claimId: string,
  opts: { evidenceBudget?: number; settlementBudget?: number } = {},
): ClaimRetryBudget {
  return {
    claimId,
    evidenceAttempts: 0,
    settlementAttempts: 0,
    evidenceBudget: Math.max(0, opts.evidenceBudget ?? ORACLE_EVIDENCE_RETRY_BUDGET_DEFAULT),
    settlementBudget: Math.max(0, opts.settlementBudget ?? ORACLE_SETTLEMENT_RETRY_BUDGET_DEFAULT),
  }
}

/**
 * Consume one retry from the given budget. Evidence acquisition and
 * transaction reconciliation draw from independent counters, so a claim that
 * keeps failing to fetch evidence does not block settlement retries and a
 * claim stuck in reconciliation does not block evidence retries.
 */
export function consumeRetry(
  budget: ClaimRetryBudget,
  kind: RetryBudgetExhaustedReason,
): RetryBudgetDecision {
  if (kind === "evidence") {
    if (budget.evidenceAttempts >= budget.evidenceBudget) {
      return { allowed: false, reason: "evidence", budget }
    }
    return { allowed: true, budget: { ...budget, evidenceAttempts: budget.evidenceAttempts + 1 } }
  }
  if (budget.settlementAttempts >= budget.settlementBudget) {
    return { allowed: false, reason: "settlement", budget }
  }
  return { allowed: true, budget: { ...budget, settlementAttempts: budget.settlementAttempts + 1 } }
}

/**
 * True when the claim has exhausted either budget and should be skipped for
 * the remainder of the worker cycle, so one failing claim cannot monopolize it.
 */
export function isRetryBudgetExhausted(budget: ClaimRetryBudget): boolean {
  return (
    budget.evidenceAttempts >= budget.evidenceBudget &&
    budget.settlementAttempts >= budget.settlementBudget
  )
}

/** One raw evidence item as fetched by a source adapter. */
export interface SportsEvidenceInput {
  /** Source identifier or URL; may carry credentials and is sanitised. */
  sourceRef: string
  /** Capture time, epoch seconds. */
  capturedAt: number
  /** Raw response body. Never retained in the manifest. */
  body: string
}

/** A single bounded, auditable manifest entry. */
export interface SportsEvidenceManifestItem {
  sourceRef: string
  capturedAt: number
  /** Hex SHA-256 of the raw body; the body itself is not stored. */
  digest: string
}

/** Bounded evidence manifest for a finality decision. */
export interface SportsEvidenceManifest {
  items: SportsEvidenceManifestItem[]
  /** Count of evidence inputs dropped due to the item cap. */
  truncated: number
}

/**
 * Strip userinfo (user:pass@) and query-string secrets from a source reference,
 * then clamp it to the maximum retained length.
 */
export function sanitizeSourceRef(ref: string): string {
  let out = ref.trim()
  out = out.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@\s]+@/, '$1')
  out = out.replace(/([?&])(api[_-]?key|token|secret|password|access[_-]?token|auth)=[^&\s]*/gi, '$1$2=REDACTED')
  if (out.length > SPORTS_EVIDENCE_SOURCE_REF_MAX_LEN) {
    out = out.slice(0, SPORTS_EVIDENCE_SOURCE_REF_MAX_LEN)
  }
  return out
}

/**
 * Build a bounded evidence manifest. Records source reference, capture time and
 * a content digest per item; never includes raw bodies or credentials. Items
 * beyond `SPORTS_EVIDENCE_MANIFEST_MAX_ITEMS` are counted in `truncated`.
 */
export function buildSportsEvidenceManifest(inputs: SportsEvidenceInput[]): SportsEvidenceManifest {
  const kept = inputs.slice(0, SPORTS_EVIDENCE_MANIFEST_MAX_ITEMS)
  const items: SportsEvidenceManifestItem[] = kept.map((e) => ({
    sourceRef: sanitizeSourceRef(e.sourceRef),
    capturedAt: e.capturedAt,
    digest: createHash('sha256').update(e.body, 'utf8').digest('hex'),
  }))
  return { items, truncated: Math.max(0, inputs.length - kept.length) }
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