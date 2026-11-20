/**
 * Dedupe helpers for market-creator candidates.
 *
 * Two layers, both used by the worker:
 *
 *   1. Within a batch: two drafted candidates are duplicates when they share the
 *      same normalised (question, resolutionUrl, deadline) signature.
 *   2. Against the chain: a drafted candidate is dropped when an OPEN/ACTIVE claim
 *      in the same category already asks the same question, or already reads the
 *      same resolution source. The chain snapshot is the source of truth, so a
 *      create whose result was lost (timeout after submit) is still caught on the
 *      next run instead of producing a second market.
 *
 * Normalisation ignores case, punctuation, filler words and URL fragments, so
 * cosmetic re-drafts of the same market do not slip through.
 */

export interface CandidateLike {
  question?: string;
  resolutionUrl?: string;
  deadline?: string;
  category?: string;
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

/**
 * Build a stable signature for a candidate. Used to detect duplicates
 * across the same run and against a caller-supplied `seen` set.
 */
export function buildCandidateSignature(candidate: CandidateLike): string {
  const question = normalizeComparableText(candidate.question ?? candidate.title);
  const url = normalizeResolutionUrl(candidate.resolutionUrl);
  const deadline = normaliseDeadline(candidate.deadline);
  return `${question}|${url}|${deadline}`;
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
 *   - a `Set` of signatures from `buildCandidateSignature` (batch-level dedupe), or
 *   - the OPEN/ACTIVE claims read from the chain, which additionally drops any
 *     candidate that repeats an existing claim's question or resolution source
 *     in the same category.
 */
export function filterDuplicateCandidates<T extends CandidateLike>(
  candidates: readonly T[],
  existing: Set<string> | readonly ExistingClaimSignature[] = new Set(),
): T[] {
  if (existing instanceof Set) {
    const out: T[] = [];
    for (const candidate of candidates) {
      const sig = buildCandidateSignature(candidate);
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
    const questionKey = normalizeComparableText(candidate.question ?? candidate.title);
    const sourceKey = normalizeResolutionUrl(candidate.resolutionUrl);
    const q = `${category}:${questionKey}`;
    const s = `${category}:${sourceKey}`;

    if (sourceKey && existingSourceKeys.has(s)) continue;
    if (questionKey && existingQuestionKeys.has(q)) continue;
    if ((sourceKey && seenSourceKeys.has(s)) || (questionKey && seenQuestionKeys.has(q))) continue;

    if (sourceKey) seenSourceKeys.add(s);
    if (questionKey) seenQuestionKeys.add(q);
    out.push(candidate);
  }
  return out;
}
