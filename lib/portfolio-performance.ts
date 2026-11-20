import type { PnlPoint } from "@/lib/agents/performance";
import type { VSCacheFreshness } from "@/lib/vs-freshness";

export interface PortfolioPerformanceResponse {
  points: PnlPoint[];
  settled: number;
  cache: VSCacheFreshness;
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

// ── Chart Ranges & Time Bounds ────────────────────────────────────────────────

export const PORTFOLIO_CHART_RANGES = ["24h", "7d", "30d", "all"] as const;
export type PortfolioChartRange = (typeof PORTFOLIO_CHART_RANGES)[number];

export interface TimeBounds {
  from?: number;
  to?: number;
}

export interface PerformanceRangeState {
  range: PortfolioChartRange;
  from?: number;
  to?: number;
}

export const DEFAULT_PERFORMANCE_RANGE: PerformanceRangeState = {
  range: "all",
};

export const MAX_TABLE_ROWS = 50;

export function formatChartDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(5, 10);
}

export function buildPerformanceChartRows(
  points: Array<{ timestamp: number; value: number }> = [],
  valueSuffix: string = " USDC",
) {
  const total = points.length;
  const truncated = total > MAX_TABLE_ROWS;
  const slice = truncated ? points.slice(-MAX_TABLE_ROWS) : points;
  const rows = slice.map((p) => ({
    date: formatChartDay(p.timestamp),
    value: `${p.value.toFixed(2)}${valueSuffix}`,
  }));
  return { rows, total, truncated };
}

/**
 * Checks whether a value is one of the supported preset chart ranges.
 */
export function isPortfolioChartRange(value: unknown): value is PortfolioChartRange {
  return typeof value === "string" && (PORTFOLIO_CHART_RANGES as readonly string[]).includes(value);
}

export interface TimeBoundsValidation {
  valid: boolean;
  reason?: "invalid_type" | "non_finite" | "non_positive" | "contradictory";
  error?: string;
}

/**
 * Reject invalid or contradictory time bounds.
 *
 * Rules:
 * - Timestamps must be finite positive numbers (> 0).
 * - Bounds must not contradict: `from` must be strictly earlier than `to` (from < to).
 * - Single-ended bounds (only `from` or only `to`) are valid if positive and finite.
 * - Missing or undefined bounds are valid (unbounded).
 */
export function validateTimeBounds(
  from?: unknown,
  to?: unknown,
): TimeBoundsValidation {
  const numFrom =
    typeof from === "string" && from.trim() !== ""
      ? Number(from)
      : typeof from === "number"
        ? from
        : undefined;

  const numTo =
    typeof to === "string" && to.trim() !== ""
      ? Number(to)
      : typeof to === "number"
        ? to
        : undefined;

  if (from !== undefined && from !== null && from !== "") {
    if (numFrom === undefined || !Number.isFinite(numFrom)) {
      return { valid: false, reason: "non_finite", error: "Start bound 'from' must be a finite number." };
    }
    if (numFrom <= 0) {
      return { valid: false, reason: "non_positive", error: "Start bound 'from' must be a positive timestamp." };
    }
  }

  if (to !== undefined && to !== null && to !== "") {
    if (numTo === undefined || !Number.isFinite(numTo)) {
      return { valid: false, reason: "non_finite", error: "End bound 'to' must be a finite number." };
    }
    if (numTo <= 0) {
      return { valid: false, reason: "non_positive", error: "End bound 'to' must be a positive timestamp." };
    }
  }

  if (numFrom !== undefined && numTo !== undefined) {
    if (numFrom >= numTo) {
      return {
        valid: false,
        reason: "contradictory",
        error: `Contradictory time bounds: start bound (${numFrom}) must be strictly earlier than end bound (${numTo}).`,
      };
    }
  }

  return { valid: true };
}

export function areTimeBoundsValid(bounds?: TimeBounds | null): boolean {
  if (!bounds) return true;
  return validateTimeBounds(bounds.from, bounds.to).valid;
}

/**
 * Parses and normalizes chart range URL search parameters.
 *
 * Rejects invalid or contradictory time bounds by discarding them and falling back
 * to a valid preset range (or "all").
 */
export function parsePerformanceRangeUrlParams(
  input: URLSearchParams | string | Record<string, string | string[] | undefined> | null | undefined,
): PerformanceRangeState {
  if (!input) return { ...DEFAULT_PERFORMANCE_RANGE };

  let sp: URLSearchParams;
  if (typeof input === "string") {
    const query = input.startsWith("?") ? input.slice(1) : input;
    sp = new URLSearchParams(query);
  } else if (input instanceof URLSearchParams) {
    sp = input;
  } else {
    sp = new URLSearchParams();
    for (const [key, val] of Object.entries(input)) {
      if (val !== undefined && val !== null) {
        if (Array.isArray(val)) {
          if (val.length > 0 && typeof val[0] === "string") sp.set(key, val[0]);
        } else if (typeof val === "string") {
          sp.set(key, val);
        }
      }
    }
  }

  const rawRange = (sp.get("range") ?? sp.get("window") ?? "").trim().toLowerCase();
  const range: PortfolioChartRange = isPortfolioChartRange(rawRange) ? rawRange : "all";

  const rawFrom = sp.get("from");
  const rawTo = sp.get("to");

  if (rawFrom === null && rawTo === null) {
    return { range };
  }

  const validation = validateTimeBounds(rawFrom, rawTo);
  if (!validation.valid) {
    // Contradictory or invalid bounds rejected; return clean preset range
    return { range };
  }

  const from = rawFrom !== null && rawFrom.trim() !== "" ? Number(rawFrom) : undefined;
  const to = rawTo !== null && rawTo.trim() !== "" ? Number(rawTo) : undefined;

  return {
    range,
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  };
}

/**
 * Serializes chart range state into a normalized query string.
 *
 * Preserves selected ranges in canonical form:
 * - Defaults (`range=all` without custom bounds) produce empty string `""`.
 * - Contradictory or invalid bounds are rejected before serialization.
 */
export function serializePerformanceRangeUrlParams(
  state: PerformanceRangeState,
): string {
  const p = new URLSearchParams();

  if (state.from !== undefined || state.to !== undefined) {
    const validation = validateTimeBounds(state.from, state.to);
    if (validation.valid) {
      if (state.from !== undefined) p.set("from", String(Math.floor(state.from)));
      if (state.to !== undefined) p.set("to", String(Math.floor(state.to)));
    }
  }

  if (state.range && state.range !== "all") {
    p.set("range", state.range);
  }

  return p.toString();
}

/**
 * Resolves the effective time window [sinceMs, untilMs] for a range state.
 */
export function resolveRangeTimeWindow(
  state: PerformanceRangeState | PortfolioChartRange,
  nowMs: number = Date.now(),
): { sinceMs?: number; untilMs?: number } {
  const rangeState: PerformanceRangeState =
    typeof state === "string" ? { range: state } : state;

  if (!areTimeBoundsValid(rangeState)) {
    return {};
  }

  let sinceMs = rangeState.from;
  const untilMs = rangeState.to;

  if (sinceMs === undefined && rangeState.range !== "all") {
    const hours =
      rangeState.range === "24h"
        ? 24
        : rangeState.range === "7d"
          ? 24 * 7
          : rangeState.range === "30d"
            ? 24 * 30
            : 0;
    if (hours > 0) {
      sinceMs = nowMs - hours * 3_600_000;
    }
  }

  return { sinceMs, untilMs };
}

/**
 * Pure performance reducer: filters and reduces historical results derived from
 * indexed market observations into the active range.
 *
 * Contradictory or invalid time bounds are rejected, failing closed or falling back
 * to the safe baseline points without injecting NaNs or corrupting SVG coordinates.
 */
export function reducePerformancePoints<T extends { timestamp: number; value: number }>(
  points: readonly T[],
  rangeOrBounds?: PerformanceRangeState | PortfolioChartRange | TimeBounds | null,
  nowMs: number = Date.now(),
): T[] {
  if (!Array.isArray(points) || points.length === 0) return [];

  const state: PerformanceRangeState =
    typeof rangeOrBounds === "string"
      ? { range: rangeOrBounds }
      : rangeOrBounds && "range" in rangeOrBounds
        ? (rangeOrBounds as PerformanceRangeState)
        : rangeOrBounds
          ? { range: "all", from: rangeOrBounds.from, to: rangeOrBounds.to }
          : { range: "all" };

  const validation = validateTimeBounds(state.from, state.to);
  if (!validation.valid) {
    // Contradictory / invalid bounds rejected; preserve safe valid series
    return points.filter(
      (p) => Number.isFinite(p.timestamp) && p.timestamp > 0 && Number.isFinite(p.value),
    );
  }

  const { sinceMs, untilMs } = resolveRangeTimeWindow(state, nowMs);

  return points.filter((point) => {
    if (!Number.isFinite(point.timestamp) || point.timestamp <= 0 || !Number.isFinite(point.value)) {
      return false;
    }
    if (sinceMs !== undefined && point.timestamp < sinceMs) return false;
    if (untilMs !== undefined && point.timestamp > untilMs) return false;
    return true;
  });
}

export type PerformanceRangeAction =
  | { type: "SET_RANGE"; range: PortfolioChartRange }
  | { type: "SET_TIME_BOUNDS"; from?: number; to?: number }
  | { type: "RESTORE_RANGE"; range: PortfolioChartRange; from?: number; to?: number }
  | { type: "RESET" };

/**
 * Performance range state reducer.
 *
 * Transitions are pure and reject contradictory or invalid time bounds.
 */
export function performanceRangeReducer(
  state: PerformanceRangeState,
  action: PerformanceRangeAction,
): PerformanceRangeState {
  switch (action.type) {
    case "SET_RANGE":
      return { range: action.range };

    case "SET_TIME_BOUNDS": {
      const validation = validateTimeBounds(action.from, action.to);
      if (!validation.valid) {
        // Reject invalid or contradictory time bounds: leave state unchanged
        return state;
      }
      return {
        range: "all",
        from: action.from,
        to: action.to,
      };
    }

    case "RESTORE_RANGE": {
      const validation = validateTimeBounds(action.from, action.to);
      if (!validation.valid) {
        // Contradictory bounds in restore action: reject and keep valid range
        return { range: action.range || "all" };
      }
      return {
        range: action.range || "all",
        from: action.from,
        to: action.to,
      };
    }

    case "RESET":
      return { ...DEFAULT_PERFORMANCE_RANGE };

    default:
      return state;
  }
}
