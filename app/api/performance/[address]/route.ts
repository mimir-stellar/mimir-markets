import { NextRequest } from "next/server";

import { handlePerformanceGet } from "@/lib/server/performance-route-handler";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params;
  const cursor = request.nextUrl.searchParams.get("cursor") ?? undefined;
  return handlePerformanceGet(address, {
    ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined,
    // Freshness metadata (trusted ledger, observation time, known gaps) is
    // attached by the shared response schema in lib/api/schema.ts so that
    // feed, detail and performance endpoints report it identically.
    cursor,
  });
}