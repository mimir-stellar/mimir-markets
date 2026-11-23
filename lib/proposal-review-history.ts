/**
 * Proposal review history model, stable reason codes, and public-view redaction.
 *
 * Every terminal proposal review decision (accepted, rejected, superseded,
 * expired) is recorded with a stable machine-readable reason code. Public
 * views project through `toPublicProposalReviewHistoryEntry` so privileged
 * actor credentials (reviewer identities, operator keys) and private notes
 * never leak outside internal operator endpoints.
 */

export const PROPOSAL_REVIEW_DECISIONS = [
  "accepted",
  "rejected",
  "superseded",
  "expired",
] as const;

export type ProposalReviewDecision = (typeof PROPOSAL_REVIEW_DECISIONS)[number];

export const PROPOSAL_REVIEW_REASON_CODES = [
  "REVIEW_APPROVED",
  "REVIEW_REJECTED",
  "POLICY_VIOLATION",
  "INVALID_RESOLUTION_SOURCE",
  "LOW_QUALITY",
  "DEPENDENCY_FAILED",
  "CANCELLED_BY_OPERATOR",
  "SUPERSEDED_BY_NEWER_PROPOSAL",
  "DUPLICATE_PROPOSAL",
  "REVIEW_DEADLINE_EXPIRED",
  "SIGNED_WINDOW_EXPIRED",
] as const;

export type ProposalReviewReasonCode = (typeof PROPOSAL_REVIEW_REASON_CODES)[number];

/** Full internal record persisted in `proposal_review_history`. */
export interface ProposalReviewHistoryRecord {
  id: number;
  proposalId: string;
  decision: ProposalReviewDecision;
  reasonCode: ProposalReviewReasonCode;
  recordedAt: number;
  supersededByProposalId: string | null;
  /** Internal-only reviewer/operator identifier. Never exposed publicly. */
  actorId: string | null;
  /** Internal-only operator note or raw failure detail. Never exposed publicly. */
  privateNote: string | null;
}

/** Public-safe projection of a proposal review history entry. */
export interface PublicProposalReviewHistoryEntry {
  id: number;
  proposalId: string;
  decision: ProposalReviewDecision;
  reasonCode: ProposalReviewReasonCode;
  recordedAt: number;
  supersededByProposalId: string | null;
}

export interface RecordProposalReviewDecisionInput {
  proposalId: string;
  decision: ProposalReviewDecision;
  reasonCode?: ProposalReviewReasonCode;
  recordedAt?: number;
  supersededByProposalId?: string | null;
  actorId?: string | null;
  privateNote?: string | null;
}

export function isProposalReviewDecision(value: unknown): value is ProposalReviewDecision {
  return typeof value === "string" && (PROPOSAL_REVIEW_DECISIONS as readonly string[]).includes(value);
}

export function isProposalReviewReasonCode(value: unknown): value is ProposalReviewReasonCode {
  return typeof value === "string" && (PROPOSAL_REVIEW_REASON_CODES as readonly string[]).includes(value);
}

export function defaultReasonCodeForDecision(decision: ProposalReviewDecision): ProposalReviewReasonCode {
  switch (decision) {
    case "accepted":
      return "REVIEW_APPROVED";
    case "rejected":
      return "REVIEW_REJECTED";
    case "superseded":
      return "SUPERSEDED_BY_NEWER_PROPOSAL";
    case "expired":
      return "REVIEW_DEADLINE_EXPIRED";
  }
}

export function decisionForReviewStatus(
  status: string,
  opts: { supersededByProposalId?: string | null } = {},
): ProposalReviewDecision | null {
  switch (status) {
    case "approved":
      return "accepted";
    case "rejected":
    case "dependency_failed":
      return "rejected";
    case "cancelled":
      return opts.supersededByProposalId ? "superseded" : "rejected";
    case "stale":
      return "expired";
    default:
      return null;
  }
}

/**
 * Project an internal history record to its public-safe representation.
 *
 * Uses an explicit allowlist so privileged actor credentials, reviewer IDs,
 * and private operator notes can never leak into public API responses.
 */
export function toPublicProposalReviewHistoryEntry(
  record: ProposalReviewHistoryRecord,
): PublicProposalReviewHistoryEntry {
  return {
    id: record.id,
    proposalId: record.proposalId,
    decision: record.decision,
    reasonCode: record.reasonCode,
    recordedAt: record.recordedAt,
    supersededByProposalId: record.supersededByProposalId ?? null,
  };
}
