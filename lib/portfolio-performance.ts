import type { PnlPoint } from "@/lib/agents/performance";
import type { VSCacheFreshness } from "@/lib/vs-freshness";

export type PerformanceState = "available" | "unavailable" | "insufficient-history";

export interface PortfolioPerformanceResponse {
  points: PnlPoint[];
  settled: number;
  cache: VSCacheFreshness;
  /** Explicit performance state without inventing zero returns for missing samples. */
  state?: PerformanceState;
}

function isCacheFreshness(value: unknown): value is VSCacheFreshness {
  if (!value || typeof value !== "object") return false;
  const cache = value as Record<string, unknown>;
  return (
    (cache.source === "index" || cache.source === "contract") &&
    (cache.status === "live" || cache.status === "cached" || cache.status === "stale") &&
    (cache.lastUpdatedAt === null || typeof cache.lastUpdatedAt === "string") &&
    (cache.ageMs === null ||
      (typeof cache.ageMs === "number" && Number.isFinite(cache.ageMs) && cache.ageMs >= 0)) &&
    typeof cache.freshnessWindowMs === "number" &&
    Number.isFinite(cache.freshnessWindowMs) &&
    cache.freshnessWindowMs > 0
  );
}

/**
 * Deduce the explicit performance state without inventing zero returns.
 *
 * - "unavailable": malformed data, non-finite values or timestamps.
 * - "insufficient-history": no settled trades or zero points.
 * - "available": at least one valid settled performance sample.
 */
export function resolvePerformanceState(
  points?: Array<{ timestamp?: number; value?: number | null } | null> | null,
  settled?: number | null,
): PerformanceState {
  if (settled !== undefined && settled !== null) {
    if (!Number.isFinite(settled) || settled < 0) return "unavailable";
    if (settled === 0) return "insufficient-history";
  }
  if (!points || !Array.isArray(points) || points.length === 0) {
    return "insufficient-history";
  }
  const hasInvalid = points.some((p) => {
    if (!p || typeof p !== "object") return true;
    if (typeof p.timestamp !== "number" || !Number.isFinite(p.timestamp) || p.timestamp <= 0) {
      return true;
    }
    if (p.value !== null && p.value !== undefined && !Number.isFinite(p.value)) {
      return true;
    }
    return false;
  });
  if (hasInvalid) return "unavailable";

  const hasFiniteValue = points.some(
    (p) => p && typeof p.value === "number" && Number.isFinite(p.value),
  );
  if (!hasFiniteValue) {
    return "insufficient-history";
  }

  return "available";
}

/**
 * Performance reducer that derives an explicit PortfolioPerformanceResponse
 * from settled points without inventing zero returns for missing history.
 */
export function reducePortfolioPerformance({
  points,
  settled,
  cache,
}: {
  points: PnlPoint[];
  settled: number;
  cache: VSCacheFreshness;
}): PortfolioPerformanceResponse {
  const state = resolvePerformanceState(points, settled);
  return {
    points,
    settled,
    cache,
    state,
  };
}

/**
 * Browser boundary guard for the portfolio performance endpoint.
 *
 * A malformed monetary point must fail closed rather than become an SVG NaN or
 * look like a legitimate zero. The server still performs all accounting in
 * atomic USDC; only the display series crosses this boundary as numbers.
 */
export function isPortfolioPerformanceResponse(
  value: unknown,
): value is PortfolioPerformanceResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  if (
    typeof response.settled !== "number" ||
    !Number.isInteger(response.settled) ||
    response.settled < 0
  ) return false;
  if (!Array.isArray(response.points) || !isCacheFreshness(response.cache)) return false;

  if (
    response.state !== undefined &&
    response.state !== "available" &&
    response.state !== "unavailable" &&
    response.state !== "insufficient-history"
  ) {
    return false;
  }

  return response.points.every((point) => {
    if (!point || typeof point !== "object") return false;
    const item = point as Record<string, unknown>;
    return (
      typeof item.timestamp === "number" &&
      Number.isFinite(item.timestamp) &&
      item.timestamp > 0 &&
      typeof item.value === "number" &&
      Number.isFinite(item.value)
    );
  });
}
