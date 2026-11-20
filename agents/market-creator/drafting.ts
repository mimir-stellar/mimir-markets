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

export interface DraftingContext {
  /** Source material the LLM should read from. */
  sourceText: string;
  /** Optional existing questions to avoid duplicating. */
  existingQuestions?: readonly string[];
  /** Maximum number of candidates to request. */
  maxCandidates?: number;
  /** Category hint for the prompt. */
  category?: string;
}

export type LlmCompleter = (prompt: string) => Promise<string>;

const DEFAULT_MAX_CANDIDATES = 5;

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

export interface DraftEvaluationResult {
  candidate: ClaimCandidate;
  allowed: boolean;
  decisionCode: "approved" | "source_quality_rejected";
  reason?: string;
}

/**
 * Evaluate a single candidate for source-quality checks.
 *
 * Verifies completeness (question, resolutionUrl, deadline), valid format,
 * crypto threshold safety, and preflight quality score floor if provided.
 */
export function evaluateCandidateSourceQuality(
  candidate: ClaimCandidate,
  opts: { minQualityScore?: number } = {},
): DraftEvaluationResult {
  if (!candidate || typeof candidate !== "object") {
    return {
      candidate: candidate ?? ({} as ClaimCandidate),
      allowed: false,
      decisionCode: "source_quality_rejected",
      reason: "candidate must be a valid object",
    };
  }
  if (!candidate.question || typeof candidate.question !== "string" || candidate.question.trim() === "") {
    return {
      candidate,
      allowed: false,
      decisionCode: "source_quality_rejected",
      reason: "missing or empty question",
    };
  }
  if (!candidate.resolutionUrl || typeof candidate.resolutionUrl !== "string" || candidate.resolutionUrl.trim() === "") {
    return {
      candidate,
      allowed: false,
      decisionCode: "source_quality_rejected",
      reason: "missing or empty resolutionUrl",
    };
  }
  if (!candidate.deadline || typeof candidate.deadline !== "string" || candidate.deadline.trim() === "") {
    return {
      candidate,
      allowed: false,
      decisionCode: "source_quality_rejected",
      reason: "missing or empty deadline",
    };
  }
  if (candidate.threshold !== undefined) {
    const thresholdErr = cryptoThresholdReason(candidate.threshold);
    if (thresholdErr !== null) {
      return {
        candidate,
        allowed: false,
        decisionCode: "source_quality_rejected",
        reason: `unsafe crypto threshold: ${thresholdErr}`,
      };
    }
  }
  if (
    opts.minQualityScore !== undefined &&
    typeof candidate.qualityScore === "number" &&
    candidate.qualityScore < opts.minQualityScore
  ) {
    return {
      candidate,
      allowed: false,
      decisionCode: "source_quality_rejected",
      reason: `quality score ${candidate.qualityScore} < min ${opts.minQualityScore}`,
    };
  }
  return {
    candidate,
    allowed: true,
    decisionCode: "approved",
  };
}

/**
 * Filter candidates for source quality, returning distinct decision codes for rejected items.
 */
export function filterCandidatesWithDecisions(
  candidates: readonly ClaimCandidate[],
  opts: { minQualityScore?: number } = {},
): {
  approved: ClaimCandidate[];
  rejected: Array<{ candidate: ClaimCandidate; decisionCode: "source_quality_rejected"; reason: string }>;
} {
  const approved: ClaimCandidate[] = [];
  const rejected: Array<{ candidate: ClaimCandidate; decisionCode: "source_quality_rejected"; reason: string }> = [];
  for (const c of candidates) {
    const evalRes = evaluateCandidateSourceQuality(c, opts);
    if (evalRes.allowed) {
      approved.push(c);
    } else {
      rejected.push({
        candidate: c,
        decisionCode: "source_quality_rejected",
        reason: evalRes.reason ?? "failed source-quality check",
      });
    }
  }
  return { approved, rejected };
}

/**
 * Exported for tests and for callers that want to inspect threshold
 * mentions in a drafted question without running the full filter.
 */
export { extractUsdThresholds, cryptoThresholdReason };
