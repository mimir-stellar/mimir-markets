import assert from "node:assert/strict";
import test from "node:test";

import {
  cumulativePnlPoints,
  type AgentTradeResult,
} from "../../lib/agents/performance";
import {
  PORTFOLIO_STATEMENT_DIGEST_ALGORITHM,
  PORTFOLIO_STATEMENT_PRICE_CONVENTIONS,
  PORTFOLIO_STATEMENT_SCHEMA_VERSION,
  buildPortfolioPerformanceManifest,
  computePortfolioPerformanceManifestDigest,
  isPortfolioPerformanceResponse,
  isPortfolioPerformanceStatementManifest,
  verifyPortfolioPerformanceManifest,
} from "../../lib/portfolio-performance";

const ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const CACHE = {
  source: "index" as const,
  status: "live" as const,
  lastUpdatedAt: "2026-09-24T00:00:00.000Z",
  ageMs: 1_000,
  freshnessWindowMs: 300_000,
};

function sampleResults(): AgentTradeResult[] {
  return [
    {
      claimId: 101,
      role: "creator",
      stake: 2,
      opposingStake: 3.1234567,
      potentialPayout: 0,
      state: "resolved",
      winnerSide: "creator",
      settledAt: 1_800_000_000_000,
      category: "macro",
      question: "Claim 101",
      outcome: "won",
      stakeAtomic: 20_000_000n,
      pnlAtomic: 31_234_567n,
    },
    {
      claimId: 102,
      role: "challenger",
      stake: 1.5,
      opposingStake: 0,
      potentialPayout: 4,
      state: "resolved",
      winnerSide: "creator",
      settledAt: 1_800_000_060_000,
      category: "macro",
      question: "Claim 102",
      outcome: "lost",
      stakeAtomic: 15_000_000n,
      pnlAtomic: -15_000_000n,
    },
    {
      claimId: 103,
      role: "creator",
      stake: 5,
      opposingStake: 0,
      potentialPayout: 0,
      state: "cancelled",
      winnerSide: "",
      settledAt: 1_800_000_120_000,
      category: "macro",
      question: "Claim 103",
      outcome: "refunded",
      stakeAtomic: 50_000_000n,
      pnlAtomic: 0n,
    },
    {
      claimId: 104,
      role: "challenger",
      stake: 4.25,
      opposingStake: 0,
      potentialPayout: 9,
      state: "open",
      winnerSide: "",
      settledAt: 1_800_000_180_000,
      category: "macro",
      question: "Claim 104",
      outcome: "open",
      stakeAtomic: 42_500_000n,
      pnlAtomic: 0n,
    },
  ];
}

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

test("rejects localized display strings to ensure presentation is never parsed into arithmetic", () => {
  const invalidLocalizedPoints = [
    { timestamp: 1_800_000_000_000, value: "$1,234.56" },
    { timestamp: 1_800_000_000_000, value: "1,234.56" },
    { timestamp: 1_800_000_000_000, value: "1.234,56" },
    { timestamp: 1_800_000_000_000, value: "12.50 USDC" },
    { timestamp: 1_800_000_000_000, value: null },
    { timestamp: 1_800_000_000_000, value: undefined },
  ];

  for (const point of invalidLocalizedPoints) {
    assert.equal(
      isPortfolioPerformanceResponse({
        points: [point as unknown as { timestamp: number; value: number }],
        settled: 1,
        cache: CACHE,
      }),
      false,
      `expected point with value ${JSON.stringify(point.value)} to be rejected`,
    );
  }
});

test("preserves canonical numeric values across locale formatting switches", () => {
  const payload = {
    points: [
      { timestamp: 1_800_000_000_000, value: 1234.5678901 },
      { timestamp: 1_800_000_060_000, value: -0.0000001 },
    ],
    settled: 2,
    cache: CACHE,
  };

  assert.equal(isPortfolioPerformanceResponse(payload), true);

  const locales = ["en-US", "de-DE", "es-ES", "fr-FR"];
  for (const locale of locales) {
    const formatter = new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const formatted = payload.points.map((point) => formatter.format(point.value));
    assert.equal(formatted.length, payload.points.length);

    // Formatting for display must not mutate canonical inputs or re-enter the boundary.
    assert.equal(payload.points[0].value, 1234.5678901);
    assert.equal(payload.points[1].value, -0.0000001);
    assert.equal(
      isPortfolioPerformanceResponse({
        points: [{ timestamp: payload.points[0].timestamp, value: formatted[0] }],
        settled: 1,
        cache: CACHE,
      }),
      false,
      `formatted string for locale ${locale} must be rejected at the calculation boundary`,
    );
  }
});
