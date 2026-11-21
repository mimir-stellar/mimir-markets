/**
 * tests/node/traders-policy.test.ts
 *
 * Unit tests for pure trader policy predicates in agents/traders/policy.ts:
 * 1. shouldBuySecondOpinion predicate (BUY_SECOND_OPINION, MIMIR_URL, DRY_RUN, claim fields)
 *    ensuring TRADER_DRY_RUN=1 spends nothing.
 * 2. filterJoinableClaims filtering logic.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FileSignalConsumptionStore,
  buildSignalIdentity,
  filterJoinableClaims,
  shouldBuySecondOpinion,
  type JoinableClaimCandidate,
  type SecondOpinionClaimFields,
} from "../../agents/traders/policy";

const VALID_CLAIM: SecondOpinionClaimFields = {
  question: "Will Stellar exceed 100k daily operations?",
  creator_position: "Yes",
  counter_position: "No",
  resolution_url: "https://stellar.expert/explorer/public",
  settlement_rule: "Based on StellarExpert ledger data.",
};

const TRADER_WALLET = "GDYJ7GZ4WDGYFE6R3HFBUK2GYMFIFP3JHFYSYAME6XISG5BEKZDJVGHN";
const OTHER_WALLET = "GB5DLP3MNPUXXJ6P67XGD3OV3ZVIMZN3NZDLVDIYQN6JSC2M7QMMBL4E";

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
  // missing claim entirely
  assert.equal(
    shouldBuySecondOpinion({
      buySecondOpinion: true,
      mimirUrl: "https://mimir.example.com",
      dryRun: false,
      claim: null,
    }),
    false,
  );

  // missing question
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

  // missing resolution_url
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
  // Valid non-dry-run
  assert.equal(
    shouldBuySecondOpinion(true, "https://mimir.example.com", false, VALID_CLAIM),
    true,
  );

  // Dry-run returns false
  assert.equal(
    shouldBuySecondOpinion(true, "https://mimir.example.com", true, VALID_CLAIM),
    false,
  );

  // Disabled buying returns false
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

test("buildSignalIdentity: produces deterministic key and rejects empty inputs", () => {
  assert.equal(buildSignalIdentity("momentum-forecaster", 42), "momentum-forecaster:42");
  assert.equal(buildSignalIdentity("  quant-thresholder ", " 7 "), "quant-thresholder:7");
  assert.throws(() => buildSignalIdentity("   ", 42), /non-empty agentId/);
  assert.throws(() => buildSignalIdentity("momentum-forecaster", "   "), /valid claimId/);
  assert.throws(() => buildSignalIdentity("momentum-forecaster", Number.NaN), /valid claimId/);
});

test("shouldBuySecondOpinion: rejects already-consumed signal identity before quote purchase", () => {
  const signalId = buildSignalIdentity("momentum-forecaster", 42);
  const consumed = new Set<string>();

  assert.equal(
    shouldBuySecondOpinion({
      buySecondOpinion: true,
      mimirUrl: "https://mimir.example.com",
      dryRun: false,
      claim: VALID_CLAIM,
      signalId,
      consumedSignals: consumed,
    }),
    true,
  );

  consumed.add(signalId);

  assert.equal(
    shouldBuySecondOpinion({
      buySecondOpinion: true,
      mimirUrl: "https://mimir.example.com",
      dryRun: false,
      claim: VALID_CLAIM,
      signalId,
      consumedSignals: consumed,
    }),
    false,
  );

  // Other claims or agents remain eligible
  assert.equal(
    shouldBuySecondOpinion({
      buySecondOpinion: true,
      mimirUrl: "https://mimir.example.com",
      dryRun: false,
      claim: VALID_CLAIM,
      signalId: buildSignalIdentity("momentum-forecaster", 43),
      consumedSignals: consumed,
    }),
    true,
  );
});

test("shouldBuySecondOpinion: fails closed when consumedSignals is provided without a valid signalId", () => {
  const consumed = new Set<string>();

  assert.equal(
    shouldBuySecondOpinion({
      buySecondOpinion: true,
      mimirUrl: "https://mimir.example.com",
      dryRun: false,
      claim: VALID_CLAIM,
      signalId: "",
      consumedSignals: consumed,
    }),
    false,
  );

  assert.equal(
    shouldBuySecondOpinion({
      buySecondOpinion: true,
      mimirUrl: "https://mimir.example.com",
      dryRun: false,
      claim: VALID_CLAIM,
      consumedSignals: consumed,
    }),
    false,
  );
});

test("FileSignalConsumptionStore: persists consumed signals across restarts and blocks repeat quote purchase", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mimir-trader-signals-"));
  const storePath = path.join(tmpDir, "consumed-signals.json");
  try {
    const signalId = buildSignalIdentity("contrarian-fader", 99);
    const firstStore = new FileSignalConsumptionStore(storePath);

    assert.equal(firstStore.isConsumed(signalId), false);
    assert.equal(
      shouldBuySecondOpinion({
        buySecondOpinion: true,
        mimirUrl: "https://mimir.example.com",
        dryRun: false,
        claim: VALID_CLAIM,
        signalId,
        consumedSignals: firstStore,
      }),
      true,
    );

    const firstRecord = firstStore.markConsumed(signalId, "AGREE", 1_700_000_000_000);
    // Idempotent second mark preserves original timestamp and outcome
    const duplicateRecord = firstStore.markConsumed(signalId, "STAKED", 1_700_000_999_000);
    assert.deepEqual(duplicateRecord, firstRecord);

    // Reload in a fresh store instance (simulating repeat polling after restart)
    const reloadedStore = new FileSignalConsumptionStore(storePath);
    assert.equal(reloadedStore.isConsumed(signalId), true);
    assert.equal(reloadedStore.size(), 1);
    assert.equal(
      shouldBuySecondOpinion({
        buySecondOpinion: true,
        mimirUrl: "https://mimir.example.com",
        dryRun: false,
        claim: VALID_CLAIM,
        signalId,
        consumedSignals: reloadedStore,
      }),
      false,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("FileSignalConsumptionStore: throws on corrupt durable store instead of silently double-spending", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mimir-trader-signals-corrupt-"));
  const storePath = path.join(tmpDir, "consumed-signals.json");
  try {
    fs.writeFileSync(storePath, "{not valid json", "utf8");
    assert.throws(() => new FileSignalConsumptionStore(storePath), /corrupt signal consumption store/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
