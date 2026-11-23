/**
 * Public read-only proposal review history endpoint.
 *
 * Exposes recorded proposal review decisions (`accepted`, `rejected`,
 * `superseded`, `expired`) with stable machine-readable reason codes.
 * Every entry is projected through `toPublicProposalReviewHistoryEntry` so
 * privileged actor credentials (reviewer identities, operator keys) and
 * private notes are never returned in public views.
 */

import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { isDbConfigured, listProposalReviewHistory } from "@/lib/db";
import {
  isProposalReviewDecision,
  isProposalReviewReasonCode,
  toPublicProposalReviewHistoryEntry,
  type ProposalReviewDecision,
  type ProposalReviewReasonCode,
} from "@/lib/proposal-review-history";

export const runtime = "nodejs";

function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

function errorResponse(message: string, status = 400): NextResponse {
  return json({ error: { message } }, status);
}

function internalErrorResponse(status = 500): NextResponse {
  const result = apiError("internal_error", "Internal server error");
  return NextResponse.json(result.body, { status, headers: result.headers });
}

function parseIntParam(raw: string | null): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || Number.isNaN(n)) return undefined;
  return Math.trunc(n);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isDbConfigured()) {
    return errorResponse("Database not configured", 503);
  }

  const { searchParams } = new URL(request.url);
  const proposalIdRaw = searchParams.get("proposalId")?.trim() || null;
  const decisionRaw = searchParams.get("decision");
  const reasonCodeRaw = searchParams.get("reasonCode");
  const limitRaw = searchParams.get("limit");
  const offsetRaw = searchParams.get("offset");

  let decision: ProposalReviewDecision | null = null;
  if (decisionRaw !== null && decisionRaw !== "") {
    if (!isProposalReviewDecision(decisionRaw)) {
      return errorResponse(`Invalid decision: ${decisionRaw}`, 400);
    }
    decision = decisionRaw;
  }

  let reasonCode: ProposalReviewReasonCode | null = null;
  if (reasonCodeRaw !== null && reasonCodeRaw !== "") {
    if (!isProposalReviewReasonCode(reasonCodeRaw)) {
      return errorResponse(`Invalid reasonCode: ${reasonCodeRaw}`, 400);
    }
    reasonCode = reasonCodeRaw;
  }

  const limit = parseIntParam(limitRaw);
  const offset = parseIntParam(offsetRaw);

  try {
    const result = await listProposalReviewHistory({
      proposalId: proposalIdRaw,
      decision,
      reasonCode,
      limit,
      offset,
    });
    return json({
      history: result.entries.map(toPublicProposalReviewHistoryEntry),
      limit: result.limit,
      offset: result.offset,
    });
  } catch (err) {
    console.error("[proposals/review/history] GET error:", err);
    return internalErrorResponse(500);
  }
}
