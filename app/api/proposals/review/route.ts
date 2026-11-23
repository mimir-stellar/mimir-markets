/**
 * The proposal review queue.
 *
 * Reads the pending market-creator proposals and moves them through the
 * queued -> in_review -> approved/rejected state machine. It is an operator tool,
 * not a user-facing API, so every handler is gated on the `internal_worker` tier
 * and the shared `CRON_SECRET` — the same pattern as the cron routes. An unset
 * `CRON_SECRET` refuses rather than waving callers through.
 *
 * Observation freshness (trusted ledger, observation time, known gaps) is
 * exposed through the shared response schema so the review queue reports the
 * same meaning as the feed, detail and performance endpoints.
 */

import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/api/policy";
import { apiError } from "@/lib/api/errors";
import { isDbConfigured } from "@/lib/db";
import {
  isDbConfigured,
  claimProposalForReview,
  completeProposalReview,
  cancelProposal,
  getProposalById,
  markProposalDependencyFailed,
  markStaleProposals,
  recordProposalReviewDecision,
  updateProposalReviewStatus,
  listProposalsForReview,
  getProposal,
  REVIEW_STATUSES,
  type ReviewStatus,
  type MarketProposalRow,
} from "@/lib/db";
import {
  enrichProposalWithExpiry,
  resolveProposalExpiry,
  resolveProposalExpiryPolicyRevision,
  toCanonicalUtc,
  type ProposalExpiryResolution,
} from "@/lib/signed-window";

export const runtime = "nodejs";

const ROUTE = "/api/proposals/review";

/**
 * Shared observation-freshness block. Every read endpoint reports the same
 * three fields with the same meaning so consumers can compare freshness across
 * feed, detail, performance and review responses.
 *
 * - trustedLedger: the ledger sequence the data was last verified against, or
 *   null when no trusted ledger has been observed yet.
 * - observedAt: ISO-8601 timestamp of the observation, or null when unknown.
 * - knownGaps: ledger ranges or conditions known to be missing from the index;
 *   empty when the observation is complete.
 */
export interface ObservationFreshness {
  trustedLedger: number | null;
  observedAt: string | null;
  knownGaps: string[];
}

/**
 * Normalize an arbitrary freshness input into the shared schema. Invalid
 * ledger numbers and timestamps collapse to null rather than leaking raw
 * values, and gaps are coerced to a clean string array.
 */
export function buildObservationFreshness(input: {
  trustedLedger?: unknown;
  observedAt?: unknown;
  knownGaps?: unknown;
} | null | undefined): ObservationFreshness {
  const ledger = input?.trustedLedger;
  const trustedLedger =
    typeof ledger === "number" && Number.isInteger(ledger) && ledger >= 0 ? ledger : null;

  let observedAt: string | null = null;
  const at = input?.observedAt;
  if (typeof at === "string" && at !== "" && !Number.isNaN(Date.parse(at))) {
    observedAt = new Date(at).toISOString();
  } else if (at instanceof Date && !Number.isNaN(at.getTime())) {
    observedAt = at.toISOString();
  }

  const gaps = Array.isArray(input?.knownGaps)
    ? (input!.knownGaps as unknown[]).filter((g): g is string => typeof g === "string" && g !== "")
    : [];

  return { trustedLedger, observedAt, knownGaps: gaps };
}

function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

function errorResponse(
  message: string,
  status = 400,
  extra: Record<string, unknown> = {},
): NextResponse {
  const { code, ...rest } = extra;
  return json(
    {
      error: {
        ...(typeof code === "string" ? { code } : {}),
        message,
      },
      ...rest,
    },
    status,
  );
}

function expiryEnvelope(expiry: ProposalExpiryResolution): Record<string, unknown> {
  return {
    expiryStatus: expiry.status,
    exists: expiry.exists,
    expired: expiry.expired,
    isExpired: expiry.isExpired,
    effectiveExpiresAt: expiry.effectiveExpiresAt,
    effectiveExpiresAtUtc: expiry.effectiveExpiresAtUtc,
    effectiveExpiry: expiry.effectiveExpiresAtUtc,
    deadlineAtUtc: expiry.deadlineAtUtc,
    reviewWindowExpiresAt: expiry.reviewWindowExpiresAt,
    reviewWindowExpiresAtUtc: expiry.reviewWindowExpiresAtUtc,
    expirySource: expiry.expirySource,
    remainingMs: expiry.remainingMs,
    policyRevision: expiry.policyRevision,
    evaluatedAtUtc: expiry.evaluatedAtUtc,
  };
}

function absentProposalResponse(proposalId: string, nowMs: number): NextResponse {
  const expiry = resolveProposalExpiry(null, { now: nowMs });
  return errorResponse("Proposal not found", 404, {
    code: "proposal_not_found",
    proposalId,
    status: "absent",
    ...expiryEnvelope(expiry),
  });
}

function expiredProposalResponse(
  proposalId: string,
  proposal: Record<string, unknown>,
  expiry: ProposalExpiryResolution,
): NextResponse {
  return errorResponse("Proposal has expired", 409, {
    code: "proposal_expired",
    proposalId,
    status: "expired",
    reviewStatus: proposal.review_status ?? null,
    ...expiryEnvelope(expiry),
  });
}

/**
 * Return a machine-readable `apiError` envelope with the given status.
 *
 * Used for 5xx failures so the client never sees a raw exception message
 * (hostnames, SQL fragments, stack-adjacent detail). The detail is logged
 * server-side instead. The `status` argument is honoured even when it differs
 * from the code's default, so the route's contract is unchanged.
 */
function internalErrorResponse(status = 500): NextResponse {
  const result = apiError("internal_error", "Internal server error");
  return NextResponse.json(result.body, { status, headers: result.headers });
}

async function requireAuth(request: NextRequest): Promise<NextResponse | null> {
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const auth = await authorizeRequest("internal_worker", {
    route: ROUTE,
    presentedSecret: presented,
    expectedSecret: process.env.CRON_SECRET,
  });
  if (!auth.allowed) {
    const error = auth.error;
    if (!error) return errorResponse("Unauthorized", 401);
    return NextResponse.json(error.body, { status: error.status, headers: error.headers });
  }

  // Validate signed window if window headers or query parameters are present
  const nonce = request.headers.get("x-mimir-nonce") ?? request.headers.get("x-nonce");
  const expiresAtHeader = request.headers.get("x-mimir-expires-at") ?? request.headers.get("x-expires-at");
  const url = new URL(request.url);
  const nonceParam = url.searchParams.get("nonce");
  const expiresAtParam = url.searchParams.get("expiresAt") ?? url.searchParams.get("expires_at");

  const effectiveNonce = nonce ?? nonceParam;
  const effectiveExpiresAtRaw = expiresAtHeader ?? expiresAtParam;

  if (effectiveNonce !== null || effectiveExpiresAtRaw !== null) {
    const expiresAt = effectiveExpiresAtRaw ? Number(effectiveExpiresAtRaw) : Number.NaN;
    const windowResult = validateSignedWindow(effectiveNonce, expiresAt);
    if (!windowResult.ok) {
      return json({ error: { message: windowResult.message, code: windowResult.code, field: windowResult.field } }, 400);
    }
  }

  return null;
}

function parseIntParam(raw: string | null): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || Number.isNaN(n)) return undefined;
  return Math.trunc(n);
}

/** Require a non-empty string; returns the trimmed value or null. */
function requireString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuth(request);
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const queryKeys = new Set(searchParams.keys());
  if ([...queryKeys].some((key) => searchParams.getAll(key).length > 1)) {
    return errorResponse("Duplicate query parameters are not allowed", 400);
  }

  if (!isDbConfigured()) {
    return errorResponse("Database not configured", 503);
  }

  const { searchParams } = new URL(request.url);
  const proposalIdRaw = searchParams.get("proposalId") ?? searchParams.get("proposal_id");
  const statusRaw = searchParams.get("status");
  const limitRaw = searchParams.get("limit");
  const offsetRaw = searchParams.get("offset");
  const limit = parseIntParam(limitRaw);
  const offset = parseIntParam(offsetRaw);

  if (isTriage) {
    try {
      const triageExport = await getProposalBacklogTriage({ limit, offset });
      return json(triageExport);
    } catch (err) {
      console.error("[proposals/review] GET triage error:", err);
      return internalErrorResponse(500);
    }
  }

  const statusRaw = searchParams.get("status");

  let status: ReviewStatus | null = null;
  if (statusRaw !== null && statusRaw !== "") {
    if (!REVIEW_STATUSES.includes(statusRaw as ReviewStatus)) {
      return errorResponse(`Invalid status: ${statusRaw}`, 400);
    }
    status = statusRaw as ReviewStatus;
  }

  try {
    if (proposalIdRaw !== null && proposalIdRaw.trim() !== "") {
      const proposalId = proposalIdRaw.trim();
      const nowMs = Date.now();
      const row = await getProposalById(proposalId);
      if (!row) {
        return absentProposalResponse(proposalId, nowMs);
      }
      const expiry = resolveProposalExpiry(row, { now: nowMs });
      const enriched = enrichProposalWithExpiry(row, { now: nowMs });
      return json({
        proposal: enriched,
        proposals: [enriched],
        proposalId,
        status: row.review_status ?? null,
        ...expiryEnvelope(expiry),
      });
    }

    const result = await listProposalsForReview({ status, limit, offset });
    const freshness = buildObservationFreshness(
      (result as { freshness?: unknown }).freshness as Parameters<typeof buildObservationFreshness>[0],
    );
    return json({
      proposals: result.proposals,
      limit: result.limit,
      offset: result.offset,
      freshness,
    });
  } catch (err) {
    console.error("[proposals/review] GET error:", err);
    return internalErrorResponse(500);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuth(request);
  if (denied) return denied;

  if (!isDbConfigured()) {
    return errorResponse("Database not configured", 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const { action, proposalId, reviewer, approve, reason, reasonCode, privateNote, supersededByProposalId } = body as {
    action: "claim" | "complete" | "cancel" | "supersede" | "expire" | "mark_stale" | "mark_dependency_failed";
    proposalId?: string;
    reviewer?: string;
    approve?: boolean;
    reason?: string;
    reasonCode?: string;
    privateNote?: string;
    supersededByProposalId?: string;
  };

  if (
    typeof body === "object" &&
    body !== null &&
    ("nonce" in body || "expiresAt" in body || "expires_at" in body)
  ) {
    const b = body as Record<string, unknown>;
    const windowResult = validateSignedWindow(b.nonce, b.expiresAt ?? b.expires_at);
    if (!windowResult.ok) {
      return json({ error: { message: windowResult.message, code: windowResult.code, field: windowResult.field } }, 400);
    }
  }

  if (!action) {
    return errorResponse("Missing action", 400);
  }

  let validatedReasonCode: ProposalReviewReasonCode | undefined;
  if (reasonCode !== undefined) {
    if (!isProposalReviewReasonCode(reasonCode)) {
      return errorResponse(`Invalid reasonCode: ${reasonCode}`, 400);
    }
    validatedReasonCode = reasonCode;
  }

  try {
    const nowMs = Date.now();
    switch (action) {
      case "claim": {
        if (!proposalId || !reviewer) {
          return errorResponse("claim requires proposalId and reviewer", 400);
        }
        const existing = await getProposalById(proposalId);
        if (!existing) {
          return absentProposalResponse(proposalId, nowMs);
        }
        const expiry = resolveProposalExpiry(existing, { now: nowMs });
        if (expiry.expired) {
          return expiredProposalResponse(proposalId, existing, expiry);
        }
        const ok = await claimProposalForReview(proposalId, reviewer);
        if (!ok) {
          return errorResponse(
            "Proposal not available for claim (not queued or already claimed)",
            409,
            {
              code: "invalid_state_transition",
              proposalId,
              status: existing.review_status ?? null,
              ...expiryEnvelope(expiry),
            },
          );
        }
        return json({
          success: true,
          proposalId,
          status: "in_review",
          ...expiryEnvelope(expiry),
        });
      }

      case "complete": {
        if (!proposalId || !reviewer || typeof approve !== "boolean") {
          return errorResponse("complete requires proposalId, reviewer, and approve (boolean)", 400);
        }
        const existing = await getProposalById(proposalId);
        if (!existing) {
          return absentProposalResponse(proposalId, nowMs);
        }
        const expiry = resolveProposalExpiry(existing, { now: nowMs });
        if (expiry.expired) {
          return expiredProposalResponse(proposalId, existing, expiry);
        }
        const ok = await completeProposalReview(proposalId, reviewer, approve);
        if (!ok) {
          return errorResponse(
            "Proposal not in review by this reviewer",
            409,
            {
              code: "invalid_state_transition",
              proposalId,
              status: existing.review_status ?? null,
              ...expiryEnvelope(expiry),
            },
          );
        }
        return json({
          success: true,
          proposalId,
          status: approve ? "approved" : "rejected",
          ...expiryEnvelope(expiry),
        });
      }

      case "cancel": {
        // Authorise exactly one proposal transition. The id and reason are
        // validated as non-empty strings so a malformed or blank request can
        // never reach the state change, and only the named proposal is passed
        // through. Other proposals and delegated spending grants are untouched.
        const targetId = requireString(proposalId);
        const cancelReason = requireString(reason);
        if (!targetId || !cancelReason) {
          return errorResponse("cancel requires proposalId and reason", 400);
        }
        const existing = await getProposalById(proposalId);
        if (!existing) {
          return absentProposalResponse(proposalId, nowMs);
        }
        const expiry = resolveProposalExpiry(existing, { now: nowMs });
        if (expiry.expired) {
          return expiredProposalResponse(proposalId, existing, expiry);
        }
        const ok = await cancelProposal(proposalId, reason);
        if (!ok) {
          return errorResponse(
            "Proposal not cancellable (not queued or in_review)",
            409,
            {
              code: "invalid_state_transition",
              proposalId,
              status: existing.review_status ?? null,
              ...expiryEnvelope(expiry),
            },
          );
        }
        return json({
          success: true,
          proposalId,
          status: "cancelled",
          ...expiryEnvelope(expiry),
        });
      }

      case "mark_dependency_failed": {
        if (!proposalId || !reason) {
          return errorResponse("mark_dependency_failed requires proposalId and reason", 400);
        }
        const existing = await getProposalById(proposalId);
        if (!existing) {
          return absentProposalResponse(proposalId, nowMs);
        }
        const expiry = resolveProposalExpiry(existing, { now: nowMs });
        if (expiry.expired) {
          return expiredProposalResponse(proposalId, existing, expiry);
        }
        const ok = await markProposalDependencyFailed(proposalId, reason);
        if (!ok) {
          return errorResponse(
            "Proposal not in a state that can be marked as dependency_failed",
            409,
            {
              code: "invalid_state_transition",
              proposalId,
              status: existing.review_status ?? null,
              ...expiryEnvelope(expiry),
            },
          );
        }
        return json({
          success: true,
          proposalId,
          status: "dependency_failed",
          ...expiryEnvelope(expiry),
        });
      }

      case "mark_stale": {
        const nowSeconds = Math.floor(nowMs / 1000);
        const count = await markStaleProposals(nowSeconds);
        return json({
          success: true,
          markedStale: count,
          policyRevision: resolveProposalExpiryPolicyRevision(
            process.env.PROPOSAL_EXPIRY_POLICY_REVISION,
          ),
          evaluatedAtUtc: toCanonicalUtc(nowMs),
        });
      }

      default:
        return errorResponse(`Unknown action: ${action}`, 400);
    }
  } catch (err) {
    console.error("[proposals/review] Error:", err);
    return internalErrorResponse(500);
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuth(request);
  if (denied) return denied;

  if (!isDbConfigured()) {
    return errorResponse("Database not configured", 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const { proposalId, status, reviewer, failureReason, reasonCode, privateNote, supersededByProposalId } = body as {
    proposalId: string;
    status: ReviewStatus;
    reviewer?: string;
    failureReason?: string;
    reasonCode?: string;
    privateNote?: string;
    supersededByProposalId?: string;
  };

  if (!proposalId || !status) {
    return errorResponse("Missing proposalId or status", 400);
  }

  if (!REVIEW_STATUSES.includes(status)) {
    return errorResponse(`Invalid status: ${status}`, 400);
  }

  let validatedReasonCode: ProposalReviewReasonCode | undefined;
  if (reasonCode !== undefined) {
    if (!isProposalReviewReasonCode(reasonCode)) {
      return errorResponse(`Invalid reasonCode: ${reasonCode}`, 400);
    }
    validatedReasonCode = reasonCode;
  }

  try {
    const nowMs = Date.now();
    const existing = await getProposalById(proposalId);
    if (!existing) {
      return absentProposalResponse(proposalId, nowMs);
    }
    const expiry = resolveProposalExpiry(existing, { now: nowMs });
    if (expiry.expired && status !== "stale") {
      return expiredProposalResponse(proposalId, existing, expiry);
    }

    const ok = await updateProposalReviewStatus(proposalId, status, { reviewer, failureReason });
    if (!ok) {
      return errorResponse("Proposal not found or invalid state transition", 409, {
        code: "invalid_state_transition",
        proposalId,
        status: existing.review_status ?? null,
        ...expiryEnvelope(expiry),
      });
    }
    const updatedExpiry =
      status === "stale"
        ? resolveProposalExpiry({ ...existing, review_status: "stale" }, { now: nowMs })
        : expiry;
    return json({
      success: true,
      proposalId,
      status,
      ...expiryEnvelope(updatedExpiry),
    });
  } catch (err) {
    console.error("[proposals/review] PATCH Error:", err);
    return internalErrorResponse(500);
  }
}
