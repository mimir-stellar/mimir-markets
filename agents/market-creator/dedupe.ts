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

/** Comparable identity of a claim that already exists on-chain. */
export interface ExistingClaimSignature {
  id: number;
  category: string;
  questionKey: string;
  resolutionUrlKey: string;
}

/** Comparable question text: lowercase, accent-free, no punctuation or filler words. */
export function normalizeComparableText(value: string | undefined | null): string {
  if (!value) return "";
  return String(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(will|does|do|did|the|their|a|an|in|on|at|by|before|after|during)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Comparable resolution source. Drops the fragment and tracking params and sorts
 * the query, but keeps the query itself: sources such as Open-Meteo identify the
 * city only by its query string, so stripping it would merge different markets.
 */
export function normalizeResolutionUrl(value: string | undefined | null): string {
  if (!value) return "";
  const raw = String(value).trim();
  try {
    const url = new URL(raw);
    url.hash = "";
    const params = [...url.searchParams.entries()]
      .filter(([key]) => !key.toLowerCase().startsWith("utm_"))
      .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
    url.search = "";
    for (const [key, val] of params) url.searchParams.append(key, val);
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${path}${url.search}`.toLowerCase();
  } catch {
    return raw.replace(/\/+$/, "").toLowerCase();
  }
}

function normaliseCategory(category: unknown): string {
  return String(category ?? "").toLowerCase().trim();
}

function extractExplicitZoneFromCandidate(
  candidate: CandidateLike,
): { ok: true; zone?: string; fromSourceZoneOnly: boolean } | { ok: false } {
  const inputKeys = ["timeZone", "timezone", "deadlineTimeZone", "deadlineTimezone"] as const;
  let selectedInput: string | undefined;

  for (const key of inputKeys) {
    const val = candidate[key];
    if (val === undefined || val === null) continue;
    if (typeof val !== "string") return { ok: false };
    const trimmed = val.trim();
    if (!trimmed) return { ok: false };
    if (selectedInput !== undefined && selectedInput.toLowerCase() !== trimmed.toLowerCase()) {
      return { ok: false };
    }
    selectedInput = trimmed;
  }

  if (candidate.sourceZone !== undefined && candidate.sourceZone !== null) {
    if (typeof candidate.sourceZone !== "string") return { ok: false };
    const trimmedSource = candidate.sourceZone.trim();
    if (!trimmedSource) return { ok: false };
    if (selectedInput !== undefined && selectedInput.toLowerCase() !== trimmedSource.toLowerCase()) {
      return { ok: false };
    }
    if (selectedInput === undefined) {
      return { ok: true, zone: trimmedSource, fromSourceZoneOnly: true };
    }
  }

  return { ok: true, zone: selectedInput, fromSourceZoneOnly: false };
}

/**
 * Resolve and validate the deadline on a candidate object, returning the
 * canonical UTC timestamp and retained source time-zone metadata, or `null`
 * if the deadline is missing, malformed, or an ambiguous local-only timestamp.
 */
export function resolveCandidateDeadline(candidate: CandidateLike): DeadlineInterpretation | null {
  if (typeof candidate.deadline !== "string") return null;
  const rawDeadline = candidate.deadline.trim();
  if (!rawDeadline) return null;

  const zoneField = extractExplicitZoneFromCandidate(candidate);
  if (!zoneField.ok) return null;

  // If the candidate already carries a validated deadlineInterpretation matching its canonical UTC deadline,
  // verify it and preserve its original rawDeadline and sourceZone metadata.
  if (
    candidate.deadlineInterpretation &&
    typeof candidate.deadlineInterpretation === "object" &&
    candidate.deadlineInterpretation.canonicalUtc === rawDeadline &&
    typeof candidate.deadlineInterpretation.rawDeadline === "string" &&
    typeof candidate.deadlineInterpretation.sourceZone === "string"
  ) {
    const verified = interpretDeadline(
      candidate.deadlineInterpretation.rawDeadline,
      candidate.deadlineInterpretation.sourceZone,
    );
    if (verified && verified.canonicalUtc === rawDeadline) {
      if (
        zoneField.zone === undefined ||
        zoneField.zone.toLowerCase() === verified.sourceZone.toLowerCase()
      ) {
        return verified;
      }
    }
  }

  const direct = interpretDeadline(rawDeadline, zoneField.zone);
  if (direct) return direct;

  // Handle already-normalized candidates where `deadline` is a canonical UTC `Z` string
  // and `sourceZone` records the original non-UTC source zone as metadata.
  if (zoneField.fromSourceZoneOnly && zoneField.zone && /[Zz]$/.test(rawDeadline)) {
    const utcParsed = interpretDeadline(rawDeadline);
    if (!utcParsed) return null;
    // Validate that `sourceZone` itself is a legitimate explicit zone by probing a sample wall-clock date.
    const zoneProbe = interpretDeadline("2026-01-15T12:00:00", zoneField.zone);
    if (!zoneProbe) return null;
    return {
      canonicalUtc: utcParsed.canonicalUtc,
      sourceZone: zoneProbe.sourceZone,
      offsetMinutes: zoneProbe.offsetMinutes,
      utcOffset: zoneProbe.utcOffset,
      rawDeadline: candidate.deadlineInterpretation?.rawDeadline ?? rawDeadline,
    };
  }

  return null;
}

/**
 * Normalize a deadline string to its canonical UTC ISO-8601 timestamp.
 *
 * Requires an explicit time-zone designator in `deadline` (e.g. `Z` or `±HH:MM`)
 * or an explicit `explicitZone` argument (IANA zone or UTC offset).
 * Returns `""` when `deadline` is empty, malformed, or an ambiguous local-only value.
 */
export function normaliseDeadline(
  deadline: string | undefined,
  explicitZone?: string,
): string {
  if (!deadline) return "";
  const interpreted = interpretDeadline(deadline, explicitZone);
  if (!interpreted) return "";
  return interpreted.canonicalUtc;
}

function normaliseSnapshot(candidate: CandidateLike): string {
  const source = (candidate.sourceId ?? "").trim().toLowerCase();
  const version = (candidate.sourceVersion ?? candidate.captureVersion ?? "").trim().toLowerCase();
  // Encode absent values distinctly so a missing snapshot never equals a real one.
  return `${source}@${version}`;
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
