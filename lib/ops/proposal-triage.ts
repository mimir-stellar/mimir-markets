/**
 * Operator Proposal Backlog Triage.
 *
 * Provides structured grouping, aging analysis, and privacy-preserving triage
 * exports for unresolved market creator proposals (`queued` and `in_review`).
 *
 * Requirements:
 * - Group bounded unresolved proposals by age and blocking reason.
 * - Omit private source text (e.g. mode_rationale, context_pack_hash, preflight_verdict)
 *   and signing metadata (e.g. nonces, signatures, keys, credentials).
 * - Bounded pagination (clamped 1..200 limit, offset >= 0).
 * - Fail-safe against missing, malformed, or boundary timestamps.
 */

import type { MarketProposalRow, ReviewStatus } from "../db";

export const PROPOSAL_AGE_BRACKETS = ["under_1h", "1h_to_24h", "over_24h"] as const;
export type ProposalAgeBracket = (typeof PROPOSAL_AGE_BRACKETS)[number];

export const UNRESOLVED_REVIEW_STATUSES: readonly ReviewStatus[] = ["queued", "in_review"];

export interface TriagedProposal {
  proposalId: string;
  question: string;
  category: string;
  subjectType: string;
  settlementMode: string;
  creatorPosition: string;
  counterPosition: string;
  resolutionUrl: string;
  settlementRule: string;
  deadline: number;
  qualityScore: number;
  disposition: string;
  reviewStatus: ReviewStatus;
  queuedAt: number | null;
  claimedAt: number | null;
  reviewer: string | null;
  blockedBy: string | null;
  failureReason: string | null;
  blockingReason: string;
  ageSeconds: number;
  ageBracket: ProposalAgeBracket;
}

export interface ProposalTriageSummary {
  total: number;
  byAge: Record<ProposalAgeBracket, number>;
  byBlockingReason: Record<string, number>;
}

export interface ProposalBacklogTriageExport {
  generatedAt: number;
  limit: number;
  offset: number;
  summary: ProposalTriageSummary;
  byAge: Record<ProposalAgeBracket, TriagedProposal[]>;
  byBlockingReason: Record<string, TriagedProposal[]>;
  byAgeAndReason: Record<ProposalAgeBracket, Record<string, TriagedProposal[]>>;
  proposals: TriagedProposal[];
}

export interface ProposalTriageOptions {
  now?: number;
  limit?: number;
  offset?: number;
}

/** Determine the age bracket from age in seconds. */
export function getProposalAgeBracket(ageSeconds: number): ProposalAgeBracket {
  if (ageSeconds < 3600) return "under_1h";
  if (ageSeconds <= 86400) return "1h_to_24h";
  return "over_24h";
}

/** Extract normalized blocking reason from proposal row. */
export function getProposalBlockingReason(
  row: Pick<MarketProposalRow, "blocked_by" | "failure_reason">,
): string {
  if (typeof row.blocked_by === "string" && row.blocked_by.trim().length > 0) {
    return row.blocked_by.trim();
  }
  if (typeof row.failure_reason === "string" && row.failure_reason.trim().length > 0) {
    return row.failure_reason.trim();
  }
  return "unblocked";
}

/**
 * Sanitize and project an unresolved proposal row into a privacy-preserving TriagedProposal.
 * Explicitly excludes private source text (mode_rationale, context_pack_hash, preflight_verdict)
 * and signing metadata (nonces, signatures, secrets).
 */
export function sanitizeTriagedProposal(
  row: MarketProposalRow,
  now: number,
): TriagedProposal {
  const queuedTimestamp =
    typeof row.queued_at === "number" && Number.isFinite(row.queued_at)
      ? row.queued_at
      : typeof row.created_at === "number" && Number.isFinite(row.created_at)
        ? row.created_at
        : now;

  const ageSeconds = Math.max(0, Math.floor((now - queuedTimestamp) / 1000));
  const ageBracket = getProposalAgeBracket(ageSeconds);
  const blockingReason = getProposalBlockingReason(row);

  return {
    proposalId: String(row.proposal_id ?? ""),
    question: String(row.question ?? ""),
    category: String(row.category ?? ""),
    subjectType: String(row.subject_type ?? ""),
    settlementMode: String(row.settlement_mode ?? ""),
    creatorPosition: String(row.creator_position ?? ""),
    counterPosition: String(row.counter_position ?? ""),
    resolutionUrl: String(row.resolution_url ?? ""),
    settlementRule: String(row.settlement_rule ?? ""),
    deadline: typeof row.deadline === "number" && Number.isFinite(row.deadline) ? row.deadline : 0,
    qualityScore: typeof row.quality_score === "number" && Number.isFinite(row.quality_score) ? row.quality_score : 0,
    disposition: String(row.disposition ?? ""),
    reviewStatus: row.review_status,
    queuedAt: typeof row.queued_at === "number" && Number.isFinite(row.queued_at) ? row.queued_at : null,
    claimedAt: typeof row.claimed_at === "number" && Number.isFinite(row.claimed_at) ? row.claimed_at : null,
    reviewer: typeof row.reviewer === "string" ? row.reviewer : null,
    blockedBy: typeof row.blocked_by === "string" ? row.blocked_by : null,
    failureReason: typeof row.failure_reason === "string" ? row.failure_reason : null,
    blockingReason,
    ageSeconds,
    ageBracket,
  };
}

/**
 * Pure function to build the operator proposal backlog triage export.
 */
export function buildProposalBacklogTriage(
  rows: readonly MarketProposalRow[],
  options: ProposalTriageOptions = {},
): ProposalBacklogTriageExport {
  const now = typeof options.now === "number" && Number.isFinite(options.now) ? options.now : Date.now();
  let limit = typeof options.limit === "number" && Number.isFinite(options.limit) ? Math.trunc(options.limit) : 50;
  limit = Math.max(1, Math.min(200, limit));
  let offset = typeof options.offset === "number" && Number.isFinite(options.offset) ? Math.trunc(options.offset) : 0;
  offset = Math.max(0, offset);

  // Filter only unresolved proposals
  const unresolved = rows.filter(
    (r) => r && (r.review_status === "queued" || r.review_status === "in_review"),
  );

  // Sanitize rows
  const triaged = unresolved.map((row) => sanitizeTriagedProposal(row, now));

  // Initialize grouping structures
  const byAge: Record<ProposalAgeBracket, TriagedProposal[]> = {
    under_1h: [],
    "1h_to_24h": [],
    over_24h: [],
  };

  const byBlockingReason: Record<string, TriagedProposal[]> = {};
  const byAgeAndReason: Record<ProposalAgeBracket, Record<string, TriagedProposal[]>> = {
    under_1h: {},
    "1h_to_24h": {},
    over_24h: {},
  };

  const ageCounts: Record<ProposalAgeBracket, number> = {
    under_1h: 0,
    "1h_to_24h": 0,
    over_24h: 0,
  };
  const reasonCounts: Record<string, number> = {};

  for (const item of triaged) {
    // Group by age
    byAge[item.ageBracket].push(item);
    ageCounts[item.ageBracket] += 1;

    // Group by blocking reason
    if (!byBlockingReason[item.blockingReason]) {
      byBlockingReason[item.blockingReason] = [];
      reasonCounts[item.blockingReason] = 0;
    }
    byBlockingReason[item.blockingReason].push(item);
    reasonCounts[item.blockingReason] += 1;

    // Cross group by age and reason
    if (!byAgeAndReason[item.ageBracket][item.blockingReason]) {
      byAgeAndReason[item.ageBracket][item.blockingReason] = [];
    }
    byAgeAndReason[item.ageBracket][item.blockingReason].push(item);
  }

  return {
    generatedAt: now,
    limit,
    offset,
    summary: {
      total: triaged.length,
      byAge: ageCounts,
      byBlockingReason: reasonCounts,
    },
    byAge,
    byBlockingReason,
    byAgeAndReason,
    proposals: triaged,
  };
}
