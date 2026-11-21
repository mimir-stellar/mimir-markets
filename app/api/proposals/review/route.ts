/**
 * The proposal review queue.
 *
 * Reads the pending market-creator proposals and moves them through the
 * queued -> in_review -> approved/rejected state machine. It is an operator tool,
 * not a user-facing API, so every handler is gated on the `internal_worker` tier
 * and the shared `CRON_SECRET` — the same pattern as the cron routes. An unset
 * `CRON_SECRET` refuses rather than waving callers through.
 *
 * Review mutations support authenticated signed request windows (`nonce`, `expiresAt`)
 * and optimistic concurrency control through `expectedRevision`. When an expected
 * revision is provided and the proposal review state is stale (the current review
 * revision is newer than expected), the mutation is rejected with a typed HTTP 409
 * conflict (`apiError("conflict", ...)`), leaving the newer review decision unchanged.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/api/policy";
import { apiError } from "@/lib/api/errors";
import {
  isDbConfigured,
  claimProposalForReview,
  completeProposalReview,
  cancelProposal,
  markProposalDependencyFailed,
  markStaleProposals,
  updateProposalReviewStatus,
  listProposalsForReview,
  getProposal,
  REVIEW_STATUSES,
  type ReviewStatus,
  type MarketProposalRow,
} from "@/lib/db";
import {
  validateSignedWindow,
  validateReviewRevision,
} from "@/lib/signed-window";

export const runtime = "nodejs";

const ROUTE = "/api/proposals/review";

function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

function errorResponse(message: string, status = 400): NextResponse {
  return json({ error: { message } }, status);
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
  if (auth.allowed) return null;
  const error = auth.error;
  if (!error) return errorResponse("Unauthorized", 401);
  return NextResponse.json(error.body, { status: error.status, headers: error.headers });
}

function parseIntParam(raw: string | null): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || Number.isNaN(n)) return undefined;
  return Math.trunc(n);
}

/**
 * Compute the current review revision for a proposal.
 *
 * An unreviewed or queued/in-review proposal is at revision 0.
 * Once a review decision has been recorded (approved, rejected, or decided review),
 * the revision advances to 1. An explicit numeric revision field on the record
 * is preferred when present.
 */
export function getProposalRevision(proposal: MarketProposalRow): number {
  if (typeof (proposal as unknown as { revision?: number }).revision === "number") {
    return (proposal as unknown as { revision?: number }).revision!;
  }
  const isDecided =
    proposal.reviewed_at !== null ||
    proposal.review_status === "approved" ||
    proposal.review_status === "rejected" ||
    (proposal as unknown as { review?: string }).review === "agree" ||
    (proposal as unknown as { review?: string }).review === "disagree";
  return isDecided ? 1 : 0;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuth(request);
  if (denied) return denied;

  if (!isDbConfigured()) {
    return errorResponse("Database not configured", 503);
  }

  const { searchParams } = new URL(request.url);
  const statusRaw = searchParams.get("status");
  const limitRaw = searchParams.get("limit");
  const offsetRaw = searchParams.get("offset");

  let status: ReviewStatus | null = null;
  if (statusRaw !== null && statusRaw !== "") {
    if (!REVIEW_STATUSES.includes(statusRaw as ReviewStatus)) {
      return errorResponse(`Invalid status: ${statusRaw}`, 400);
    }
    status = statusRaw as ReviewStatus;
  }

  const limit = parseIntParam(limitRaw);
  const offset = parseIntParam(offsetRaw);

  try {
    const result = await listProposalsForReview({ status, limit, offset });
    return json({
      proposals: result.proposals,
      limit: result.limit,
      offset: result.offset,
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

  const {
    action,
    proposalId,
    reviewer,
    approve,
    reason,
    nonce,
    expiresAt,
    expectedRevision,
  } = (body ?? {}) as {
    action: "claim" | "complete" | "cancel" | "mark_stale" | "mark_dependency_failed";
    proposalId?: string;
    reviewer?: string;
    approve?: boolean;
    reason?: string;
    nonce?: unknown;
    expiresAt?: unknown;
    expectedRevision?: unknown;
  };

  if (!action) {
    return errorResponse("Missing action", 400);
  }

  if (nonce !== undefined || expiresAt !== undefined) {
    const windowResult = validateSignedWindow(nonce, expiresAt);
    if (!windowResult.ok) {
      const err = apiError(windowResult.code, windowResult.message, { field: windowResult.field });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }
  }

  if (expectedRevision !== undefined) {
    const formatCheck = validateReviewRevision(expectedRevision);
    if (!formatCheck.ok) {
      const err = apiError(formatCheck.code, formatCheck.message, { field: formatCheck.field });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }
    if (!proposalId) {
      const err = apiError("invalid_request", "expectedRevision requires proposalId", {
        field: "expectedRevision",
      });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }
    const currentProposal = await getProposal(proposalId);
    if (!currentProposal) {
      const err = apiError("not_found", `Proposal not found: ${proposalId}`);
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }
    const currentRevision = getProposalRevision(currentProposal);
    const revCheck = validateReviewRevision(expectedRevision, currentRevision);
    if (!revCheck.ok) {
      const err = apiError(revCheck.code, revCheck.message, { field: revCheck.field });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }
  }

  try {
    switch (action) {
      case "claim": {
        if (!proposalId || !reviewer) {
          return errorResponse("claim requires proposalId and reviewer", 400);
        }
        const existing = await getProposal(proposalId);
        if (existing && getProposalRevision(existing) > 0) {
          const err = apiError("conflict", "proposal review revision is stale: review decision already recorded", {
            field: "expectedRevision",
          });
          return NextResponse.json(err.body, { status: err.status, headers: err.headers });
        }
        const ok = await claimProposalForReview(proposalId, reviewer);
        if (!ok) {
          const refreshed = await getProposal(proposalId);
          if (refreshed && getProposalRevision(refreshed) > 0) {
            const err = apiError("conflict", "proposal review revision is stale: review decision already recorded", {
              field: "expectedRevision",
            });
            return NextResponse.json(err.body, { status: err.status, headers: err.headers });
          }
          return errorResponse("Proposal not available for claim (not queued or already claimed)", 409);
        }
        return json({ success: true, proposalId, status: "in_review" });
      }

      case "complete": {
        if (!proposalId || !reviewer || typeof approve !== "boolean") {
          return errorResponse("complete requires proposalId, reviewer, and approve (boolean)", 400);
        }
        const existing = await getProposal(proposalId);
        if (existing && getProposalRevision(existing) > 0) {
          const err = apiError("conflict", "proposal review revision is stale: review decision already recorded", {
            field: "expectedRevision",
          });
          return NextResponse.json(err.body, { status: err.status, headers: err.headers });
        }
        const ok = await completeProposalReview(proposalId, reviewer, approve);
        if (!ok) {
          const refreshed = await getProposal(proposalId);
          if (refreshed && getProposalRevision(refreshed) > 0) {
            const err = apiError("conflict", "proposal review revision is stale: review decision already recorded", {
              field: "expectedRevision",
            });
            return NextResponse.json(err.body, { status: err.status, headers: err.headers });
          }
          return errorResponse("Proposal not in review by this reviewer", 409);
        }
        return json({ success: true, proposalId, status: approve ? "approved" : "rejected" });
      }

      case "cancel": {
        if (!proposalId || !reason) {
          return errorResponse("cancel requires proposalId and reason", 400);
        }
        const ok = await cancelProposal(proposalId, reason);
        if (!ok) {
          return errorResponse("Proposal not cancellable (not queued or in_review)", 409);
        }
        return json({ success: true, proposalId, status: "cancelled" });
      }

      case "mark_dependency_failed": {
        if (!proposalId || !reason) {
          return errorResponse("mark_dependency_failed requires proposalId and reason", 400);
        }
        const ok = await markProposalDependencyFailed(proposalId, reason);
        if (!ok) {
          return errorResponse("Proposal not in a state that can be marked as dependency_failed", 409);
        }
        return json({ success: true, proposalId, status: "dependency_failed" });
      }

      case "mark_stale": {
        const nowSeconds = Math.floor(Date.now() / 1000);
        const count = await markStaleProposals(nowSeconds);
        return json({ success: true, markedStale: count });
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

  const {
    proposalId,
    status,
    reviewer,
    failureReason,
    nonce,
    expiresAt,
    expectedRevision,
  } = (body ?? {}) as {
    proposalId: string;
    status: ReviewStatus;
    reviewer?: string;
    failureReason?: string;
    nonce?: unknown;
    expiresAt?: unknown;
    expectedRevision?: unknown;
  };

  if (!proposalId || !status) {
    return errorResponse("Missing proposalId or status", 400);
  }

  if (!REVIEW_STATUSES.includes(status)) {
    return errorResponse(`Invalid status: ${status}`, 400);
  }

  if (nonce !== undefined || expiresAt !== undefined) {
    const windowResult = validateSignedWindow(nonce, expiresAt);
    if (!windowResult.ok) {
      const err = apiError(windowResult.code, windowResult.message, { field: windowResult.field });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }
  }

  if (expectedRevision !== undefined) {
    const formatCheck = validateReviewRevision(expectedRevision);
    if (!formatCheck.ok) {
      const err = apiError(formatCheck.code, formatCheck.message, { field: formatCheck.field });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }
    const currentProposal = await getProposal(proposalId);
    if (!currentProposal) {
      const err = apiError("not_found", `Proposal not found: ${proposalId}`);
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }
    const currentRevision = getProposalRevision(currentProposal);
    const revisionCheck = validateReviewRevision(expectedRevision, currentRevision);
    if (!revisionCheck.ok) {
      const err = apiError(revisionCheck.code, revisionCheck.message, { field: revisionCheck.field });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }
  }

  try {
    const ok = await updateProposalReviewStatus(proposalId, status, { reviewer, failureReason });
    if (!ok) {
      const refreshed = await getProposal(proposalId);
      if (refreshed && getProposalRevision(refreshed) > 0) {
        const err = apiError("conflict", "proposal review revision is stale: review decision already recorded", {
          field: "expectedRevision",
        });
        return NextResponse.json(err.body, { status: err.status, headers: err.headers });
      }
      return errorResponse("Proposal not found or invalid state transition", 409);
    }
    return json({ success: true, proposalId, status });
  } catch (err) {
    console.error("[proposals/review] PATCH Error:", err);
    return internalErrorResponse(500);
  }
}
