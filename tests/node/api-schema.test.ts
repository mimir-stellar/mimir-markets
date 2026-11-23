import assert from "node:assert/strict";
import test from "node:test";

import {
  API_SCHEMA_VERSION,
  SCHEMA_VERSION_HEADER,
  buildFeedSourceMetadata,
  checkShape,
  resolveRequestVersion,
  schemaVersionHeaders,
  staleFeedSourceMetadata,
  unavailableFeedSourceMetadata,
  validateFeedSourceMetadata,
  versioned,
  versionedMarketFeed,
  type ShapeSpec,
} from "../../lib/api/schema";

// ── Version negotiation ───────────────────────────────────────────────────────

test("a matching version is accepted", () => {
  const verdict = resolveRequestVersion(String(API_SCHEMA_VERSION));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.version, API_SCHEMA_VERSION);
});

test("a newer client version is refused, not coerced", () => {
  // A client speaking v2 to a v1 server is asking for behaviour that does not exist.
  const verdict = resolveRequestVersion(String(API_SCHEMA_VERSION + 1));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "unsupported_version");
});

test("an older client version is refused too", () => {
  assert.equal(resolveRequestVersion("0").reason, "unsupported_version");
});

test("a read may omit the version and gets the current one", () => {
  // Existing clients must keep working.
  for (const raw of [null, undefined, "", "   "]) {
    const verdict = resolveRequestVersion(raw);
    assert.equal(verdict.ok, true, JSON.stringify(raw));
    assert.equal(verdict.version, API_SCHEMA_VERSION);
  }
});

test("a write must state the version", () => {
  // A payment whose shape nobody pinned is not something to guess at.
  const verdict = resolveRequestVersion(null, { mutating: true });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "version_required");
});

test("a malformed version is refused rather than parsed loosely", () => {
  // parseInt would take "1abc" as 1, which is a client that has not agreed on the
  // format being told it succeeded.
  for (const raw of ["v1", "1.0", "1abc", "-1", "1e0", "٣"]) {
    assert.equal(resolveRequestVersion(raw).reason, "malformed_version", raw);
  }
});

// ── Shape checking ────────────────────────────────────────────────────────────

const SPEC: ShapeSpec = {
  question: { type: "string", required: true, min: 8, max: 200 },
  stake: { type: "number", required: true, min: 2, max: 1_000 },
  slots: { type: "integer" },
  isPrivate: { type: "boolean" },
  mode: { type: "string", oneOf: ["pool", "duel", "fixed_odds"] },
};

function payload(overrides: Record<string, unknown> = {}) {
  return { question: "will it rain tomorrow", stake: 10, ...overrides };
}

test("a valid payload passes", () => {
  const result = checkShape(payload(), SPEC);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("a missing required field is named", () => {
  const result = checkShape({ stake: 10 }, SPEC);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["question is required"]);
});

test("null counts as absent, not as a value of the wrong type", () => {
  // The error a caller needs is "you did not send it", not "null is not a string".
  const result = checkShape(payload({ question: null }), SPEC);
  assert.deepEqual(result.errors, ["question is required"]);
});

test("a wrong type is reported once, without also failing its range checks", () => {
  const result = checkShape(payload({ stake: "10" }), SPEC);
  assert.deepEqual(result.errors, ["stake must be a number"]);
});

test("string length bounds are enforced", () => {
  assert.match(checkShape(payload({ question: "short" }), SPEC).errors[0], /at least 8/);
  assert.match(checkShape(payload({ question: "x".repeat(201) }), SPEC).errors[0], /at most 200/);
});

test("number bounds are enforced", () => {
  assert.match(checkShape(payload({ stake: 1 }), SPEC).errors[0], />= 2/);
  assert.match(checkShape(payload({ stake: 5_000 }), SPEC).errors[0], /<= 1000/);
});

test("an enumerated field rejects a value outside the set", () => {
  assert.match(checkShape(payload({ mode: "squad_pool" }), SPEC).errors[0], /must be one of/);
  assert.equal(checkShape(payload({ mode: "duel" }), SPEC).ok, true);
});

test("an integer field rejects a fractional number", () => {
  assert.equal(checkShape(payload({ slots: 2.5 }), SPEC).ok, false);
  assert.equal(checkShape(payload({ slots: 2 }), SPEC).ok, true);
});

test("NaN and Infinity are not numbers here", () => {
  // JSON cannot carry them, but a hand-built object can, and both break arithmetic
  // downstream silently.
  assert.equal(checkShape(payload({ stake: Number.NaN }), SPEC).ok, false);
  assert.equal(checkShape(payload({ stake: Number.POSITIVE_INFINITY }), SPEC).ok, false);
});

test("an array is not an object", () => {
  const result = checkShape([{ question: "x" }], SPEC);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["payload must be a JSON object"]);
});

test("an object field rejects an array", () => {
  // Arrays are objects in JS and almost never what an object field means.
  const spec: ShapeSpec = { meta: { type: "object", required: true } };
  assert.equal(checkShape({ meta: [] }, spec).ok, false);
  assert.equal(checkShape({ meta: {} }, spec).ok, true);
});

test("a non-object payload is refused rather than throwing", () => {
  for (const value of [null, "string", 42, undefined]) {
    assert.equal(checkShape(value, SPEC).ok, false);
  }
});

test("an unexpected field is reported, not silently dropped", () => {
  // Silently dropping is how a caller believes it set a cap that never applied.
  const result = checkShape(payload({ maxSpendUsdc: 5 }), SPEC);
  assert.deepEqual(result.unexpected, ["maxSpendUsdc"]);
  // Reported, but not an error on its own — the version check is where a
  // newer-shaped client is refused.
  assert.equal(result.ok, true);
});

test("all errors are collected, not just the first", () => {
  const result = checkShape({ question: "no", stake: 0 }, SPEC);
  assert.equal(result.errors.length, 2);
});

// ── Responses ─────────────────────────────────────────────────────────────────

test("a response carries the version that produced it", () => {
  assert.deepEqual(versioned({ ok: true }), {
    schemaVersion: API_SCHEMA_VERSION,
    data: { ok: true },
  });
});

test("the version header matches the constant", () => {
  assert.deepEqual(schemaVersionHeaders(), {
    [SCHEMA_VERSION_HEADER]: String(API_SCHEMA_VERSION),
  });
});

// ── Source availability and freshness metadata ────────────────────────────────

const BASE_NOW = 1_780_000_000_000;
const WINDOW_MS = 60_000;

test("source metadata classifies live, cached, and stale snapshots deterministically across boundaries", () => {
  const live = buildFeedSourceMetadata({
    source: "index",
    updatedAtMs: BASE_NOW - WINDOW_MS,
    freshnessWindowMs: WINDOW_MS,
    nowMs: BASE_NOW,
  });
  assert.equal(live.status, "live");
  assert.equal(live.stale, false);
  assert.equal(live.unavailable, false);
  assert.equal(live.degraded, false);
  assert.equal(live.ageMs, WINDOW_MS);
  assert.equal(validateFeedSourceMetadata(live).ok, true);

  const cachedAtLowerBoundary = buildFeedSourceMetadata({
    source: "index",
    updatedAtMs: BASE_NOW - (WINDOW_MS + 1),
    freshnessWindowMs: WINDOW_MS,
    nowMs: BASE_NOW,
  });
  assert.equal(cachedAtLowerBoundary.status, "cached");
  assert.equal(cachedAtLowerBoundary.stale, false);
  assert.equal(cachedAtLowerBoundary.degraded, false);

  const cachedAtUpperBoundary = buildFeedSourceMetadata({
    source: "index",
    updatedAtMs: BASE_NOW - WINDOW_MS * 5,
    freshnessWindowMs: WINDOW_MS,
    nowMs: BASE_NOW,
  });
  assert.equal(cachedAtUpperBoundary.status, "cached");
  assert.equal(cachedAtUpperBoundary.stale, false);

  const stalePastUpperBoundary = buildFeedSourceMetadata({
    source: "index",
    updatedAtMs: BASE_NOW - (WINDOW_MS * 5 + 1),
    freshnessWindowMs: WINDOW_MS,
    nowMs: BASE_NOW,
  });
  assert.equal(stalePastUpperBoundary.status, "stale");
  assert.equal(stalePastUpperBoundary.stale, true);
  assert.equal(stalePastUpperBoundary.unavailable, false);
  assert.equal(stalePastUpperBoundary.degraded, true);
  assert.equal(validateFeedSourceMetadata(stalePastUpperBoundary).ok, true);
});

test("an index snapshot without a known update timestamp defaults to stale, never live", () => {
  const unknownAge = buildFeedSourceMetadata({
    source: "index",
    updatedAtMs: null,
    freshnessWindowMs: WINDOW_MS,
    nowMs: BASE_NOW,
  });
  assert.equal(unknownAge.status, "stale");
  assert.equal(unknownAge.stale, true);
  assert.equal(unknownAge.unavailable, false);
  assert.equal(unknownAge.degraded, true);
  assert.equal(unknownAge.lastUpdatedAt, null);
  assert.equal(unknownAge.ageMs, null);
  assert.equal(validateFeedSourceMetadata(unknownAge).ok, true);
});

test("stale and unavailable source metadata builders emit stable, schema-valid descriptors", () => {
  const staleFallback = staleFeedSourceMetadata({
    source: "index",
    updatedAtMs: BASE_NOW - 10_000,
    freshnessWindowMs: WINDOW_MS,
    nowMs: BASE_NOW,
    reason: "read_index_query_failed",
  });
  assert.equal(staleFallback.status, "stale");
  assert.equal(staleFallback.stale, true);
  assert.equal(staleFallback.unavailable, false);
  assert.equal(staleFallback.degraded, true);
  assert.equal(staleFallback.reason, "read_index_query_failed");
  assert.equal(validateFeedSourceMetadata(staleFallback).ok, true);

  const unavailable = unavailableFeedSourceMetadata({
    source: "index",
    updatedAtMs: null,
    freshnessWindowMs: WINDOW_MS,
    nowMs: BASE_NOW,
    reason: "read_index_unavailable",
  });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.stale, true);
  assert.equal(unavailable.unavailable, true);
  assert.equal(unavailable.degraded, true);
  assert.equal(unavailable.reason, "read_index_unavailable");
  assert.equal(validateFeedSourceMetadata(unavailable).ok, true);
});

test("validateFeedSourceMetadata rejects contradictory status flags and mismatched timestamp/age pairs", () => {
  const validLive = buildFeedSourceMetadata({
    source: "index",
    updatedAtMs: BASE_NOW - 5_000,
    freshnessWindowMs: WINDOW_MS,
    nowMs: BASE_NOW,
  });

  const contradictoryUnavailable = {
    ...validLive,
    status: "unavailable",
    unavailable: false,
    stale: false,
    degraded: false,
  };
  const unavailableCheck = validateFeedSourceMetadata(contradictoryUnavailable);
  assert.equal(unavailableCheck.ok, false);
  assert.ok(unavailableCheck.errors.some((e) => e.includes("unavailable must be true")));
  assert.ok(unavailableCheck.errors.some((e) => e.includes("stale must be true")));

  const mismatchedTimestamps = {
    ...validLive,
    lastUpdatedAt: null,
    ageMs: 5_000,
  };
  const mismatchCheck = validateFeedSourceMetadata(mismatchedTimestamps);
  assert.equal(mismatchCheck.ok, false);
  assert.ok(
    mismatchCheck.errors.some((e) =>
      e.includes("lastUpdatedAt and ageMs must either both be present or both be null"),
    ),
  );
});

test("versionedMarketFeed wraps a healthy empty feed and refuses an unavailable source", () => {
  const liveCache = buildFeedSourceMetadata({
    source: "index",
    updatedAtMs: BASE_NOW,
    freshnessWindowMs: WINDOW_MS,
    nowMs: BASE_NOW,
  });
  const emptyFeed = versionedMarketFeed({
    items: [],
    cache: liveCache,
    nextCursor: null,
  });
  assert.equal(emptyFeed.schemaVersion, API_SCHEMA_VERSION);
  assert.deepEqual(emptyFeed.items, []);
  assert.equal(emptyFeed.count, 0);
  assert.equal(emptyFeed.cache.status, "live");
  assert.equal(emptyFeed.cache.unavailable, false);

  const unavailableCache = unavailableFeedSourceMetadata({
    source: "index",
    nowMs: BASE_NOW,
  });
  assert.throws(
    () => versionedMarketFeed({ items: [], cache: unavailableCache }),
    /unavailable read-index source cannot be wrapped as a successful market feed response/,
  );
});
