import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import fixtures from "../../fixtures/payout-rounding/v1.json";
import { splitFees, settleMarket, type FeeSnapshot } from "../../lib/fees";
import { poolChallengerPayoutUnits, previewChallengerPayoutSafe } from "../../lib/payout";
import { ROUNDING_POLICY_VERSION, requireRoundingPolicyVersion, UnsupportedRoundingPolicyVersion } from "../../lib/rounding-policy";
import { feeTerms, PLATFORM_RECIPIENT, AGENT_OWNER_RECIPIENT } from "./payout-preview-fixtures";

test("shared fixtures pin the same version as Rust and client settlement", () => {
  const rust = readFileSync(new URL("../../contracts-soroban/mimir-market/src/fees.rs", import.meta.url), "utf8");
  const version = rust.match(/pub const ROUNDING_POLICY_VERSION: u32 = (\d+);/);
  assert.ok(version);
  assert.equal(Number(version[1]), ROUNDING_POLICY_VERSION);
  assert.equal(fixtures.roundingPolicyVersion, ROUNDING_POLICY_VERSION);
  assert.equal(fixtures.usdcDecimals, 7);
  for (const row of fixtures.feeVectors) {
    const snapshot: FeeSnapshot = {
      platformFeeBps: row.platformBps, agentOwnerFeeBps: row.ownerBps,
      platformRecipient: PLATFORM_RECIPIENT, agentOwnerRecipient: AGENT_OWNER_RECIPIENT,
      takenAt: 0, agentId: null,
    };
    const split = splitFees({
      principalUnits: BigInt(row.principal), grossPayoutUnits: BigInt(row.gross),
      snapshot, outcome: "challengers_win", requiredRoundingPolicyVersion: fixtures.roundingPolicyVersion,
    });
    assert.equal(split.payoutUnits, BigInt(row.net), row.name);
    assert.equal(split.platformFeeUnits + split.agentOwnerFeeUnits, BigInt(row.fee), row.name);
  }
});

test("preview publishes version 1 and leaves existing payout values unchanged", () => {
  const args = { settlementMode: "fixed_odds" as const, stake: 2.013, creatorStake: 10,
    challengerPoolBefore: 0, challengerPayoutBps: 10_001, fees: { status: "ready" as const,
      terms: feeTerms({ platformFeeBps: 700, agentOwnerFeeBps: 300 }) } };
  const legacy = previewChallengerPayoutSafe(args);
  const versioned = previewChallengerPayoutSafe({ ...args, requiredRoundingPolicyVersion: ROUNDING_POLICY_VERSION });
  assert.deepEqual(versioned, legacy);
  assert.equal(versioned.roundingPolicyVersion, 1);
  assert.equal(versioned.platformFee, 0.000014);
  assert.equal(versioned.agentOwnerFee, 0.000006);
  assert.equal(versioned.netPayout, 2.0131813);
  assert.equal(previewChallengerPayoutSafe({ ...args, fees: { status: "unavailable" } }).roundingPolicyVersion, 1);
});

test("settlement accepts policy 1 and preserves the unversioned result", () => {
  const snapshot: FeeSnapshot = { platformFeeBps: 700, agentOwnerFeeBps: 300,
    platformRecipient: PLATFORM_RECIPIENT, agentOwnerRecipient: AGENT_OWNER_RECIPIENT,
    takenAt: 0, agentId: null };
  const participants = [
    { address: "creator-example", stakeUnits: 2013n, grossPayoutUnits: 0n },
    { address: "challenger-example", stakeUnits: 20130000n, grossPayoutUnits: 20132013n },
  ];
  const args = { participants, snapshot, outcome: "challengers_win" as const };
  const legacy = settleMarket(args);
  assert.deepEqual(settleMarket({ ...args, requiredRoundingPolicyVersion: fixtures.roundingPolicyVersion }), legacy);
  assert.equal(legacy.totalPayoutUnits, 20131813n);
  assert.equal(legacy.totalPlatformFeeUnits + legacy.totalAgentOwnerFeeUnits, 200n);
  assert.equal(legacy.dustUnits, 0n);
});

test("unsupported policies reject previews and settlement including zero-fee paths", () => {
  const snapshot: FeeSnapshot = { platformFeeBps: 0, agentOwnerFeeBps: 0,
    platformRecipient: "", agentOwnerRecipient: null, takenAt: 0, agentId: null };
  for (const version of [0, 2, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 4294967295]) {
    assert.throws(() => requireRoundingPolicyVersion(version), UnsupportedRoundingPolicyVersion);
    assert.throws(() => previewChallengerPayoutSafe({ settlementMode: "pool", stake: 0,
      creatorStake: 0, challengerPoolBefore: 0, requiredRoundingPolicyVersion: version }), UnsupportedRoundingPolicyVersion);
    assert.throws(() => splitFees({ principalUnits: 0n, grossPayoutUnits: 0n,
      snapshot, outcome: "draw", requiredRoundingPolicyVersion: version }), UnsupportedRoundingPolicyVersion);
    assert.throws(() => settleMarket({ participants: [], snapshot,
      outcome: "draw", requiredRoundingPolicyVersion: version }), UnsupportedRoundingPolicyVersion);
  }
  for (const value of [null, "1", {}, []]) {
    const version = value as unknown as number;
    assert.throws(() => previewChallengerPayoutSafe({ settlementMode: "pool", stake: 0,
      creatorStake: 0, challengerPoolBefore: 0, requiredRoundingPolicyVersion: version }), UnsupportedRoundingPolicyVersion);
  }
});

test("pool fixture accounts for integer truncation and one atomic unit of final-claim dust", () => {
  const row = fixtures.poolVector;
  const gross = poolChallengerPayoutUnits({ stakeUnits: BigInt(row.challengerStake),
    creatorStakeUnits: BigInt(row.creatorStake), challengerPoolUnits: BigInt(row.totalChallengerStake) });
  assert.equal(gross.totalReturnUnits, BigInt(row.formulaGross));
  assert.equal(BigInt(row.finalGross) - gross.totalReturnUnits, BigInt(row.dust));
  assert.equal(2n * gross.totalReturnUnits + BigInt(row.finalGross),
    BigInt(row.creatorStake) + BigInt(row.totalChallengerStake));
});
