import assert from "node:assert/strict";
import test from "node:test";

import {
  clearCopyPreviewCache,
  copyPermissionRevision,
  copyPreviewKey,
  createCopyPreviewCacheEntry,
  evaluateCopy,
  evaluateCopyWithPreview,
  getCopyPreviewCache,
  getCopyPreviewCacheByPosition,
  invalidateCopyPreview,
  invalidateCopyPreviewsForPermission,
  setCopyPreviewCache,
  validateCopyExecutionAgainstPreview,
  type CopyExecutionContext,
  type CopyPermission,
  type CopyPreviewCacheEntry,
  type CopySignal,
} from "../../lib/copy-trading";
import { spendPermissionRevision, type SpendPermissionRecord } from "../../lib/agents/spend-permissions";
import { buildCopyExecutionDryRun } from "../../lib/copy-execution-dry-run";

const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const MIMIR = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const OWNER = "GBMGZBFKUNOS7JWPRPF5IMZR27DCR6BEP6SQVFV2I354UPY35FZTIR2Y";
const NOW = 1_800_000_000_000;
const UNIT = 10_000_000n;

function permission(overrides: Partial<CopyPermission> = {}): CopyPermission {
  return {
    permissionId: "perm-copy-1",
    ownerWallet: OWNER,
    executionAgentId: "agent-b",
    signalAgentId: "agent-a",
    maxPerPositionUsdc: 5,
    dailyCapUsdc: 10,
    weeklyCapUsdc: 30,
    totalOpenExposureUsdc: 20,
    maxRealizedLossAtomic: "150000000",
    allowedCategories: ["crypto"],
    allowedModes: ["pool"],
    minConfidenceBps: 7000,
    minPayoutBps: 12000,
    expiresAt: NOW + 86_400_000,
    depth: 1,
    status: "active",
    spendPermission: {
      token: USDC,
      spender: MIMIR,
      allowanceAtomic: 100n * UNIT,
      periodSeconds: 86400,
    },
    signedPolicyHash: "hash-initial",
    ...overrides,
  };
}

function signal(overrides: Partial<CopySignal> = {}): CopySignal {
  return {
    sourcePositionId: "pos-1",
    signalAgentId: "agent-a",
    sourceDepth: 0,
    claimId: 42,
    category: "crypto",
    mode: "pool",
    confidenceBps: 8500,
    payoutBps: 15000,
    stakeUsdc: 3,
    deadline: NOW + 300_000,
    remainingSlots: 5,
    availableLiquidityUsdc: 100,
    requiredLiquidityUsdc: 3,
    sourceAttributionId: "attr-1",
    marketState: "open",
    ...overrides,
  };
}

function context(overrides: Partial<CopyExecutionContext> = {}): CopyExecutionContext {
  return {
    now: NOW,
    globalPaused: false,
    usage: {
      usedTodayUsdc: 0,
      usedThisWeekUsdc: 0,
      openExposureUsdc: 0,
      realizedLossAtomic: "0",
    },
    existingClaimIds: new Set<number>(),
    ancestryAgentIds: ["agent-a"],
    configuredUsdc: USDC,
    configuredSpender: MIMIR,
    onchainAllowanceAtomic: 100n * UNIT,
    simulation: { ok: true, blockNumber: 1000n },
    ...overrides,
  };
}

test("preview cache entry binds to the permission revision", () => {
  clearCopyPreviewCache();
  const perm = permission();
  const sig = signal();
  const rev = copyPermissionRevision(perm);

  const dryRun = buildCopyExecutionDryRun({
    permission: perm,
    signal: sig,
    context: context(),
    env: { MIMIR_FEATURE_COPY_TRADING: "1" },
  });

  assert.equal(dryRun.policyEligible, true);
  assert.equal(dryRun.stakeAtomic, "30000000");
  assert.equal(dryRun.permissionRevision, rev);
  assert.ok(dryRun.previewId);

  const cached = getCopyPreviewCache(dryRun.previewId!, NOW);
  assert.ok(cached);
  assert.equal(cached?.permissionRevision, rev);
  assert.equal(cached?.stakeAtomic, "30000000");
  assert.equal(cached?.stakeUsdc, 3);
  assert.equal(cached?.allowed, true);
  assert.equal(cached?.policyEligible, true);
});

test("policy update changes revision and invalidates previous preview", () => {
  clearCopyPreviewCache();
  const perm = permission();
  const sig = signal();
  const initialRev = copyPermissionRevision(perm);

  const entry = createCopyPreviewCacheEntry({
    permission: perm,
    signal: sig,
    decision: { allowed: true, stakeUsdc: 3 },
    policyEligible: true,
    now: NOW,
  });
  setCopyPreviewCache(entry);

  // 1. Cap change (e.g. owner lowers maxPerPositionUsdc to 2)
  const updatedPerm = permission({ maxPerPositionUsdc: 2 });
  const updatedRev = copyPermissionRevision(updatedPerm);
  assert.notEqual(updatedRev, initialRev);

  const result = validateCopyExecutionAgainstPreview({
    preview: entry,
    permission: updatedPerm,
    executionStakeAtomic: 30000000n,
    executionStakeUsdc: 3,
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "revision_mismatch");

  // 2. Monotonic revision bump
  const bumpedPerm = permission({ revision: 1 });
  assert.notEqual(copyPermissionRevision(bumpedPerm), initialRev);
  const bumpResult = validateCopyExecutionAgainstPreview({
    preview: entry,
    permission: bumpedPerm,
    executionStakeAtomic: 30000000n,
    now: NOW,
  });
  assert.equal(bumpResult.ok, false);
  assert.equal(bumpResult.reason, "revision_mismatch");

  // 3. Category allowlist change
  const categoryPerm = permission({ allowedCategories: ["macro"] });
  assert.notEqual(copyPermissionRevision(categoryPerm), initialRev);
});

test("revocation changes revision, invalidates cached preview, and blocks execution", () => {
  clearCopyPreviewCache();
  const perm = permission();
  const sig = signal();

  const entry = createCopyPreviewCacheEntry({
    permission: perm,
    signal: sig,
    decision: { allowed: true, stakeUsdc: 3 },
    policyEligible: true,
    now: NOW,
  });
  setCopyPreviewCache(entry);
  assert.ok(getCopyPreviewCache(entry.previewId, NOW));

  // Invalidate cache on owner revocation
  const purged = invalidateCopyPreviewsForPermission(perm.permissionId);
  assert.equal(purged, 1);
  assert.equal(getCopyPreviewCache(entry.previewId, NOW), null);

  // Even if caller presents the old preview entry directly:
  const revokedPerm = permission({ status: "revoked" });
  assert.notEqual(copyPermissionRevision(revokedPerm), entry.permissionRevision);

  const check = validateCopyExecutionAgainstPreview({
    preview: entry,
    permission: revokedPerm,
    executionStakeAtomic: 30000000n,
    executionStakeUsdc: 3,
    now: NOW,
  });
  assert.equal(check.ok, false);
  assert.equal(check.reason, "permission_revoked");
});

test("exact amounts are strictly preserved between preview and execution", () => {
  clearCopyPreviewCache();
  const perm = permission();
  const sig = signal({ stakeUsdc: 2.75 }); // fractional USDC

  const entry = createCopyPreviewCacheEntry({
    permission: perm,
    signal: sig,
    decision: { allowed: true, stakeUsdc: 2.75 },
    policyEligible: true,
    now: NOW,
  });
  assert.equal(entry.stakeAtomic, "27500000");
  assert.equal(entry.stakeUsdc, 2.75);

  // Matching amounts succeed and preserve exact values
  const valid = validateCopyExecutionAgainstPreview({
    preview: entry,
    permission: perm,
    executionStakeAtomic: 27500000n,
    executionStakeUsdc: 2.75,
    now: NOW,
  });
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.stakeAtomic, 27500000n);
    assert.equal(valid.stakeUsdc, 2.75);
  }

  // evaluateCopyWithPreview preserves exact amount
  const execResult = evaluateCopyWithPreview(perm, sig, context(), entry);
  assert.equal(execResult.allowed, true);
  if (execResult.allowed) {
    assert.equal(execResult.stakeUsdc, 2.75);
    assert.equal(execResult.stakeAtomic, 27500000n);
  }
});

test("amount mismatch between preview and execution is detected and rejected", () => {
  const perm = permission();
  const sig = signal({ stakeUsdc: 3 });

  const entry = createCopyPreviewCacheEntry({
    permission: perm,
    signal: sig,
    decision: { allowed: true, stakeUsdc: 3 },
    policyEligible: true,
    now: NOW,
  });

  // Atomic amount mismatch
  const mismatchAtomic = validateCopyExecutionAgainstPreview({
    preview: entry,
    permission: perm,
    executionStakeAtomic: 29999999n,
    executionStakeUsdc: 3,
    now: NOW,
  });
  assert.equal(mismatchAtomic.ok, false);
  assert.equal(mismatchAtomic.reason, "amount_mismatch");

  // Display USDC mismatch
  const mismatchUsdc = validateCopyExecutionAgainstPreview({
    preview: entry,
    permission: perm,
    executionStakeAtomic: 30000000n,
    executionStakeUsdc: 3.01,
    now: NOW,
  });
  assert.equal(mismatchUsdc.ok, false);
  assert.equal(mismatchUsdc.reason, "amount_mismatch");

  // evaluateCopyWithPreview with mismatched signal stake
  const mismatchExec = evaluateCopyWithPreview(
    perm,
    signal({ stakeUsdc: 3.5 }),
    context(),
    entry,
  );
  assert.equal(mismatchExec.allowed, false);
  assert.equal(mismatchExec.reason, "amount_mismatch");
});

test("preview expiration and boundary conditions fail closed", () => {
  const perm = permission();
  const sig = signal({ deadline: NOW + 10_000 });

  const entry = createCopyPreviewCacheEntry({
    permission: perm,
    signal: sig,
    decision: { allowed: true, stakeUsdc: 3 },
    policyEligible: true,
    now: NOW,
    ttlMs: 5_000,
  });
  assert.equal(entry.expiresAt, NOW + 5_000);

  // Still active
  assert.equal(
    validateCopyExecutionAgainstPreview({
      preview: entry,
      permission: perm,
      executionStakeAtomic: 30000000n,
      now: NOW + 4_999,
    }).ok,
    true,
  );

  // Expired at TTL
  const expired = validateCopyExecutionAgainstPreview({
    preview: entry,
    permission: perm,
    executionStakeAtomic: 30000000n,
    now: NOW + 5_000,
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "preview_expired");

  // Ineligible preview cannot execute
  const ineligibleEntry = createCopyPreviewCacheEntry({
    permission: perm,
    signal: sig,
    decision: { allowed: false, reason: "position_cap" },
    policyEligible: false,
    now: NOW,
  });
  const ineligResult = validateCopyExecutionAgainstPreview({
    preview: ineligibleEntry,
    permission: perm,
    executionStakeAtomic: 30000000n,
    now: NOW,
  });
  assert.equal(ineligResult.ok, false);
  assert.equal(ineligResult.reason, "policy_ineligible");
});

test("spend permission revision reflects changes in allowance, period, salt, and status", () => {
  const base: SpendPermissionRecord = {
    permissionHash: "hash-spend-1",
    agentId: "agent-b",
    account: OWNER,
    spender: MIMIR,
    token: USDC,
    allowanceAtomic: 50n * UNIT,
    periodSeconds: 86400,
    startAt: 1800000000,
    endAt: 1800086400,
    salt: "0",
    extraData: "",
    signature: "sig-1",
    permissionJson: "{}",
    createdAt: NOW,
  };

  const initialRev = spendPermissionRevision(base);
  assert.ok(initialRev);

  // Allowance change
  const changedAllowance = { ...base, allowanceAtomic: 60n * UNIT };
  assert.notEqual(spendPermissionRevision(changedAllowance), initialRev);

  // Revision counter bump
  const bumpedRev = { ...base, revision: 1 };
  assert.notEqual(spendPermissionRevision(bumpedRev), initialRev);

  // Revocation
  const revoked = { ...base, revokedAt: NOW + 1000 };
  assert.notEqual(spendPermissionRevision(revoked), initialRev);
});
