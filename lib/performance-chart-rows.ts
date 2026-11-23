/**
 * Keyboard-accessible table rows for PerformanceChart.
 *
 * Keyboard and screen-reader users cannot hover SVG points, so PerformanceChart
 * provides a "Show data" table toggle. This module converts raw performance points
 * into tabular rows while preserving explicit unavailable and insufficient-history
 * semantics without inventing zero returns for missing samples.
 */

import type { PerformanceState } from "@/lib/portfolio-performance";

export const MAX_TABLE_ROWS = 50;

/** Format an epoch timestamp in milliseconds to YYYY-MM-DD. */
export function formatChartDay(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "—";
  return new Date(timestamp).toISOString().slice(5, 10);
}

export interface PerformanceChartRow {
  date: string;
  value: string;
  state: PerformanceState;
  timestamp?: number;
}

export interface PerformanceChartTable {
  rows: PerformanceChartRow[];
  total: number;
  truncated: boolean;
  state: PerformanceState;
}

export interface BuildPerformanceChartRowsOptions {
  maxRows?: number;
  state?: PerformanceState;
}

/**
 * Build semantically consistent table rows from performance points.
 *
 * Missing or null sample values are explicitly labeled as "Unavailable" (or
 * "Insufficient history") rather than formatting as "0.00 USDC".
 */
export function buildPerformanceChartRows(
  points?: Array<{ timestamp: number; value?: number | null; state?: PerformanceState } | null> | null,
  valueSuffix: string = " USDC",
  options?: BuildPerformanceChartRowsOptions,
): PerformanceChartTable {
  const max = options?.maxRows ?? MAX_TABLE_ROWS;

  if (!points || !Array.isArray(points) || points.length === 0) {
    const tableState: PerformanceState = options?.state ?? "insufficient-history";
    return {
      rows: [],
      total: 0,
      truncated: false,
      state: tableState,
    };
  }

  const rows: PerformanceChartRow[] = points.map((point) => {
    if (!point || typeof point !== "object") {
      return {
        date: "—",
        value: "Unavailable",
        state: "unavailable",
      };
    }

    const date = formatChartDay(point.timestamp);
    const isMissingValue =
      point.value === null || point.value === undefined || !Number.isFinite(point.value);

    if (isMissingValue) {
      const sampleState: PerformanceState = point.state ?? "unavailable";
      const valueLabel =
        sampleState === "insufficient-history" ? "Insufficient history" : "Unavailable";
      return {
        date,
        value: valueLabel,
        state: sampleState,
        timestamp: point.timestamp,
      };
    }

    const numericValue = point.value as number;
    return {
      date,
      value: `${numericValue.toFixed(2)}${valueSuffix}`,
      state: point.state ?? "available",
      timestamp: point.timestamp,
    };
  });

  const total = rows.length;
  const truncated = total > max;
  const slicedRows = truncated ? rows.slice(-max) : rows;

  const derivedState: PerformanceState = options?.state ?? (
    slicedRows.some((r) => r.state === "unavailable")
      ? "unavailable"
      : slicedRows.every((r) => r.state === "insufficient-history")
        ? "insufficient-history"
        : "available"
  );

  return {
    rows: slicedRows,
    total,
    truncated,
    state: derivedState,
  };
}
