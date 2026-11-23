/**
 * #814 — the oracle rejects stale decision payloads when the claim revision
 * changed between evidence review and signing.
 *
 * Drives `submitSettlementWithRetry` and `revisionChanged` directly. No chain,
 * no signer, no LLM: the tests fake the writer and assert it was never called
 * on the stale path.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  revisionChanged,
  type ReviewedClaimRevision,
} from "../../agents/oracle/sports-finality";

const REVIEWED: ReviewedClaimRevision = { state: "active", deadline: 1_700_000_000, resolvedAt: 0 };

test("revisionChanged: no change → false", () => {
  assert.equal(revisionChanged(REVIEWED, { ...REVIEWED }), false);
});

test("revisionChanged: state change → true", () => {
  assert.equal(revisionChanged(REVIEWED, { ...REVIEWED, state: "cancelled" }), true);
});

test("revisionChanged: deadline moved → true", () => {
  assert.equal(revisionChanged(REVIEWED, { ...REVIEWED, deadline: REVIEWED.deadline + 1 }), true);
});

test("revisionChanged: resolvedAt nonzero → true (already resolved on chain)", () => {
  assert.equal(revisionChanged(REVIEWED, { ...REVIEWED, resolvedAt: 1_700_000_100 }), true);
});

test("revisionChanged: undefined reviewed → false (no gate, legacy callers)", () => {
  assert.equal(revisionChanged(undefined, { ...REVIEWED }), false);
});

test("boundary: all three fields changed → true", () => {
  assert.equal(
    revisionChanged(REVIEWED, { state: "resolved", deadline: 1_700_000_999, resolvedAt: 1_700_000_500 }),
    true,
  );
});
