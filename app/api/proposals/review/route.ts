/**
 * The proposal review queue.
 *
 * Reads the pending market-creator proposals and moves them through the
 * queued -> in_review -> approved/rejected state machine. It is an operator tool,
 * not a user-facing API, so every handler is gated on the `internal_worker` tier
 * and the shared `CRON_SECRET` — the same pattern as the cron routes. An unset
 * `CRON_SECRET` refuses rather than waving callers through.
 *
 * Approval is bound to an immutable canonical market draft digest. When a
 * `complete` approval is recorded, the caller must present the digest of the
 * draft they reviewed (computed over wording, source commitment, stake and
 * deadline). Execution is then refused if the stored draft no longer matches
 * the approved digest, so any post-approval change to an approved draft field
 * invalidates the approval.
 */

import { createHash } from "crypto";
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
  updateProposalReviewStatus,
  listProposalsForReview,
  REVIEW_STATUSES,
  type ReviewStatus,
} from "@/lib/db";

export const runtime = "nodejs";

const ROUTE = "/api/proposals/review";

/** Draft fields bound by the approval digest. Changing any of them invalidates approval. */
export interface MarketDraftFields {
  wording: string;
  sourceCommitment: string;
  stake: number;
  deadline: number;
}

/**
 * Compute the canonical digest of a market draft. Fields are serialized in a
 * fixed order with JSON so the digest is deterministic across callers. `stake`
 * is an integer USDC amount (no floats) and `deadline` an integer unix time.
 */
export function computeMarketDraftDigest(draft: MarketDraftFields): string {
  if (
    typeof draft.wording !== "string" ||
    typeof draft.sourceCommitment !== "string" ||
    !Number.isSafeInteger(draft.stake) ||
    !Number.isSafeInteger(draft.deadline)
  ) {
    throw new Error("invalid market draft fields");
  }
  const canonical = JSON.stringify([
    draft.wording,
    draft.sourceCommitment,
    draft.stake,
    draft.deadline,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Returns true only when the currently stored draft still hashes to the digest
 * that was approved. Used to refuse execution after any approved field changed.
 */
export function isApprovedDraftCurrent(
  approvedDigest: string,
  currentDraft: MarketDraftFields,
): boolean {
  let current: string;
  try {
    current = computeMarketDraftDigest(currentDraft);
  } catch {
    return false;
  }
  return current === approvedDigest;
}

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

  const { action, proposalId, reviewer, approve, reason, approvedDigest } = body as {
    action: "claim" | "complete" | "cancel" | "mark_stale" | "mark_dependency_failed";
    proposalId?: string;
    reviewer?: string;
    approve?: boolean;
    reason?: string;
    approvedDigest?: string;
  };

  if (!action) {
    return errorResponse("Missing action", 400);
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
        if (approve && (typeof approvedDigest !== "string" || !/^[0-9a-f]{64}$/.test(approvedDigest))) {
          return errorResponse("approve requires approvedDigest (sha256 hex of the reviewed draft)", 400);
        }
        const ok = await completeProposalReview(
          proposalId,
          reviewer,
          approve,
          approve ? approvedDigest : undefined,
        );
        if (!ok) {
          return errorResponse("Proposal not in review by this reviewer", 409);
        }
        return json({
          success: true,
          proposalId,
          status: approve ? "approved" : "rejected",
          ...(approve ? { approvedDigest } : {}),
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

  const { proposalId, status, reviewer, failureReason } = body as {
    proposalId: string;
    status: ReviewStatus;
    reviewer?: string;
    failureReason?: string;
  };

  if (!proposalId || !status) {
    return errorResponse("Missing proposalId or status", 400);
  }

  if (!REVIEW_STATUSES.includes(status)) {
    return errorResponse(`Invalid status: ${status}`, 400);
  }

  try {
    const ok = await updateProposalReviewStatus(proposalId, status, { reviewer, failureReason });
    if (!ok) {
      return errorResponse("Proposal not found or invalid state transition", 409);
    }
    return json({ success: true, proposalId, status });
  } catch (err) {
    console.error("[proposals/review] PATCH Error:", err);
    return internalErrorResponse(500);
  }
}
