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

export interface CandidateLike {
  question?: string;
  resolutionUrl?: string;
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

function normaliseDeadline(deadline: string | undefined): string {
  if (!deadline) return "";
  const ms = Date.parse(deadline);
  if (!Number.isFinite(ms)) return deadline.trim().toLowerCase();
  return new Date(ms).toISOString();
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
 * The first occurrence wins; later ones are dropped. The second argument is
 * either:
 *   - a `Set` of signatures from `buildCandidateSignature` (batch-level dedupe).
 *     Keys recorded under a different normalization policy version will not
 *     match and are therefore treated as incompatible rather than reused; or
 *   - the OPEN/ACTIVE claims read from the chain, which additionally drops any
 *     candidate that repeats an existing claim's question or resolution source
 *     in the same category. Within the batch, two drafts that share a question
 *     or source are only collapsed when they come from the same source snapshot.
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
