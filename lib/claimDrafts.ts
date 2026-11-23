export const CLAIM_DRAFT_CATEGORY_IDS = [
  "sports",
  "weather",
  "crypto",
  "culture",
  "custom",
] as const;

export const CLAIM_DRAFT_MAX_CANDIDATES = 3;

export type ClaimDraftCategory = (typeof CLAIM_DRAFT_CATEGORY_IDS)[number];

export const CLAIM_DRAFT_SOURCE_TYPES = ["official", "media", "other"] as const;

export type ClaimDraftSourceType = (typeof CLAIM_DRAFT_SOURCE_TYPES)[number];

export interface SourceClaimDraftCandidate {
  category: ClaimDraftCategory;
  claimText: string;
  sideA: string;
  sideB: string;
  deadlineAt: string;
  timezone: string;
  primaryResolutionSource: string;
  settlementRule: string;
  ambiguityFlags: string[];
  confidenceScore: number;
}

export interface SourceClaimDraftResponse {
  sourceUrl: string;
  sourceType: ClaimDraftSourceType;
  sourceSummary: string;
  candidates: SourceClaimDraftCandidate[];
}

export type ChallengeOpportunityAction = "create" | "challenge";

export type ChallengeOpportunityStrengthTier = "strong" | "good" | "fair" | "weak";

export interface ChallengeOpportunity {
  id: string;
  sourceUrl: string;
  sourceType: ClaimDraftSourceType;
  sourceSummary: string;
  candidate: SourceClaimDraftCandidate;
  claimStrengthScore: number;
  claimStrengthTier: ChallengeOpportunityStrengthTier;
  action: ChallengeOpportunityAction;
  existingClaimId?: number;
}

export interface ChallengeOpportunitiesResponse {
  items: ChallengeOpportunity[];
  count: number;
  generatedAt: string;
}

/**
 * Canonical market draft fields that a proposal approval must bind to.
 * Any change to these fields after approval invalidates the approval.
 */
export interface CanonicalMarketDraftFields {
  claimText: string;
  sourceUrl: string;
  stake: number;
  deadlineAt: string;
}

/**
 * Produces a deterministic, order-stable canonical serialization of the
 * approval-bound draft fields. Stake is an integer USDC amount; no floats.
 */
export function canonicalizeMarketDraft(fields: CanonicalMarketDraftFields): string {
  if (!Number.isSafeInteger(fields.stake) || fields.stake < 0) {
    throw new Error("stake must be a non-negative safe integer (USDC units)");
  }
  return JSON.stringify({
    claimText: fields.claimText,
    sourceUrl: fields.sourceUrl,
    stake: fields.stake,
    deadlineAt: fields.deadlineAt,
  });
}

/**
 * Computes a SHA-256 hex digest of the canonical draft. Uses Web Crypto when
 * available, falling back to node:crypto for server runtimes.
 */
export async function computeMarketDraftDigest(
  fields: CanonicalMarketDraftFields,
): Promise<string> {
  const data = new TextEncoder().encode(canonicalizeMarketDraft(fields));
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto subtle API is unavailable");
  }
  const digest = await subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Returns true only when the digest recorded at approval time matches the
 * digest of the current draft. Any drift in wording, source, stake or deadline
 * makes execution invalid.
 */
export async function isApprovedDraftUnchanged(
  approvedDigest: string,
  current: CanonicalMarketDraftFields,
): Promise<boolean> {
  const currentDigest = await computeMarketDraftDigest(current);
  return currentDigest === approvedDigest;
}
