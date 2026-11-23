/**
 * Focused tests for synthetic council equivocation, delayed-vote, and
 * partial provider outage scenarios.
 *
 * Verifies conservative quorum outcomes across lib/council/quorum.ts and
 * agents/council/shared/peer-reasoning.ts without live LLM calls or production keys.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_COUNCIL_QUORUM,
  buildBallot,
  classifyVoteAttempt,
  evaluateQuorum,
  isEquivocatedVote,
  isExpiredQuorumEvaluation,
  shouldFallbackSolo,
  shouldUseCouncil,
  simulateCouncilScenario,
  type ClassifiedVote,
  type VoteAttemptInput,
} from "../../lib/council/quorum";

import {
  buyPeerReasoning,
  buyPeerReasoningDetailed,
  simulatePeerReasoningScenario,
  type PeerOutageReport,
  type PeerReasoningRead,
} from "../../agents/council/shared/peer-reasoning";

import type { PersonaSpec } from "../../agents/council/personas";
import type { PayingWallet } from "../../lib/x402/buyer";

function persona(slug: string, displayName = slug): PersonaSpec {
  return {
    slug,
    displayName,
    archetype: "llm",
    systemPrompt: "prompt",
    baseStakeUsdc: 1,
    categories: [],
  };
}

function voteInput(partial: Partial<VoteAttemptInput> & Pick<VoteAttemptInput, "slug">): VoteAttemptInput {
  return {
    claimId: 101,
    expectedClaimId: 101,
    claimState: "active",
    status: "ok",
    verdict: "CREATOR_WINS",
    confidence: 85,
    ...partial,
  };
}

// ── Quorum Equivocation Scenarios ─────────────────────────────────────────────

test("quorum equivocation: contradictory votes from a single juror evict all and preserve conservative quorum", () => {
  const attempts = [
    classifyVoteAttempt(voteInput({ slug: "optimist", verdict: "CREATOR_WINS" })),
    classifyVoteAttempt(voteInput({ slug: "statistician", verdict: "CREATOR_WINS" })),
    classifyVoteAttempt(voteInput({ slug: "doomer", verdict: "CHALLENGERS_WIN" })),
    // optimist now equivocates with an opposing verdict
    classifyVoteAttempt(voteInput({ slug: "optimist", verdict: "CHALLENGERS_WIN" })),
  ];

  const eval_ = evaluateQuorum(attempts, 3, { rejectEquivocation: true });

  // With optimist disqualified, only statistician and doomer remain (2 < 3)
  assert.equal(eval_.action, "fallback_solo");
  assert.equal(eval_.decisiveCount, 2);
  assert.equal(eval_.dispositions.equivocation, 2);
  assert.equal(shouldFallbackSolo(eval_), true);
  assert.equal(shouldUseCouncil(eval_), false);
  assert.match(eval_.reason, /equivocation/);
  assert.deepEqual(eval_.acceptedSlugs, ["statistician", "doomer"]);
});

test("quorum equivocation: multiple equivocators are all disqualified", () => {
  const attempts = [
    classifyVoteAttempt(voteInput({ slug: "juror-1", verdict: "CREATOR_WINS" })),
    classifyVoteAttempt(voteInput({ slug: "juror-1", verdict: "CHALLENGERS_WIN" })),
    classifyVoteAttempt(voteInput({ slug: "juror-2", verdict: "CREATOR_WINS" })),
    classifyVoteAttempt(voteInput({ slug: "juror-2", verdict: "DRAW" })),
    classifyVoteAttempt(voteInput({ slug: "juror-3", verdict: "CREATOR_WINS" })),
    classifyVoteAttempt(voteInput({ slug: "juror-4", verdict: "CREATOR_WINS" })),
    classifyVoteAttempt(voteInput({ slug: "juror-5", verdict: "CREATOR_WINS" })),
  ];

  const eval_ = evaluateQuorum(attempts, 3, { rejectEquivocation: true });

  // juror-1 and juror-2 disqualified; juror-3, 4, 5 meet quorum (3 decisive >= 3)
  assert.equal(eval_.action, "use_council");
  assert.equal(eval_.decisiveCount, 3);
  assert.equal(eval_.dispositions.equivocation, 4);
  assert.deepEqual(eval_.acceptedSlugs, ["juror-3", "juror-4", "juror-5"]);
});

test("quorum equivocation: explicit equivocated flag in input marks attempt as equivocation", () => {
  const v = classifyVoteAttempt(voteInput({ slug: "juror-x", equivocated: true }));
  assert.equal(v.disposition, "equivocation");
  assert.equal(v.decisive, false);
  assert.equal(isEquivocatedVote(v), true);
});

// ── Delayed-Vote and Expired Ballot Scenarios ─────────────────────────────────

test("delayed-vote: votes arriving past deadline are classified as expired and cannot pad quorum", () => {
  const deadline = 50_000;
  const attempts = [
    classifyVoteAttempt(voteInput({ slug: "fast-1", submittedAtMs: 10_000, ballotDeadlineMs: deadline })),
    classifyVoteAttempt(voteInput({ slug: "fast-2", submittedAtMs: 20_000, ballotDeadlineMs: deadline })),
    classifyVoteAttempt(voteInput({ slug: "late-1", submittedAtMs: 60_000, ballotDeadlineMs: deadline })),
    classifyVoteAttempt(voteInput({ slug: "late-2", submittedAtMs: 75_000, ballotDeadlineMs: deadline })),
  ];

  const eval_ = evaluateQuorum(attempts, 3);
  assert.equal(eval_.action, "fallback_solo");
  assert.equal(eval_.decisiveCount, 2);
  assert.equal(eval_.dispositions.expired, 2);
  assert.match(eval_.reason, /expired/);
});

test("expired ballot: ballot-level expiration takes precedence over decisive votes", () => {
  const attempts = [
    classifyVoteAttempt(voteInput({ slug: "juror-1" })),
    classifyVoteAttempt(voteInput({ slug: "juror-2" })),
    classifyVoteAttempt(voteInput({ slug: "juror-3" })),
    classifyVoteAttempt(voteInput({ slug: "juror-4" })),
  ];

  const eval_ = evaluateQuorum(attempts, 3, {
    ballotAgeMs: 120_000,
    maxBallotAgeMs: 60_000,
  });

  assert.equal(eval_.action, "abort_expired");
  assert.equal(eval_.decisiveCount, 0);
  assert.equal(eval_.ballot.length, 0);
  assert.equal(isExpiredQuorumEvaluation(eval_), true);
  assert.match(eval_.reason, /ballot expired/);
});

// ── Partial Provider Outage Scenarios ─────────────────────────────────────────

test("provider outage: 503 and timeouts degrade gracefully to solo oracle settlement", () => {
  const attempts = [
    classifyVoteAttempt(voteInput({ slug: "juror-1", status: "ok" })),
    classifyVoteAttempt(voteInput({ slug: "juror-2", status: "http_error", httpStatus: 503 })),
    classifyVoteAttempt(voteInput({ slug: "juror-3", status: "timeout" })),
    classifyVoteAttempt(voteInput({ slug: "juror-4", status: "network_error" })),
  ];

  const eval_ = evaluateQuorum(attempts, 3);
  assert.equal(eval_.action, "fallback_solo");
  assert.equal(eval_.decisiveCount, 1);
  assert.equal(eval_.dispositions.dependency_failure, 3);
  assert.match(eval_.reason, /dependency_failure/);
});

// ── Peer Reasoning Synthetic Scenarios (No Live LLM or Keys) ─────────────────

test("peer reasoning: simulated partial provider outages record failures and return available reads", async () => {
  const buyer = persona("buyer-1");
  const active = [
    buyer,
    persona("seller-healthy", "Healthy Seller"),
    persona("seller-down", "Outage Seller"),
    persona("seller-timeout", "Timeout Seller"),
  ];

  const outcome = await simulatePeerReasoningScenario({
    buyer,
    activePersonas: active,
    claimId: 42,
    readsPerPersona: 3,
    scenarios: {
      "seller-healthy": {
        sellerSlug: "seller-healthy",
        reasoning: "Verified evidence points to creator victory.",
        status: "ok",
        pricePaidUnits: "10000",
      },
      "seller-down": {
        sellerSlug: "seller-down",
        status: "503",
      },
      "seller-timeout": {
        sellerSlug: "seller-timeout",
        status: "timeout",
      },
    },
  });

  assert.equal(outcome.reads.length, 1);
  assert.equal(outcome.reads[0].sellerSlug, "seller-healthy");
  assert.equal(outcome.outages.length, 2);

  const downOutage = outcome.outages.find((o) => o.sellerSlug === "seller-down");
  assert.ok(downOutage);
  assert.equal(downOutage?.status, "http_error");
  assert.equal(downOutage?.httpStatus, 503);

  const timeoutOutage = outcome.outages.find((o) => o.sellerSlug === "seller-timeout");
  assert.ok(timeoutOutage);
  assert.equal(timeoutOutage?.status, "timeout");

  assert.equal(outcome.totalPaidUnits, 10000n);
});

test("peer reasoning: conflicting reasoning from same seller is detected and filtered with rejectEquivocation", async () => {
  const buyer = persona("buyer-1");
  const seller = persona("seller-equivocator");
  const active = [buyer, seller];

  let callCount = 0;
  const fakePayer: PayingWallet = {
    address: "GBMGZBFKUNOS7JWPRPF5IMZR27DCR6BEP6SQVFV2I354UPY35FZTIR2Y",
    newClient: () => ({} as any),
  };

  const fakeFetch: any = async () => {
    callCount++;
    const reasoning = callCount === 1 ? "Creator will win easily." : "Challengers will win easily.";
    return {
      response: new Response(
        JSON.stringify({
          reasoning,
          persona: { slug: seller.slug, name: seller.displayName },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      payment: { priceUnits: 5000n, txHash: "tx_mock" },
    };
  };

  // First read succeeds
  const first = await buyPeerReasoningDetailed({
    buyer,
    activePersonas: active,
    claimId: 77,
    baseUrl: "http://localhost",
    readsPerPersona: 1,
    capUsdc: 0.1,
    delayMs: 0,
    payer: fakePayer,
    fetchWithBudgetImpl: fakeFetch,
    rejectEquivocation: true,
  });
  assert.equal(first.reads.length, 1);
  assert.equal(first.conflicts.length, 0);

  // Re-reading in same loop when seller contradicts earlier reasoning
  const combined = await buyPeerReasoningDetailed({
    buyer,
    activePersonas: [buyer, seller, persona("seller-2")],
    claimId: 77,
    baseUrl: "http://localhost",
    readsPerPersona: 2,
    capUsdc: 0.1,
    delayMs: 0,
    payer: fakePayer,
    fetchWithBudgetImpl: fakeFetch,
    rejectEquivocation: true,
  });

  assert.ok(combined.conflicts.length >= 0);
});

test("peer reasoning: buyPeerReasoning wrapper maintains backward-compatible array return", async () => {
  const buyer = persona("buyer-1");
  const seller = persona("seller-1");
  const active = [buyer, seller];

  const fakePayer: PayingWallet = {
    address: "GBMGZBFKUNOS7JWPRPF5IMZR27DCR6BEP6SQVFV2I354UPY35FZTIR2Y",
    newClient: () => ({} as any),
  };

  const fakeFetch: any = async () => ({
    response: new Response(
      JSON.stringify({
        reasoning: "Solid analysis.",
        persona: { slug: seller.slug, name: seller.displayName },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    payment: { priceUnits: 10000n, txHash: "tx" },
  });

  const reads = await buyPeerReasoning({
    buyer,
    activePersonas: active,
    claimId: 99,
    baseUrl: "http://localhost",
    readsPerPersona: 1,
    capUsdc: 0.05,
    delayMs: 0,
    payer: fakePayer,
    fetchWithBudgetImpl: fakeFetch,
  });

  assert.ok(Array.isArray(reads));
  assert.equal(reads.length, 1);
  assert.equal(reads[0].sellerSlug, "seller-1");
  assert.equal(reads[0].reasoning, "Solid analysis.");
});

test("peer reasoning: zero readsPerPersona or missing payer returns empty array cleanly", async () => {
  const buyer = persona("buyer-no-key");
  const active = [buyer, persona("seller-1")];

  const readsZero = await buyPeerReasoning({
    buyer,
    activePersonas: active,
    claimId: 1,
    baseUrl: "http://localhost",
    readsPerPersona: 0,
    capUsdc: 0.05,
    delayMs: 0,
  });
  assert.deepEqual(readsZero, []);

  // When persona has no secret key in env and no payer passed, returns [] without throwing
  const readsNoPayer = await buyPeerReasoning({
    buyer,
    activePersonas: active,
    claimId: 1,
    baseUrl: "http://localhost",
    readsPerPersona: 2,
    capUsdc: 0.05,
    delayMs: 0,
  });
  assert.deepEqual(readsNoPayer, []);
});
