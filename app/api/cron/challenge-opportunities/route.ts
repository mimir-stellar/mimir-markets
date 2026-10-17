import { NextResponse } from "next/server";

import { apiError } from "@/lib/api/errors";
import { authorizeCronRequest } from "@/lib/api/cron-auth";
import { refreshChallengeOpportunitiesIndex } from "@/lib/server/challenge-opportunities";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  // Authorize outside the try: an unauthenticated caller must never reach the
  // refresh below, not even through the error path. The tier fails closed when
  // CRON_SECRET is unset, and the helper is the only place that reads it.
  const auth = authorizeCronRequest(request, "/api/cron/challenge-opportunities");
  if (!auth.allowed && auth.error) {
    // The tier's error already carries a machine-readable code, a retryable flag
    // and a Retry-After when waiting can help.
    return NextResponse.json(auth.error.body, {
      status: auth.error.status,
      headers: auth.error.headers,
    });
  }

  if (process.env.NEXT_PUBLIC_FEATURE_SOURCE_DRAFTS !== "1") {
    const err = apiError("not_found", "Challenge opportunities are not enabled");
    return NextResponse.json(err.body, { status: err.status, headers: err.headers });
  }

  try {
    const summary = await refreshChallengeOpportunitiesIndex();

    return NextResponse.json(
      {
        generatedAt: new Date(summary.generatedAt).toISOString(),
        locales: summary.locales,
        countsByLocale: summary.countsByLocale,
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to refresh challenge opportunities";

    const code = /not configured/i.test(message) ? "upstream_unavailable" : "internal_error";
    const err = apiError(code, message);

    return NextResponse.json(err.body, { status: err.status, headers: err.headers });
  }
}
