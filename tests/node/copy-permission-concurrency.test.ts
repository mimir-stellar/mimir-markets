import assert from "node:assert/strict";
import test from "node:test";

import { explainCopySkipReason } from "../../lib/copy-trading";
import {
  COPY_FIXTURE_NOW_MS,
  COPY_FIXTURE_UNIT,
  createCopyPermissionScenario,
  type CopySignalFixture,
} from "./copy-permission-fixtures";

function signal(claimId: number, stakeUsdc = 3): CopySignalFixture {
  return {
    sourcePositionId: `pos-${claimId}`,
    signalAgentId: "agent-a",
    sourceDepth: 0,
    claimId,
    category: "crypto",
    mode: "pool",
    confidenceBps: 8000,
    payoutBps: 15000,
    stakeUsdc,
    deadline: COPY_FIXTURE_NOW_MS + 30_000,
    remainingSlots: 3,
    availableLiquidityUsdc: 20,
    requiredLiquidityUsdc: stakeUsdc,
    sourceAttributionId: `attr-${claimId}`,
  };
}

const outcome = (result: { status: string; reason?: string }) =>
  result.status === "executed" ? "executed" : result.reason;

test("simultaneous previews cannot double-spend the signed daily cap", async (t) => {
  const scenario = createCopyPermissionScenario();
  t.after(() => scenario.close());
  const batch = [signal(7), signal(8), signal(9)];

  const previews = await scenario.preview(batch);
  assert.deepEqual(previews.map((preview) => preview.policyEligible), [true, true, true]);
  assert.deepEqual(previews.map((preview) => preview.stakeAtomic), ["30000000", "30000000", "30000000"]);

  const results = await scenario.execute(batch);
  assert.deepEqual(results.map(outcome), ["executed", "daily_cap", "daily_cap"]);
  assert.equal(scenario.totalExecutedAtomic(), 3n * COPY_FIXTURE_UNIT);
  assert.equal(scenario.allowanceAtomic(), 7n * COPY_FIXTURE_UNIT);

  const check = scenario.assertWithinSignedPolicy();
  assert.equal(check.executed, 1);
  assert.equal(check.skipped, 2);
  assert.equal(check.totalStakeAtomic, "30000000");
  assert.equal(check.remainingAllowanceAtomic, "70000000");
  assert.equal(check.signedPolicyHash, scenario.signedPolicyHash);
});

test("two stakes landing exactly on the signed cap execute; the next fractional stake skips", async (t) => {
  const scenario = createCopyPermissionScenario();
  t.after(() => scenario.close());

  const results = await scenario.execute([signal(7, 2), signal(8, 3), signal(9, 0.000001)]);
  assert.deepEqual(results.map(outcome), ["executed", "executed", "daily_cap"]);
  assert.equal(scenario.totalExecutedAtomic(), 5n * COPY_FIXTURE_UNIT);
  assert.equal(scenario.assertWithinSignedPolicy().totalStakeAtomic, "50000000");
});

test("a signed revocation between preview and execution authorizes nothing", async (t) => {
  const scenario = createCopyPermissionScenario();
  t.after(() => scenario.close());
  const batch = [signal(7), signal(8)];

  assert.deepEqual((await scenario.preview(batch)).map((preview) => preview.policyEligible), [true, true]);
  const revokeMessage = scenario.revoke({ nonce: "revoke-preview-gap" });
  assert.match(revokeMessage, /action: revoke/);
  assert.match(revokeMessage, /permission: copy-permission-887/);

  const results = await scenario.execute(batch);
  assert.deepEqual(results.map(outcome), ["permission_revoked", "permission_revoked"]);
  assert.equal(scenario.totalExecutedAtomic(), 0n);
  assert.equal(scenario.allowanceAtomic(), 10n * COPY_FIXTURE_UNIT);
});

test("revocation after the first simultaneous execution stops the rest", async (t) => {
  const scenario = createCopyPermissionScenario();
  t.after(() => scenario.close());
  const batch = [signal(7), signal(8), signal(9)];

  assert.deepEqual((await scenario.preview(batch)).map((preview) => preview.policyEligible), [true, true, true]);
  const results = await scenario.execute(batch, {
    afterExecution: (index, row) => {
      if (index === 0 && row.status === "executed") scenario.revoke({ nonce: "revoke-mid-flight" });
    },
  });

  assert.deepEqual(results.map(outcome), ["executed", "permission_revoked", "permission_revoked"]);
  assert.equal(scenario.totalExecutedAtomic(), 3n * COPY_FIXTURE_UNIT);
  assert.equal(scenario.assertWithinSignedPolicy().executed, 1);
});

test("a raised limit in a mutated policy cannot authorize a larger stake", async (t) => {
  const scenario = createCopyPermissionScenario();
  t.after(() => scenario.close());
  scenario.replacePermission({
    ...scenario.permission,
    maxPerPositionUsdc: 20,
    dailyCapUsdc: 50,
    spendPermission: {
      ...scenario.permission.spendPermission,
      allowanceAtomic: 50n * COPY_FIXTURE_UNIT,
    },
  });

  const results = await scenario.execute([signal(7, 20)]);
  assert.deepEqual(results.map(outcome), ["policy_hash_mismatch"]);
  assert.equal(scenario.totalExecutedAtomic(), 0n);
  assert.match(explainCopySkipReason("policy_hash_mismatch"), /signed policy/i);
});

test("audit and chain state survive a resumed scenario from the same temporary directory", async (t) => {
  const first = createCopyPermissionScenario();
  t.after(() => first.close());
  await first.execute([signal(7)]);

  const resumed = createCopyPermissionScenario({ stateDir: first.stateDir });
  const results = await resumed.execute([signal(7), signal(8, 1)]);
  assert.deepEqual(results.map(outcome), ["duplicate_position", "executed"]);
  assert.equal(resumed.totalExecutedAtomic(), 4n * COPY_FIXTURE_UNIT);
  assert.equal(resumed.audit().length, 3);
});
