import assert from "node:assert/strict";
import test from "node:test";
import {
  assetsForRedemption,
  basketCompositionDigest,
  basketExposure,
  compareBasketCompositions,
  createBasketCompositionSnapshot,
  DEFAULT_BASKET_POLICY,
  evolveBasketCompositionSnapshot,
  highWaterMarkFee,
  isMaterialCompositionChange,
  previewBasketExposureBeforeCreate,
  sharesForDeposit,
  simulateVirtualBasket,
  subscriptionMessage,
  validateBasket,
  verifyBasketCompositionSnapshot,
} from "../../lib/baskets";

const weights = [
  { agentId: "a", weightBps: 4_000, category: "crypto", mode: "pool" },
  { agentId: "b", weightBps: 3_000, category: "sports", mode: "duel" },
  { agentId: "c", weightBps: 3_000, category: "sports", mode: "pool", stale: true },
];
const policy = { maxSingleAgentBps: 5_000, maxCategoryBps: 6_000, staleSignalAction: "skip" as const, failedCopyAction: "keep_idle" as const };

test("virtual basket validates weights and exposes category/mode concentration", () => {
  assert.deepEqual(validateBasket(weights, policy), []);
  assert.deepEqual(basketExposure(weights), { categories: { crypto: 4_000, sports: 6_000 }, modes: { pool: 7_000, duel: 3_000 } });
});

test("stale agents stay idle and NAV/drawdown are deterministic atomic values", () => {
  const snapshots = simulateVirtualBasket(weights, [{ timestamp: 1, returnsBps: { a: 1_000, b: -500, c: 9_999 } }, { timestamp: 2, returnsBps: { a: -2_000, b: -1_000, c: 9_999 } }]);
  assert.equal(snapshots[0]!.navAtomic, 1_025_000_000n);
  assert.ok(snapshots[1]!.drawdownBps > 0);
});

test("high-water mark prevents repeated performance fees", () => {
  assert.deepEqual(highWaterMarkFee(1_100_000n, 1_000_000n, 1_000n), { feeAtomic: 10_000n, nextHighWaterMarkAtomic: 1_100_000n });
  assert.equal(highWaterMarkFee(1_050_000n, 1_100_000n, 1_000n).feeAtomic, 0n);
});

test("share conversions conserve atomic rounding and never overpay", () => {
  for (let assets = 1n; assets < 1_000n; assets += 7n) {
    const shares = sharesForDeposit(assets, 1_000_003n, 999_983n);
    if (shares === 0n) continue;
    assert.ok(assetsForRedemption(shares, 1_000_003n, 999_983n) <= assets);
  }
});

test("exposure preview: empty basket stays empty with no policy errors", () => {
  const preview = previewBasketExposureBeforeCreate([]);
  assert.equal(preview.status, "empty");
  assert.equal(preview.totalBps, 0);
  assert.deepEqual(preview.errors, []);
  assert.deepEqual(preview.categoryBars, []);
});

test("exposure preview: incomplete allocation still shows live bars", () => {
  const preview = previewBasketExposureBeforeCreate([
    { agentId: "a", weightBps: 2_500, category: "council", mode: "pool" },
    { agentId: "b", weightBps: 2_500, category: "byoa", mode: "pool" },
  ]);
  assert.equal(preview.status, "incomplete");
  assert.equal(preview.totalBps, 5_000);
  assert.ok(preview.errors.includes("weights_must_total_10000_bps"));
  assert.equal(preview.categoryBars.length, 2);
  assert.equal(preview.agentBars.every((bar) => !bar.overLimit), true);
});

test("exposure preview: category over default 60% cap is invalid at 100%", () => {
  const preview = previewBasketExposureBeforeCreate([
    { agentId: "a", weightBps: 4_000, category: "council", mode: "pool" },
    { agentId: "b", weightBps: 3_500, category: "council", mode: "pool" },
    { agentId: "c", weightBps: 2_500, category: "byoa", mode: "pool" },
  ], DEFAULT_BASKET_POLICY);
  assert.equal(preview.status, "invalid");
  assert.ok(preview.errors.includes("category_exposure"));
  const council = preview.categoryBars.find((bar) => bar.key === "council");
  assert.ok(council);
  assert.equal(council!.bps, 7_500);
  assert.equal(council!.overLimit, true);
});

test("exposure preview: single agent over 40% flags agent bar at the boundary", () => {
  // Boundary: 40% exact is allowed; 41% is not.
  const atCap = previewBasketExposureBeforeCreate([
    { agentId: "a", weightBps: 4_000, category: "council", mode: "pool" },
    { agentId: "b", weightBps: 3_000, category: "byoa", mode: "pool" },
    { agentId: "c", weightBps: 3_000, category: "philosopher", mode: "pool" },
  ], DEFAULT_BASKET_POLICY);
  assert.equal(atCap.status, "ready");
  assert.deepEqual(atCap.errors, []);

  const over = previewBasketExposureBeforeCreate([
    { agentId: "a", weightBps: 4_100, category: "council", mode: "pool" },
    { agentId: "b", weightBps: 3_000, category: "byoa", mode: "pool" },
    { agentId: "c", weightBps: 2_900, category: "philosopher", mode: "pool" },
  ], DEFAULT_BASKET_POLICY);
  assert.equal(over.status, "invalid");
  assert.ok(over.errors.includes("single_agent_exposure"));
  const agentA = over.agentBars.find((bar) => bar.key === "a");
  assert.equal(agentA?.overLimit, true);
});

test("exposure preview: ready mix matches basketExposure categories and modes", () => {
  const ready = [
    { agentId: "a", weightBps: 3_000, category: "council", mode: "pool" },
    { agentId: "b", weightBps: 3_000, category: "byoa", mode: "pool" },
    { agentId: "c", weightBps: 4_000, category: "philosopher", mode: "pool" },
  ];
  const preview = previewBasketExposureBeforeCreate(ready, DEFAULT_BASKET_POLICY);
  assert.equal(preview.status, "ready");
  assert.deepEqual(preview.categories, basketExposure(ready).categories);
  assert.deepEqual(preview.modes, basketExposure(ready).modes);
  assert.equal(preview.policy.maxCategoryBps, DEFAULT_BASKET_POLICY.maxCategoryBps);
});

test("regression: zero-weight rows are ignored in the create preview", () => {
  const preview = previewBasketExposureBeforeCreate([
    { agentId: "a", weightBps: 4_000, category: "council", mode: "pool" },
    { agentId: "b", weightBps: 0, category: "council", mode: "pool" },
    { agentId: "c", weightBps: 3_000, category: "byoa", mode: "pool" },
    { agentId: "d", weightBps: 3_000, category: "philosopher", mode: "pool" },
  ]);
  assert.equal(preview.status, "ready");
  assert.equal(preview.agentBars.some((bar) => bar.key === "b"), false);
  assert.equal(preview.categories.council, 4_000);
});

test("basket validation rejects floating point weight dust", () => {
  const invalidWeights = [
    { agentId: "a", weightBps: 5_000.5, category: "council", mode: "pool" },
    { agentId: "b", weightBps: 4_999.5, category: "byoa", mode: "pool" },
  ];
  const errors = validateBasket(invalidWeights, DEFAULT_BASKET_POLICY);
  assert.ok(errors.includes("weights_must_be_integers"));
});

test("composition digest binds canonical member identities and weights independent of input order", () => {
  const orderA = [
    { agentId: "statistician", weightBps: 4_000 },
    { agentId: "optimist", weightBps: 3_500 },
    { agentId: "contrarian", weightBps: 2_500 },
  ];
  const orderB = [
    { agentId: "contrarian", weightBps: 2_500 },
    { agentId: "statistician", weightBps: 4_000 },
    { agentId: "optimist", weightBps: 3_500 },
  ];

  const digestA = basketCompositionDigest(orderA);
  const digestB = basketCompositionDigest({ members: orderB });
  assert.match(digestA, /^[0-9a-f]{64}$/);
  assert.equal(digestA, digestB);

  // Changing a member weight or member identity must produce a distinct digest.
  const shiftedWeight = basketCompositionDigest([
    { agentId: "statistician", weightBps: 4_001 },
    { agentId: "optimist", weightBps: 3_499 },
    { agentId: "contrarian", weightBps: 2_500 },
  ]);
  const swappedAgent = basketCompositionDigest([
    { agentId: "statistician", weightBps: 4_000 },
    { agentId: "pessimist", weightBps: 3_500 },
    { agentId: "contrarian", weightBps: 2_500 },
  ]);
  const caseChangedAgent = basketCompositionDigest([
    { agentId: "Statistician", weightBps: 4_000 },
    { agentId: "optimist", weightBps: 3_500 },
    { agentId: "contrarian", weightBps: 2_500 },
  ]);

  assert.notEqual(digestA, shiftedWeight);
  assert.notEqual(digestA, swappedAgent);
  assert.notEqual(digestA, caseChangedAgent);
});

test("composition digest rejects malformed members, duplicate agents and control-char delimiter injection", () => {
  assert.throws(() => basketCompositionDigest([]), /basket_composition_empty/);
  assert.throws(
    () => basketCompositionDigest([{ agentId: "   ", weightBps: 10_000 }]),
    /invalid_member_agent_id/,
  );
  assert.throws(
    () => basketCompositionDigest([{ agentId: "a\u001f1000", weightBps: 10_000 }]),
    /invalid_member_agent_id/,
  );
  assert.throws(
    () =>
      basketCompositionDigest([
        { agentId: "a", weightBps: 5_000 },
        { agentId: " a ", weightBps: 5_000 },
      ]),
    /duplicate_agent/,
  );
  assert.throws(
    () => basketCompositionDigest([{ agentId: "a", weightBps: 0 }]),
    /single_agent_exposure/,
  );
  assert.throws(
    () => basketCompositionDigest([{ agentId: "a", weightBps: 5_000.25 }]),
    /weights_must_be_integers/,
  );
});

test("versioned composition snapshots track evolution and verify cryptographic integrity", () => {
  const v1 = createBasketCompositionSnapshot({
    basketId: "council-core",
    version: 1,
    capturedAt: 1_700_000_000_000,
    members: [
      { agentId: "optimist", weightBps: 6_000 },
      { agentId: "contrarian", weightBps: 4_000 },
    ],
  });

  assert.equal(v1.version, 1);
  assert.equal(v1.totalWeightBps, 10_000);
  assert.equal(v1.previousDigest, null);
  assert.deepEqual(
    v1.members.map((m) => m.agentId),
    ["contrarian", "optimist"],
  );
  assert.deepEqual(verifyBasketCompositionSnapshot(v1), { ok: true });

  // Evolving with the same members in a different order keeps version 1 and the same digest.
  const reordered = evolveBasketCompositionSnapshot(
    v1,
    [
      { agentId: "contrarian", weightBps: 4_000 },
      { agentId: "optimist", weightBps: 6_000 },
    ],
    { capturedAt: 1_700_000_060_000 },
  );
  assert.equal(reordered.version, 1);
  assert.equal(reordered.compositionDigest, v1.compositionDigest);
  assert.equal(reordered.previousDigest, null);

  // Material weight change advances to version 2 and binds previousDigest to v1.
  const v2 = evolveBasketCompositionSnapshot(
    v1,
    [
      { agentId: "optimist", weightBps: 5_000 },
      { agentId: "contrarian", weightBps: 5_000 },
    ],
    { capturedAt: 1_700_000_120_000 },
  );
  assert.equal(v2.version, 2);
  assert.notEqual(v2.compositionDigest, v1.compositionDigest);
  assert.equal(v2.previousDigest, v1.compositionDigest);
  assert.deepEqual(verifyBasketCompositionSnapshot(v2), { ok: true });

  // Tampering with a member weight without recomputing the digest fails verification.
  const tampered = {
    ...v2,
    members: [
      { agentId: "contrarian", weightBps: 4_900 },
      { agentId: "optimist", weightBps: 5_100 },
    ],
  };
  assert.deepEqual(verifyBasketCompositionSnapshot(tampered), {
    ok: false,
    error: "composition_digest_mismatch",
  });
});

test("material composition comparison enforces weight-drift boundary and flags any member identity change", () => {
  const baseline = [
    { agentId: "a", weightBps: 5_000 },
    { agentId: "b", weightBps: 5_000 },
  ];

  // Reordered array is unchanged.
  const unchanged = compareBasketCompositions(baseline, [
    { agentId: "b", weightBps: 5_000 },
    { agentId: "a", weightBps: 5_000 },
  ]);
  assert.equal(unchanged.digestChanged, false);
  assert.equal(unchanged.materialChange, false);
  assert.equal(unchanged.reason, "unchanged");

  // Boundary with materialDriftBps = 100 (1%): 99 bps shift is within tolerance; 100 bps is material.
  const withinTolerance = compareBasketCompositions(
    baseline,
    [
      { agentId: "a", weightBps: 5_099 },
      { agentId: "b", weightBps: 4_901 },
    ],
    { materialDriftBps: 100 },
  );
  assert.equal(withinTolerance.digestChanged, true);
  assert.equal(withinTolerance.maxWeightDeltaBps, 99);
  assert.equal(withinTolerance.materialChange, false);
  assert.equal(withinTolerance.reason, "within_tolerance");

  const atBoundary = compareBasketCompositions(
    baseline,
    [
      { agentId: "a", weightBps: 5_100 },
      { agentId: "b", weightBps: 4_900 },
    ],
    { materialDriftBps: 100 },
  );
  assert.equal(atBoundary.digestChanged, true);
  assert.equal(atBoundary.maxWeightDeltaBps, 100);
  assert.equal(atBoundary.materialChange, true);
  assert.equal(atBoundary.reason, "weights_changed");

  // Replacing a member is always material even if the replaced member's weight is tiny (< materialDriftBps).
  const tinyMemberSwap = isMaterialCompositionChange(
    [
      { agentId: "a", weightBps: 9_950 },
      { agentId: "b", weightBps: 50 },
    ],
    [
      { agentId: "a", weightBps: 9_950 },
      { agentId: "c", weightBps: 50 },
    ],
    { materialDriftBps: 500 },
  );
  assert.equal(tinyMemberSwap, true);
});

test("subscriptionMessage optionally binds compositionVersion and compositionDigest while preserving backward compatibility", () => {
  const baseArgs = {
    action: "subscribe" as const,
    basketId: "council-core",
    subscriber: "GBAHBL3NSW3KH3HZENA4H6NKTWLDZESHQLNAB2O5HORMZH6GK5FWTTKO",
    perMarketUsdc: 5,
    nonce: "nonce-1234567890abcdef",
    expiresAt: 1_800_000_000_000,
  };
  const legacyMsg = subscriptionMessage(baseArgs);
  assert.equal(legacyMsg.includes("compositionDigest:"), false);

  const snapshot = createBasketCompositionSnapshot({
    basketId: "council-core",
    version: 3,
    capturedAt: 1_800_000_000_000,
    members: [
      { agentId: "optimist", weightBps: 5_000 },
      { agentId: "statistician", weightBps: 5_000 },
    ],
  });
  const versionedMsg = subscriptionMessage({
    ...baseArgs,
    compositionVersion: snapshot.version,
    compositionDigest: snapshot.compositionDigest,
  });
  assert.match(versionedMsg, /compositionVersion: 3/);
  assert.match(versionedMsg, new RegExp(`compositionDigest: ${snapshot.compositionDigest}`));
});
