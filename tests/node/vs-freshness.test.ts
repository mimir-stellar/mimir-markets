import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVSCacheFreshness,
  classifyVSCacheStaleReason,
  isStaleIndexSnapshot,
  makeContractFreshness,
} from "../../lib/vs-freshness";

const windowMs = 60_000;

test("warns only when an indexed snapshot crosses the stale boundary", () => {
  const cached = buildVSCacheFreshness({
    updatedAtMs: Date.now() - windowMs * 2,
    freshnessWindowMs: windowMs,
    source: "index",
  });
  assert.ok(cached.lastUpdatedAt);
  const updatedAtMs = Date.parse(cached.lastUpdatedAt);
  assert.equal(cached.status, "cached");
  assert.equal(isStaleIndexSnapshot(cached, updatedAtMs + windowMs * 5), false);
  assert.equal(isStaleIndexSnapshot(cached, updatedAtMs + windowMs * 5 + 1), true);
});

test("warns for an index with no usable update time", () => {
  const unknown = buildVSCacheFreshness({
    updatedAtMs: null,
    freshnessWindowMs: windowMs,
    source: "index",
  });
  assert.equal(isStaleIndexSnapshot(unknown), true);
  assert.equal(isStaleIndexSnapshot({ ...unknown, status: "cached" }), true);
  assert.equal(isStaleIndexSnapshot({ ...unknown, status: "cached", lastUpdatedAt: "invalid" }), true);
  assert.equal(isStaleIndexSnapshot({ ...unknown, status: "cached", lastUpdatedAt: new Date().toISOString(), freshnessWindowMs: 0 }), true);
});

test("does not warn for live contract reads or unavailable metadata", () => {
  assert.equal(isStaleIndexSnapshot(makeContractFreshness()), false);
  assert.equal(isStaleIndexSnapshot({ ...makeContractFreshness(), status: "stale" }), false);
  assert.equal(isStaleIndexSnapshot(null), false);
});

test("projection completeness carries trusted ledger, known gaps, and projection generation", () => {
  const freshness = buildVSCacheFreshness({
    updatedAtMs: Date.now(),
    freshnessWindowMs: windowMs,
    source: "index",
    projection: {
      trustedLedger: 123456,
      knownGaps: 0,
      projectionGeneration: 1,
    },
  });

  assert.ok(freshness.projection);
  assert.equal(freshness.projection.trustedLedger, 123456);
  assert.equal(freshness.projection.knownGaps, 0);
  assert.equal(freshness.projection.projectionGeneration, 1);
});

test("makeContractFreshness provides authoritative live completeness", () => {
  const live = makeContractFreshness({ trustedLedger: 999999 });
  assert.equal(live.source, "contract");
  assert.equal(live.status, "live");
  assert.ok(live.projection);
  assert.equal(live.projection.trustedLedger, 999999);
  assert.equal(live.projection.knownGaps, 0);
  assert.equal(live.projection.projectionGeneration, 1);
});

test("boundary and failure: missing or degraded cache state retains unavailable projection completeness", () => {
  const degraded = buildVSCacheFreshness({
    updatedAtMs: null,
    freshnessWindowMs: windowMs,
    source: "index",
    projection: {
      trustedLedger: null,
      knownGaps: 5,
      projectionGeneration: 1,
    },
  });

  assert.equal(degraded.status, "stale");
  assert.ok(degraded.projection);
  assert.equal(degraded.projection.trustedLedger, null);
  assert.equal(degraded.projection.knownGaps, 5);
  assert.equal(degraded.projection.projectionGeneration, 1);
});

test("distinguishes provider lag, projection failure and unknown coverage", () => {
  const projection = {
    trustedLedger: 123456,
    knownGaps: 0,
    projectionGeneration: 1,
  };

  assert.equal(classifyVSCacheStaleReason({
    updatedAtMs: Date.now() - windowMs * 6,
    projection,
  }), "provider_lag");

  assert.equal(classifyVSCacheStaleReason({
    updatedAtMs: Date.now(),
    projection: { ...projection, knownGaps: 2 },
  }), "projection_failure");

  assert.equal(classifyVSCacheStaleReason({
    updatedAtMs: null,
    projection: { ...projection, trustedLedger: null },
  }), "unknown_coverage");

  const stale = buildVSCacheFreshness({
    updatedAtMs: null,
    freshnessWindowMs: windowMs,
    source: "index",
  });
  assert.equal(stale.status, "stale");
  assert.equal(stale.staleReason, "unknown_coverage");

  const cached = buildVSCacheFreshness({
    updatedAtMs: Date.now() - windowMs * 2,
    freshnessWindowMs: windowMs,
    source: "index",
  });
  assert.equal(cached.status, "cached");
  assert.equal(cached.staleReason, undefined);

  assert.equal(makeContractFreshness().staleReason, undefined);
});
