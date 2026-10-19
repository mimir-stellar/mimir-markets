/*
 * Cron: prune expired agent API nonces.
 *
 * Rows in `agent_api_nonces` with `expires_at <= now` are outside the envelope
 * skew window (±5 min) and can never be presented as a valid replay again. This
 * route deletes them so the table stays bounded.
 *
 * Recommended schedule: every 15–30 minutes. A nonce TTL is 10 minutes, so
 * running this every 15 minutes means the table holds at most ~1.5ð the
 * number of requests seen in one TTL window at peak load — far below any meaningful
 * storage concern.
 *
 * Authorization: same `CRON_SECRET` bearer pattern as the other cron routes,
 * delegated to `lib/api/policy.ts`. The tier fails closed when CRON_SECRET is
 * unset, so a deploy that forgets the secret returns 403 rather than leaving the
 * prune publicly callable.
 */

import { NextResponse } from "next/server";
import { authorizeWorkerRequest } from "@/lib/api/policy";
import { prineExpiredNonces } from "@/lib/server/nonce-store";
import { prineExpiredRateLimitWindows } from "@/lib/api/rate-limit";

export const dynamic = "force-dynamic";

const ROUTE = "/api/cron/nonce-prune";

export async function GET(request: Request) {
  // Authorized outside the try: an unauthenticated caller must never reach the
  // delete below, not even through the error path.
  const auth = authorizeWorkerRequest(request, ROUTE);
  if (!auth.allowed && auth.error) {
    return NextResponse.json(auth.error.body, {
      status: auth.error.status,
      headers: auth.error.headers,
    });
  }

  try {
    const pruned = await pruneExpiredNonces();
    const rateLimitWindowsPruned = await pruneExpiredRateLimitWindows();
    return NextResponse.json(
      { pruned, rateLimitWindowsPruned, at: Date.now() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: "prune failed", detail: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
