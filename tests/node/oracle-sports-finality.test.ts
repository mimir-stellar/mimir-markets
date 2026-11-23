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

// ── Policy version binding to reviewed evidence timestamp ────────────

test("binds policy version to the reviewed evidence timestamp", () => {
  const ts1 = 1_700_000_123_456;
  const decision1 = evaluateSportsFinality(claim(), "Final: 3-1", withinGrace, {
    evidenceTimestamp: ts1,
  });

  assert.equal(decision1.policyId, SPORTS_FINALITY_POLICY_ID);
  assert.equal(decision1.evidenceTimestamp, ts1);
  assert.equal(
    decision1.policyVersion,
    `${SPORTS_FINALITY_POLICY_ID}:${SPORTS_FINALITY_BASE_VERSION}@${ts1}`,
  );
  assert.equal(decision1.final, true);
  assert.equal(decision1.reason, "concluded");

  const ts2 = 1_700_000_999_999;
  const decision2 = evaluateSportsFinality(claim(), "Match in progress", withinGrace, {
    evidenceTimestamp: ts2,
  });
  assert.equal(decision2.evidenceTimestamp, ts2);
  assert.equal(
    decision2.policyVersion,
    `${SPORTS_FINALITY_POLICY_ID}:${SPORTS_FINALITY_BASE_VERSION}@${ts2}`,
  );
  assert.equal(decision2.final, false);
  assert.equal(decision2.reason, "in_progress");
});

test("formatSportsFinalityPolicyVersion and parseSportsFinalityPolicyVersion round-trip", () => {
  const ts = EVIDENCE_TIMESTAMP;
  const formattedDefault = formatSportsFinalityPolicyVersion({ evidenceTimestamp: ts });
  assert.equal(formattedDefault, "sports-finality:v1@1700000000000");

  const parsedDefault = parseSportsFinalityPolicyVersion(formattedDefault);
  assert.equal(parsedDefault.policyId, "sports-finality");
  assert.equal(parsedDefault.baseVersion, "v1");
  assert.equal(parsedDefault.graceHours, undefined);
  assert.equal(parsedDefault.evidenceTimestamp, ts);

  const formattedCustom = formatSportsFinalityPolicyVersion({
    evidenceTimestamp: ts,
    graceHours: 24,
  });
  assert.equal(formattedCustom, "sports-finality:v1:g24h@1700000000000");

  const parsedCustom = parseSportsFinalityPolicyVersion(formattedCustom);
  assert.equal(parsedCustom.policyId, "sports-finality");
  assert.equal(parsedCustom.baseVersion, "v1");
  assert.equal(parsedCustom.graceHours, 24);
  assert.equal(parsedCustom.evidenceTimestamp, ts);
});

// ── Policy identity visibility across configuration changes ──────────

test("keeps policy identity visible after configuration changes", () => {
  // Config 1: 24 hours grace window
  const decision24h = evaluateSportsFinality(claim(), "Final score: 2-0", withinGrace, {
    evidenceTimestamp: EVIDENCE_TIMESTAMP,
    graceHours: 24,
  });
  assert.equal(decision24h.policyId, "sports-finality");
  assert.ok(
    decision24h.policyVersion.startsWith("sports-finality:"),
    `Expected policyVersion to preserve identity prefix, got ${decision24h.policyVersion}`,
  );
  assert.equal(decision24h.policyVersion, `sports-finality:v1:g24h@${EVIDENCE_TIMESTAMP}`);
  assert.equal(decision24h.graceSecs, 24 * 3600);

  // Config 2: 6 hours grace window
  const decision6h = evaluateSportsFinality(claim(), "FT 1-0", withinGrace, {
    evidenceTimestamp: EVIDENCE_TIMESTAMP,
    graceHours: 6,
  });
  assert.equal(decision6h.policyId, "sports-finality");
  assert.ok(decision6h.policyVersion.startsWith("sports-finality:"));
  assert.equal(decision6h.policyVersion, `sports-finality:v1:g6h@${EVIDENCE_TIMESTAMP}`);
  assert.equal(decision6h.graceSecs, 6 * 3600);

  // Config 3: via environment variable SPORTS_SETTLE_GRACE_HOURS
  const prevEnv = process.env.SPORTS_SETTLE_GRACE_HOURS;
  try {
    process.env.SPORTS_SETTLE_GRACE_HOURS = "48";
    assert.equal(getSportsSettleGraceHours(), 48);
    const decisionEnv = evaluateSportsFinality(claim(), "Final: 100-98", withinGrace, {
      evidenceTimestamp: EVIDENCE_TIMESTAMP,
    });
    assert.equal(decisionEnv.policyId, "sports-finality");
    assert.ok(decisionEnv.policyVersion.startsWith("sports-finality:"));
    assert.equal(decisionEnv.policyVersion, `sports-finality:v1:g48h@${EVIDENCE_TIMESTAMP}`);
    assert.equal(decisionEnv.graceSecs, 48 * 3600);
  } finally {
    if (prevEnv !== undefined) {
      process.env.SPORTS_SETTLE_GRACE_HOURS = prevEnv;
    } else {
      delete process.env.SPORTS_SETTLE_GRACE_HOURS;
    }
  }
});

// ── Decision recording ────────────────────────────────────────────────

test("records the applied sports finality policy version with each decision", () => {
  clearRecordedSportsFinalityDecisions();
  assert.equal(getRecordedSportsFinalityDecisions().length, 0);

  const c1 = claim(DEADLINE, 101);
  const d1 = evaluateSportsFinality(c1, "Final score: 3-2", withinGrace, {
    evidenceTimestamp: 1_700_000_001_000,
  });
  assert.equal(d1.final, true);
  assert.equal(d1.claimId, 101);

  const c2 = claim(DEADLINE, 102);
  const d2 = evaluateSportsFinality(c2, "Live in 3rd quarter", withinGrace, {
    evidenceTimestamp: 1_700_000_002_000,
  });
  assert.equal(d2.final, false);
  assert.equal(d2.claimId, 102);

  const c3 = claim(DEADLINE, 103);
  const d3 = evaluateSportsFinality(c3, "Live in progress", pastGrace, {
    evidenceTimestamp: 1_700_000_003_000,
  });
  assert.equal(d3.final, true);
  assert.equal(d3.reason, "grace_window_expired");
  assert.equal(d3.claimId, 103);

  const recorded = getRecordedSportsFinalityDecisions();
  assert.equal(recorded.length, 3);

  assert.equal(recorded[0].claimId, 101);
  assert.equal(recorded[0].policyVersion, "sports-finality:v1@1700000001000");
  assert.equal(recorded[0].final, true);
  assert.equal(recorded[0].reason, "concluded");

  assert.equal(recorded[1].claimId, 102);
  assert.equal(recorded[1].policyVersion, "sports-finality:v1@1700000002000");
  assert.equal(recorded[1].final, false);
  assert.equal(recorded[1].reason, "in_progress");

  assert.equal(recorded[2].claimId, 103);
  assert.equal(recorded[2].policyVersion, "sports-finality:v1@1700000003000");
  assert.equal(recorded[2].final, true);
  assert.equal(recorded[2].reason, "grace_window_expired");
});

// ── Failure and boundary cases ────────────────────────────────────────

test("fails closed and throws on invalid evidence timestamp", () => {
  // Negative timestamp
  assert.throws(
    () => evaluateSportsFinality(claim(), "Final: 1-0", withinGrace, { evidenceTimestamp: -100 }),
    /Invalid evidence timestamp/,
  );

  // Zero timestamp
  assert.throws(
    () => evaluateSportsFinality(claim(), "Final: 1-0", withinGrace, { evidenceTimestamp: 0 }),
    /Invalid evidence timestamp/,
  );

  // NaN timestamp
  assert.throws(
    () => evaluateSportsFinality(claim(), "Final: 1-0", withinGrace, { evidenceTimestamp: NaN }),
    /Invalid evidence timestamp/,
  );

  // Non-finite timestamp
  assert.throws(
    () => evaluateSportsFinality(claim(), "Final: 1-0", withinGrace, { evidenceTimestamp: Infinity }),
    /Invalid evidence timestamp/,
  );

  // Parsing invalid strings
  assert.throws(
    () => parseSportsFinalityPolicyVersion("invalid-no-at-sign"),
    /Invalid sports finality policy version string/,
  );
  assert.throws(
    () => parseSportsFinalityPolicyVersion("sports-finality:v1@not-a-number"),
    /Invalid evidence timestamp in policy version/,
  );
  assert.throws(
    () => parseSportsFinalityPolicyVersion("sports-only@12345"),
    /Invalid policy version format/,
  );
});

test("handles grace configuration boundaries and safely clamps non-positive grace hours", () => {
  // 0 hours should be clamped to at least 1 hour
  assert.equal(getSportsSettleGraceHours(0), 12); // falsy/0 returns default 12
  assert.equal(getSportsSettleGraceHours(-5), 12); // negative returns default 12
  assert.equal(getSportsSettleGraceHours("0"), 12);

  // Explicit graceHours of 1 in evaluateSportsFinality
  const decision1h = evaluateSportsFinality(claim(), "Live: 1st quarter", DEADLINE + 3600 + 1, {
    evidenceTimestamp: EVIDENCE_TIMESTAMP,
    graceHours: 1,
  });
  assert.equal(decision1h.final, true);
  assert.equal(decision1h.reason, "grace_window_expired");
  assert.equal(decision1h.policyVersion, `sports-finality:v1:g1h@${EVIDENCE_TIMESTAMP}`);
});

test("correctly categorizes distinct evidence reasons", () => {
  const evaluate = (text: string) =>
    evaluateSportsFinality(claim(), text, withinGrace, { evidenceTimestamp: EVIDENCE_TIMESTAMP });

  // Concluded
  assert.equal(evaluate("Final: 98-95").reason, "concluded");
  assert.equal(evaluate("Full time: 0-0").reason, "concluded");

  // In progress
  assert.equal(evaluate("Live: 4th quarter").reason, "in_progress");
  assert.equal(evaluate("Match in progress — 80th minute").reason, "in_progress");
  assert.equal(evaluate("Halftime score 1-0").reason, "in_progress");

  // Postponed / upcoming
  assert.equal(evaluate("Game postponed due to rain").reason, "postponed_or_upcoming");
  assert.equal(evaluate("Scheduled for 7:30 PM").reason, "postponed_or_upcoming");
  assert.equal(evaluate("Match suspended").reason, "postponed_or_upcoming");

  // Empty
  assert.equal(evaluate("").reason, "empty_evidence");
  assert.equal(evaluate("   \n\t  ").reason, "empty_evidence");

  // Unrecognized
  assert.equal(evaluate("Random non-sports commentary text here").reason, "unrecognized");
});
