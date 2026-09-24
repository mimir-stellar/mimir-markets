import { NextResponse } from "next/server";

import {
  computeAgentPerformance,
  cumulativePnlPoints,
} from "@/lib/agents/performance";
import { getAgentTradeRows, getSyncMeta } from "@/lib/db";
import type { PortfolioPerformanceResponse } from "@/lib/portfolio-performance";
import {
  createApiError,
  parseAddressParam,
} from "@/lib/server/api-validation";
import { buildVSCacheFreshness } from "@/lib/vs-freshness";

export const dynamic = "force-dynamic";

const DEFAULT_SYNC_INTERVAL_MS = 300_000;
const SETTLEMENT_LAST_SYNC_META_KEY = "settlement_last_sync_at";

function performanceFreshnessWindowMs(): number {
  const configured = Number(process.env.SYNC_POLL_INTERVAL_MS ?? DEFAULT_SYNC_INTERVAL_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_SYNC_INTERVAL_MS;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address: rawAddress } = await params;
  const address = parseAddressParam(rawAddress);
  if (!address) {
    return NextResponse.json(
      createApiError("invalid_parameter", "Invalid address"),
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const [rows, lastSettlementSync] = await Promise.all([
      getAgentTradeRows(address),
      getSyncMeta(SETTLEMENT_LAST_SYNC_META_KEY),
    ]);
    const { performance, results } = computeAgentPerformance(rows);
    const updatedAtMs = Number(lastSettlementSync ?? "0");

    const body: PortfolioPerformanceResponse = {
      points: cumulativePnlPoints(results),
      settled: performance.settled,
      cache: buildVSCacheFreshness({
        updatedAtMs:
          Number.isFinite(updatedAtMs) && updatedAtMs > 0 ? updatedAtMs : null,
        freshnessWindowMs: performanceFreshnessWindowMs(),
        source: "index",
      }),
    };

    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      createApiError("internal_error", "Unable to load portfolio performance"),
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
