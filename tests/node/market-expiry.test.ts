/**
 * tests/node/market-expiry.test.ts
 *
 * Focused coverage for issue #920: expiry checks follow the observed ledger
 * context, not the browser clock alone.
 *
 * Positive, negative, boundary and regression cases are covered so the failure
 * mode (promising eligibility from a stale estimate) stays caught.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CHALLENGE_LOCK_SECONDS,
  MARKET_EXPIRY_CLOCK_SKEW_TOLERANCE_MS,
  MARKET_EXPIRY_MAX_OBSERVATION_AGE_MS,
  evaluateMarketExpiry,
  observationFromFreshness,
  type ExpiryObservation,
} from "../../lib/market-expiry";
import { VS_CHALLENGE_LOCK_SECONDS } from "../../lib/contract";

const NOW_MS = 1_800_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function observation(overrides: Partial<ExpiryObservation> = {}): ExpiryObservation {
  return {
    source: "ledger",
    receivedAtMs: NOW_MS,
    serverNowMs: NOW_MS,
    freshness: null,
    ...overrides,
  };
}

test("challenge lock constant mirrors the contract constant", () => {
  assert.equal(DEFAULT_CHALLENGE_LOCK_SECONDS, VS_CHALLENGE_LOCK_SECONDS);
});

// ── Positive: a fresh observation can still promise eligibility ───────────────

test("positive: fresh observation with time left is open and challengeable", () => {
  const expiry = evaluateMarketExpiry({
    deadlineUnix: NOW_SEC + 3600,
    nowMs: NOW_MS,
    observation: observation(),
    marketState: "open",
  });

  assert.equal(expiry.status, "open");
  assert.equal(expiry.estimateStale, false);
  assert.equal(expiry.staleReason, null);
  assert.equal(expiry.challengeable, true);
  assert.equal(expiry.secondsRemaining, 3600);
  assert.equal(expiry.observationAgeMs, 0);
  assert.equal(expiry.clockSkewMs, 0);
});

test("positive: an accepted market with a fresh observation is still challengeable", () => {
  const expiry = evaluateMarketExpiry({
    deadlineUnix: NOW_SEC + 3600,
    nowMs: NOW_MS,
    observation: observation(),
    marketState: "accepted",
  });

  assert.equal(expiry.challengeable, true);
});

// ── Boundary: challenge lock window ───────────────────────────────────────────

test("boundary: exactly the lock window remaining is still challengeable", () => {
  const expiry = evaluateMarketExpiry({
    deadlineUnix: NOW_SEC + DEFAULT_CHALLENGE_LOCK_SECONDS,
    nowMs: NOW_MS,
    observation: observation(),
  });

  assert.equal(expiry.secondsRemaining, DEFAULT_CHALLENGE_LOCK_SECONDS);
  assert.equal(expiry.status, "open");
  assert.equal(expiry.challengeable, true);
});

test("boundary: one second inside the lock window is closing_soon, not challengeable", () => {
  const expiry = evaluateMarketExpiry({
    deadlineUnix: NOW_SEC + DEFAULT_CHALLENGE_LOCK_SECONDS - 1,
    nowMs: NOW_MS,
    observation: observation(),
  });

  assert.equal(expiry.status, "closing_soon");
  assert.equal(expiry.challengeable, false);
  assert.equal(expiry.estimateStale, false);
});

test("boundary: exactly at the deadline is expired", () => {
  const expiry = evaluateMarketExpiry({
    deadlineUnix: NOW_SEC,
    nowMs: NOW_MS,
    observation: observation(),
  });

  assert.equal(expiry.status, "expired");
  assert.equal(expiry.secondsRemaining, 0);
  assert.equal(expiry.challengeable, false);
});

// ── Negative: unusable deadlines ──────────────────────────────────────────────

test("negative: missing or malformed deadlines are unknown and never challengeable", () => {
  for (const deadline of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const expiry = evaluateMarketExpiry({
      deadlineUnix: deadline,
      nowMs: NOW_MS,
      observation: observation(),
    });

    assert.equal(expiry.status, "unknown");
    assert.equal(expiry.deadlineUnix, null);
    assert.equal(expiry.secondsRemaining, null);
    assert.equal(expiry.estimateStale, true);
    assert.equal(expiry.staleReason, "missing_deadline");
    assert.equal(expiry.challengeable, false);
  }
});

test("negative: resolved and cancelled markets are never challengeable", () => {
  for (const marketState of ["resolved", "cancelled"] as const) {
    const expiry = evaluateMarketExpiry({
      deadlineUnix: NOW_SEC + 3600,
      nowMs: NOW_MS,
      observation: observation(),
      marketState,
    });

    assert.equal(expiry.challengeable, false);
    assert.equal(expiry.estimateStale, false);
  }
});

// ── Regression: stale observations must not promise eligibility ───────────────

test("regression: an aged observation is flagged and never challengeable", () => {
  const expiry = evaluateMarketExpiry({
    deadlineUnix: NOW_SEC + 3600,
    nowMs: NOW_MS,
    observation: observation({ receivedAtMs: NOW_MS - MARKET_EXPIRY_MAX_OBSERVATION_AGE_MS - 1 }),
  });

  assert.equal(expiry.status, "open"); // the estimate itself is unchanged
  assert.equal(expiry.estimateStale, true);
  assert.equal(expiry.staleReason, "observation_too_old");
  assert.equal(expiry.challengeable, false);
});

test("boundary: observation exactly at the max age is still trusted", () => {
  const expiry = evaluateMarketExpiry({
    deadlineUnix: NOW_SEC + 3600,
    nowMs: NOW_MS,
    observation: observation({
      receivedAtMs: NOW_MS - MARKET_EXPIRY_MAX_OBSERVATION_AGE_MS,
      serverNowMs: NOW_MS - MARKET_EXPIRY_MAX_OBSERVATION_AGE_MS,
    }),
  });

  assert.equal(expiry.estimateStale, false);
  assert.equal(expiry.challengeable, true);
});

test("regression: a stale read index blocks eligibility before the age check", () => {
  const expiry = evaluateMarketExpiry({
    deadlineUnix: NOW_SEC + 3600,
    nowMs: NOW_MS,
    observation: observation({
      source: "index",
      freshness: {
        source: "index",
        status: "stale",
        lastUpdatedAt: new Date(NOW_MS - 10 * 60_000).toISOString(),
        ageMs: 10 * 60_000,
        freshnessWindowMs: 15_000,
      },
    }),
  });

  assert.equal(expiry.estimateStale, true);
  assert.equal(expiry.staleReason, "index_stale");
  assert.equal(expiry.challengeable, false);
});

test("regression: clock skew against the server blocks eligibility", () => {
  const expiry = evaluateMarketExpiry({
    deadlineUnix: NOW_SEC + 3600,
    nowMs: NOW_MS,
    observation: observation({
      receivedAtMs: NOW_MS,
      serverNowMs: NOW_MS - MARKET_EXPIRY_CLOCK_SKEW_TOLERANCE_MS - 1,
    }),
  });

  assert.equal(expiry.estimateStale, true);
  assert.equal(expiry.staleReason, "clock_skew");
  assert.equal(expiry.challengeable, false);
  assert.ok((expiry.clockSkewMs ?? 0) > MARKET_EXPIRY_CLOCK_SKEW_TOLERANCE_MS);
});

test("boundary: skew exactly at the tolerance is still trusted", () => {
  const expiry = evaluateMarketExpiry({
    deadlineUnix: NOW_SEC + 3600,
    nowMs: NOW_MS,
    observation: observation({
      serverNowMs: NOW_MS - MARKET_EXPIRY_CLOCK_SKEW_TOLERANCE_MS,
    }),
  });

  assert.equal(expiry.estimateStale, false);
  assert.equal(expiry.challengeable, true);
});

test("regression: a local draft deadline is always an estimate, never eligibility", () => {
  const expiry = evaluateMarketExpiry({
    deadlineUnix: NOW_SEC + 3600,
    nowMs: NOW_MS,
    observation: {
      source: "local_draft",
      receivedAtMs: NOW_MS,
      serverNowMs: NOW_MS,
    },
  });

  assert.equal(expiry.status, "open");
  assert.equal(expiry.estimateStale, true);
  assert.equal(expiry.staleReason, "no_ledger_observation");
  assert.equal(expiry.challengeable, false);
});

test("regression: no observation at all is an estimate, never eligibility", () => {
  const expiry = evaluateMarketExpiry({
    deadlineUnix: NOW_SEC + 3600,
    nowMs: NOW_MS,
    observation: null,
  });

  assert.equal(expiry.estimateStale, true);
  assert.equal(expiry.staleReason, "no_ledger_observation");
  assert.equal(expiry.challengeable, false);
});

// ── Freshness → observation ───────────────────────────────────────────────────

test("observationFromFreshness reconstructs the server clock from freshness", () => {
  const receivedAtMs = NOW_MS + 250;
  const obs = observationFromFreshness(
    {
      source: "index",
      status: "live",
      lastUpdatedAt: new Date(NOW_MS - 2_000).toISOString(),
      ageMs: 2_000,
      freshnessWindowMs: 15_000,
    },
    receivedAtMs,
  );

  assert.equal(obs.source, "index");
  assert.equal(obs.receivedAtMs, receivedAtMs);
  assert.equal(obs.serverNowMs, NOW_MS);
  assert.equal(obs.freshness?.source, "index");
});

test("observationFromFreshness maps contract reads to the ledger source", () => {
  const obs = observationFromFreshness(
    {
      source: "contract",
      status: "live",
      lastUpdatedAt: new Date(NOW_MS).toISOString(),
      ageMs: 0,
      freshnessWindowMs: 1,
    },
    NOW_MS,
  );

  assert.equal(obs.source, "ledger");
  assert.equal(obs.serverNowMs, NOW_MS);
});

test("observationFromFreshness tolerates missing or malformed freshness", () => {
  const noFreshness = observationFromFreshness(null, NOW_MS);
  assert.equal(noFreshness.source, "ledger");
  assert.equal(noFreshness.serverNowMs, null);

  const malformed = observationFromFreshness(
    {
      source: "index",
      status: "cached",
      lastUpdatedAt: null,
      ageMs: null,
      freshnessWindowMs: 15_000,
    },
    NOW_MS,
  );
  assert.equal(malformed.serverNowMs, null);
});
