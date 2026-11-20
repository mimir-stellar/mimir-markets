import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PERFORMANCE_RANGE,
  PORTFOLIO_CHART_RANGES,
  areTimeBoundsValid,
  buildPerformanceChartRows,
  formatChartDay,
  isPortfolioChartRange,
  isPortfolioPerformanceResponse,
  parsePerformanceRangeUrlParams,
  performanceRangeReducer,
  reducePerformancePoints,
  resolveRangeTimeWindow,
  serializePerformanceRangeUrlParams,
  validateTimeBounds,
  type PerformanceRangeState,
} from "../../lib/portfolio-performance";

const CACHE = {
  source: "index" as const,
  status: "live" as const,
  lastUpdatedAt: "2026-09-24T00:00:00.000Z",
  ageMs: 1_000,
  freshnessWindowMs: 300_000,
};

// ── Existing supported behavior ───────────────────────────────────────────────

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

// ── Time Bounds Validation & Contradiction Rejection ─────────────────────────

test("accepts valid time bounds when from is strictly less than to", () => {
  const result = validateTimeBounds(1_700_000_000_000, 1_700_100_000_000);
  assert.equal(result.valid, true);
  assert.equal(areTimeBoundsValid({ from: 1_700_000_000_000, to: 1_700_100_000_000 }), true);
});

test("accepts open-ended bounds with only from or only to", () => {
  assert.equal(validateTimeBounds(1_700_000_000_000, undefined).valid, true);
  assert.equal(validateTimeBounds(undefined, 1_700_100_000_000).valid, true);
  assert.equal(validateTimeBounds(undefined, undefined).valid, true);
});

test("rejects contradictory time bounds where from >= to", () => {
  // start bound after end bound
  const inverted = validateTimeBounds(1_700_200_000_000, 1_700_100_000_000);
  assert.equal(inverted.valid, false);
  assert.equal(inverted.reason, "contradictory");
  assert.equal(areTimeBoundsValid({ from: 1_700_200_000_000, to: 1_700_100_000_000 }), false);

  // equal bounds (zero-length window)
  const equal = validateTimeBounds(1_700_100_000_000, 1_700_100_000_000);
  assert.equal(equal.valid, false);
  assert.equal(equal.reason, "contradictory");
});

test("rejects invalid, non-finite, or non-positive time bounds", () => {
  for (const [from, to] of [
    [Number.NaN, 1_700_100_000_000],
    [1_700_000_000_000, Number.POSITIVE_INFINITY],
    [-1_000, 1_700_100_000_000],
    [0, 1_700_100_000_000],
    [1_700_000_000_000, -500],
    ["not-a-number", 1_700_100_000_000],
  ]) {
    const res = validateTimeBounds(from, to);
    assert.equal(res.valid, false, `Expected bounds [${from}, ${to}] to be rejected`);
  }
});

// ── Normalized URL State Serialization & Parsing ─────────────────────────────

test("defaults serialize to an empty query and parse back to defaults", () => {
  assert.equal(serializePerformanceRangeUrlParams(DEFAULT_PERFORMANCE_RANGE), "");
  assert.deepEqual(
    parsePerformanceRangeUrlParams(new URLSearchParams("")),
    DEFAULT_PERFORMANCE_RANGE,
  );
  assert.deepEqual(parsePerformanceRangeUrlParams(""), DEFAULT_PERFORMANCE_RANGE);
  assert.deepEqual(parsePerformanceRangeUrlParams(null), DEFAULT_PERFORMANCE_RANGE);
});

test("preset ranges round-trip through normalized URL state", () => {
  for (const range of PORTFOLIO_CHART_RANGES) {
    if (range === "all") continue;
    const state: PerformanceRangeState = { range };
    const qs = serializePerformanceRangeUrlParams(state);
    assert.equal(qs, `range=${range}`);
    const parsed = parsePerformanceRangeUrlParams(qs);
    assert.equal(parsed.range, range);
    assert.equal(parsed.from, undefined);
    assert.equal(parsed.to, undefined);
  }
});

test("accepts legacy ?window= query parameter as alias for ?range=", () => {
  const parsed = parsePerformanceRangeUrlParams("?window=7d");
  assert.equal(parsed.range, "7d");
});

test("custom valid time bounds round-trip through URL state", () => {
  const state: PerformanceRangeState = {
    range: "all",
    from: 1_700_000_000_000,
    to: 1_700_500_000_000,
  };
  const qs = serializePerformanceRangeUrlParams(state);
  assert.match(qs, /from=1700000000000/);
  assert.match(qs, /to=1700500000000/);

  const parsed = parsePerformanceRangeUrlParams(qs);
  assert.deepEqual(parsed, state);
});

test("rejects invalid or contradictory time bounds in URL state and falls back to safe valid range", () => {
  // Contradictory bounds in URL (from > to)
  const contradictory = parsePerformanceRangeUrlParams("range=7d&from=1700500000000&to=1700000000000");
  assert.equal(contradictory.range, "7d");
  assert.equal(contradictory.from, undefined, "Contradictory 'from' bound must be discarded");
  assert.equal(contradictory.to, undefined, "Contradictory 'to' bound must be discarded");

  // Non-finite / bogus bounds in URL
  const bogus = parsePerformanceRangeUrlParams("from=bogus&to=infinity");
  assert.equal(bogus.range, "all");
  assert.equal(bogus.from, undefined);
  assert.equal(bogus.to, undefined);

  // Negative timestamp in URL
  const negative = parsePerformanceRangeUrlParams("from=-1000&to=2000");
  assert.equal(negative.range, "all");
  assert.equal(negative.from, undefined);
});

// ── Performance Reducer for Points ───────────────────────────────────────────

test("reducePerformancePoints filters observations by preset range", () => {
  const NOW = 1_800_000_000_000;
  const HOUR = 3_600_000;
  const points = [
    { timestamp: NOW - 40 * HOUR, value: 10 },
    { timestamp: NOW - 10 * HOUR, value: 20 },
    { timestamp: NOW - 1 * HOUR, value: 30 },
  ];

  // 24h window clips the 40h-old observation
  const dayPoints = reducePerformancePoints(points, "24h", NOW);
  assert.equal(dayPoints.length, 2);
  assert.deepEqual(
    dayPoints.map((p) => p.value),
    [20, 30],
  );

  // all window keeps all observations
  const allPoints = reducePerformancePoints(points, "all", NOW);
  assert.equal(allPoints.length, 3);
});

test("reducePerformancePoints filters observations by custom time bounds", () => {
  const points = [
    { timestamp: 1_000, value: 1 },
    { timestamp: 2_000, value: 2 },
    { timestamp: 3_000, value: 3 },
    { timestamp: 4_000, value: 4 },
  ];

  const filtered = reducePerformancePoints(points, { from: 1_500, to: 3_500 });
  assert.deepEqual(
    filtered.map((p) => p.value),
    [2, 3],
  );
});

test("reducePerformancePoints rejects contradictory time bounds without failing or emitting NaNs", () => {
  const points = [
    { timestamp: 1_000, value: 1 },
    { timestamp: 2_000, value: 2 },
  ];

  // Contradictory bounds: from (3000) > to (1000)
  const result = reducePerformancePoints(points, { from: 3_000, to: 1_000 });
  // Should reject contradictory bounds and return the valid points rather than crashing or returning NaNs
  assert.equal(result.length, 2);
  assert.ok(result.every((p) => Number.isFinite(p.value) && Number.isFinite(p.timestamp)));
});

// ── Performance Range Reducer (State Transitions) ───────────────────────────

test("performanceRangeReducer handles range selection and resets custom bounds", () => {
  const initial: PerformanceRangeState = { range: "all", from: 1_000, to: 2_000 };
  const next = performanceRangeReducer(initial, { type: "SET_RANGE", range: "30d" });
  assert.equal(next.range, "30d");
  assert.equal(next.from, undefined);
  assert.equal(next.to, undefined);
});

test("performanceRangeReducer rejects contradictory bounds action and preserves state", () => {
  const initial: PerformanceRangeState = { range: "7d" };
  // Dispatch contradictory time bounds
  const next = performanceRangeReducer(initial, { type: "SET_TIME_BOUNDS", from: 5_000, to: 2_000 });
  assert.deepEqual(next, initial, "Contradictory time bounds action must be rejected and state unchanged");
});

test("performanceRangeReducer restores state from action rejecting contradictory bounds", () => {
  const validRestore = performanceRangeReducer(DEFAULT_PERFORMANCE_RANGE, {
    type: "RESTORE_RANGE",
    range: "7d",
    from: 1_000,
    to: 2_000,
  });
  assert.deepEqual(validRestore, { range: "7d", from: 1_000, to: 2_000 });

  const contradictoryRestore = performanceRangeReducer(DEFAULT_PERFORMANCE_RANGE, {
    type: "RESTORE_RANGE",
    range: "7d",
    from: 2_000,
    to: 1_000,
  });
  assert.deepEqual(contradictoryRestore, { range: "7d" }, "Contradictory bounds in restore action must be stripped");
});

// ── Chart Rows Table Helpers ─────────────────────────────────────────────────

test("buildPerformanceChartRows builds formatted table rows and respects truncation limits", () => {
  const points = [
    { timestamp: 1_800_000_000_000, value: 12.3456 },
    { timestamp: 1_800_086_400_000, value: -5.5 },
  ];
  const table = buildPerformanceChartRows(points, " USDC");
  assert.equal(table.total, 2);
  assert.equal(table.truncated, false);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0].value, "12.35 USDC");
  assert.equal(table.rows[1].value, "-5.50 USDC");
  assert.equal(table.rows[0].date, formatChartDay(1_800_000_000_000));
});

// ── PerformanceChart Component Rendering & Accessibility ────────────────────

test("PerformanceChart renders accessible range controls and keyboard table toggle", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { PerformanceChart } = await import("../../components/charts/PerformanceChart");

  const markup = renderToStaticMarkup(
    createElement(PerformanceChart, {
      points: [
        { timestamp: 1_700_000_000_000, value: 10 },
        { timestamp: 1_700_086_400_000, value: 25 },
      ],
      baseline: 0,
      label: "Portfolio P&L",
      syncUrl: false,
    }),
  );

  // Range controls present and accessible
  assert.match(markup, /role="group"/);
  assert.match(markup, /aria-label="Chart range"/);
  assert.match(markup, /data-range-key="24h"/);
  assert.match(markup, /data-range-key="7d"/);
  assert.match(markup, /data-range-key="30d"/);
  assert.match(markup, /data-range-key="all"/);

  // Default range "all" is active
  assert.match(markup, /data-range-key="all"[^>]*aria-pressed="true"/);

  // Keyboard table button is present
  assert.match(markup, /Show data/);
  assert.match(markup, /aria-expanded="false"/);
});

test("PerformanceChart renders invalid alert on hostile / non-finite baseline", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { PerformanceChart } = await import("../../components/charts/PerformanceChart");

  const markup = renderToStaticMarkup(
    createElement(PerformanceChart, {
      points: [{ timestamp: 1_000, value: 10 }],
      baseline: Number.NaN,
      label: "Portfolio P&L",
      invalidMessage: "Custom invalid error",
      syncUrl: false,
    }),
  );

  assert.match(markup, /role="alert"/);
  assert.match(markup, /Custom invalid error/);
});

test("PerformanceChart supports multi-series comparison without crashing", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { PerformanceChart } = await import("../../components/charts/PerformanceChart");

  const markup = renderToStaticMarkup(
    createElement(PerformanceChart, {
      series: [
        { label: "Agent A", points: [{ timestamp: 1_700_000_000_000, value: 5 }], stroke: "#00ff00" },
        { label: "Agent B", points: [{ timestamp: 1_700_000_000_000, value: -2 }], stroke: "#ff0000" },
      ],
      baseline: 0,
      label: "Agent Comparison",
      syncUrl: false,
    }),
  );

  assert.match(markup, /role="img"/);
  assert.match(markup, /Agent Comparison/);
});
