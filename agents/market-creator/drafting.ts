/**
 * LLM drafting for market creator.
 *
 * This module owns the prompt and the parsing of the model's response
 * into candidate objects. The prompts and caps are deliberately unchanged by the
 * refactor - this is a move, not a rewrite.
 */

import { extractUsdThresholds, cryptoThresholdReason } from "./thresholds.js";

export interface ClaimCandidate {
  question: string;
  resolutionUrl: string;
  deadline: string;
  category?: string;
  threshold?: number;
  [key: string]: unknown;
}

/**
 * Reasons a drafted candidate can be rejected before transaction attempts.
 * Stable identifiers: consumers may key on these strings.
 */
export type CandidateRejectionReason =
  | "missing_fields"
  | "unsafe_crypto_threshold"
  | "source_fetch_failed"
  | "duplicate_question";

/**
 * Per-source retry bookkeeping for rejected source fetches.
 * `nextEligibleAt` is an epoch-ms timestamp before which the source must not be retried.
 */
export interface SourceRetryState {
  sourceUrl: string;
  reason: CandidateRejectionReason;
  attempts: number;
  nextEligibleAt: number;
}

export interface RetryQueueOptions {
  /** Maximum number of tracked sources; oldest entries are evicted beyond this. */
  maxEntries?: number;
  /** Base backoff in ms; doubled per attempt. */
  baseBackoffMs?: number;
  /** Upper bound on backoff in ms. */
  maxBackoffMs?: number;
  /** Maximum attempts before a source is dropped from the queue. */
  maxAttempts?: number;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

const DEFAULT_RETRY_OPTIONS = {
  maxEntries: 100,
  baseBackoffMs: 60_000,
  maxBackoffMs: 3_600_000,
  maxAttempts: 5,
} as const;

/**
 * Bounded retry queue for rejected source fetches. Tracks a stable reason and
 * next eligibility per source so that low-quality or unreachable sources are
 * not re-attempted immediately.
 */
export class SourceRetryQueue {
  private readonly entries = new Map<string, SourceRetryState>();
  private readonly maxEntries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;

  constructor(options: RetryQueueOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_RETRY_OPTIONS.maxEntries;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_RETRY_OPTIONS.baseBackoffMs;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_RETRY_OPTIONS.maxBackoffMs;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_RETRY_OPTIONS.maxAttempts;
    this.now = options.now ?? (() => Date.now());
  }

  /** Record a rejection for a source and compute its next eligibility. */
  recordRejection(sourceUrl: string, reason: CandidateRejectionReason): SourceRetryState {
    const prev = this.entries.get(sourceUrl);
    const attempts = (prev?.attempts ?? 0) + 1;
    const backoff = Math.min(
      this.baseBackoffMs * 2 ** (attempts - 1),
      this.maxBackoffMs,
    );
    const state: SourceRetryState = {
      sourceUrl,
      reason,
      attempts,
      nextEligibleAt: this.now() + backoff,
    };
    this.entries.delete(sourceUrl);
    this.entries.set(sourceUrl, state);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return state;
  }

  /** True when the source may be fetched again now. */
  isEligible(sourceUrl: string): boolean {
    const state = this.entries.get(sourceUrl);
    if (!state) return true;
    if (state.attempts >= this.maxAttempts) return false;
    return this.now() >= state.nextEligibleAt;
  }

  get(sourceUrl: string): SourceRetryState | undefined {
    return this.entries.get(sourceUrl);
  }

  clear(sourceUrl: string): void {
    this.entries.delete(sourceUrl);
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Drop candidates whose source is currently ineligible for retry. Candidates
 * are never sent on to transaction attempts while their source is backed off.
 */
export function filterByRetryEligibility(
  candidates: readonly ClaimCandidate[],
  queue: SourceRetryQueue,
): ClaimCandidate[] {
  return candidates.filter((candidate) => queue.isEligible(candidate.resolutionUrl));
}

export interface DraftingContext {
  /** Source material the LLM should read from. */
  sourceText: string;
  /**
   * Normalization policy version(s) in effect for this draft. Included in
   * deduplication keys so that decisions cached under an incompatible policy
   * are invalidated explicitly rather than silently reused.
   */
  normalizationPolicyVersion?: string;
  /** Optional existing questions to avoid duplicating. */
  existingQuestions?: readonly string[];
  /** Maximum number of candidates to request. */
  maxCandidates?: number;
  /** Category hint for the prompt. */
  category?: string;
}

export type LlmCompleter = (prompt: string) => Promise<string>;

const DEFAULT_MAX_CANDIDATES = 5;

/**
 * Build a deterministic deduplication key for a drafted candidate. The key
 * includes the normalization policy version so that a policy change produces
 * a distinct identity, and cached decisions under the old version are not
 * reused.
 */
export function buildDedupeKey(
  candidate: Pick<ClaimCandidate, "question" | "resolutionUrl" | "deadline">,
  normalizationPolicyVersion: string = "unversioned",
): string {
  const normalizedQuestion = candidate.question.trim().toLowerCase().replace(/\s+/g, " ");
  return [
    `policy=${normalizationPolicyVersion}`,
    `q=${normalizedQuestion}`,
    `url=${candidate.resolutionUrl.trim()}`,
    `deadline=${candidate.deadline.trim()}`,
  ].join("|");
}

export function buildDraftingPrompt(context: DraftingContext): string {
  const max = context.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const categoryLine = context.category ? `Category: ${context.category}\n` : "";
  const existingLine = context.existingQuestions?.length
    ? `Existing questions (do not duplicate):\n${context.existingQuestions.map((q) => `- ${q}`).join("\n")}\n`
    : "";

  return [
    "You are drafting prediction market candidates.",
    "Each candidate must be settleable by fetching ONE resolutionUrl and reading a number or a date out of it.",
    categoryLine,
    existingLine,
    `Return at most ${max} candidates as a JSON array of objects with fields: question, resolutionUrl, deadline (ISO 8601), category, threshold (optional, USD).`,
    "Source material:",
    context.sourceText,
  ].filter(Boolean).join("\n\n");
}

/**
 * Parse the LLM response into candidates. Tolerates code fences and
 * surrounding prose. Returns [] on any parsing failure - the caller treats
 * that as "no candidates this run".
 */
export function parseDraftedCandidates(raw: string): ClaimCandidate[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*)```/i);
  const jsonText = fenceMatch ? fenceMatch[1] : trimmed;

  const start = jsonText.indexOf("[");
  const end = jsonText.lastIndexOf("]");
  if (start < 0 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: ClaimCandidate[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const question = typeof rec.question === "string" ? rec.question.trim() : "";
    const resolutionUrl = typeof rec.resolutionUrl === "string" ? rec.resolutionUrl.trim() : "";
    const deadline = typeof rec.deadline === "string" ? rec.deadline.trim() : "";
    if (!question || !resolutionUrl || !deadline) continue;
    out.push({
      question,
      resolutionUrl,
      deadline,
      category: typeof rec.category === "string" ? rec.category : undefined,
      threshold: typeof rec.threshold === "number" ? rec.threshold : undefined,
    });
  }
  return out;
}

/**
 * Drop candidates whose crypto threshold fails the sanity check.
 * Candidates without a threshold are kept unchanged.
 */
export function filterUnsafeCryptoThresholds(
  candidates: readonly ClaimCandidate[],
): ClaimCandidate[] {
  return candidates.filter((candidate) => {
    if (candidate.threshold === undefined) return true;
    return cryptoThresholdReason(candidate.threshold) === null;
  });
}

/**
 * Draft candidates by calling the provided completer with the drafting
 * prompt, then parsing and sanitising the response.
 */
export async function draftClaimCandidates(
  completer: LlmCompleter,
  context: DraftingContext,
): Promise<ClaimCandidate[]> {
  const prompt = buildDraftingPrompt(context);
  const raw = await completer(prompt);
  const parsed = parseDraftedCandidates(raw);
  return filterUnsafeCryptoThresholds(parsed);
}

/**
 * Drafting variant that also consults a retry queue: candidates whose source
 * is backed off are excluded so low-quality drafts never reach transaction attempts.
 */
export async function draftClaimCandidatesWithRetry(
  completer: LlmCompleter,
  context: DraftingContext,
  queue: SourceRetryQueue,
): Promise<ClaimCandidate[]> {
  const drafted = await draftClaimCandidates(completer, context);
  return filterByRetryEligibility(drafted, queue);
}

/**
 * Exported for tests and for callers that want to inspect threshold
 * mentions in a drafted question without running the full filter.
 */
export { extractUsdThresholds, cryptoThresholdReason };
