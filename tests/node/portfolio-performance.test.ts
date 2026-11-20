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

test("builds a reproducible statement manifest invariant to input position ordering", () => {
  const results = sampleResults();
  const reversed = [...results].reverse();

  const first = buildPortfolioPerformanceManifest({
    address: ADDRESS,
    results,
    cache: CACHE,
  });
  const second = buildPortfolioPerformanceManifest({
    address: ADDRESS,
    results: reversed,
    cache: CACHE,
  });

  assert.equal(first.schemaVersion, PORTFOLIO_STATEMENT_SCHEMA_VERSION);
  assert.equal(first.digestAlgorithm, PORTFOLIO_STATEMENT_DIGEST_ALGORITHM);
  assert.deepEqual(first.priceConventions, PORTFOLIO_STATEMENT_PRICE_CONVENTIONS);
  assert.match(first.digest, /^[0-9a-f]{64}$/);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.positions, second.positions);
  assert.equal(isPortfolioPerformanceStatementManifest(first), true);
});

test("verifies exact realized totals in atomic USDC independently of chart rendering", () => {
  const results = sampleResults();
  const manifest = buildPortfolioPerformanceManifest({
    address: ADDRESS,
    results,
    cache: CACHE,
  });

  // Verify without passing chart points at all.
  const verification = verifyPortfolioPerformanceManifest(manifest);
  assert.equal(verification.ok, true);
  assert.deepEqual(verification.errors, []);
  assert.equal(verification.computedDigest, manifest.digest);

  // Claim 101: +3.1234567 USDC (31234567)
  // Claim 102: -1.5 USDC (-15000000)
  // Claim 103: refunded (0)
  // Claim 104: open (excluded from realized, counted in openExposure = 42500000)
  assert.equal(verification.recomputedTotals.realizedPnlAtomic, 16_234_567n);
  assert.equal(verification.recomputedTotals.openExposureAtomic, 42_500_000n);
  assert.equal(verification.recomputedTotals.volumeAtomic, 127_500_000n);
  assert.equal(verification.recomputedTotals.settled, 3);
  assert.equal(verification.recomputedTotals.wins, 1);
  assert.equal(verification.recomputedTotals.losses, 1);
  assert.equal(verification.recomputedTotals.refunds, 1);
  assert.equal(verification.recomputedTotals.open, 1);
  assert.equal(manifest.coverage.earliestSettledAt, 1_800_000_000_000);
  assert.equal(manifest.coverage.latestSettledAt, 1_800_000_120_000);
});

test("changes digest when observation coverage or window changes", () => {
  const results = sampleResults();
  const baseline = buildPortfolioPerformanceManifest({
    address: ADDRESS,
    results,
    cache: CACHE,
  });
  const staleCoverage = buildPortfolioPerformanceManifest({
    address: ADDRESS,
    results,
    cache: { ...CACHE, status: "stale" },
  });
  const windowed = buildPortfolioPerformanceManifest({
    address: ADDRESS,
    results,
    cache: CACHE,
    window: { sinceMs: 1_800_000_060_000 },
  });

  assert.notEqual(staleCoverage.digest, baseline.digest);
  assert.notEqual(windowed.digest, baseline.digest);
  assert.equal(windowed.totals.settled, 2);
  assert.equal(windowed.totals.realizedPnlAtomic, "-15000000");
  assert.equal(windowed.totals.openExposureAtomic, "42500000");
  assert.equal(verifyPortfolioPerformanceManifest(windowed).ok, true);
});

test("supports empty position sets with valid reproducible digest", () => {
  const manifest = buildPortfolioPerformanceManifest({
    address: ADDRESS,
    results: [],
    cache: { ...CACHE, status: "stale", lastUpdatedAt: null, ageMs: null },
  });

  const verification = verifyPortfolioPerformanceManifest(manifest);
  assert.equal(verification.ok, true);
  assert.equal(verification.recomputedTotals.realizedPnlAtomic, 0n);
  assert.equal(manifest.coverage.earliestSettledAt, null);
  assert.equal(manifest.coverage.latestSettledAt, null);
  assert.equal(manifest.coverage.totalPositions, 0);
});

test("fails verification when realized totals, digest, or open-position invariants are tampered", () => {
  const results = sampleResults();
  const manifest = buildPortfolioPerformanceManifest({
    address: ADDRESS,
    results,
    cache: CACHE,
  });

  // 1. Tampered realized total
  const tamperedTotals = {
    ...manifest,
    totals: { ...manifest.totals, realizedPnlAtomic: "99999999" },
  };
  const totalCheck = verifyPortfolioPerformanceManifest(tamperedTotals);
  assert.equal(totalCheck.ok, false);
  assert.ok(totalCheck.errors.some((e) => e.includes("realizedPnlAtomic mismatch")));
  assert.ok(totalCheck.errors.some((e) => e.includes("digest mismatch")));

  // 2. Open position with non-zero realized P&L even if digest is recomputed
  const badPositions = manifest.positions.map((pos) =>
    pos.outcome === "open" ? { ...pos, realizedPnlAtomic: "10000000" } : pos,
  );
  const badPayload = {
    schemaVersion: manifest.schemaVersion,
    address: manifest.address,
    priceConventions: manifest.priceConventions,
    coverage: manifest.coverage,
    totals: manifest.totals,
    positions: badPositions,
  };
  const forgedOpen = {
    ...badPayload,
    digestAlgorithm: manifest.digestAlgorithm,
    digest: computePortfolioPerformanceManifestDigest(badPayload),
  };
  const openCheck = verifyPortfolioPerformanceManifest(forgedOpen);
  assert.equal(openCheck.ok, false);
  assert.ok(openCheck.errors.some((e) => e.includes("must have realizedPnlAtomic of 0")));
});

test("response guard accepts valid manifest and rejects tampered manifest or chart divergence", () => {
  const results = sampleResults();
  const points = cumulativePnlPoints(results);
  const manifest = buildPortfolioPerformanceManifest({
    address: ADDRESS,
    results,
    cache: CACHE,
  });

  assert.equal(
    isPortfolioPerformanceResponse({
      points,
      settled: 3,
      cache: CACHE,
      manifest,
    }),
    true,
  );

  // Tampered digest must fail closed
  assert.equal(
    isPortfolioPerformanceResponse({
      points,
      settled: 3,
      cache: CACHE,
      manifest: { ...manifest, digest: "0".repeat(64) },
    }),
    false,
  );

  // Chart points diverging from exact realized total must fail closed
  const driftedPoints = points.map((p, idx) =>
    idx === points.length - 1 ? { ...p, value: p.value + 1 } : p,
  );
  assert.equal(
    isPortfolioPerformanceResponse({
      points: driftedPoints,
      settled: 3,
      cache: CACHE,
      manifest,
    }),
    false,
  );
});
