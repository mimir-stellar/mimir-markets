/**
 * Credential-free oracle outage and recovery scenarios (#817).
 *
 * The worker's settlement path crosses four boundaries that fail in different
 * ways: evidence collection, sports finality, the verdict policy, and the
 * funded `resolve_claim` submission. This module models those boundaries with
 * the same pure helpers the worker uses, so contradictory sources, a delayed
 * final result and an uncertain submission can be replayed without a live
 * market, an LLM key, a Stellar seed or an RPC connection.
 *
 * Nothing here is a second settlement policy. Evidence conflicts are converted
 * to an explicit UNRESOLVABLE verdict and then passed through
 * `applySettlementPolicy`, sports finality goes through
 * `isSportsEventFinal`, and submission outcomes go through
 * `classifySettlementError` + `settlementRetryDecision`. The scenarios below
 * only pin the conservative result of each composition:
 *
 *   contradictory sources  → refund, never a side
 *   source outage          → defer, then settle once a source recovers
 *   delayed finality       → defer inside the grace window
 *   uncertain submission   → reconcile the chain before any retry
 *
 * Every scenario is deterministic. `now` is injected, delays are returned as
 * data instead of slept, and no function reads an environment variable or
 * performs I/O.
 */

import type { VerdictPayload } from "../verdict";
import {
  classifySettlementError,
  DEFAULT_SETTLEMENT_RETRY_CONFIG,
  settlementRetryDecision,
  type SettlementRetryConfig,
} from "../settlement-retry";
import { applySettlementPolicy, type UnresolvableReason } from "./unresolvable-policy";
import { tierVerdict } from "./confidence-tiers";
import { isSportsEventFinal } from "../../agents/oracle/sports-finality";

/** The side a source says should win, or that it cannot decide. */
export type SourceOutcome = "creator" | "challengers" | "draw" | "unresolvable";

/** One source the oracle could have read for a claim. */
export interface ScenarioSource {
  /** Stable label used only in scenario output. */
  id: string;
  /** False models a timeout, DNS failure or blocked source. */
  reachable: boolean;
  /** Present only when the source was readable. */
  outcome?: SourceOutcome;
  /** Text the oracle would give the model, used for finality detection. */
  text?: string;
}

/** A claim shape shared by every scenario step. */
export interface ScenarioClaim {
  id: number;
  question: string;
  category: string;
  /** Epoch seconds, matching the on-chain field. */
  deadline: number;
}

/** One failed or ambiguous `resolve_claim` attempt. */
export interface ScenarioSubmission {
  /** Error text the contract boundary surfaced. */
  error: string;
  /** Retained hash, when the RPC returned one. */
  txHash?: string;
  /** Fresh chain state observed after the attempt. */
  chainState: "active" | "resolved" | "cancelled" | "unavailable";
  /** 1-based attempt number. */
  attempt: number;
  /** Defaults to the worker's default retry budget. */
  config?: SettlementRetryConfig;
}

/** What a scenario step expects the oracle to do. */
export interface ScenarioExpectation {
  action: "settle" | "refund" | "defer" | "reconcile" | "retry" | "skip" | "abort";
  /** Stable reason for the expected action, asserted by the runner. */
  reason: string;
  /** For settle/refund steps: the exact verdict the oracle must write. */
  verdict?: VerdictPayload["verdict"];
}

/** One replayable oracle decision. */
export interface ScenarioStep {
  label: string;
  /** Epoch seconds used by finality and grace-window checks. */
  now: number;
  sources: ScenarioSource[];
  /** The model verdict produced from the sources in this step. */
  verdict: VerdictPayload;
  /** Present when this step follows a submission attempt. */
  submission?: ScenarioSubmission;
  expect: ScenarioExpectation;
}

/** A named outage, its recovery, and the conservative outcomes it must produce. */
export interface OracleOutageScenario {
  id: string;
  title: string;
  /** What failed. */
  outage: string;
  /** What must happen for the oracle to resume. */
  recovery: string;
  claim: ScenarioClaim;
  steps: ScenarioStep[];
}

/** The oracle decision a step resolves to. */
export interface ScenarioDecision {
  action: ScenarioExpectation["action"];
  reason: string;
  /** Present for settle/refund decisions. */
  verdict?: VerdictPayload;
  /** Present for retry decisions; returned instead of sleeping. */
  delayMs?: number;
}

export interface ScenarioStepResult {
  label: string;
  decision: ScenarioDecision;
  expectation: ScenarioExpectation;
  passed: boolean;
}

export interface OracleScenarioResult {
  id: string;
  title: string;
  passed: boolean;
  steps: ScenarioStepResult[];
}

const CONTRADICTORY_SOURCES: ScenarioExpectation = {
  action: "refund",
  reason: "contradictory-sources",
  verdict: "UNRESOLVABLE",
};

/**
 * Decide whether readable sources agree. Only `reachable` sources count: an
 * outage is not a vote, so a single surviving source is still usable.
 * `unresolvable` sources abstain rather than conflict.
 */
function sourceConflict(sources: ScenarioSource[]): boolean {
  const outcomes = new Set(
    sources
      .filter((source) => source.reachable && source.outcome && source.outcome !== "unresolvable")
      .map((source) => source.outcome as SourceOutcome),
  );
  return outcomes.size > 1;
}

function evidenceText(sources: ScenarioSource[]): string {
  return sources
    .filter((source) => source.reachable)
    .map((source) => source.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function refund(
  reason: string,
  verdict: VerdictPayload,
  policyReason?: UnresolvableReason,
): ScenarioDecision {
  return {
    action: "refund",
    reason: policyReason ? `${reason}:${policyReason}` : reason,
    verdict,
  };
}

/**
 * Apply the evidence and verdict boundaries in the same order as the worker:
 * outage → finality → contradictory sources → confidence/refund policy.
 *
 * The conflict check deliberately runs before the policy. A high-confidence
 * model verdict is not allowed to break a tie between sources that disagree;
 * the claim is refunded instead of paying one side.
 */
function decideFromEvidence(
  claim: ScenarioClaim,
  step: ScenarioStep,
): ScenarioDecision {
  const readable = step.sources.filter((source) => source.reachable);
  if (readable.length === 0) {
    return { action: "defer", reason: "source-outage" };
  }

  if (claim.category === "sports" && !isSportsEventFinal(claim, evidenceText(step.sources), step.now)) {
    return { action: "defer", reason: "finality-delayed" };
  }

  if (sourceConflict(step.sources)) {
    const unresolvable: VerdictPayload = {
      verdict: "UNRESOLVABLE",
      confidence: 0,
      explanation: `[CONTRADICTORY SOURCES] ${step.verdict.explanation}`.slice(0, 500),
    };
    const decision = applySettlementPolicy(unresolvable, tierVerdict);
    return refund("contradictory-sources", decision.verdict);
  }

  const decision = applySettlementPolicy(step.verdict, tierVerdict);
  if (decision.outcome === "refund") {
    return refund("verdict-policy", decision.verdict, decision.reason);
  }
  return { action: "settle", reason: decision.outcome, verdict: decision.verdict };
}

/**
 * Reconcile an ambiguous submission against fresh chain state.
 *
 * The chain wins over the error text. If Soroban says the claim is resolved, a
 * retry would be a duplicate, so the attempt is reconciled. If the chain cannot
 * be read, the oracle defers instead of resubmitting blind. A retry is returned
 * only while the bounded budget allows it and the claim is still active.
 */
function decideFromSubmission(step: ScenarioStep, submission: ScenarioSubmission): ScenarioDecision {
  const error = Object.assign(new Error(submission.error), submission.txHash ? { txHash: submission.txHash } : {});
  const info = classifySettlementError(error);
  const config = submission.config ?? DEFAULT_SETTLEMENT_RETRY_CONFIG;
  const retry = settlementRetryDecision(info, submission.attempt, config);

  if (submission.chainState === "resolved") {
    return { action: "reconcile", reason: info.kind === "duplicate" ? "chain-already-resolved" : "chain-resolved-after-uncertain-submit" };
  }
  if (submission.chainState === "cancelled") {
    return { action: "skip", reason: "chain-cancelled" };
  }
  if (submission.chainState === "unavailable") {
    return { action: "defer", reason: "chain-read-unavailable" };
  }

  // The fresh read says active. Lifecycle errors that claim the claim is gone
  // disagree with the authoritative read, so neither retry nor skip is safe.
  if (info.kind === "duplicate" || info.kind === "cancelled" || info.kind === "stale") {
    return { action: "defer", reason: "chain-disagrees-with-error" };
  }

  if (retry.action === "retry") {
    return { action: "retry", reason: "submission-uncertain", delayMs: retry.delayMs };
  }
  if (retry.action === "abort") {
    return { action: "abort", reason: "malformed-submission" };
  }
  if (retry.action === "defer") {
    return { action: "defer", reason: info.kind === "paused" ? "operator-paused" : "retry-exhausted" };
  }
  return { action: "defer", reason: retry.reason };
}

/** Resolve one scenario step without I/O, a clock read or an environment read. */
export function decideScenarioStep(claim: ScenarioClaim, step: ScenarioStep): ScenarioDecision {
  if (step.submission) return decideFromSubmission(step, step.submission);
  return decideFromEvidence(claim, step);
}

function matchesExpectation(decision: ScenarioDecision, expectation: ScenarioExpectation): boolean {
  if (decision.action !== expectation.action) return false;
  if (decision.reason !== expectation.reason) return false;
  if (expectation.verdict && decision.verdict?.verdict !== expectation.verdict) return false;
  return true;
}

/** Run every step and report the exact decision alongside the expectation. */
export function runOracleOutageScenario(scenario: OracleOutageScenario): OracleScenarioResult {
  const steps = scenario.steps.map((step) => {
    const decision = decideScenarioStep(scenario.claim, step);
    return {
      label: step.label,
      decision,
      expectation: step.expect,
      passed: matchesExpectation(decision, step.expect),
    };
  });
  return {
    id: scenario.id,
    title: scenario.title,
    passed: steps.every((step) => step.passed),
    steps,
  };
}

/** Run the full registry. Order is stable so CLI output can be diffed. */
export function runOracleOutageScenarios(
  scenarios: readonly OracleOutageScenario[] = ORACLE_OUTAGE_SCENARIOS,
): OracleScenarioResult[] {
  return scenarios.map(runOracleOutageScenario);
}

const CRYPTO_CLAIM: ScenarioClaim = {
  id: 8171,
  question: "Will protocol X ship its upgrade before block 1,000,000?",
  category: "crypto",
  deadline: 1_800_000_000,
};

const SPORTS_CLAIM: ScenarioClaim = {
  id: 8172,
  question: "Will the Lakers beat the Celtics?",
  category: "sports",
  deadline: 1_800_000_000,
};

const CREATOR_SETTLES: VerdictPayload = {
  verdict: "CREATOR_WINS",
  confidence: 91,
  explanation: "Both the primary feed and the mirror report the event resolved YES.",
};

const SOURCE_OUTAGE: OracleOutageScenario = {
  id: "source-outage",
  title: "Evidence source outage, then recovery",
  outage: "Every resolution source times out while the claim is expired.",
  recovery: "A source becomes reachable on a later poll and the claim settles normally.",
  claim: CRYPTO_CLAIM,
  steps: [
    {
      label: "all sources unreachable",
      now: CRYPTO_CLAIM.deadline + 60,
      sources: [
        { id: "primary", reachable: false },
        { id: "mirror", reachable: false },
      ],
      verdict: CREATOR_SETTLES,
      expect: { action: "defer", reason: "source-outage" },
    },
    {
      label: "source recovers and agrees",
      now: CRYPTO_CLAIM.deadline + 120,
      sources: [
        { id: "primary", reachable: true, outcome: "creator", text: "Upgrade shipped at block 999,001." },
        { id: "mirror", reachable: true, outcome: "creator", text: "Upgrade confirmed before the deadline." },
      ],
      verdict: CREATOR_SETTLES,
      expect: { action: "settle", reason: "firm", verdict: "CREATOR_WINS" },
    },
  ],
};

const CONTRADICTORY_SOURCES_SCENARIO: OracleOutageScenario = {
  id: "contradictory-sources",
  title: "Contradictory sources refund instead of choosing a side",
  outage: "Two reachable sources report opposite outcomes while the model is highly confident.",
  recovery: "The conflicting source is retracted; a single authoritative source can settle.",
  claim: CRYPTO_CLAIM,
  steps: [
    {
      label: "primary and mirror disagree",
      now: CRYPTO_CLAIM.deadline + 60,
      sources: [
        { id: "primary", reachable: true, outcome: "creator", text: "Upgrade shipped before the deadline." },
        { id: "mirror", reachable: true, outcome: "challengers", text: "Upgrade slipped past the deadline." },
      ],
      verdict: CREATOR_SETTLES,
      expect: CONTRADICTORY_SOURCES,
    },
    {
      label: "conflicting mirror is retracted",
      now: CRYPTO_CLAIM.deadline + 120,
      sources: [
        { id: "primary", reachable: true, outcome: "creator", text: "Upgrade shipped before the deadline." },
        { id: "mirror", reachable: false },
      ],
      verdict: CREATOR_SETTLES,
      expect: { action: "settle", reason: "firm", verdict: "CREATOR_WINS" },
    },
  ],
};

const DELAYED_FINALITY: OracleOutageScenario = {
  id: "delayed-finality",
  title: "Delayed sports finality defers, then settles or refunds",
  outage: "The match is still live when the claim deadline passes.",
  recovery: "The final result arrives inside the grace window; otherwise the claim refunds after it.",
  claim: SPORTS_CLAIM,
  steps: [
    {
      label: "live result inside the grace window",
      now: SPORTS_CLAIM.deadline + 600,
      sources: [
        { id: "scoreboard", reachable: true, outcome: "creator", text: "Live: 2nd half, 12:04 remaining." },
      ],
      verdict: { verdict: "CREATOR_WINS", confidence: 88, explanation: "The home side leads late." },
      expect: { action: "defer", reason: "finality-delayed" },
    },
    {
      label: "final result arrives inside the grace window",
      now: SPORTS_CLAIM.deadline + 1_200,
      sources: [
        { id: "scoreboard", reachable: true, outcome: "creator", text: "Final: Lakers 102, Celtics 99." },
      ],
      verdict: { verdict: "CREATOR_WINS", confidence: 99, explanation: "Final score confirms the creator side." },
      expect: { action: "settle", reason: "firm", verdict: "CREATOR_WINS" },
    },
    {
      label: "grace window expires with no final result",
      now: SPORTS_CLAIM.deadline + 2 * 24 * 3600,
      sources: [
        { id: "scoreboard", reachable: true, outcome: "unresolvable", text: "Live: 2nd half, 12:04 remaining." },
      ],
      verdict: { verdict: "UNRESOLVABLE", confidence: 0, explanation: "No final result is available." },
      expect: { action: "refund", reason: "verdict-policy:model-unresolvable", verdict: "UNRESOLVABLE" },
    },
  ],
};

const TX_HASH = "a".repeat(64);
const UNCERTAIN_SUBMISSION: OracleOutageScenario = {
  id: "uncertain-submission",
  title: "Uncertain submission reconciles Soroban before retrying",
  outage: "resolve_claim times out after the RPC may have submitted the transaction.",
  recovery: "A fresh get_claim read decides whether to reconcile, retry or defer.",
  claim: CRYPTO_CLAIM,
  steps: [
    {
      label: "timed out, but the chain already resolved",
      now: CRYPTO_CLAIM.deadline + 60,
      sources: [],
      verdict: CREATOR_SETTLES,
      submission: {
        error: "timeout waiting for transaction result",
        txHash: TX_HASH,
        chainState: "resolved",
        attempt: 1,
      },
      expect: { action: "reconcile", reason: "chain-resolved-after-uncertain-submit" },
    },
    {
      label: "timed out and the chain is still active",
      now: CRYPTO_CLAIM.deadline + 120,
      sources: [],
      verdict: CREATOR_SETTLES,
      submission: {
        error: "timeout waiting for transaction result",
        txHash: TX_HASH,
        chainState: "active",
        attempt: 1,
      },
      expect: { action: "retry", reason: "submission-uncertain" },
    },
    {
      label: "retry budget exhausted while still active",
      now: CRYPTO_CLAIM.deadline + 180,
      sources: [],
      verdict: CREATOR_SETTLES,
      submission: {
        error: "timeout waiting for transaction result",
        txHash: TX_HASH,
        chainState: "active",
        attempt: DEFAULT_SETTLEMENT_RETRY_CONFIG.maxAttempts,
      },
      expect: { action: "defer", reason: "retry-exhausted" },
    },
    {
      label: "chain read unavailable after the timeout",
      now: CRYPTO_CLAIM.deadline + 240,
      sources: [],
      verdict: CREATOR_SETTLES,
      submission: {
        error: "timeout waiting for transaction result",
        txHash: TX_HASH,
        chainState: "unavailable",
        attempt: 1,
      },
      expect: { action: "defer", reason: "chain-read-unavailable" },
    },
  ],
};

/** Stable registry used by the CLI and the focused test suite. */
export const ORACLE_OUTAGE_SCENARIOS: readonly OracleOutageScenario[] = [
  SOURCE_OUTAGE,
  CONTRADICTORY_SOURCES_SCENARIO,
  DELAYED_FINALITY,
  UNCERTAIN_SUBMISSION,
];
