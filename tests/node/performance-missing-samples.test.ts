import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPerformanceChartRows,
  formatChartDay,
  MAX_TABLE_ROWS,
} from "../../lib/performance-chart-rows";
import {
  isPortfolioPerformanceResponse,
  reducePortfolioPerformance,
  resolvePerformanceState,
  type PerformanceState,
} from "../../lib/portfolio-performance";

const VALID_CACHE = {
  source: "index" as const,
  status: "live" as const,
  lastUpdatedAt: "2026-10-01T00:00:00.000Z",
  ageMs: 1_000,
  freshnessWindowMs: 300_000,
};

test("resolvePerformanceState: distinguishes available, unavailable, and insufficient-history", () => {
  // Empty points or zero settled => insufficient-history
  assert.equal(resolvePerformanceState([], 0), "insufficient-history");
  assert.equal(resolvePerformanceState([], 5), "insufficient-history");
  assert.equal(resolvePerformanceState(null, 0), "insufficient-history");

  // Valid samples with settled > 0 => available
  assert.equal(
    resolvePerformanceState([{ timestamp: 1_800_000_000_000, value: 12.5 }], 1),
    "available",
  );

  // Invalid / non-finite timestamps or values => unavailable
  assert.equal(
    resolvePerformanceState([{ timestamp: Number.NaN, value: 10 }], 1),
    "unavailable",
  );
  assert.equal(
    resolvePerformanceState([{ timestamp: 0, value: 10 }], 1),
    "unavailable",
  );
  assert.equal(
    resolvePerformanceState([{ timestamp: -100, value: 10 }], 1),
    "unavailable",
  );
  assert.equal(
    resolvePerformanceState([{ timestamp: 1_800_000_000_000, value: Number.POSITIVE_INFINITY }], 1),
    "unavailable",
  );
  assert.equal(
    resolvePerformanceState([{ timestamp: 1_800_000_000_000, value: 10 }], -1),
    "unavailable",
  );

  // Samples with only null values => insufficient-history (not zero)
  assert.equal(
    resolvePerformanceState([{ timestamp: 1_800_000_000_000, value: null }]),
    "insufficient-history",
  );
});

test("reducePortfolioPerformance: attaches explicit state without inventing zero returns", () => {
  const points = [
    { timestamp: 1_800_000_000_000, value: 5.25 },
    { timestamp: 1_800_000_060_000, value: 10.5 },
  ];
  const response = reducePortfolioPerformance({
    points,
    settled: 2,
    cache: VALID_CACHE,
  });

  assert.equal(response.state, "available");
  assert.equal(response.settled, 2);
  assert.equal(isPortfolioPerformanceResponse(response), true);

  const emptyResponse = reducePortfolioPerformance({
    points: [],
    settled: 0,
    cache: VALID_CACHE,
  });
  assert.equal(emptyResponse.state, "insufficient-history");
  assert.equal(isPortfolioPerformanceResponse(emptyResponse), true);
});

test("isPortfolioPerformanceResponse: validates explicit state values", () => {
  const base = {
    points: [{ timestamp: 1_800_000_000_000, value: 1 }],
    settled: 1,
    cache: VALID_CACHE,
  };

  assert.equal(isPortfolioPerformanceResponse({ ...base, state: "available" }), true);
  assert.equal(isPortfolioPerformanceResponse({ ...base, state: "unavailable" }), true);
  assert.equal(isPortfolioPerformanceResponse({ ...base, state: "insufficient-history" }), true);
  assert.equal(isPortfolioPerformanceResponse({ ...base, state: "unknown" }), false);
  assert.equal(isPortfolioPerformanceResponse({ ...base, state: 123 }), false);
});

test("buildPerformanceChartRows: explains missing samples as Unavailable without inventing 0.00 USDC", () => {
  const points = [
    { timestamp: 1_800_000_000_000, value: 10.5 },
    { timestamp: 1_800_086_400_000, value: null }, // Missing sample
    { timestamp: 1_800_172_800_000, value: undefined }, // Missing sample
    { timestamp: 1_800_259_200_000, value: 0 }, // Actual zero return
    { timestamp: 1_800_345_600_000, value: null, state: "insufficient-history" as PerformanceState },
  ];

  const table = buildPerformanceChartRows(points, " USDC");

  assert.equal(table.total, 5);
  assert.equal(table.truncated, false);

  // Valid positive number
  assert.equal(table.rows[0].value, "10.50 USDC");
  assert.equal(table.rows[0].state, "available");

  // Missing sample (null): MUST be "Unavailable", NEVER "0.00 USDC"
  assert.equal(table.rows[1].value, "Unavailable");
  assert.notEqual(table.rows[1].value, "0.00 USDC");
  assert.equal(table.rows[1].state, "unavailable");

  // Missing sample (undefined): MUST be "Unavailable", NEVER "0.00 USDC"
  assert.equal(table.rows[2].value, "Unavailable");
  assert.notEqual(table.rows[2].value, "0.00 USDC");
  assert.equal(table.rows[2].state, "unavailable");

  // Legitimate zero return: represented as "0.00 USDC"
  assert.equal(table.rows[3].value, "0.00 USDC");
  assert.equal(table.rows[3].state, "available");

  // Insufficient history sample
  assert.equal(table.rows[4].value, "Insufficient history");
  assert.equal(table.rows[4].state, "insufficient-history");
});

test("buildPerformanceChartRows: handles empty or null input with explicit state", () => {
  const emptyTable = buildPerformanceChartRows([]);
  assert.equal(emptyTable.rows.length, 0);
  assert.equal(emptyTable.total, 0);
  assert.equal(emptyTable.state, "insufficient-history");

  const nullTable = buildPerformanceChartRows(null, " USDC", { state: "unavailable" });
  assert.equal(nullTable.rows.length, 0);
  assert.equal(nullTable.state, "unavailable");
});

test("buildPerformanceChartRows: truncates to maxRows preserving latest points", () => {
  const points = Array.from({ length: 60 }, (_, i) => ({
    timestamp: 1_800_000_000_000 + i * 86_400_000,
    value: i * 1.5,
  }));

  const table = buildPerformanceChartRows(points, " USDC");
  assert.equal(table.total, 60);
  assert.equal(table.truncated, true);
  assert.equal(table.rows.length, MAX_TABLE_ROWS);
  // Last row should correspond to the 60th point (index 59)
  assert.equal(table.rows[table.rows.length - 1].value, `${(59 * 1.5).toFixed(2)} USDC`);
});

test("formatChartDay: handles invalid or edge case timestamps", () => {
  assert.equal(formatChartDay(0), "—");
  assert.equal(formatChartDay(-1), "—");
  assert.equal(formatChartDay(Number.NaN), "—");
  assert.match(formatChartDay(1_800_000_000_000), /^\d{2}-\d{2}$/);
});
