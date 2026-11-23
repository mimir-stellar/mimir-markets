import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  MAX_MIRROR_QUEUE_FAILURES,
  MAX_MIRROR_QUEUE_FAILURE_MESSAGE_LENGTH,
  pendingMirrorQueueFor,
  pendingMirrorsFor,
  type MirrorQueueDependencies,
} from "../../lib/server/mirror-queue";

const SUBSCRIBER = Keypair.random().publicKey();
const MEMBER_ADDRESS = Keypair.random().publicKey();
const NOW = 1_000_000;

function makeDeps(opts: {
  subscriptions?: string[] | (() => Promise<string[]>);
  definitions?:
    | Array<{ id: string; name: string; members: Array<{ agentId: string; weightBps: number }> }>
    | (() => Promise<Array<{ id: string; name: string; members: Array<{ agentId: string; weightBps: number }> }>>);
  agents?:
    | Array<{ id: string; displayName: string; address: string }>
    | (() => Promise<Array<{ id: string; displayName: string; address: string }>>);
  claims?:
    | Array<{ id: number; question?: string | null; deadline: number; creator?: string | null }>
    | (() => Promise<Array<{ id: number; question?: string | null; deadline: number; creator?: string | null }>>);
  challengers?:
    | Record<number, Array<{ address: string; stake: number }>>
    | ((claimId: number) => Promise<Array<{ address: string; stake: number }>>);
}): MirrorQueueDependencies {
  return {
    listSubscriptions:
      typeof opts.subscriptions === "function"
        ? opts.subscriptions
        : async () => opts.subscriptions ?? [],
    listDefinitions:
      typeof opts.definitions === "function"
        ? opts.definitions
        : async () => opts.definitions ?? [],
    listAgents:
      typeof opts.agents === "function"
        ? opts.agents
        : async () => opts.agents ?? [],
    listOpenClaims:
      typeof opts.claims === "function"
        ? opts.claims
        : async () => opts.claims ?? [],
    listChallengers:
      typeof opts.challengers === "function"
        ? opts.challengers
        : async (claimId) => opts.challengers?.[claimId] ?? [],
  };
}

const BASKET: MirrorQueueBasketDefinition = {
  id: "b",
  name: "Basket",
  version: 1,
  members: [{ agentId: "a1", weightBps: 10_000 }],
};

const AGENT = { id: "a1", displayName: "Agent One", address: MEMBER_ADDRESS };
const AGENT_TWO = { id: "a2", displayName: "Agent Two", address: SECOND_MEMBER_ADDRESS };
const AGENT_THREE = { id: "a3", displayName: "Agent Three", address: THIRD_MEMBER_ADDRESS };

describe("pendingMirrorQueueFor & pendingMirrorsFor", () => {
  const originalDateNow = Date.now;

  beforeEach(() => {
    Date.now = () => NOW * 1000;
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  it("distinguishes invalid subscriber addresses from incomplete sources", async () => {
    const deps = makeDeps({ subscriptions: ["b"] });
    const result = await pendingMirrorQueueFor("not-a-stellar-address", {}, deps);
    assert.equal(result.status, "invalid_subscriber");
    assert.equal(result.complete, true);
    assert.deepEqual(result.mirrors, []);
    assert.deepEqual(result.following, []);
    assert.equal(result.failureSummary, null);
  });

  it("distinguishes no subscriptions from unavailable subscriptions", async () => {
    const deps = makeDeps({
      subscriptions: [],
      definitions: [BASKET],
      agents: [AGENT],
      claims: [{ id: 1, deadline: NOW + 1000 }],
      challengers: { 1: [{ address: MEMBER_ADDRESS, stake: 10 }] },
    });

    const result = await pendingMirrorQueueFor(SUBSCRIBER, {}, deps);
    assert.equal(result.status, "no_subscriptions");
    assert.equal(result.complete, true);
    assert.deepEqual(result.mirrors, []);
    assert.deepEqual(result.following, []);
    assert.equal(result.failureSummary, null);

    // Backward-compatible wrapper still returns [].
    assert.deepEqual(await pendingMirrorsFor(SUBSCRIBER, {}, deps), []);
  });

  it("distinguishes no eligible opportunities from source failures", async () => {
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [BASKET],
      agents: [AGENT],
      claims: [{ id: 1, deadline: NOW + 1000 }],
      challengers: { 1: [] },
    });

    const result = await pendingMirrorQueueFor(SUBSCRIBER, {}, deps);
    assert.equal(result.status, "complete");
    assert.equal(result.complete, true);
    assert.deepEqual(result.mirrors, []);
    assert.deepEqual(result.following, ["b"]);
    assert.equal(result.failureSummary, null);
  });

  it("exposes incomplete result when subscriptions source fails", async () => {
    const deps = makeDeps({
      subscriptions: async () => {
        throw new Error("postgres connection refused");
      },
    });

    const result = await pendingMirrorQueueFor(SUBSCRIBER, {}, deps);
    assert.equal(result.status, "incomplete");
    assert.equal(result.complete, false);
    assert.deepEqual(result.mirrors, []);
    assert.deepEqual(result.following, []);
    assert.ok(result.failureSummary);
    assert.equal(result.failureSummary.totalFailures, 1);
    assert.deepEqual(result.failureSummary.unavailableSources, ["subscriptions"]);
    assert.equal(result.failureSummary.truncated, false);
    assert.equal(result.failureSummary.failures[0].source, "subscriptions");
    assert.match(result.failureSummary.failures[0].message, /postgres connection refused/);
    assert.match(result.failureSummary.summary, /subscriptions/);
  });

  it("exposes incomplete result when agents directory fails", async () => {
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [BASKET],
      agents: async () => {
        throw new Error("agent directory timeout");
      },
      claims: [{ id: 1, deadline: NOW + 1000 }],
      challengers: { 1: [{ address: MEMBER_ADDRESS, stake: 10 }] },
    });

    const result = await pendingMirrorQueueFor(SUBSCRIBER, {}, deps);
    assert.equal(result.status, "incomplete");
    assert.equal(result.complete, false);
    assert.deepEqual(result.mirrors, []);
    assert.deepEqual(result.following, ["b"]);
    assert.ok(result.failureSummary);
    assert.deepEqual(result.failureSummary.unavailableSources, ["agents"]);
    assert.equal(result.failureSummary.totalFailures, 1);
    assert.match(result.failureSummary.summary, /agents/);
  });

  it("returns partial mirrors alongside failure summary when a single claim challenger lookup fails", async () => {
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [BASKET],
      agents: [AGENT],
      claims: [
        { id: 1, deadline: NOW + 1000 },
        { id: 2, deadline: NOW + 2000 },
      ],
      challengers: async (claimId) => {
        if (claimId === 1) throw new Error("indexer timeout on claim 1");
        return [{ address: MEMBER_ADDRESS, stake: 25 }];
      },
    });

    const result = await pendingMirrorQueueFor(SUBSCRIBER, {}, deps);
    assert.equal(result.status, "incomplete");
    assert.equal(result.complete, false);
    assert.deepEqual(result.mirrors.map((m) => m.claimId), [2]);
    assert.equal(result.mirrors[0].memberStakeUsdc, 25);
    assert.ok(result.failureSummary);
    assert.deepEqual(result.failureSummary.unavailableSources, ["challengers"]);
    assert.equal(result.failureSummary.totalFailures, 1);
    assert.equal(result.failureSummary.failures[0].claimId, 1);
    assert.match(result.failureSummary.failures[0].message, /indexer timeout on claim 1/);
  });

  it("bounds failure count and message length in failureSummary", async () => {
    const claimCount = MAX_MIRROR_QUEUE_FAILURES + 3;
    const claims = Array.from({ length: claimCount }, (_, idx) => ({
      id: idx + 1,
      deadline: NOW + 1000 + idx,
    }));
    const longError = `rpc   failure:\n${"x".repeat(MAX_MIRROR_QUEUE_FAILURE_MESSAGE_LENGTH + 50)}`;

    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [BASKET],
      agents: [AGENT],
      claims,
      challengers: async () => {
        throw new Error(longError);
      },
    });

    const result = await pendingMirrorQueueFor(SUBSCRIBER, {}, deps);
    assert.equal(result.status, "incomplete");
    assert.equal(result.complete, false);
    assert.ok(result.failureSummary);
    assert.equal(result.failureSummary.totalFailures, claimCount);
    assert.equal(result.failureSummary.failures.length, MAX_MIRROR_QUEUE_FAILURES);
    assert.equal(result.failureSummary.truncated, true);
    assert.ok(
      result.failureSummary.failures.every(
        (f) => f.message.length <= MAX_MIRROR_QUEUE_FAILURE_MESSAGE_LENGTH && !f.message.includes("\n"),
      ),
    );
    assert.match(
      result.failureSummary.summary,
      new RegExp(`${claimCount} failures recorded \\(showing first ${MAX_MIRROR_QUEUE_FAILURES}\\)`),
    );
  });

  it("excludes expired markets and markets the follower already mirrored", async () => {
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [BASKET],
      agents: [AGENT],
      claims: [
        { id: 1, deadline: NOW - 1 },
        { id: 2, deadline: NOW + 1000 },
        { id: 3, deadline: NOW + 2000 },
      ],
      challengers: {
        1: [{ address: MEMBER_ADDRESS, stake: 10 }],
        2: [
          { address: MEMBER_ADDRESS, stake: 15 },
          { address: SUBSCRIBER, stake: 2 },
        ],
        3: [{ address: MEMBER_ADDRESS, stake: 20 }],
      },
    });

    const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);
    assert.deepEqual(result.map((r) => r.claimId), [3]);
    assert.equal(result[0].memberStakeUsdc, 20);
  });
  assert.deepEqual(await pendingMirrorsFor(SUBSCRIBER, {}, deps), []);
});

test("pendingMirrorsFor: excludes markets the follower already mirrored", async () => {
  const deps = makeDeps({
    subscriptions: ["b"],
    definitions: [BASKET],
    agents: [AGENT],
    claims: [
      { id: 1, deadline: NOW + 1000 },
      { id: 2, deadline: NOW + 2000 },
    ],
    challengers: {
      1: [
        { address: MEMBER_ADDRESS, stake: 10 },
        { address: SUBSCRIBER, stake: 2 },
      ],
      2: [{ address: MEMBER_ADDRESS, stake: 20 }],
    },
  });
  const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);
  assert.deepEqual(result.map((r) => r.claimId), [2]);
});

test("pendingMirrorsFor: excludes expired markets", async () => {
  const deps = makeDeps({
    subscriptions: ["b"],
    definitions: [BASKET],
    agents: [AGENT],
    claims: [
      { id: 1, deadline: NOW - 1 },
      { id: 2, deadline: NOW + 1000 },
    ],
    challengers: {
      1: [{ address: MEMBER_ADDRESS, stake: 10 }],
      2: [{ address: MEMBER_ADDRESS, stake: 20 }],
    },
  });
  const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);
  assert.deepEqual(result.map((r) => r.claimId), [2]);
});

test("pendingMirrorsFor: deduplicates markets shared across multiple baskets", async () => {
  const deps = makeDeps({
    subscriptions: ["b1", "b2"],
    definitions: [
      { id: "b1", name: "B1", members: [{ agentId: "a1", weightBps: 10_000 }] },
      { id: "b2", name: "B2", members: [{ agentId: "a1", weightBps: 10_000 }] },
    ],
    agents: [AGENT],
    claims: [{ id: 1, deadline: NOW + 1000 }],
    challengers: { 1: [{ address: MEMBER_ADDRESS, stake: 10 }] },
  });
  const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);
  assert.deepEqual(result.map((r) => r.claimId), [1]);
});

test("pendingMirrorsFor: carries the per-market amount and versioned composition digest through", async () => {
  const deps = makeDeps({
    subscriptions: ["b"],
    definitions: [{ ...BASKET, version: 2 }],
    agents: [AGENT],
    claims: [
      { id: 1, deadline: NOW + 1000 },
      { id: 2, deadline: NOW + 2000 },
    ],
    challengers: {
      1: [{ address: MEMBER_ADDRESS, stake: 10 }],
      2: [{ address: MEMBER_ADDRESS, stake: 25 }],
    },
  });
  const result = await pendingMirrorsFor(SUBSCRIBER, { b: 8 }, deps);
  const byId = new Map(result.map((r) => [r.claimId, r]));
  assert.equal(byId.get(1)?.memberStakeUsdc, 10);
  assert.equal(byId.get(2)?.memberStakeUsdc, 25);
  assert.equal(byId.get(1)?.mirrorUsdc, 8);
  assert.equal(byId.get(1)?.compositionVersion, 2);
  assert.equal(
    byId.get(1)?.compositionDigest,
    basketCompositionDigest(BASKET.members),
  );
});

test("pendingMirrorsFor: keeps pending mirror previews when member order changes without material composition change", async () => {
  const reviewedSnapshot = createBasketCompositionSnapshot({
    basketId: "multi",
    version: 1,
    capturedAt: 1_700_000_000_000,
    members: [
      { agentId: "a1", weightBps: 6_000 },
      { agentId: "a2", weightBps: 4_000 },
    ],
  });

  // Live definition lists members in reverse order with identical weights.
  const deps = makeDeps({
    subscriptions: ["multi"],
    definitions: [
      {
        id: "multi",
        name: "Multi Basket",
        version: 1,
        members: [
          { agentId: "a2", weightBps: 4_000 },
          { agentId: "a1", weightBps: 6_000 },
        ],
      },
    ],
    agents: [AGENT, AGENT_TWO],
    claims: [{ id: 10, deadline: NOW + 1000 }],
    challengers: { 10: [{ address: MEMBER_ADDRESS, stake: 12 }] },
    reviewedCompositions: { multi: reviewedSnapshot },
  });

  const review = await reviewPendingMirrorsFor(SUBSCRIBER, { multi: 10 }, deps);
  assert.equal(review.invalidated.length, 0);
  assert.equal(review.mirrors.length, 1);
  assert.equal(review.mirrors[0]?.claimId, 10);
  assert.equal(review.mirrors[0]?.mirrorUsdc, 6);
  assert.equal(review.mirrors[0]?.compositionDigest, reviewedSnapshot.compositionDigest);
});

test("pendingMirrorsFor: invalidates pending mirror previews when composition weights or members change materially", async () => {
  const v1 = createBasketCompositionSnapshot({
    basketId: "multi",
    version: 1,
    capturedAt: 1_700_000_000_000,
    members: [
      { agentId: "a1", weightBps: 6_000 },
      { agentId: "a2", weightBps: 4_000 },
    ],
  });

  // 1) Material weight shift (60/40 -> 40/60) invalidates the basket's pending mirrors.
  const weightShiftedDeps = makeDeps({
    subscriptions: ["multi"],
    definitions: [
      {
        id: "multi",
        name: "Multi Basket",
        version: 2,
        members: [
          { agentId: "a1", weightBps: 4_000 },
          { agentId: "a2", weightBps: 6_000 },
        ],
      },
    ],
    agents: [AGENT, AGENT_TWO],
    claims: [{ id: 11, deadline: NOW + 1000 }],
    challengers: { 11: [{ address: MEMBER_ADDRESS, stake: 15 }] },
  });
  const options: MirrorQueueOptions = {
    reviewedCompositions: { multi: v1 },
  };

  assert.deepEqual(
    await pendingMirrorsFor(SUBSCRIBER, { multi: 10 }, weightShiftedDeps, options),
    [],
  );
  const weightReview = await reviewPendingMirrorsFor(
    SUBSCRIBER,
    { multi: 10 },
    weightShiftedDeps,
    options,
  );
  assert.equal(weightReview.mirrors.length, 0);
  assert.equal(weightReview.invalidated.length, 1);
  assert.equal(weightReview.invalidated[0]?.basketId, "multi");
  assert.equal(weightReview.invalidated[0]?.reason, "weights_changed_materially");
  assert.equal(weightReview.invalidated[0]?.diff?.maxWeightDeltaBps, 2_000);

  // 2) Swapping a member identity (a2 -> a3) at the exact same weight (4000 bps) also invalidates.
  const memberSwappedDeps = makeDeps({
    subscriptions: ["multi"],
    definitions: [
      {
        id: "multi",
        name: "Multi Basket",
        version: 2,
        members: [
          { agentId: "a1", weightBps: 6_000 },
          { agentId: "a3", weightBps: 4_000 },
        ],
      },
    ],
    agents: [AGENT, AGENT_TWO, AGENT_THREE],
    claims: [{ id: 12, deadline: NOW + 1000 }],
    challengers: { 12: [{ address: MEMBER_ADDRESS, stake: 15 }] },
  });

  const memberReview = await reviewPendingMirrorsFor(
    SUBSCRIBER,
    { multi: 10 },
    memberSwappedDeps,
    options,
  );
  assert.equal(memberReview.mirrors.length, 0);
  assert.equal(memberReview.invalidated.length, 1);
  assert.equal(memberReview.invalidated[0]?.reason, "members_changed");
});

test("pendingMirrorsFor: boundary case for materialDriftBps tolerance and corrupted or regressed snapshots", async () => {
  const v2 = createBasketCompositionSnapshot({
    basketId: "multi",
    version: 2,
    capturedAt: 1_700_000_000_000,
    members: [
      { agentId: "a1", weightBps: 6_000 },
      { agentId: "a2", weightBps: 4_000 },
    ],
  });

  // Boundary: with materialDriftBps = 100, a 99 bps drift stays valid, while 100 bps invalidates.
  const drift99Deps = makeDeps({
    subscriptions: ["multi"],
    definitions: [
      {
        id: "multi",
        name: "Multi Basket",
        version: 3,
        members: [
          { agentId: "a1", weightBps: 6_099 },
          { agentId: "a2", weightBps: 3_901 },
        ],
      },
    ],
    agents: [AGENT, AGENT_TWO],
    claims: [{ id: 20, deadline: NOW + 1000 }],
    challengers: { 20: [{ address: MEMBER_ADDRESS, stake: 10 }] },
  });
  const allowed99 = await reviewPendingMirrorsFor(
    SUBSCRIBER,
    { multi: 10 },
    drift99Deps,
    { reviewedCompositions: { multi: v2 }, materialDriftBps: 100 },
  );
  assert.equal(allowed99.invalidated.length, 0);
  assert.equal(allowed99.mirrors.length, 1);

  const drift100Deps = makeDeps({
    subscriptions: ["multi"],
    definitions: [
      {
        id: "multi",
        name: "Multi Basket",
        version: 3,
        members: [
          { agentId: "a1", weightBps: 6_100 },
          { agentId: "a2", weightBps: 3_900 },
        ],
      },
    ],
    agents: [AGENT, AGENT_TWO],
    claims: [{ id: 20, deadline: NOW + 1000 }],
    challengers: { 20: [{ address: MEMBER_ADDRESS, stake: 10 }] },
  });
  const blocked100 = await reviewPendingMirrorsFor(
    SUBSCRIBER,
    { multi: 10 },
    drift100Deps,
    { reviewedCompositions: { multi: v2 }, materialDriftBps: 100 },
  );
  assert.equal(blocked100.mirrors.length, 0);
  assert.equal(blocked100.invalidated[0]?.reason, "weights_changed_materially");

  // Failure case: version regression (live version 1 < reviewed version 2).
  const regressedDeps = makeDeps({
    subscriptions: ["multi"],
    definitions: [
      {
        id: "multi",
        name: "Multi Basket",
        version: 1,
        members: v2.members,
      },
    ],
    agents: [AGENT, AGENT_TWO],
    claims: [{ id: 20, deadline: NOW + 1000 }],
    challengers: { 20: [{ address: MEMBER_ADDRESS, stake: 10 }] },
  });
  const regressed = await reviewPendingMirrorsFor(
    SUBSCRIBER,
    { multi: 10 },
    regressedDeps,
    { reviewedCompositions: { multi: v2 } },
  );
  assert.equal(regressed.mirrors.length, 0);
  assert.equal(regressed.invalidated[0]?.reason, "version_regression");

  // Failure case: tampered reviewed snapshot where stored digest disagrees with members.
  const tamperedSnapshot = {
    ...v2,
    members: [
      { agentId: "a1", weightBps: 5_000 },
      { agentId: "a2", weightBps: 5_000 },
    ],
  };
  const tampered = await reviewPendingMirrorsFor(
    SUBSCRIBER,
    { multi: 10 },
    makeDeps({
      subscriptions: ["multi"],
      definitions: [{ id: "multi", name: "Multi", version: 2, members: v2.members }],
      agents: [AGENT, AGENT_TWO],
      claims: [{ id: 20, deadline: NOW + 1000 }],
      challengers: { 20: [{ address: MEMBER_ADDRESS, stake: 10 }] },
    }),
    { reviewedCompositions: { multi: tamperedSnapshot } },
  );
  assert.equal(tampered.mirrors.length, 0);
  assert.equal(tampered.invalidated[0]?.reason, "invalid_reviewed_snapshot");
});

test("validatePendingMirrorPreviews and invalidateStaleMirrorPreviews invalidate stale previews after basket rebalance", async () => {
  const v1 = createBasketCompositionSnapshot({
    basketId: "multi",
    version: 1,
    capturedAt: 1_700_000_000_000,
    members: [
      { agentId: "a1", weightBps: 6_000 },
      { agentId: "a2", weightBps: 4_000 },
    ],
  });

  const initialDefinitions: MirrorQueueBasketDefinition[] = [
    {
      id: "multi",
      name: "Multi Basket",
      version: v1.version,
      members: v1.members,
      compositionSnapshot: v1,
    },
  ];

  const deps = makeDeps({
    subscriptions: ["multi"],
    definitions: initialDefinitions,
    agents: [AGENT, AGENT_TWO],
    claims: [{ id: 30, deadline: NOW + 1000 }],
    challengers: { 30: [{ address: MEMBER_ADDRESS, stake: 20 }] },
  });

  const previews = await pendingMirrorsFor(SUBSCRIBER, { multi: 10 }, deps);
  assert.equal(previews.length, 1);

  // Against the unchanged definition, the preview remains valid.
  const unchangedVerdict = validatePendingMirrorPreviews(previews, initialDefinitions);
  assert.equal(unchangedVerdict.valid.length, 1);
  assert.equal(unchangedVerdict.invalidated.length, 0);

  // Evolve the basket composition materially (a1 removed, replaced by a3).
  const v2 = evolveBasketCompositionSnapshot(v1, [
    { agentId: "a3", weightBps: 6_000 },
    { agentId: "a2", weightBps: 4_000 },
  ]);
  const updatedDefinitions: MirrorQueueBasketDefinition[] = [
    {
      id: "multi",
      name: "Multi Basket",
      version: v2.version,
      members: v2.members,
      compositionSnapshot: v2,
    },
  ];

  const rebalancedVerdict = validatePendingMirrorPreviews(previews, updatedDefinitions);
  assert.equal(rebalancedVerdict.valid.length, 0);
  assert.equal(rebalancedVerdict.invalidated.length, 1);
  assert.equal(rebalancedVerdict.invalidated[0]?.reason, "member_removed");
  assert.deepEqual(invalidateStaleMirrorPreviews(previews, updatedDefinitions), []);
});
