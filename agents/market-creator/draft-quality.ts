/**
 * Market draft quality explanation report.
 *
 * The drafting and dedupe layers silently drop or keep candidates. This module
 * explains *why* a drafted candidate is (or is not) fit to become a market,
 * one check at a time, without changing what the worker creates:
 *
 *   objective_wording  the question can be settled by reading one number/date
 *   source             the resolution URL is a usable, single evidence source
 *   deadline           the deadline parses and sits inside the creation window
 *
 * Every check reports a status and a bounded list of machine-readable reasons.
 * Reasons are drawn from a closed set of codes, each check carries at most
 * MAX_REASONS_PER_CHECK reasons, and every message is capped at
 * MAX_REASON_MESSAGE_LENGTH characters, so a report is safe to log, persist in
 * a read index, or return from an API without leaking unbounded model output.
 *
 * A draft that is wrong (subjective wording, a malformed URL, a past deadline)
 * is `invalid`: retrying later will not fix it. A draft that only failed
 * because its evidence could not be fetched right now is
 * `evidence_unavailable`: it is well formed and may pass on a later run.
 *
 * The module is pure: evidence availability is passed in by the caller (for
 * example from a probe of the resolution URL), so no network I/O happens here.
 */

import type { ClaimCandidate } from "./drafting.js";
import { buildCandidateSignature } from "./dedupe.js";
import { cryptoThresholdReason } from "./thresholds.js";

export const DRAFT_QUALITY_REPORT_VERSION = "draft-quality-v1";

/** Maximum reasons reported per check. Extra reasons are counted, not listed. */
export const MAX_REASONS_PER_CHECK = 4;
/** Maximum characters in a single reason message. */
export const MAX_REASON_MESSAGE_LENGTH = 160;

export const MIN_QUESTION_LENGTH = 12;
export const MAX_QUESTION_LENGTH = 200;
/** A deadline closer than this to "now" cannot attract stakes before it passes. */
export const DEFAULT_MIN_DEADLINE_LEAD_MS = 60 * 60 * 1000;
/** A deadline further out than this is not a near-term market. */
export const DEFAULT_MAX_DEADLINE_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;

export type DraftQualityCheckId = "objective_wording" | "source" | "deadline";
export type DraftQualityCheckStatus = "pass" | "fail" | "unavailable";
export type DraftQualityVerdict = "accepted" | "invalid" | "evidence_unavailable";

/** Closed set of reason codes. Adding a code is an interface change. */
export type DraftQualityReasonCode =
  // objective_wording
  | "question_missing"
  | "question_too_short"
  | "question_too_long"
  | "question_not_interrogative"
  | "question_compound"
  | "question_subjective_term"
  | "threshold_unsafe"
  // source
  | "source_url_missing"
  | "source_url_malformed"
  | "source_url_insecure"
  | "source_url_has_credentials"
  | "source_url_local_host"
  | "source_snapshot_missing"
  | "source_evidence_unavailable"
  // deadline
  | "deadline_missing"
  | "deadline_unparseable"
  | "deadline_in_past"
  | "deadline_too_soon"
  | "deadline_too_far";

export interface DraftQualityReason {
  code: DraftQualityReasonCode;
  message: string;
}

export interface DraftQualityCheck {
  id: DraftQualityCheckId;
  status: DraftQualityCheckStatus;
  /** At most MAX_REASONS_PER_CHECK entries. */
  reasons: DraftQualityReason[];
  /** Reasons that were found but not listed because of the bound. */
  truncatedReasons: number;
}

export interface DraftQualityReport {
  version: typeof DRAFT_QUALITY_REPORT_VERSION;
  /** Question as drafted, trimmed and capped at MAX_QUESTION_LENGTH. */
  question: string;
  verdict: DraftQualityVerdict;
  /** True only for `evidence_unavailable`: a later run may accept the draft. */
  retryable: boolean;
  /** Always in the order objective_wording, source, deadline. */
  checks: DraftQualityCheck[];
}

/**
 * Evidence availability for the draft's resolution URL, as observed by the
 * caller. `unknown` (the default) means nobody probed it, which is not a
 * failure: the oracle fetches evidence again at settlement.
 */
export type EvidenceAvailability =
  | { state: "available" }
  | { state: "unknown" }
  | { state: "unavailable"; detail?: string };

export interface DraftQualityOptions {
  /** Reference time in epoch ms. Required so reports are deterministic. */
  nowMs: number;
  evidence?: EvidenceAvailability;
  minDeadlineLeadMs?: number;
  maxDeadlineHorizonMs?: number;
  /** Require sourceId/captureVersion on the draft. Off by default. */
  requireSourceSnapshot?: boolean;
}

/**
 * Words whose truth depends on opinion rather than on a number or a date read
 * from one document. Matched as whole words, case-insensitively.
 */
const SUBJECTIVE_TERMS = [
  "best",
  "worst",
  "good",
  "bad",
  "great",
  "better",
  "worse",
  "likely",
  "unlikely",
  "probably",
  "significant",
  "significantly",
  "popular",
  "successful",
  "impressive",
  "huge",
  "soon",
  "should",
] as const;

const SUBJECTIVE_PATTERN = new RegExp(`\\b(${SUBJECTIVE_TERMS.join("|")})\\b`, "gi");

function boundMessage(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_REASON_MESSAGE_LENGTH) return flat;
  return `${flat.slice(0, MAX_REASON_MESSAGE_LENGTH - 1)}…`;
}

function buildCheck(
  id: DraftQualityCheckId,
  reasons: DraftQualityReason[],
  failureStatus: DraftQualityCheckStatus = "fail",
): DraftQualityCheck {
  const listed = reasons.slice(0, MAX_REASONS_PER_CHECK).map((reason) => ({
    code: reason.code,
    message: boundMessage(reason.message),
  }));
  return {
    id,
    status: reasons.length === 0 ? "pass" : failureStatus,
    reasons: listed,
    truncatedReasons: Math.max(0, reasons.length - listed.length),
  };
}

function checkObjectiveWording(candidate: Partial<ClaimCandidate>): DraftQualityCheck {
  const reasons: DraftQualityReason[] = [];
  const question = typeof candidate.question === "string" ? candidate.question.trim() : "";

  if (!question) {
    reasons.push({ code: "question_missing", message: "question is empty" });
    return buildCheck("objective_wording", reasons);
  }
  if (question.length < MIN_QUESTION_LENGTH) {
    reasons.push({
      code: "question_too_short",
      message: `question has ${question.length} characters; minimum is ${MIN_QUESTION_LENGTH}`,
    });
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    reasons.push({
      code: "question_too_long",
      message: `question has ${question.length} characters; maximum is ${MAX_QUESTION_LENGTH}`,
    });
  }
  if (!question.endsWith("?")) {
    reasons.push({ code: "question_not_interrogative", message: "question does not end with '?'" });
  }
  const questionMarks = (question.match(/\?/g) ?? []).length;
  if (questionMarks > 1) {
    reasons.push({
      code: "question_compound",
      message: `question asks ${questionMarks} things; a market settles exactly one`,
    });
  }
  const subjective = [...new Set((question.match(SUBJECTIVE_PATTERN) ?? []).map((t) => t.toLowerCase()))];
  for (const term of subjective) {
    reasons.push({
      code: "question_subjective_term",
      message: `"${term}" depends on opinion, not a value read from the source`,
    });
  }
  if (candidate.threshold !== undefined) {
    const thresholdReason = typeof candidate.threshold === "number"
      ? cryptoThresholdReason(candidate.threshold)
      : "threshold is not a number";
    if (thresholdReason) reasons.push({ code: "threshold_unsafe", message: thresholdReason });
  }
  return buildCheck("objective_wording", reasons);
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host === "::1"
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^0\./.test(host);
}

function checkSource(
  candidate: Partial<ClaimCandidate>,
  options: DraftQualityOptions,
): DraftQualityCheck {
  const reasons: DraftQualityReason[] = [];
  const raw = typeof candidate.resolutionUrl === "string" ? candidate.resolutionUrl.trim() : "";

  if (!raw) {
    reasons.push({ code: "source_url_missing", message: "resolutionUrl is empty" });
    return buildCheck("source", reasons);
  }

  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {
    reasons.push({ code: "source_url_malformed", message: "resolutionUrl is not an absolute URL" });
  }

  if (url) {
    if (url.protocol !== "https:") {
      reasons.push({
        code: "source_url_insecure",
        message: `resolutionUrl uses ${url.protocol.replace(/:$/, "")}; evidence must be fetched over https`,
      });
    }
    if (url.username || url.password) {
      reasons.push({ code: "source_url_has_credentials", message: "resolutionUrl embeds credentials" });
    }
    if (isLocalHost(url.hostname)) {
      reasons.push({
        code: "source_url_local_host",
        message: "resolutionUrl points at a local or private host the oracle cannot read",
      });
    }
  }

  if (options.requireSourceSnapshot && (!candidate.sourceId || !candidate.captureVersion)) {
    reasons.push({
      code: "source_snapshot_missing",
      message: "draft is not bound to a source snapshot (sourceId and captureVersion)",
    });
  }

  if (reasons.length > 0) return buildCheck("source", reasons);

  // The draft itself is well formed; only now does evidence availability matter.
  const evidence = options.evidence ?? { state: "unknown" };
  if (evidence.state === "unavailable") {
    const detail = evidence.detail ? `: ${evidence.detail}` : "";
    return buildCheck(
      "source",
      [{ code: "source_evidence_unavailable", message: `evidence could not be fetched right now${detail}` }],
      "unavailable",
    );
  }
  return buildCheck("source", []);
}

function checkDeadline(
  candidate: Partial<ClaimCandidate>,
  options: DraftQualityOptions,
): DraftQualityCheck {
  const reasons: DraftQualityReason[] = [];
  const raw = typeof candidate.deadline === "string" ? candidate.deadline.trim() : "";
  const minLead = options.minDeadlineLeadMs ?? DEFAULT_MIN_DEADLINE_LEAD_MS;
  const maxHorizon = options.maxDeadlineHorizonMs ?? DEFAULT_MAX_DEADLINE_HORIZON_MS;

  if (!raw) {
    reasons.push({ code: "deadline_missing", message: "deadline is empty" });
    return buildCheck("deadline", reasons);
  }
  const deadlineMs = Date.parse(raw);
  if (!Number.isFinite(deadlineMs)) {
    reasons.push({ code: "deadline_unparseable", message: "deadline is not an ISO 8601 date-time" });
    return buildCheck("deadline", reasons);
  }

  const leadMs = deadlineMs - options.nowMs;
  if (leadMs <= 0) {
    reasons.push({ code: "deadline_in_past", message: `deadline ${new Date(deadlineMs).toISOString()} has passed` });
  } else if (leadMs < minLead) {
    reasons.push({
      code: "deadline_too_soon",
      message: `deadline is ${Math.round(leadMs / 60_000)} min away; minimum lead is ${Math.round(minLead / 60_000)} min`,
    });
  } else if (leadMs > maxHorizon) {
    reasons.push({
      code: "deadline_too_far",
      message: `deadline is ${Math.round(leadMs / 86_400_000)} days away; maximum horizon is ${Math.round(maxHorizon / 86_400_000)} days`,
    });
  }
  return buildCheck("deadline", reasons);
}

function verdictFor(checks: readonly DraftQualityCheck[]): DraftQualityVerdict {
  if (checks.some((check) => check.status === "fail")) return "invalid";
  if (checks.some((check) => check.status === "unavailable")) return "evidence_unavailable";
  return "accepted";
}

/**
 * Explain whether one drafted candidate is fit to become a market.
 * Pure and deterministic for a given candidate and options.
 */
export function explainDraftQuality(
  candidate: Partial<ClaimCandidate>,
  options: DraftQualityOptions,
): DraftQualityReport {
  const checks = [
    checkObjectiveWording(candidate),
    checkSource(candidate, options),
    checkDeadline(candidate, options),
  ];
  const verdict = verdictFor(checks);
  const question = typeof candidate.question === "string"
    ? candidate.question.trim().slice(0, MAX_QUESTION_LENGTH)
    : "";
  return {
    version: DRAFT_QUALITY_REPORT_VERSION,
    question,
    verdict,
    retryable: verdict === "evidence_unavailable",
    checks,
  };
}

export interface DraftBatchQualityEntry extends DraftQualityReport {
  /** Position of the draft in the input batch. */
  index: number;
  /** Index of the earlier draft this one duplicates (same dedupe signature), if any. */
  duplicateOf: number | null;
}

export interface DraftBatchQualityReport {
  version: typeof DRAFT_QUALITY_REPORT_VERSION;
  entries: DraftBatchQualityEntry[];
  summary: {
    total: number;
    accepted: number;
    invalid: number;
    evidenceUnavailable: number;
    duplicates: number;
  };
}

export interface DraftBatchQualityOptions extends DraftQualityOptions {
  /** Evidence availability per resolution URL (exact, trimmed). Overrides `evidence`. */
  evidenceByUrl?: ReadonlyMap<string, EvidenceAvailability>;
}

/**
 * Explain a batch of drafts. Uses the same signature as the dedupe layer to
 * point duplicates at the draft that wins, so the report matches what
 * filterDuplicateCandidates would keep. Duplicates keep their own verdict.
 */
export function explainDraftBatchQuality(
  candidates: readonly Partial<ClaimCandidate>[],
  options: DraftBatchQualityOptions,
): DraftBatchQualityReport {
  const firstIndexBySignature = new Map<string, number>();
  const entries: DraftBatchQualityEntry[] = candidates.map((candidate, index) => {
    const url = typeof candidate.resolutionUrl === "string" ? candidate.resolutionUrl.trim() : "";
    const evidence = options.evidenceByUrl?.get(url) ?? options.evidence;
    const report = explainDraftQuality(candidate, { ...options, evidence });

    const signature = buildCandidateSignature({
      question: candidate.question,
      resolutionUrl: candidate.resolutionUrl,
      deadline: candidate.deadline,
      sourceId: candidate.sourceId,
      sourceVersion: candidate.captureVersion,
    });
    const first = firstIndexBySignature.get(signature);
    if (first === undefined) firstIndexBySignature.set(signature, index);

    return { ...report, index, duplicateOf: first ?? null };
  });

  return {
    version: DRAFT_QUALITY_REPORT_VERSION,
    entries,
    summary: {
      total: entries.length,
      accepted: entries.filter((e) => e.verdict === "accepted").length,
      invalid: entries.filter((e) => e.verdict === "invalid").length,
      evidenceUnavailable: entries.filter((e) => e.verdict === "evidence_unavailable").length,
      duplicates: entries.filter((e) => e.duplicateOf !== null).length,
    },
  };
}
