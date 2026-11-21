/**
 * The proposal review queue.
 *
 * Reads the pending market-creator proposals and moves them through the
 * queued -> in_review -> approved/rejected state machine. It is an operator tool,
 * not a user-facing API, so every handler is gated on the `internal_worker` tier
 * and the shared `CRON_SECRET` — the same pattern as the cron routes. An unset
 * `CRON_SECRET` refuses rather than waving callers through.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/api/policy";
import { apiError } from "@/lib/api/errors";
import { getDb, isDbConfigured } from "@/lib/db";
import {
  claimProposalForReview,
  completeProposalReview,
  cancelProposal,
  markProposalDependencyFailed,
  markStaleProposals,
  recordProposalReviewDecision,
  updateProposalReviewStatus,
  listProposalsForReview,
  REVIEW_STATUSES,
  type ReviewStatus,
} from "@/lib/db";
import {
  decisionForReviewStatus,
  defaultReasonCodeForDecision,
  isProposalReviewReasonCode,
  type ProposalReviewReasonCode,
} from "@/lib/proposal-review-history";

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
    switch (action) {
      case "claim": {
        if (!proposalId || !reviewer) {
          return errorResponse("claim requires proposalId and reviewer", 400);
        }
        const ok = await claimProposalForReview(proposalId, reviewer);
        if (!ok) {
          return errorResponse("Proposal not available for claim (not queued or already claimed)", 409);
        }
        return json({ success: true, proposalId, status: "in_review" });
      }

      case "complete": {
        if (!proposalId || !reviewer || typeof approve !== "boolean") {
          return errorResponse("complete requires proposalId, reviewer, and approve (boolean)", 400);
        }
        const ok = await completeProposalReview(proposalId, reviewer, approve);
        if (!ok) {
          return errorResponse("Proposal not in review by this reviewer", 409);
        }
        const decision = approve ? "accepted" : "rejected";
        const effectiveReasonCode = validatedReasonCode ?? defaultReasonCodeForDecision(decision);
        await recordProposalReviewDecision({
          proposalId,
          decision,
          reasonCode: effectiveReasonCode,
          actorId: reviewer,
          privateNote: privateNote ?? reason ?? null,
        });
        return json({
          success: true,
          proposalId,
          status: approve ? "approved" : "rejected",
          decision,
          reasonCode: effectiveReasonCode,
        });
      }

      case "cancel": {
        if (!proposalId || !reason) {
          return errorResponse("cancel requires proposalId and reason", 400);
        }
        const ok = await cancelProposal(proposalId, reason);
        if (!ok) {
          return errorResponse("Proposal not cancellable (not queued or in_review)", 409);
        }
        const decision = supersededByProposalId ? "superseded" : "rejected";
        const effectiveReasonCode =
          validatedReasonCode ??
          (supersededByProposalId ? "SUPERSEDED_BY_NEWER_PROPOSAL" : "CANCELLED_BY_OPERATOR");
        await recordProposalReviewDecision({
          proposalId,
          decision,
          reasonCode: effectiveReasonCode,
          supersededByProposalId: supersededByProposalId ?? null,
          actorId: reviewer ?? null,
          privateNote: privateNote ?? reason,
        });
        return json({
          success: true,
          proposalId,
          status: "cancelled",
          decision,
          reasonCode: effectiveReasonCode,
        });
      }

      case "supersede": {
        if (!proposalId || !supersededByProposalId) {
          return errorResponse("supersede requires proposalId and supersededByProposalId", 400);
        }
        const ok = await cancelProposal(proposalId, reason ?? `superseded by ${supersededByProposalId}`);
        if (!ok) {
          return errorResponse("Proposal not superseding-eligible (not queued or in_review)", 409);
        }
        const effectiveReasonCode = validatedReasonCode ?? "SUPERSEDED_BY_NEWER_PROPOSAL";
        await recordProposalReviewDecision({
          proposalId,
          decision: "superseded",
          reasonCode: effectiveReasonCode,
          supersededByProposalId,
          actorId: reviewer ?? null,
          privateNote: privateNote ?? reason ?? null,
        });
        return json({
          success: true,
          proposalId,
          status: "cancelled",
          decision: "superseded",
          reasonCode: effectiveReasonCode,
          supersededByProposalId,
        });
      }

      case "expire": {
        if (!proposalId) {
          return errorResponse("expire requires proposalId", 400);
        }
        const effectiveReasonCode = validatedReasonCode ?? "REVIEW_DEADLINE_EXPIRED";
        const ok = await updateProposalReviewStatus(proposalId, "stale", {
          failureReason: reason ?? effectiveReasonCode,
        });
        if (!ok) {
          return errorResponse("Proposal not found or could not be expired", 409);
        }
        await recordProposalReviewDecision({
          proposalId,
          decision: "expired",
          reasonCode: effectiveReasonCode,
          actorId: reviewer ?? null,
          privateNote: privateNote ?? reason ?? null,
        });
        return json({
          success: true,
          proposalId,
          status: "stale",
          decision: "expired",
          reasonCode: effectiveReasonCode,
        });
      }

      case "mark_dependency_failed": {
        if (!proposalId || !reason) {
          return errorResponse("mark_dependency_failed requires proposalId and reason", 400);
        }
        const ok = await markProposalDependencyFailed(proposalId, reason);
        if (!ok) {
          return errorResponse("Proposal not in a state that can be marked as dependency_failed", 409);
        }
        const effectiveReasonCode = validatedReasonCode ?? "DEPENDENCY_FAILED";
        await recordProposalReviewDecision({
          proposalId,
          decision: "rejected",
          reasonCode: effectiveReasonCode,
          actorId: reviewer ?? null,
          privateNote: privateNote ?? reason,
        });
        return json({
          success: true,
          proposalId,
          status: "dependency_failed",
          decision: "rejected",
          reasonCode: effectiveReasonCode,
        });
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
    const ok = await updateProposalReviewStatus(proposalId, status, { reviewer, failureReason });
    if (!ok) {
      return errorResponse("Proposal not found or invalid state transition", 409);
    }
    const decision = decisionForReviewStatus(status, { supersededByProposalId });
    if (decision) {
      const effectiveReasonCode =
        validatedReasonCode ??
        (status === "dependency_failed"
          ? "DEPENDENCY_FAILED"
          : status === "cancelled" && !supersededByProposalId
            ? "CANCELLED_BY_OPERATOR"
            : defaultReasonCodeForDecision(decision));
      await recordProposalReviewDecision({
        proposalId,
        decision,
        reasonCode: effectiveReasonCode,
        supersededByProposalId: supersededByProposalId ?? null,
        actorId: reviewer ?? null,
        privateNote: privateNote ?? failureReason ?? null,
      });
    }
    return json({ success: true, proposalId, status });
  } catch (err) {
    console.error("[proposals/review] PATCH Error:", err);
    return internalErrorResponse(500);
  }
}