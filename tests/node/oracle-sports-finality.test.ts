import assert from "node:assert/strict";
import test from "node:test";

import {
  SPORTS_FINALITY_BASE_VERSION,
  SPORTS_FINALITY_POLICY_ID,
  SPORTS_SETTLE_GRACE_HOURS_DEFAULT,
  SPORTS_SETTLE_GRACE_SECS,
  clearRecordedSportsFinalityDecisions,
  evaluateSportsFinality,
  formatSportsFinalityPolicyVersion,
  getRecordedSportsFinalityDecisions,
  getSportsSettleGraceHours,
  isSportsEventFinal,
  parseSportsFinalityPolicyVersion,
  type SportsClaim,
} from "../../agents/oracle/sports-finality";

const DEADLINE = 1_000_000; // epoch seconds, well within the grace window by default
const withinGrace = DEADLINE + 1_000; // ~17 min after deadline, inside 12h grace
const pastGrace = DEADLINE + SPORTS_SETTLE_GRACE_SECS + 1; // one second past grace
const graceBoundary = DEADLINE + SPORTS_SETTLE_GRACE_SECS; // exactly at the boundary
const EVIDENCE_TIMESTAMP = 1_700_000_000_000; // epoch ms

function claim(deadline = DEADLINE, id = 42): SportsClaim {
  return { id, deadline };
}

test("sports grace window default is twelve hours", () => {
  assert.equal(SPORTS_SETTLE_GRACE_SECS, 12 * 3600);
  assert.equal(SPORTS_SETTLE_GRACE_HOURS_DEFAULT, 12);
  assert.equal(getSportsSettleGraceHours(), 12);
});

// ── Final evidence → settle ───────────────────────────────────────────

test("final score text is treated as final", () => {
  assert.equal(isSportsEventFinal(claim(), "Final: Lakers 102, Celtics 99", withinGrace), true);
});

test("final score label is treated as final", () => {
  assert.equal(isSportsEventFinal(claim(), "Final score: 2-1", withinGrace), true);
});

test("full time text is treated as final", () => {
  assert.equal(isSportsEventFinal(claim(), "Full time: 1-1", withinGrace), true);
});

test("FT abbreviation is treated as final", () => {
  assert.equal(isSportsEventFinal(claim(), "FT 3-2", withinGrace), true);
});

// ── Not-final evidence → defer ────────────────────────────────────────

test("live in-progress text is not final", () => {
  assert.equal(isSportsEventFinal(claim(), "Live: 2nd quarter, 6:12 remaining", withinGrace), false);
});

test("in-progress minute text is not final", () => {
  assert.equal(isSportsEventFinal(claim(), "Match in progress — 58th minute", withinGrace), false);
});

test("postponed text is not final", () => {
  assert.equal(
    isSportsEventFinal(claim(), "Postponed due to weather, new date TBD", withinGrace),
    false,
  );
});

test("scheduled/upcoming text is not final", () => {
  assert.equal(isSportsEventFinal(claim(), "Scheduled for 8pm ET tomorrow", withinGrace), false);
});

test("empty evidence is not final", () => {
  assert.equal(isSportsEventFinal(claim(), "", withinGrace), false);
});

// ── Grace window boundaries → settle regardless of evidence ───────────

test("one second past the grace window settles even with live evidence", () => {
  assert.equal(isSportsEventFinal(claim(), "Live: 2nd quarter", pastGrace), true);
});

test("exactly at the grace boundary is not past grace and still defers", () => {
  assert.equal(isSportsEventFinal(claim(), "Live: 2nd quarter", graceBoundary), false);
});

// ── Evidence acquisition failure classes ──────────────────────────────

test("unavailable evidence defers and is not treated as final", () => {
  assert.equal(isSportsEventFinal(claim(), undefined as unknown as string, withinGrace), false);
});

test("stale evidence defers rather than settling inside grace", () => {
  assert.equal(isSportsEventFinal(claim(), "Live: 2nd quarter, 6:12 remaining", withinGrace), false);
});

test("malformed evidence defers and is not treated as final", () => {
  assert.equal(isSportsEventFinal(claim(), null as unknown as string, withinGrace), false);
});

test("unsupported evidence category defers and is not treated as final", () => {
  assert.equal(isSportsEventFinal(claim(), "Cricket: Test match, day 3 stumps", withinGrace), false);
});

test("dependency failure at grace boundary still defers, not settled", () => {
  assert.equal(isSportsEventFinal(claim(), undefined as unknown as string, graceBoundary), false);
});
