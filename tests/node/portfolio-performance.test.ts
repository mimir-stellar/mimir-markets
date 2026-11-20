import assert from "node:assert/strict";
import test from "node:test";

import {
  formatTrustedLedger,
  isPerformanceObservationCoverage,
  isPortfolioPerformanceResponse,
  normalizeMissingIntervals,
  parseTrustedLedger,
  splitPointsByMissingIntervals,
} from "../../lib/portfolio-performance";

const CACHE = {
  source: "index" as const,
  status: "live" as const,
  lastUpdatedAt: "2026-09-24T00:00:00.000Z",
  ageMs: 1_000,
  freshnessWindowMs: 300_000,
};

test("accepts a finite settled-performance payload", () => {
  assert.equal(
    isPortfolioPerformanceResponse({
      points: [
        { timestamp: 1_800_000_000_000, value: 2 },
        { timestamp: 1_800_000_060_000, value: -0.5 },
      ],
      settled: 2,
      cache: CACHE,
    }),
    true,
  );
});

test("accepts an empty but valid performance series", () => {
  assert.equal(
    isPortfolioPerformanceResponse({
      points: [],
      settled: 0,
      cache: { ...CACHE, status: "stale", ageMs: null, lastUpdatedAt: null },
    }),
    true,
  );
});

test("rejects non-finite money and timestamps instead of displaying them as zero", () => {
  for (const point of [
    { timestamp: Number.NaN, value: 1 },
    { timestamp: 0, value: 1 },
    { timestamp: 1, value: Number.POSITIVE_INFINITY },
  ]) {
    assert.equal(
      isPortfolioPerformanceResponse({ points: [point], settled: 1, cache: CACHE }),
      false,
    );
  }
});

test("rejects malformed freshness and settlement counts", () => {
  assert.equal(
    isPortfolioPerformanceResponse({ points: [], settled: -1, cache: CACHE }),
    false,
  );
  assert.equal(
    isPortfolioPerformanceResponse({
      points: [],
      settled: 0,
      cache: { ...CACHE, status: "unknown" },
    }),
    false,
  );
});

test("accepts observation coverage with lastTrustedLedger and missingIntervals", () => {
  assert.equal(
    isPortfolioPerformanceResponse({
      points: [
        { timestamp: 1_800_000_000_000, value: 0 },
        { timestamp: 1_800_000_300_000, value: 4.5 },
      ],
      settled: 2,
      cache: CACHE,
      coverage: {
        lastTrustedLedger: 123_456,
        missingIntervals: [
          {
            startTimestamp: 1_800_000_060_000,
            endTimestamp: 1_800_000_180_000,
            reason: "indexer lag",
          },
        ],
      },
    }),
    true,
  );

  assert.equal(
    isPerformanceObservationCoverage({
      lastTrustedLedger: null,
      missingIntervals: [],
    }),
    true,
  );
});

test("rejects malformed observation coverage rather than silently accepting it", () => {
  for (const badCoverage of [
    { lastTrustedLedger: -1, missingIntervals: [] },
    { lastTrustedLedger: 12.5, missingIntervals: [] },
    { lastTrustedLedger: "123", missingIntervals: [] },
    { lastTrustedLedger: 100, missingIntervals: "none" },
    {
      lastTrustedLedger: 100,
      missingIntervals: [{ startTimestamp: 200, endTimestamp: 100 }],
    },
    {
      lastTrustedLedger: 100,
      missingIntervals: [{ startTimestamp: 0, endTimestamp: 100 }],
    },
    {
      lastTrustedLedger: 100,
      missingIntervals: [{ startTimestamp: 100, endTimestamp: 200, reason: 42 }],
    },
  ]) {
    assert.equal(
      isPortfolioPerformanceResponse({
        points: [],
        settled: 0,
        cache: CACHE,
        coverage: badCoverage,
      }),
      false,
    );
  }
});

test("parseTrustedLedger accepts non-negative integers and fails closed on invalid input", () => {
  assert.equal(parseTrustedLedger("543210"), 543_210);
  assert.equal(parseTrustedLedger(" 0 "), 0);
  assert.equal(parseTrustedLedger(99), 99);
  assert.equal(parseTrustedLedger(null), null);
  assert.equal(parseTrustedLedger(undefined), null);
  assert.equal(parseTrustedLedger(""), null);
  assert.equal(parseTrustedLedger("-5"), null);
  assert.equal(parseTrustedLedger("12.34"), null);
  assert.equal(parseTrustedLedger("abc"), null);
  assert.equal(parseTrustedLedger(-1), null);
  assert.equal(parseTrustedLedger(Number.NaN), null);
});

test("normalizeMissingIntervals sorts and merges overlapping intervals", () => {
  const merged = normalizeMissingIntervals([
    { startTimestamp: 300, endTimestamp: 400, reason: "late" },
    { startTimestamp: 100, endTimestamp: 200, reason: "first" },
    { startTimestamp: 180, endTimestamp: 250 },
  ]);
  assert.deepEqual(merged, [
    { startTimestamp: 100, endTimestamp: 250, reason: "first" },
    { startTimestamp: 300, endTimestamp: 400, reason: "late" },
  ]);
});

test("splitPointsByMissingIntervals breaks the line across gaps while preserving verified zero performance", () => {
  const verifiedZeroSeries = [
    { timestamp: 1_000, value: 0 },
    { timestamp: 2_000, value: 0 },
    { timestamp: 3_000, value: 0 },
  ];
  // Verified zero performance with no missing intervals remains one continuous segment.
  assert.deepEqual(splitPointsByMissingIntervals(verifiedZeroSeries, []), [
    verifiedZeroSeries,
  ]);

  // A missing interval between 1_500 and 2_500 splits the series into separate observed segments.
  const gappedSeries = [
    { timestamp: 1_000, value: 1.5 },
    { timestamp: 1_400, value: 2.0 },
    { timestamp: 2_600, value: 0 },
    { timestamp: 3_000, value: 3.0 },
  ];
  assert.deepEqual(
    splitPointsByMissingIntervals(gappedSeries, [
      { startTimestamp: 1_500, endTimestamp: 2_500, reason: "unobserved gap" },
    ]),
    [
      [
        { timestamp: 1_000, value: 1.5 },
        { timestamp: 1_400, value: 2.0 },
      ],
      [
        { timestamp: 2_600, value: 0 },
        { timestamp: 3_000, value: 3.0 },
      ],
    ],
  );
});

test("formatTrustedLedger formats ledger numbers and unavailable fallback", () => {
  assert.equal(formatTrustedLedger(1_234_567), "#1,234,567");
  assert.equal(formatTrustedLedger(0), "#0");
  assert.equal(formatTrustedLedger(null), "unavailable");
  assert.equal(formatTrustedLedger(undefined), "unavailable");
});
