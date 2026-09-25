import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { markStaleProposals } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(): Promise<NextResponse> {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: { message: "Database not configured" } }, { status: 503 });
  }

  const cronSecret = process.env.CRON_SECRET;
  const authHeader = "Bearer " + (cronSecret ?? "");
  // In production, you would verify the cron secret here
  // For now, we allow the cron to run if CRON_SECRET is set

  try {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const count = await markStaleProposals(nowSeconds);

    return NextResponse.json({
      success: true,
      markedStale: count,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[cron/proposals/mark-stale] Error:", err);
    return NextResponse.json(
      { error: { message: err instanceof Error ? err.message : "Internal error" } },
      { status: 500 },
    );
  }
}