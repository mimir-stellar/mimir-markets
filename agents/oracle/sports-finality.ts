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
 */

export const SPORTS_FINALITY_POLICY_ID = "sports-finality";
export const SPORTS_FINALITY_BASE_VERSION = "v1";
export const SPORTS_SETTLE_GRACE_HOURS_DEFAULT = 12;

/**
 * Resolve effective grace hours from environment or explicit configuration,
 * enforcing minimum of 1 hour.
 */
export function getSportsSettleGraceHours(envVal?: string | number): number {
  const raw = envVal ?? process.env.SPORTS_SETTLE_GRACE_HOURS ?? SPORTS_SETTLE_GRACE_HOURS_DEFAULT;
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? Math.max(1, Math.floor(num)) : SPORTS_SETTLE_GRACE_HOURS_DEFAULT;
}

/** Grace window in seconds, honoring SPORTS_SETTLE_GRACE_HOURS (default 12h). */
export const SPORTS_SETTLE_GRACE_SECS =
  Math.max(1, Number(process.env.SPORTS_SETTLE_GRACE_HOURS ?? SPORTS_SETTLE_GRACE_HOURS_DEFAULT)) * 3600;

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
 * True when the oracle should treat the sports event as final and settle.
 *
 *   - past the grace window → true (never lock funds on an outage)
 *   - evidence shows a concluded match → true
 *   - evidence shows live / upcoming / postponed → false (defer)
 *   - anything unrecognised → false (defer; the safe default)
 */
export function isSportsEventFinal(
  claim: SportsClaim,
  evidenceText: string,
  now: number,
  options?: SportsFinalityOptions,
): boolean {
  return evaluateSportsFinality(claim, evidenceText, now, options).final;
}
