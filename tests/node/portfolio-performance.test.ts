import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLiveRefreshToSnapshots,
  comparePortfolioSnapshots,
  freezePortfolioSnapshot,
  isPortfolioPerformanceResponse,
  isPortfolioSnapshot,
  isPortfolioSnapshotComparison,
  type PortfolioSnapshot,
} from "../../lib/portfolio-performance";

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

test("creates and validates a frozen portfolio snapshot", () => {
  const points = [
    { timestamp: 1_800_000_000_000, value: 10 },
    { timestamp: 1_800_060_000_000, value: 25 },
  ];
  const snap = freezePortfolioSnapshot("q3-review", "Q3 Reviewed Portfolio", {
    points,
    settled: 2,
  });

  assert.equal(isPortfolioSnapshot(snap), true);
  assert.equal(snap.id, "q3-review");
  assert.equal(snap.metric, "cumulative_pnl_usdc");
  assert.equal(snap.frozen, true);
  assert.equal(snap.points.length, 2);
  assert.equal(snap.points[0].value, 10);
});

test("rejects invalid portfolio snapshots", () => {
  // Empty or invalid id
  assert.equal(
    isPortfolioSnapshot({
      id: "",
      label: "empty id",
      capturedAt: Date.now(),
      metric: "cumulative_pnl_usdc",
      points: [],
      settled: 0,
      frozen: true,
    }),
    false,
  );

  // Non-finite point money
  assert.equal(
    isPortfolioSnapshot({
      id: "bad-point",
      label: "Bad Point",
      capturedAt: Date.now(),
      metric: "cumulative_pnl_usdc",
      points: [{ timestamp: 1000, value: Number.NaN }],
      settled: 1,
      frozen: true,
    }),
    false,
  );

  // Negative settled count
  assert.equal(
    isPortfolioSnapshot({
      id: "neg-settled",
      label: "Negative Settled",
      capturedAt: Date.now(),
      metric: "cumulative_pnl_usdc",
      points: [],
      settled: -1,
      frozen: true,
    }),
    false,
  );
});

test("compares selected snapshots using the same metric definition", () => {
  const snap1 = freezePortfolioSnapshot(
    "q1-review",
    "Q1 Review",
    { points: [{ timestamp: 1_000_000, value: 100 }], settled: 1 },
    { metric: "cumulative_pnl_usdc" },
  );
  const snap2 = freezePortfolioSnapshot(
    "q2-review",
    "Q2 Review",
    { points: [{ timestamp: 2_000_000, value: 250 }], settled: 2 },
    { metric: "cumulative_pnl_usdc" },
  );

  const comparison = comparePortfolioSnapshots([snap1, snap2], "cumulative_pnl_usdc");
  assert.equal(isPortfolioSnapshotComparison(comparison), true);
  assert.equal(comparison.metric, "cumulative_pnl_usdc");
  assert.equal(comparison.snapshots.length, 2);
  assert.equal(comparison.snapshots[0].id, "q1-review");
  assert.equal(comparison.snapshots[1].id, "q2-review");
});

test("boundary: compares an empty set of snapshots cleanly", () => {
  const comparison = comparePortfolioSnapshots([], "cumulative_pnl_usdc");
  assert.equal(isPortfolioSnapshotComparison(comparison), true);
  assert.equal(comparison.snapshots.length, 0);
});

test("failure: refuses comparison when snapshots use mismatched metric definitions", () => {
  const snap1: PortfolioSnapshot = {
    id: "snap-1",
    label: "Snap 1",
    capturedAt: 1000,
    metric: "cumulative_pnl_usdc",
    points: [{ timestamp: 1000, value: 10 }],
    settled: 1,
    frozen: true,
  };
  const snap2: PortfolioSnapshot = {
    id: "snap-2",
    label: "Snap 2",
    capturedAt: 2000,
    metric: "realised_pnl_usdc",
    points: [{ timestamp: 2000, value: 15 }],
    settled: 1,
    frozen: true,
  };

  assert.throws(
    () => comparePortfolioSnapshots([snap1, snap2], "cumulative_pnl_usdc"),
    /Metric mismatch in snapshot comparison/,
  );
});

test("prevents live refreshes from changing a reviewed historical comparison", () => {
  const frozenHistorical = freezePortfolioSnapshot(
    "historical-benchmark",
    "Reviewed Benchmark 2026-Q1",
    {
      points: [
        { timestamp: 1_800_000_000_000, value: 100 },
        { timestamp: 1_800_060_000_000, value: 150 },
      ],
      settled: 2,
    },
  );

  const snapshots: PortfolioSnapshot[] = [frozenHistorical];

  // Incoming live refresh tries to mutate the historical snapshot with new points and settled counts
  const refreshed = applyLiveRefreshToSnapshots(snapshots, {
    id: "historical-benchmark",
    points: [
      { timestamp: 1_800_000_000_000, value: 500 },
      { timestamp: 1_800_060_000_000, value: 999 },
    ],
    settled: 99,
  });

  // The historical comparison snapshot was frozen and must remain intact
  assert.equal(refreshed[0].frozen, true);
  assert.equal(refreshed[0].settled, 2);
  assert.equal(refreshed[0].points[0].value, 100);
  assert.equal(refreshed[0].points[1].value, 150);

  // An unfrozen live snapshot, on the other hand, accepts live refreshes
  const unfrozenLive: PortfolioSnapshot = {
    id: "live-active",
    label: "Live Active Portfolio",
    capturedAt: 1_800_000_000_000,
    metric: "cumulative_pnl_usdc",
    points: [{ timestamp: 1_800_000_000_000, value: 10 }],
    settled: 1,
    frozen: false,
  };

  const updatedLive = applyLiveRefreshToSnapshots([unfrozenLive], {
    id: "live-active",
    points: [
      { timestamp: 1_800_000_000_000, value: 10 },
      { timestamp: 1_800_060_000_000, value: 20 },
    ],
    settled: 2,
  });

  assert.equal(updatedLive[0].settled, 2);
  assert.equal(updatedLive[0].points.length, 2);
  assert.equal(updatedLive[0].points[1].value, 20);
});
