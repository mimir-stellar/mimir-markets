import assert from "node:assert/strict";
import test from "node:test";

import {
  allowsCreatorSideEffect,
  creatorSideEffectPolicy,
  isMarketCreatorDryRun,
  type CreatorSideEffect,
} from "../../lib/market-creator/dry-run";

const ALL_EFFECTS: CreatorSideEffect[] = ["create_claim", "cancel_claim", "paid_preflight"];

// ── Env parsing ───────────────────────────────────────────────────────────────

test("isMarketCreatorDryRun is strict opt-in on MARKET_CREATOR_DRY_RUN=1", () => {
  assert.equal(isMarketCreatorDryRun({ MARKET_CREATOR_DRY_RUN: "1" }), true);
  assert.equal(isMarketCreatorDryRun({}), false);
  assert.equal(isMarketCreatorDryRun({ MARKET_CREATOR_DRY_RUN: "0" }), false);
  assert.equal(isMarketCreatorDryRun({ MARKET_CREATOR_DRY_RUN: "true" }), false);
  assert.equal(isMarketCreatorDryRun({ MARKET_CREATOR_DRY_RUN: "" }), false);
});

// ── Side-effect policy ────────────────────────────────────────────────────────

test("normal mode allows every side effect", () => {
  const policy = creatorSideEffectPolicy(false);
  assert.equal(policy.dryRun, false);
  for (const effect of ALL_EFFECTS) {
    assert.equal(allowsCreatorSideEffect(policy, effect), true, effect);
  }
});

test("dry run blocks create, cancel, and paid preflight", () => {
  const policy = creatorSideEffectPolicy(true);
  assert.equal(policy.dryRun, true);
  for (const effect of ALL_EFFECTS) {
    assert.equal(allowsCreatorSideEffect(policy, effect), false, effect);
  }
});

test("the gate is all-or-nothing — no effect can slip through alone", () => {
  for (const dryRun of [false, true]) {
    const policy = creatorSideEffectPolicy(dryRun);
    const allowed = ALL_EFFECTS.filter((effect) => allowsCreatorSideEffect(policy, effect));
    assert.equal(
      allowed.length,
      dryRun ? 0 : ALL_EFFECTS.length,
      `dryRun=${dryRun} allowed [${allowed.join(", ")}]`,
    );
  }
});
