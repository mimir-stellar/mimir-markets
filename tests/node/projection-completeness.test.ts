import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVSCacheFreshness,
  makeContractFreshness,
  CURRENT_PROJECTION_GENERATION,
  type ProjectionCompleteness,
} from "../../lib/vs-freshness";

test("[positive] snapshot carries projection completeness with trusted ledger, known gaps, and generation", () => {
  const completeness: ProjectionCompleteness = {
    trustedLedger: 5829104,
    knownGaps: 0,
    projectionGeneration: CURRENT_PROJECTION_GENERATION,
  };

  const freshness = buildVSCacheFreshness({
    updatedAtMs: Date.now() - 5000,
    freshnessWindowMs: 60000,
    source: "index",
    projection: completeness,
  });

  assert.equal(freshness.status, "live");
  assert.equal(freshness.source, "index");
  assert.deepEqual(freshness.projection, {
    trustedLedger: 5829104,
    knownGaps: 0,
    projectionGeneration: 1,
  });
});

test("[positive] direct contract read provides contract freshness with authoritative projection", () => {
  const contractFreshness = makeContractFreshness({ trustedLedger: 6000100 });
  assert.equal(contractFreshness.source, "contract");
  assert.equal(contractFreshness.status, "live");
  assert.deepEqual(contractFreshness.projection, {
    trustedLedger: 6000100,
    knownGaps: 0,
    projectionGeneration: 1,
  });
});

test("[negative] distinguish unavailable cache state from missing on-chain market", () => {
  // 1. Unavailable cache state: database is down or index hasn't synced
  const unavailableCacheFreshness = buildVSCacheFreshness({
    updatedAtMs: null,
    freshnessWindowMs: 15000,
    source: "index",
    projection: {
      trustedLedger: null,
      knownGaps: 0,
      projectionGeneration: CURRENT_PROJECTION_GENERATION,
    },
  });

  assert.equal(unavailableCacheFreshness.status, "stale");
  assert.equal(unavailableCacheFreshness.lastUpdatedAt, null);
  assert.equal(unavailableCacheFreshness.projection?.trustedLedger, null);

  // 2. Verified index where market is genuinely missing on chain (id > last_claim_count)
  const freshMissingMarketFreshness = buildVSCacheFreshness({
    updatedAtMs: Date.now(),
    freshnessWindowMs: 15000,
    source: "index",
    projection: {
      trustedLedger: 5829104,
      knownGaps: 0,
      projectionGeneration: CURRENT_PROJECTION_GENERATION,
    },
  });

  assert.equal(freshMissingMarketFreshness.status, "live");
  assert.notEqual(freshMissingMarketFreshness.lastUpdatedAt, null);
  assert.equal(freshMissingMarketFreshness.projection?.trustedLedger, 5829104);

  // The two states are distinctly identifiable by caller
  assert.notEqual(unavailableCacheFreshness.status, freshMissingMarketFreshness.status);
  assert.notEqual(
    unavailableCacheFreshness.projection?.trustedLedger,
    freshMissingMarketFreshness.projection?.trustedLedger
  );
});

test("[boundary] projection completeness preserves known gaps and custom generation if configured", () => {
  const withGaps = buildVSCacheFreshness({
    updatedAtMs: Date.now() - 100_000, // cached (stale multiplier boundary)
    freshnessWindowMs: 60_000,
    source: "index",
    projection: {
      trustedLedger: 5800000,
      knownGaps: 3,
      projectionGeneration: 2,
    },
  });

  assert.equal(withGaps.status, "cached");
  assert.equal(withGaps.projection?.knownGaps, 3);
  assert.equal(withGaps.projection?.projectionGeneration, 2);
});

test("[boundary] zero trusted ledger or falsy numbers are handled safely", () => {
  const zeroLedger = buildVSCacheFreshness({
    updatedAtMs: Date.now(),
    freshnessWindowMs: 60_000,
    source: "index",
    projection: {
      trustedLedger: null,
      knownGaps: 0,
      projectionGeneration: CURRENT_PROJECTION_GENERATION,
    },
  });

  assert.equal(zeroLedger.projection?.trustedLedger, null);
  assert.equal(zeroLedger.projection?.knownGaps, 0);
  assert.equal(zeroLedger.projection?.projectionGeneration, 1);
});
