/**
 * tests/node/traders-policy.test.ts
 *
 * Unit tests for pure trader policy predicates and bounded decision journal
 * in agents/traders/policy.ts:
 * 1. shouldBuySecondOpinion predicate (BUY_SECOND_OPINION, MIMIR_URL, DRY_RUN, claim fields)
 *    ensuring TRADER_DRY_RUN=1 spends nothing.
 * 2. filterJoinableClaims filtering logic.
 * 3. TraderDecisionJournal bounded capacity and FIFO eviction.
 * 4. Deterministic signal, policy revision, and disposition digest computation.
 * 5. Strict exclusion of private model prompts and signing keys.
 * 6. Sequence reservation coordination and lifecycle transitions.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  computeStakeSizing,
  filterJoinableClaims,
  shouldBuySecondOpinion,
  computeSignalDigest,
  computePolicyRevisionDigest,
  computeDispositionDigest,
  verifyDecisionDigest,
  assertNoSigningMaterial,
  stripPrivatePrompts,
  TraderDecisionJournal,
  createTraderDecisionJournal,
  TraderJournalSecurityError,
  type JoinableClaimCandidate,
  type SecondOpinionClaimFields,
} from "../../agents/traders/policy";
import type { SequenceReservation } from "../../lib/agents/sequence-manager";

const VALID_CLAIM: SecondOpinionClaimFields = {
  question: "Will Stellar exceed 100k daily operations?",
  creator_position: "Yes",
  counter_position: "No",
  resolution_url: "https://stellar.expert/explorer/public",
  settlement_rule: "Based on StellarExpert ledger data.",
};

const TRADER_WALLET = "GDYJ7GZ4WDGYFE6R3HFBUK2GYMFIFP3JHFYSYAME6XISG5BEKZDJVGHN";
const OTHER_WALLET = "GB5DLP3MNPUXXJ6P67XGD3OV3ZVIMZN3NZDLVDIYQN6JSC2M7QMMBL4E";
const FAKE_STELLAR_SECRET = "SB5DLP3MNPUXXJ6P67XGD3OV3ZVIMZN3NZDLVDIYQN6JSC2M7QMMBL4E";

test("shouldBuySecondOpinion: returns true when all conditions are satisfied in non-dry-run mode", () => {
  const result = shouldBuySecondOpinion({
    buySecondOpinion: true,
    mimirUrl: "https://mimir.example.com",
    dryRun: false,
    claim: VALID_CLAIM,
  });
  assert.equal(result, true);
});

test("shouldBuySecondOpinion: returns false when dryRun is true (never spends in dry-run)", () => {
  const result = shouldBuySecondOpinion({
    buySecondOpinion: true,
    mimirUrl: "https://mimir.example.com",
    dryRun: true,
    claim: VALID_CLAIM,
  });
  assert.equal(result, false);
});

test("shouldBuySecondOpinion: returns false when buySecondOpinion is false", () => {
  const result = shouldBuySecondOpinion({
    buySecondOpinion: false,
    mimirUrl: "https://mimir.example.com",
    dryRun: false,
    claim: VALID_CLAIM,
  });
  assert.equal(result, false);
});

test("shouldBuySecondOpinion: returns false when mimirUrl is unset or empty", () => {
  assert.equal(
    shouldBuySecondOpinion({
      buySecondOpinion: true,
      mimirUrl: "",
      dryRun: false,
      claim: VALID_CLAIM,
    }),
    false,
  );
  assert.equal(
    shouldBuySecondOpinion({
      buySecondOpinion: true,
      mimirUrl: "   ",
      dryRun: false,
      claim: VALID_CLAIM,
    }),
    false,
  );
  assert.equal(
    shouldBuySecondOpinion({
      buySecondOpinion: true,
      mimirUrl: null,
      dryRun: false,
      claim: VALID_CLAIM,
    }),
    false,
  );
});

test("shouldBuySecondOpinion: returns false when claim or required claim fields are missing", () => {
  assert.equal(
    shouldBuySecondOpinion({
      buySecondOpinion: true,
      mimirUrl: "https://mimir.example.com",
      dryRun: false,
      claim: null,
    }),
    false,
  );
  assert.equal(
    shouldBuySecondOpinion({
      buySecondOpinion: true,
      mimirUrl: "https://mimir.example.com",
      dryRun: false,
      claim: { ...VALID_CLAIM, question: null },
    }),
    false,
  );
  assert.equal(
    shouldBuySecondOpinion({
      buySecondOpinion: true,
      mimirUrl: "https://mimir.example.com",
      dryRun: false,
      claim: { ...VALID_CLAIM, question: "" },
    }),
    false,
  );
  assert.equal(
    shouldBuySecondOpinion({
      buySecondOpinion: true,
      mimirUrl: "https://mimir.example.com",
      dryRun: false,
      claim: { ...VALID_CLAIM, resolution_url: null },
    }),
    false,
  );
  assert.equal(
    shouldBuySecondOpinion({
      buySecondOpinion: true,
      mimirUrl: "https://mimir.example.com",
      dryRun: false,
      claim: { ...VALID_CLAIM, resolution_url: "  " },
    }),
    false,
  );
});

test("shouldBuySecondOpinion: supports positional argument signature", () => {
  assert.equal(
    shouldBuySecondOpinion(true, "https://mimir.example.com", false, VALID_CLAIM),
    true,
  );
  assert.equal(
    shouldBuySecondOpinion(true, "https://mimir.example.com", true, VALID_CLAIM),
    false,
  );
  assert.equal(
    shouldBuySecondOpinion(false, "https://mimir.example.com", false, VALID_CLAIM),
    false,
  );
});

test("filterJoinableClaims: filters out claims too close to deadline (<= 300s)", () => {
  const now = 1_000_000;
  const claims: JoinableClaimCandidate[] = [
    { id: 1, deadline: now + 300, creator: OTHER_WALLET, visibility: "public" },
    { id: 2, deadline: now + 299, creator: OTHER_WALLET, visibility: "public" },
    { id: 3, deadline: now + 301, creator: OTHER_WALLET, visibility: "public" },
  ];
  const challengers = new Map<number, { address: string }[]>();

  const filtered = filterJoinableClaims(claims, challengers, TRADER_WALLET, now);
  assert.deepEqual(filtered.map((c) => c.id), [3]);
});

test("filterJoinableClaims: filters out claims created by the trader", () => {
  const now = 1_000_000;
  const claims: JoinableClaimCandidate[] = [
    { id: 1, deadline: now + 1000, creator: TRADER_WALLET, visibility: "public" },
    { id: 2, deadline: now + 1000, creator: OTHER_WALLET, visibility: "public" },
  ];
  const challengers = new Map<number, { address: string }[]>();

  const filtered = filterJoinableClaims(claims, challengers, TRADER_WALLET, now);
  assert.deepEqual(filtered.map((c) => c.id), [2]);
});

test("filterJoinableClaims: filters out non-public claims", () => {
  const now = 1_000_000;
  const claims: JoinableClaimCandidate[] = [
    { id: 1, deadline: now + 1000, creator: OTHER_WALLET, visibility: "private" },
    { id: 2, deadline: now + 1000, creator: OTHER_WALLET, visibility: "public" },
  ];
  const challengers = new Map<number, { address: string }[]>();

  const filtered = filterJoinableClaims(claims, challengers, TRADER_WALLET, now);
  assert.deepEqual(filtered.map((c) => c.id), [2]);
});

test("filterJoinableClaims: filters out claims already challenged by this trader", () => {
  const now = 1_000_000;
  const claims: JoinableClaimCandidate[] = [
    { id: 1, deadline: now + 1000, creator: OTHER_WALLET, visibility: "public" },
    { id: 2, deadline: now + 1000, creator: OTHER_WALLET, visibility: "public" },
  ];
  const challengers = new Map<number, { address: string }[]>([
    [1, [{ address: TRADER_WALLET }]],
    [2, [{ address: "SOME_OTHER_CHALLENGER" }]],
  ]);

  const filtered = filterJoinableClaims(claims, challengers, TRADER_WALLET, now);
  assert.deepEqual(filtered.map((c) => c.id), [2]);
});

// ── Bounded Trader Decision Journal Tests ────────────────────────────────────

test("computeSignalDigest: computes deterministic 64-character hex digest independent of key order", () => {
  const signalA = { question: "Will BTC reach 100k?", resolutionUrl: "https://example.com/btc", deadline: 1700000000 };
  const signalB = { deadline: 1700000000, question: "Will BTC reach 100k?", resolutionUrl: "https://example.com/btc" };

  const digestA = computeSignalDigest(signalA);
  const digestB = computeSignalDigest(signalB);

  assert.equal(digestA.length, 64);
  assert.equal(/^[0-9a-f]{64}$/.test(digestA), true);
  assert.equal(digestA, digestB, "Key insertion order must not alter canonical signal digest");
});

test("computePolicyRevisionDigest and computeDispositionDigest: produce deterministic digests", () => {
  const policyRevA = { revision: "v1.2", minConfidence: 70, stakeUsdc: 2 };
  const policyRevB = { stakeUsdc: 2, revision: "v1.2", minConfidence: 70 };
  assert.equal(computePolicyRevisionDigest(policyRevA), computePolicyRevisionDigest(policyRevB));

  const dispA = { action: "stake", verdict: "DISAGREE" as const, confidence: 75, stakeUsdc: 2 };
  const dispB = { stakeUsdc: 2, confidence: 75, verdict: "DISAGREE" as const, action: "stake" };
  assert.equal(computeDispositionDigest(dispA), computeDispositionDigest(dispB));
});

test("verifyDecisionDigest: validates matching digests and catches tampered inputs", () => {
  const signal = { question: "Will XLM surge?", deadline: 1800000000 };
  const policyRevision = "rev_alpha_1";
  const disposition = { action: "stake", verdict: "DISAGREE" as const, confidence: 80 };

  const journal = createTraderDecisionJournal();
  const entry = journal.record({
    agentId: "momentum-forecaster",
    claimId: 42,
    signal,
    policyRevision,
    disposition,
  });

  const check = verifyDecisionDigest(entry, { signal, policyRevision, disposition });
  assert.equal(check.valid, true);
  assert.equal(check.signalMatches, true);
  assert.equal(check.policyRevisionMatches, true);
  assert.equal(check.dispositionMatches, true);

  // Tampered signal
  const tamperedSignalCheck = verifyDecisionDigest(entry, {
    signal: { ...signal, question: "Tampered question" },
    policyRevision,
    disposition,
  });
  assert.equal(tamperedSignalCheck.valid, false);
  assert.equal(tamperedSignalCheck.signalMatches, false);
});

test("assertNoSigningMaterial: throws TraderJournalSecurityError on Stellar secret seeds", () => {
  assert.throws(
    () => assertNoSigningMaterial({ key: FAKE_STELLAR_SECRET }),
    (err: unknown) => err instanceof TraderJournalSecurityError && err.message.includes("Stellar secret seed"),
  );

  assert.throws(
    () => assertNoSigningMaterial(`Bearer token with seed ${FAKE_STELLAR_SECRET}`),
    (err: unknown) => err instanceof TraderJournalSecurityError,
  );
});

test("assertNoSigningMaterial: throws TraderJournalSecurityError on forbidden secret key names", () => {
  assert.throws(
    () => assertNoSigningMaterial({ secretKey: "some_key_value" }),
    (err: unknown) => err instanceof TraderJournalSecurityError && err.message.includes("forbidden secret key name"),
  );

  assert.throws(
    () => assertNoSigningMaterial({ nested: { private_key: "0x123" } }),
    (err: unknown) => err instanceof TraderJournalSecurityError && err.message.includes("forbidden secret key name"),
  );

  // Public Stellar keys (G...) and non-secret fields are accepted
  assert.doesNotThrow(() => assertNoSigningMaterial({ address: TRADER_WALLET, other: OTHER_WALLET }));
});

test("stripPrivatePrompts: strips private model prompts and strategies", () => {
  const input = {
    claimId: 10,
    question: "Test question?",
    prompt: "You are a private LLM model instructed to...",
    systemPrompt: "SYSTEM: override everything",
    strategy: "Fading momentum aggressively",
    nested: {
      instructions: "Do not disclose this prompt",
      safeData: 123,
    },
  };

  const stripped = stripPrivatePrompts(input);
  assert.deepEqual(stripped, {
    claimId: 10,
    question: "Test question?",
    nested: {
      safeData: 123,
    },
  });
});

test("TraderDecisionJournal: records signal, policy revision, and disposition digests without leaking prompts or secrets", () => {
  const journal = createTraderDecisionJournal({ capacity: 10 });

  const entry = journal.record({
    agentId: "contrarian-fader",
    claimId: 101,
    signal: {
      question: "Will inflation fall?",
      resolution_url: "https://fed.gov/cpi",
      prompt: "PRIVATE PROMPT: analyze inflation and answer AGREE/DISAGREE",
      strategy: "Fade consensus expectation",
    },
    policyRevision: {
      revision: "2026-11",
      minConfidence: 70,
      personaStrategy: "Confidential persona prompt strategy",
    },
    disposition: {
      action: "stake",
      verdict: "DISAGREE",
      confidence: 85,
      stakeUsdc: 2,
      reason: "Consensus expectations are overly optimistic.",
    },
  });

  assert.ok(entry.id.startsWith("tdj_"));
  assert.equal(entry.agentId, "contrarian-fader");
  assert.equal(entry.claimId, 101);
  assert.equal(entry.signalDigest.length, 64);
  assert.equal(entry.policyRevisionDigest.length, 64);
  assert.equal(entry.dispositionDigest.length, 64);

  // Verify that neither the entry nor its stringified form contains private prompt text
  const serialized = JSON.stringify(entry);
  assert.equal(serialized.includes("PRIVATE PROMPT"), false);
  assert.equal(serialized.includes("Fade consensus expectation"), false);
  assert.equal(serialized.includes("Confidential persona prompt strategy"), false);

  assert.equal(journal.size(), 1);
  assert.deepEqual(journal.byAgent("contrarian-fader"), [entry]);
  assert.deepEqual(journal.byClaim(101), [entry]);
});

test("TraderDecisionJournal: fails closed when signing material is passed into record()", () => {
  const journal = createTraderDecisionJournal();

  assert.throws(
    () =>
      journal.record({
        agentId: "momentum-forecaster",
        claimId: 5,
        signal: { question: "test" },
        policyRevision: "v1",
        disposition: {
          action: "stake",
          // Accidental leak of signing secret
          signingKey: FAKE_STELLAR_SECRET,
        } as unknown as string,
      }),
    (err: unknown) => err instanceof TraderJournalSecurityError,
  );

  assert.equal(journal.size(), 0, "Security rejection must prevent record from being stored");
});

test("TraderDecisionJournal: coordinates with SequenceReservation lifecycle", () => {
  const journal = createTraderDecisionJournal();

  let state: "reserved" | "submitted" | "released" = "reserved";
  const mockReservation: SequenceReservation = {
    address: TRADER_WALLET,
    sequence: BigInt(123456789),
    get state() {
      return state;
    },
    submit() {
      state = "submitted";
    },
    release() {
      state = "released";
    },
  };

  const entry = journal.record({
    agentId: "quant-thresholder",
    claimId: 202,
    signal: { question: "Will volume exceed 500k?" },
    policyRevision: "v1",
    disposition: { action: "stake", verdict: "DISAGREE", confidence: 90, stakeUsdc: 2 },
    sequenceReservation: mockReservation,
  });

  assert.ok(entry.sequenceReservation);
  assert.equal(entry.sequenceReservation.address, TRADER_WALLET);
  assert.equal(entry.sequenceReservation.sequence, "123456789");
  assert.equal(entry.sequenceReservation.state, "reserved");

  // On-chain transaction lands: update sequence reservation state
  mockReservation.submit();
  const updated = journal.updateReservationState(entry.id, "submitted");
  assert.equal(updated, true);

  const stored = journal.get(entry.id);
  assert.equal(stored?.sequenceReservation?.state, "submitted");
});

test("TraderDecisionJournal: enforces bounded capacity and evicts oldest entries (FIFO)", () => {
  const capacity = 3;
  const journal = createTraderDecisionJournal({ capacity });

  assert.equal(journal.capacity(), 3);
  assert.equal(journal.size(), 0);

  const e1 = journal.record({ agentId: "agent-a", claimId: 1, signal: "s1", policyRevision: "p1", disposition: "pass" });
  const e2 = journal.record({ agentId: "agent-a", claimId: 2, signal: "s2", policyRevision: "p1", disposition: "pass" });
  const e3 = journal.record({ agentId: "agent-b", claimId: 3, signal: "s3", policyRevision: "p1", disposition: "stake" });

  assert.equal(journal.size(), 3);
  assert.deepEqual(journal.entries().map((e) => e.claimId), [1, 2, 3]);

  // Fourth entry exceeds capacity: e1 should be evicted (FIFO)
  const e4 = journal.record({ agentId: "agent-b", claimId: 4, signal: "s4", policyRevision: "p1", disposition: "dry_run" });

  assert.equal(journal.size(), 3);
  assert.deepEqual(journal.entries().map((e) => e.claimId), [2, 3, 4]);
  assert.equal(journal.get(e1.id), undefined);
  assert.equal(journal.get(e2.id)?.claimId, 2);
  assert.equal(journal.last()?.claimId, 4);

  // recent(2) returns the last 2 entries
  assert.deepEqual(journal.recent(2).map((e) => e.claimId), [3, 4]);
});

test("TraderDecisionJournal: failure and boundary cases", () => {
  // Invalid capacity throws RangeError
  assert.throws(() => new TraderDecisionJournal({ capacity: 0 }), RangeError);
  assert.throws(() => new TraderDecisionJournal({ capacity: -10 }), RangeError);
  assert.throws(() => new TraderDecisionJournal({ capacity: 3.5 }), RangeError);

  const journal = new TraderDecisionJournal({ capacity: 2 });

  // Invalid claimId
  assert.throws(
    () => journal.record({ agentId: "trader", claimId: 0, signal: "s", policyRevision: "p", disposition: "pass" }),
    (err: Error) => err.message.includes("claimId must be a positive integer"),
  );
  assert.throws(
    () => journal.record({ agentId: "trader", claimId: -5, signal: "s", policyRevision: "p", disposition: "pass" }),
    (err: Error) => err.message.includes("claimId must be a positive integer"),
  );

  // Missing/empty agentId
  assert.throws(
    () => journal.record({ agentId: "   ", claimId: 1, signal: "s", policyRevision: "p", disposition: "pass" }),
    (err: Error) => err.message.includes("agentId must be a non-empty string"),
  );

  // Malformed precomputed digests
  assert.throws(
    () => journal.record({ agentId: "trader", claimId: 1, signal: "s", signalDigest: "not-a-valid-hex", policyRevision: "p", disposition: "pass" }),
    (err: Error) => err.message.includes("signalDigest must be a 64-character hex string"),
  );

  // Empty journal boundaries
  const emptyJournal = createTraderDecisionJournal();
  assert.equal(emptyJournal.size(), 0);
  assert.deepEqual(emptyJournal.recent(), []);
  assert.deepEqual(emptyJournal.entries(), []);
  assert.equal(emptyJournal.last(), undefined);
  assert.equal(emptyJournal.get("non-existent"), undefined);
  assert.deepEqual(emptyJournal.byAgent("nobody"), []);
  assert.deepEqual(emptyJournal.byClaim(999), []);

  // clear() empties buffer
  journal.record({ agentId: "trader", claimId: 1, signal: "s", policyRevision: "p", disposition: "pass" });
  assert.equal(journal.size(), 1);
  journal.clear();
  assert.equal(journal.size(), 0);
});
