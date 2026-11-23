import assert from "node:assert/strict";
import test from "node:test";

import {
  decideScenarioStep,
  ORACLE_OUTAGE_SCENARIOS,
  runOracleOutageScenario,
  runOracleOutageScenarios,
  type OracleOutageScenario,
  type ScenarioClaim,
  type ScenarioStep,
} from "../../lib/oracle/outage-recovery";
import { SPORTS_SETTLE_GRACE_SECS } from "../../agents/oracle/sports-finality";
import { DEFAULT_SETTLEMENT_RETRY_CONFIG } from "../../lib/settlement-retry";

const CRYPTO_CLAIM: ScenarioClaim = {
  id: 1,
  question: "Will the upgrade ship?",
  category: "crypto",
  deadline: 1_800_000_000,
};

const SPORTS_CLAIM: ScenarioClaim = {
  id: 2,
  question: "Will the home side win?",
  category: "sports",
  deadline: 1_800_000_000,
};

const CREATOR_VERDICT = {
  verdict: "CREATOR_WINS" as const,
  confidence: 95,
  explanation: "The source says the creator side resolved true.",
};

const UNRESOLVABLE_VERDICT = {
  verdict: "UNRESOLVABLE" as const,
  confidence: 0,
  explanation: "The result cannot be determined.",
};

function evidenceStep(overrides: Partial<ScenarioStep> = {}): ScenarioStep {
  return {
    label: "test step",
    now: CRYPTO_CLAIM.deadline + 60,
    sources: [{ id: "primary", reachable: true, outcome: "creator", text: "Resolved YES." }],
    verdict: CREATOR_VERDICT,
    expect: { action: "settle", reason: "firm", verdict: "CREATOR_WINS" },
    ...overrides,
  };
}

function submissionStep(
  overrides: Partial<NonNullable<ScenarioStep["submission"]>> = {},
): ScenarioStep {
  return {
    label: "submission step",
    now: CRYPTO_CLAIM.deadline + 60,
    sources: [],
    verdict: CREATOR_VERDICT,
    submission: {
      error: "timeout waiting for transaction result",
      txHash: "b".repeat(64),
      chainState: "active",
      attempt: 1,
      ...overrides,
    },
    expect: { action: "retry", reason: "submission-uncertain" },
  };
}

// ── Registry and runner ───────────────────────────────────────────────

test("the registry covers every outage named by the issue", () => {
  assert.deepEqual(
    ORACLE_OUTAGE_SCENARIOS.map((scenario) => scenario.id),
    ["source-outage", "contradictory-sources", "delayed-finality", "uncertain-submission"],
  );
});

test("every registered scenario reaches its expected conservative outcome", () => {
  const results = runOracleOutageScenarios();
  assert.equal(results.length, ORACLE_OUTAGE_SCENARIOS.length);
  for (const result of results) {
    assert.equal(result.passed, true, `${result.id} failed: ${JSON.stringify(result.steps, null, 2)}`);
  }
});

test("the runner reports a mismatch instead of silently passing", () => {
  const scenario: OracleOutageScenario = {
    id: "deliberate-mismatch",
    title: "deliberate mismatch",
    outage: "none",
    recovery: "none",
    claim: CRYPTO_CLAIM,
    steps: [
      evidenceStep({
        expect: { action: "defer", reason: "source-outage" },
      }),
    ],
  };
  const result = runOracleOutageScenario(scenario);
  assert.equal(result.passed, false);
  assert.equal(result.steps[0].decision.action, "settle");
});

// ── Contradictory sources ─────────────────────────────────────────────

test("contradictory sources refund even when the model is highly confident", () => {
  const decision = decideScenarioStep(
    CRYPTO_CLAIM,
    evidenceStep({
      sources: [
        { id: "primary", reachable: true, outcome: "creator", text: "Resolved YES." },
        { id: "mirror", reachable: true, outcome: "challengers", text: "Resolved NO." },
      ],
    }),
  );
  assert.equal(decision.action, "refund");
  assert.equal(decision.reason, "contradictory-sources");
  assert.equal(decision.verdict?.verdict, "UNRESOLVABLE");
});

test("an unreachable source is not a conflicting vote", () => {
  const decision = decideScenarioStep(
    CRYPTO_CLAIM,
    evidenceStep({
      sources: [
        { id: "primary", reachable: true, outcome: "creator", text: "Resolved YES." },
        { id: "mirror", reachable: false },
      ],
    }),
  );
  assert.equal(decision.action, "settle");
  assert.equal(decision.verdict?.verdict, "CREATOR_WINS");
});

test("unresolvable sources abstain rather than conflict", () => {
  const decision = decideScenarioStep(
    CRYPTO_CLAIM,
    evidenceStep({
      sources: [
        { id: "primary", reachable: true, outcome: "creator", text: "Resolved YES." },
        { id: "mirror", reachable: true, outcome: "unresolvable", text: "No result available." },
      ],
    }),
  );
  assert.equal(decision.action, "settle");
});

// ── Source outage and recovery ────────────────────────────────────────

test("a total source outage defers without refunding", () => {
  const decision = decideScenarioStep(
    CRYPTO_CLAIM,
    evidenceStep({
      sources: [
        { id: "primary", reachable: false },
        { id: "mirror", reachable: false },
      ],
    }),
  );
  assert.deepEqual(decision, { action: "defer", reason: "source-outage" });
});

test("the source-outage scenario settles after a source recovers", () => {
  const result = runOracleOutageScenario(ORACLE_OUTAGE_SCENARIOS.find((scenario) => scenario.id === "source-outage")!);
  assert.equal(result.passed, true);
  assert.equal(result.steps[0].decision.action, "defer");
  assert.equal(result.steps[1].decision.action, "settle");
  assert.equal(result.steps[1].decision.verdict?.verdict, "CREATOR_WINS");
});

// ── Delayed finality ──────────────────────────────────────────────────

test("a live sports result inside the grace window defers", () => {
  const decision = decideScenarioStep(
    SPORTS_CLAIM,
    evidenceStep({
      now: SPORTS_CLAIM.deadline + 60,
      sources: [{ id: "scoreboard", reachable: true, outcome: "creator", text: "Live: 2nd half." }],
    }),
  );
  assert.deepEqual(decision, { action: "defer", reason: "finality-delayed" });
});

test("exactly at the grace boundary still defers", () => {
  const decision = decideScenarioStep(
    SPORTS_CLAIM,
    evidenceStep({
      now: SPORTS_CLAIM.deadline + SPORTS_SETTLE_GRACE_SECS,
      sources: [{ id: "scoreboard", reachable: true, outcome: "creator", text: "Live: 2nd half." }],
    }),
  );
  assert.deepEqual(decision, { action: "defer", reason: "finality-delayed" });
});

test("one second past grace lets the verdict policy decide", () => {
  const decision = decideScenarioStep(
    SPORTS_CLAIM,
    evidenceStep({
      now: SPORTS_CLAIM.deadline + SPORTS_SETTLE_GRACE_SECS + 1,
      sources: [{ id: "scoreboard", reachable: true, outcome: "unresolvable", text: "Live: 2nd half." }],
      verdict: UNRESOLVABLE_VERDICT,
    }),
  );
  assert.equal(decision.action, "refund");
  assert.equal(decision.reason, "verdict-policy:model-unresolvable");
  assert.equal(decision.verdict?.verdict, "UNRESOLVABLE");
});

test("a final result arriving inside the grace window settles", () => {
  const decision = decideScenarioStep(
    SPORTS_CLAIM,
    evidenceStep({
      now: SPORTS_CLAIM.deadline + 1_200,
      sources: [{ id: "scoreboard", reachable: true, outcome: "creator", text: "Final: 102–99." }],
    }),
  );
  assert.equal(decision.action, "settle");
  assert.equal(decision.verdict?.verdict, "CREATOR_WINS");
});

// ── Uncertain submission ──────────────────────────────────────────────

test("an uncertain submission whose claim is already resolved reconciles without retrying", () => {
  const decision = decideScenarioStep(
    CRYPTO_CLAIM,
    submissionStep({ chainState: "resolved" }),
  );
  assert.equal(decision.action, "reconcile");
  assert.equal(decision.reason, "chain-resolved-after-uncertain-submit");
  assert.equal(decision.delayMs, undefined);
});

test("an uncertain submission against an active claim retries within budget", () => {
  const decision = decideScenarioStep(CRYPTO_CLAIM, submissionStep({ attempt: 1 }));
  assert.equal(decision.action, "retry");
  assert.equal(decision.reason, "submission-uncertain");
  assert.ok((decision.delayMs ?? 0) > 0);
});

test("an uncertain submission defers after the retry budget is exhausted", () => {
  const decision = decideScenarioStep(
    CRYPTO_CLAIM,
    submissionStep({ attempt: DEFAULT_SETTLEMENT_RETRY_CONFIG.maxAttempts }),
  );
  assert.deepEqual(decision, { action: "defer", reason: "retry-exhausted" });
});

test("an unreadable chain after an uncertain submission defers instead of resubmitting", () => {
  const decision = decideScenarioStep(
    CRYPTO_CLAIM,
    submissionStep({ chainState: "unavailable" }),
  );
  assert.deepEqual(decision, { action: "defer", reason: "chain-read-unavailable" });
});

test("a cancelled claim is skipped even when the submission timed out", () => {
  const decision = decideScenarioStep(
    CRYPTO_CLAIM,
    submissionStep({ chainState: "cancelled" }),
  );
  assert.deepEqual(decision, { action: "skip", reason: "chain-cancelled" });
});

test("a duplicate error against an active claim defers rather than retrying or skipping", () => {
  const decision = decideScenarioStep(
    CRYPTO_CLAIM,
    submissionStep({ error: "claim already resolved", chainState: "active" }),
  );
  assert.deepEqual(decision, { action: "defer", reason: "chain-disagrees-with-error" });
});

test("a malformed submission aborts without a retry", () => {
  const decision = decideScenarioStep(
    CRYPTO_CLAIM,
    submissionStep({ error: "invalid verdict payload", chainState: "active" }),
  );
  assert.deepEqual(decision, { action: "abort", reason: "malformed-submission" });
});

test("an operator pause defers without retrying", () => {
  const decision = decideScenarioStep(
    CRYPTO_CLAIM,
    submissionStep({ error: "MIMIR_PAUSE_ORACLE_SETTLEMENT is enabled", chainState: "active" }),
  );
  assert.deepEqual(decision, { action: "defer", reason: "operator-paused" });
});
