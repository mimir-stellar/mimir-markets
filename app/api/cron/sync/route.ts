import { NextResponse } from "next/server";

import { beat } from "@/lib/ops/heartbeat";
import { apiError } from "@/lib/api/errors";
import { authorizeCronRequest } from "@/lib/api/cron-auth";
import { reconcileVsIndex } from "@/lib/server/vs-index";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Manual/external trigger for the same reconcile the `sync` worker runs on its own
 * interval (agents/sync/index.ts), so it reports the same heartbeat — an operator
 * kicking the index by hand is a real sync, and the probe should see it.
 *
 * Keep in step with SyNC_POLL_INTERVAL_MS: the probe derives its staleness
 * thresholds from the declared interval, and a value shorter than the real cadence
 * would alarm on a healthy worker.
 */
const SYNC_INTERVAL_SEC = Number(process.env.SYNC_POLL_INTERVAL_MS ?? "300000") / 1000;

export async function GET(request: Request) {
  // Authorized outside the try: an unauthenticated caller must never reach the
  // heartbeat below, not even through the error path, or it could keep a dead
  // sync worker looking merely degraded instead of missing. The helper fails
  // closed when CRON_SECRET is unset.
  const auth = authorizeCronRequest(request, "/api/cron/sync");
  if (!auth.allowed && auth.error) {
    // The tier's error already carries a machine-readable code, a retryable flag
    // and a Retry-After when waiting can help.
    return NextResponse.json(auth.error.body, {
      status: auth.error.status,
      headers: auth.error.headers,
    });
  }

  try {
    const summary = await reconcileVsIndex();
    await beat("sync", { intervalSec: SYNC_INTERVAL_SEC });

    return NextResponse.json(
      {
        synced: summary.synced,
        new: summary.new,
        stateChanges: summary.stateChanges,
        corrected: summary.corrected,
        inconsistencies: summary.inconsistencies,
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (error) {
    // Alive and failing, which staleness alone would report as healthy.
    await beat("sync", { error, intervalSec: SYNC_INTERVAL_SEC });
    const err = apiError("internal_error", "Unable to reconcile VS index");
    return NextResponse.json(err.body, { status: err.status, headers: err.headers });
  }
}
