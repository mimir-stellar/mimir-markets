/**
 * Dedupe helpers for market-creator candidates.
 *
 * Two candidates are considered duplicates when they share the same
 * (question, resolutionUrl, deadline, normalization policy version) signature.
 * The signature is normalised so that case, punctuation and whitespace
 * differences don't produce duplicates on-chain.
 *
 * The normalization policy version is included in the signature so that when
 * the normalization rules change, previously-seen keys are not silently reused
 * across policy generations. Bumping NORMALIZATION_POLICY_VERSION invalidates
 * all cached dedupe decisions computed under older policies.
 */

/**
 * Version of the normalization policy used to build candidate signatures.
 * Increment whenever normaliseQuestion / normaliseUrl / normaliseDeadline
 * change behaviour in a way that could alter signatures.
 */
export const NORMALIZATION_POLICY_VERSION = "v1";

export interface CandidateLike {
  question?: string;
  resolutionUrl?: string;
  deadline?: string;
  // Optional canonical fields that may be present on candidates.
  id?: string;
  title?: string;
  [key: string]: unknown;
}

/**
 * Stable reason codes recorded when a source fetch is rejected. Reasons are
 * short, machine-readable tokens so they can be aggregated and tested.
 */
export type RetryReason =
  | "fetch_failed"
  | "low_quality_draft"
  | "duplicate"
  | "unknown";

export interface RetryEntry {
  sourceKey: string;
  reason: RetryReason;
  attempts: number;
  /** Epoch ms before which the source must not be retried. */
  nextEligibleAt: number;
}

export interface RetryQueueOptions {
  /** Maximum number of tracked sources; oldest entries are evicted first. */
  maxEntries?: number;
  /** Base backoff in ms; grows exponentially with attempts. */
  baseBackoffMs?: number;
  /** Upper bound on backoff in ms. */
  maxBackoffMs?: number;
  /** Maximum attempts before a source is dropped from the queue. */
  maxAttempts?: number;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

/**
 * Bounded retry queue tracking rejected source fetches, their stable reasons
 * and when each source next becomes eligible for retry.
 */
export class CreatorRetryQueue {
  private readonly entries = new Map<string, RetryEntry>();
  private readonly maxEntries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;

  constructor(options: RetryQueueOptions = {}) {
    this.maxEntries = options.maxEntries ?? 100;
    this.baseBackoffMs = options.baseBackoffMs ?? 60_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 3_600_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.now = options.now ?? (() => Date.now());
  }

  /** Record a rejected fetch for a source and schedule its next eligibility. */
  recordRejection(sourceKey: string, reason: RetryReason): RetryEntry {
    const prev = this.entries.get(sourceKey);
    const attempts = (prev?.attempts ?? 0) + 1;
    const backoff = Math.min(
      this.baseBackoffMs * 2 ** (attempts - 1),
      this.maxBackoffMs,
    );
    const entry: RetryEntry = {
      sourceKey,
      reason,
      attempts,
      nextEligibleAt: this.now() + backoff,
    };
    // Re-insert so Map order reflects recency for eviction.
    this.entries.delete(sourceKey);
    this.entries.set(sourceKey, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return entry;
  }

  /** Whether a source may be retried now. Unknown sources are eligible. */
  isEligible(sourceKey: string): boolean {
    const entry = this.entries.get(sourceKey);
    if (!entry) return true;
    if (entry.attempts >= this.maxAttempts) return false;
    return this.now() >= entry.nextEligibleAt;
  }

  get(sourceKey: string): RetryEntry | undefined {
    return this.entries.get(sourceKey);
  }

  /** Clear a source after a successful fetch. */
  clear(sourceKey: string): void {
    this.entries.delete(sourceKey);
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Returns true when a draft is of sufficient quality to be submitted in a
 * transaction. Low-quality drafts are kept out of transaction attempts.
 */
export function isSubmittableCandidate(candidate: CandidateLike): boolean {
  const question = normaliseQuestion(candidate.question ?? candidate.title);
  if (question.length < 10) return false;
  if (!candidate.resolutionUrl || !candidate.resolutionUrl.trim()) return false;
  if (!candidate.deadline || !Number.isFinite(Date.parse(candidate.deadline))) {
    return false;
  }
  return true;
}

function normaliseQuestion(question: string | undefined): string {
  if (!question) return "";
  return question
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseUrl(url: string | undefined): string {
  if (!url) return "";
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

function normaliseDeadline(deadline: string | undefined): string {
  if (!deadline) return "";
  const ms = Date.parse(deadline);
  if (!Number.isFinite(ms)) return deadline.trim().toLowerCase();
  return new Date(ms).toISOString();
}

/**
 * Build a stable signature for a candidate. Used to detect duplicates
 * across the same run and against already-created markets.
 *
 * The signature is prefixed with the normalization policy version so that
 * keys produced under different policies never compare equal.
 */
export function buildCandidateSignature(
  candidate: CandidateLike,
  policyVersion: string = NORMALIZATION_POLICY_VERSION,
): string {
  const question = normaliseQuestion(candidate.question ?? candidate.title);
  const url = normaliseUrl(candidate.resolutionUrl);
  const deadline = normaliseDeadline(candidate.deadline);
  return `${policyVersion}|${question}|${url}|${deadline}`;
}

/**
 * Filter duplicate candidates while preserving input order.
 *
 * The first occurrence of a signature wins; subsequent ones are dropped.
 * An optional `seen` set can be passed in to also dedupe against candidates
 * that already exist on-chain or in a previous batch. Keys recorded under a
 * different normalization policy version will not match and are therefore
 * treated as incompatible rather than reused.
 */
export function filterDuplicateCandidates<T extends CandidateLike>(
  candidates: readonly T[],
  seen: Set<string> = new Set(),
  policyVersion: string = NORMALIZATION_POLICY_VERSION,
): T[] {
  const out: T[] = [];
  for (const candidate of candidates) {
    const sig = buildCandidateSignature(candidate, policyVersion);
    if (seen.has(sig)) continue;
    seen.add(sig);
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
