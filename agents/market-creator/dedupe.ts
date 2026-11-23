/**
 * Dedupe helpers for market-creator candidates.
 *
 * Two layers, both used by the worker:
 *
 *   1. Within a batch: two drafted candidates are duplicates when they share the
 *      same normalised (question, resolutionUrl, deadline, sourceSnapshot)
 *      signature.
 *   2. Against the chain: a drafted candidate is dropped when an OPEN/ACTIVE claim
 *      in the same category already asks the same question, or already reads the
 *      same resolution source. The chain snapshot is the source of truth, so a
 *      create whose result was lost (timeout after submit) is still caught on the
 *      next run instead of producing a second market.
 *
 * Normalisation ignores case, punctuation, filler words and URL fragments, so
 * cosmetic re-drafts of the same market do not slip through.
 *
 * The source snapshot binds a draft to the exact capture of its source
 * material (source identity plus capture version). Two drafts that read the
 * same question but from materially different snapshots are NOT duplicates:
 * a future-outcome question resolved against a different capture of the same
 * URL can have a different answer, so collapsing them would drop a market
 * that is genuinely distinct.
 *
 * The normalization policy version is included in the signature so that when
 * the normalization rules change, previously-seen keys are not silently reused
 * across policy generations. Bumping NORMALIZATION_POLICY_VERSION invalidates
 * all cached dedupe decisions computed under older policies.
 */

/**
 * Version of the normalization policy used to build candidate signatures.
 * Increment whenever normalizeComparableText / normalizeResolutionUrl /
 * normaliseDeadline change behaviour in a way that could alter signatures.
 *
 * v2: question text drops filler words and accents; resolution URLs keep a
 * sorted query string without utm_ params and drop the fragment.
 */
export const NORMALIZATION_POLICY_VERSION = "v2";

import {
  interpretDeadline,
  parseExplicitDeadline,
  formatUtcOffset,
  type DeadlineInterpretation,
  type DeadlineParseResult,
  type DeadlineRejectionReason,
} from "./drafting.js";

import { StatementRevisionError } from "./drafting.js";

export interface CandidateLike {
  question?: string;
  resolutionUrl?: string;
  /** Deadline timestamp (normalized to canonical UTC ISO-8601 when valid). */
  deadline?: string;
  category?: string;
  /** Identity of the source the draft was read from (e.g. feed or API id). */
  sourceId?: string;
  /** Version/capture marker of the source material at drafting time. */
  sourceVersion?: string;
  /** Capture version as set by `draftClaimCandidates`; same role as sourceVersion. */
  captureVersion?: string;
  // Optional canonical fields that may be present on candidates.
  id?: string;
  title?: string;
  [key: string]: unknown;
}

export function normaliseQuestion(question: string | undefined): string {
  if (!question) return "";
  return question
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(will|does|do|did|the|their|a|an|in|on|at|by|before|after|during)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normaliseUrl(url: string | undefined): string {
  if (!url) return "";
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

export function normaliseDeadline(deadline: string | number | undefined): string {
  if (deadline === undefined || deadline === null || deadline === "") return "";
  try {
    return canonicaliseStatementDeadline(deadline);
  } catch {
    return String(deadline).trim().toLowerCase();
  }
}

export const normalizeComparableText = normaliseQuestion;
export const normalizeResolutionUrl = normaliseUrl;
export const normalizeDeadline = normaliseDeadline;

export interface ExistingClaimSignature {
  id?: number | string;
  category?: string;
  questionKey?: string;
  sourceKey?: string;
  [key: string]: unknown;
}

/**
 * Normalise a statement deadline to canonical ISO-8601 UTC representation (e.g. "2026-11-22T12:00:00.000Z").
 * Accepts ISO-8601 strings, unix timestamps (in seconds or milliseconds), or numeric strings.
 */
export function canonicaliseStatementDeadline(deadline: unknown): string {
  if (deadline === undefined || deadline === null || deadline === "") {
    throw new StatementRevisionError("Missing deadline timestamp", "invalid_deadline", ["deadline"]);
  }

  let ms: number;
  if (typeof deadline === "number") {
    if (!Number.isFinite(deadline) || Number.isNaN(deadline)) {
      throw new StatementRevisionError("Invalid numeric deadline", "invalid_deadline", ["deadline"]);
    }
    // If < 1e11, treat as unix seconds; otherwise milliseconds
    ms = deadline < 1e11 ? Math.floor(deadline * 1000) : Math.floor(deadline);
  } else if (typeof deadline === "string") {
    const trimmed = deadline.trim();
    if (!trimmed) {
      throw new StatementRevisionError("Empty deadline timestamp", "invalid_deadline", ["deadline"]);
    }
    // Check if entire string is numeric (unix seconds or milliseconds)
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      if (!Number.isFinite(num)) {
        throw new StatementRevisionError("Invalid numeric deadline string", "invalid_deadline", ["deadline"]);
      }
      ms = num < 1e11 ? Math.floor(num * 1000) : Math.floor(num);
    } else {
      ms = Date.parse(trimmed);
    }
  } else if (deadline instanceof Date) {
    ms = deadline.getTime();
  } else {
    throw new StatementRevisionError("Unsupported deadline type", "invalid_deadline", ["deadline"]);
  }

  if (!Number.isFinite(ms) || Number.isNaN(ms)) {
    throw new StatementRevisionError(`Invalid deadline timestamp: ${String(deadline)}`, "invalid_deadline", ["deadline"]);
  }

  return new Date(ms).toISOString();
}

function normaliseSnapshot(candidate: CandidateLike): string {
  const source = (candidate.sourceId ?? "").trim().toLowerCase();
  const version = (candidate.sourceVersion ?? candidate.captureVersion ?? "").trim().toLowerCase();
  // Encode absent values distinctly so a missing snapshot never equals a real one.
  return `${source}@${version}`;
}

/**
 * Validate and canonicalise a resolution source URL.
 * Requires http or https protocol and returns normalized URL href (without trailing slash on pathname).
 * Returns null if URL is malformed, empty, or not http(s).
 */
export function canonicaliseResolutionSourceUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    const origin = parsed.origin.toLowerCase();
    let pathname = parsed.pathname.replace(/\/+$/, "");
    if (pathname === "" && !parsed.search && !parsed.hash) {
      pathname = "";
    }
    const search = parsed.search;
    return `${origin}${pathname}${search}`;
  } catch {
    return null;
  }
}

/**
 * Check whether a string contains invalid UTF-16 text encoding (such as unpaired surrogates).
 */
export function hasInvalidTextEncoding(text: string): boolean {
  try {
    encodeURIComponent(text);
    return false;
  } catch {
    return true;
  }
}

/**
 * Build a stable signature for a candidate. Used to detect duplicates
 * across the same run and against a caller-supplied `seen` set.
 *
 * The signature is prefixed with the normalization policy version so that
 * keys produced under different policies never compare equal.
 */
export function buildCandidateSignature(
  candidate: CandidateLike,
  policyVersion: string = NORMALIZATION_POLICY_VERSION,
): string {
  const question = normalizeComparableText(candidate.question ?? candidate.title);
  const url = normalizeResolutionUrl(candidate.resolutionUrl);
  const deadline = normaliseDeadline(candidate.deadline);
  const snapshot = normaliseSnapshot(candidate);
  return `${policyVersion}|${question}|${url}|${deadline}|${snapshot}`;
}

/** Signature of an existing on-chain claim, for `filterDuplicateCandidates`. */
export function buildExistingClaimSignature(claim: {
  id: number;
  category?: string;
  question?: string;
  resolution_url?: string;
}): ExistingClaimSignature {
  return {
    id: claim.id,
    category: normaliseCategory(claim.category),
    questionKey: normalizeComparableText(claim.question),
    resolutionUrlKey: normalizeResolutionUrl(claim.resolution_url),
  };
}

/**
 * Filter duplicate candidates while preserving input order.
 *
 * When a candidate specifies a `deadline`, it must have an explicit time-zone
 * interpretation; candidates with ambiguous local-only or malformed deadlines
 * are rejected. Kept candidates have their `deadline` normalized to a canonical
 * UTC timestamp with `sourceZone` and `deadlineInterpretation` retained as metadata.
 *
 * The first occurrence of a signature wins; subsequent ones are dropped.
 * An optional `seen` set can be passed in to also dedupe against candidates
 * that already exist on-chain or in a previous batch. Keys recorded under a
 * different normalization policy version will not match and are therefore
 * treated as incompatible rather than reused.
 */
export function filterDuplicateCandidates<T extends CandidateLike>(
  candidates: readonly T[],
  existing: Set<string> | readonly ExistingClaimSignature[] = new Set(),
  policyVersion: string = NORMALIZATION_POLICY_VERSION,
): T[] {
  if (existing instanceof Set) {
    const out: T[] = [];
    for (const candidate of candidates) {
      const sig = buildCandidateSignature(candidate, policyVersion);
      if (existing.has(sig)) continue;
      existing.add(sig);
      out.push(candidate);
    }
    return out;
  }

  const existingQuestionKeys = new Map<string, number>();
  const existingSourceKeys = new Map<string, number>();
  for (const claim of existing) {
    if (claim.questionKey) existingQuestionKeys.set(`${claim.category}:${claim.questionKey}`, claim.id);
    if (claim.resolutionUrlKey) existingSourceKeys.set(`${claim.category}:${claim.resolutionUrlKey}`, claim.id);
  }

  const seenQuestionKeys = new Set<string>();
  const seenSourceKeys = new Set<string>();
  const out: T[] = [];

  for (const candidate of candidates) {
    const category = normaliseCategory(candidate.category);
    const snapshot = normaliseSnapshot(candidate);
    const questionKey = normalizeComparableText(candidate.question ?? candidate.title);
    const sourceKey = normalizeResolutionUrl(candidate.resolutionUrl);

    if (sourceKey && existingSourceKeys.has(`${category}:${sourceKey}`)) continue;
    if (questionKey && existingQuestionKeys.has(`${category}:${questionKey}`)) continue;

    const q = `${category}:${snapshot}:${questionKey}`;
    const s = `${category}:${snapshot}:${sourceKey}`;
    if ((sourceKey && seenSourceKeys.has(s)) || (questionKey && seenQuestionKeys.has(q))) continue;

    if (sourceKey) seenSourceKeys.add(s);
    if (questionKey) seenQuestionKeys.add(q);
    out.push(candidate);
  }
  return out;
}

/**
 * Drop cached dedupe keys that were produced under a different normalization
 * policy version. Keys are expected to carry their version as the prefix
 * before the first '|'. Returns the number of keys removed.
 */
export function invalidateIncompatibleKeys(
  seen: Set<string>,
  policyVersion: string = NORMALIZATION_POLICY_VERSION,
): number {
  let removed = 0;
  for (const key of [...seen]) {
    const sep = key.indexOf("|");
    const keyVersion = sep < 0 ? "" : key.slice(0, sep);
    if (keyVersion !== policyVersion) {
      seen.delete(key);
      removed++;
    }
  }
  return removed;
}
