/**
 * Dedicated operator proposal backlog triage export route.
 *
 * Serves structured grouping of unresolved proposals by age and blocking reason,
 * with private source text and signing metadata omitted.
 * Gated on internal_worker tier and validates signed request windows if provided.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/api/policy";
import { apiError } from "@/lib/api/errors";
import { getProposalBacklogTriage, isDbConfigured } from "@/lib/db";
import { validateSignedWindow } from "@/lib/signed-window";

export const runtime = "nodejs";

const ROUTE = "/api/proposals/review/triage";

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

  // Validate signed window if window parameters or headers are provided
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

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuth(request);
  if (denied) return denied;

  if (!isDbConfigured()) {
    return errorResponse("Database not configured", 503);
  }

  const { searchParams } = new URL(request.url);
  const limit = parseIntParam(searchParams.get("limit"));
  const offset = parseIntParam(searchParams.get("offset"));

  try {
    const result = await getProposalBacklogTriage({ limit, offset });
    return json(result);
  } catch (err) {
    console.error("[proposals/review/triage] GET error:", err);
    return internalErrorResponse(500);
  }
}
