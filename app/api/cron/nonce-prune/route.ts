/**
 * Cron: prune expired agent API nonces.
 *
 * Rows in `agent_api_nonces` with `expires_at <= now` are outside the envelope
 * skew window (±5 min) and can never be presented as a valid replay again. This
 * route deletes them so the table stays bounded.
 *
 * Recommended schedule: every 15–30 minutes. A nonce TTL is 10 minutes, so
 * running this every 15 minutes means the table holds at most ~1.5× the number
 * of requests seen in one TTL window at peak load — far below any meaningful
 * storage concern.
 *
 * Authorization: same `CRON_SECRET` bearer pattern as the other cron routes.
 */

import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/api/policy";
import { pruneExpiredNonces } from "@/lib/server/nonce-store";
import { apiError } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

let customPrune: typeof pruneExpiredNonces | null = null;

/**
 * Override the prune function for testing.
 */
export function _setPruneExpiredNoncesForTest(fn: typeof pruneExpiredNonces | null): void {
  customPrune = fn;
}

function authorizeWorker(request: Request, route: string) {
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  return authorizeRequest("internal_worker", {
    route,
    presentedSecret: presented,
    expectedSecret: process.env.CRON_SECRET,
  });
}

export async function GET(
  request: Request,
  deps?: { pruneExpiredNonces?: typeof pruneExpiredNonces },
) {
  const auth = authorizeWorker(request, "/api/cron/nonce-prune");
  if (!auth.allowed && auth.error) {
    return NextResponse.json(auth.error.body, {
      status: auth.error.status,
      headers: auth.error.headers,
    });
  }

  const prune = deps?.pruneExpiredNonces ?? customPrune ?? pruneExpiredNonces;
  try {
    const pruned = await prune();
    return NextResponse.json(
      { pruned, at: Date.now() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[cron/nonce-prune] Failed to prune expired nonces:", error);
    const err = apiError("internal_error", "Failed to prune expired nonces");
    return NextResponse.json(err.body, {
      status: err.status,
      headers: {
        ...err.headers,
        "Cache-Control": "no-store",
      },
    });
  }
}
