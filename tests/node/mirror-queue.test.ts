/**
 * Tests for pendingMirrorsFor ineligibility classification.
 *
 * Before/after summary
 * --------------------
 * Before: pendingMirrorsFor returned PendingMirror[] only; silently dropped
 *         closed, already-mirrored, and stale-composition suggestions.
 * After:  pendingMirrorsFor returns { pending, ineligible } where every dropped
 *         suggestion carries an explicit reason ("closed_market",
 *         "already_mirrored", or "stale_composition") together with the original
 *         claim and agent data so the caller can explain the change.
 */
import "./helpers/stubs.cjs";
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import {
  pendingMirrorsFor,
  type MirrorQueueDependencies,
  type MirrorIneligibilityReason,
} from "../../lib/server/mirror-queue";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SUBSCRIBER     = "GBO43ZBS4RBC2QFDKB23U6TBFEEK47ZLGSXDJSRV2H3PNQK5ZDEYXVLE";
const MEMBER_ADDRESS = "GD2SI5PUEFKC7TONNX7OR72WMYUO7WZDSCDSIVWWXPDIDYW5OP3ETM5D";
const OTHER_ADDRESS  = "GCIXSDPXXIJSLEVZSYFCZRNOD6GBFIFKNTEI6X2HC6LE65KUVYMGU4X5";
const NOW = 1_000_000; // seconds since epoch

const AGENT = { id: "a1", displayName: "Agent One", address: MEMBER_ADDRESS };

type ClaimStub     = { id: number; question?: string | null; deadline: number; creator?: string | null };
type ChallengerStub = { address: string; stake: number };

function makeDeps(opts: {
  subscriptions?: string[];
  definitions?: Array<{ id: string; name: string; members: Array<{ agentId: string; weightBps: number }> }>;
  agents?: Array<{ id: string; displayName: string; address: string }>;
  openClaims?:   ClaimStub[];
  closedClaims?: ClaimStub[];
  challengers?:  Record<number, ChallengerStub[]>;
}): MirrorQueueDependencies {
  return {
    listSubscriptions:  async ()        => opts.subscriptions  ?? [],
    listDefinitions:    async ()        => opts.definitions    ?? [],
    listAgents:         async ()        => opts.agents         ?? [],
    listOpenClaims:     async ()        => opts.openClaims     ?? [],
    listClosedClaims:   async ()        => opts.closedClaims   ?? [],
    listChallengers:    async (claimId) => opts.challengers?.[claimId] ?? [],
  };
}

// ---------------------------------------------------------------------------
// Clock control
// ---------------------------------------------------------------------------

function withFixedClock(fn: () => void | Promise<void>) {
  return async () => {
    const spy = mock.method(Date, "now", () => NOW * 1000);
    try {
      await fn();
    } finally {
      spy.mock.restore();
    }
  };
}

// ---------------------------------------------------------------------------
// Existing behaviour (preserved)
// ---------------------------------------------------------------------------

describe("pendingMirrorsFor – existing behaviour", () => {
  it("returns empty pending and ineligible when the follower has no subscriptions", withFixedClock(async () => {
    const deps = makeDeps({
      subscriptions: [],
      definitions: [BASKET],
      agents: [AGENT],
      openClaims: [{ id: 1, deadline: NOW + 1000 }],
      challengers: { 1: [{ address: MEMBER_ADDRESS, stake: 10 }] },
    });
    const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);
    assert.deepStrictEqual(result.pending, []);
    assert.deepStrictEqual(result.ineligible, []);
  }));

  it("includes open claims where a basket member has a position", withFixedClock(async () => {
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [BASKET],
      agents: [AGENT],
      openClaims: [
        { id: 1, deadline: NOW + 1000 },
        { id: 2, deadline: NOW + 2000 },
      ],
      challengers: {
        1: [{ address: MEMBER_ADDRESS, stake: 10 }],
        2: [{ address: MEMBER_ADDRESS, stake: 20 }],
      },
    });
    const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);
    assert.deepStrictEqual(result.pending.map((r) => r.claimId), [1, 2]);
  }));

  it("sorts pending results by deadline ascending", withFixedClock(async () => {
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [BASKET],
      agents: [AGENT],
      openClaims: [
        { id: 2, deadline: NOW + 2000 },
        { id: 1, deadline: NOW + 1000 },
      ],
      challengers: {
        1: [{ address: MEMBER_ADDRESS, stake: 10 }],
        2: [{ address: MEMBER_ADDRESS, stake: 20 }],
      },
    });
    const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);
    assert.deepStrictEqual(result.pending.map((r) => r.claimId), [1, 2]);
  }));

  it("carries the per-market member stake through", withFixedClock(async () => {
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [BASKET],
      agents: [AGENT],
      openClaims: [
        { id: 1, deadline: NOW + 1000 },
        { id: 2, deadline: NOW + 2000 },
      ],
      challengers: {
        1: [{ address: MEMBER_ADDRESS, stake: 10 }],
        2: [{ address: MEMBER_ADDRESS, stake: 25 }],
      },
    });
    const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);
    const byId = new Map(result.pending.map((r) => [r.claimId, r.memberStakeUsdc]));
    assert.strictEqual(byId.get(1), 10);
    assert.strictEqual(byId.get(2), 25);
  }));

  it("returns empty when there are no claims at all", withFixedClock(async () => {
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [BASKET],
      agents: [AGENT],
      openClaims: [],
      closedClaims: [],
    });
    const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);
    assert.strictEqual(result.pending.length, 0);
    assert.strictEqual(result.ineligible.length, 0);
  }));
});

// ---------------------------------------------------------------------------
// Ineligibility: already_mirrored
// ---------------------------------------------------------------------------

describe("pendingMirrorsFor – already_mirrored", () => {
  it("moves a claim to ineligible when the subscriber's wallet is already a challenger", withFixedClock(async () => {
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [BASKET],
      agents: [AGENT],
      openClaims: [{ id: 1, deadline: NOW + 1000 }],
      challengers: {
        1: [
          { address: MEMBER_ADDRESS, stake: 15 },
          { address: SUBSCRIBER,     stake: 5  },
        ],
      },
    });
    const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);

    assert.strictEqual(result.pending.length, 0);
    assert.strictEqual(result.ineligible.length, 1);

    const item = result.ineligible[0];
    assert.strictEqual(item.reason satisfies MirrorIneligibilityReason, "already_mirrored");
    assert.strictEqual(item.claimId, 1);
    assert.strictEqual(item.basketId, "b");
    assert.strictEqual(item.agentId, "a1");
    assert.strictEqual(item.memberStakeUsdc, 15);
  }));

  it("preserves the original question text on an already-mirrored entry", withFixedClock(async () => {
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [BASKET],
      agents: [AGENT],
      openClaims: [{ id: 7, question: "Will it rain?", deadline: NOW + 500 }],
      challengers: {
        7: [
          { address: MEMBER_ADDRESS, stake: 8 },
          { address: SUBSCRIBER,     stake: 3 },
        ],
      },
    });
    const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);
    // deadline = NOW + 500 ≤ NOW + 300? No, 500 > 300, so it's already_mirrored
    // (subscriber is in challengers list before tooLate is checked for subscriber).
    assert.strictEqual(result.ineligible[0].question, "Will it rain?");
  }));

  it("falls back to 'Claim #id' when question is null", withFixedClock(async () => {
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [BASKET],
      agents: [AGENT],
      openClaims: [{ id: 42, question: null, deadline: NOW + 500 }],
      challengers: {
        42: [
          { address: MEMBER_ADDRESS, stake: 5 },
          { address: SUBSCRIBER,     stake: 2 },
        ],
      },
    });
    const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);
    assert.strictEqual(result.ineligible[0].question, "Claim #42");
  }));

  it("does not emit already_mirrored when subscriber acted independently (no member match)", withFixedClock(async () => {
    // Subscriber is a challenger but no basket member has a position.
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [BASKET],
      agents: [AGENT],
      openClaims: [{ id: 1, deadline: NOW + 1000 }],
      challengers: {
        1: [{ address: SUBSCRIBER, stake: 5 }], // only subscriber, member absent
      },
    });
    const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);
    assert.strictEqual(result.pending.length, 0);
    // Member had no position so there's nothing to attribute; no ineligible row.
    assert.strictEqual(result.ineligible.length, 0);
  }));
});

// ---------------------------------------------------------------------------
// Ineligibility: closed_market
// ---------------------------------------------------------------------------

describe("pendingMirrorsFor – closed_market", () => {
  it("surfaces a resolved claim as closed_market ineligible", withFixedClock(async () => {
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [BASKET],
      agents: [AGENT],
      openClaims: [],
      closedClaims: [{ id: 10, question: "Resolved question", deadline: NOW - 500 }],
      challengers: {
        10: [{ address: MEMBER_ADDRESS, stake: 20 }],
      },
    });
    const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);

    assert.strictEqual(result.pending.length, 0);
    assert.strictEqual(result.ineligible.length, 1);

    const item = result.ineligible[0];
    assert.strictEqual(item.reason satisfies MirrorIneligibilityReason, "closed_market");
    assert.strictEqual(item.claimId, 10);
    assert.strictEqual(item.agentId, "a1");
    assert.strictEqual(item.agentName, "Agent One");
    assert.strictEqual(item.memberStakeUsdc, 20);
    assert.strictEqual(item.question, "Resolved question");
  }));

  it("treats an open claim past the 5-minute staking window as closed_market", withFixedClock(async () => {
    // deadline = NOW + 100 s, which is ≤ nowSeconds + 300
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [BASKET],
      agents: [AGENT],
      openClaims: [{ id: 5, deadline: NOW + 100 }],
      challengers: {
        5: [{ address: MEMBER_ADDRESS, stake: 12 }],
      },
    });
    const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);

    assert.strictEqual(result.pending.length, 0);
    assert.strictEqual(result.ineligible.length, 1);
    assert.strictEqual(result.ineligible[0].reason satisfies MirrorIneligibilityReason, "closed_market");
    assert.strictEqual(result.ineligible[0].claimId, 5);
  }));

  it("does not add a closed_market entry when the claim creator is the subscriber", withFixedClock(async () => {
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [BASKET],
      agents: [AGENT],
      closedClaims: [{ id: 11, deadline: NOW - 100, creator: SUBSCRIBER }],
      challengers: { 11: [{ address: MEMBER_ADDRESS, stake: 5 }] },
    });
    const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);
    assert.strictEqual(result.ineligible.length, 0);
  }));

  it("does not double-count a claim appearing in both open and closed lists", withFixedClock(async () => {
    // During a reindex a claim id can transiently appear in both lists.
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [BASKET],
      agents: [AGENT],
      openClaims:   [{ id: 3, deadline: NOW + 1000 }],
      closedClaims: [{ id: 3, deadline: NOW + 1000 }],
      challengers:  { 3: [{ address: MEMBER_ADDRESS, stake: 7 }] },
    });
    const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);

    // The closed list is processed first, so the entry is classified as
    // closed_market; the open-claims pass skips it via the classified set.
    const all = [...result.pending, ...result.ineligible];
    const forClaim3 = all.filter((e) => e.claimId === 3);
    assert.strictEqual(forClaim3.length, 1);
    assert.strictEqual(result.ineligible[0].reason, "closed_market");
  }));

  it("does not produce a closed_market entry when the agent had no position on the closed claim", withFixedClock(async () => {
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [BASKET],
      agents: [AGENT],
      closedClaims: [{ id: 20, deadline: NOW - 200 }],
      challengers:  { 20: [{ address: OTHER_ADDRESS, stake: 5 }] },
    });
    const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);
    assert.strictEqual(result.ineligible.length, 0);
  }));
});

// ---------------------------------------------------------------------------
// Ineligibility: stale_composition
// ---------------------------------------------------------------------------

describe("pendingMirrorsFor – stale_composition", () => {
  it("flags a claim as stale_composition when the member agent is missing from the directory", withFixedClock(async () => {
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [BASKET],  // references agentId "a1"
      agents: [],             // "a1" not in directory → stale
      openClaims: [{ id: 99, deadline: NOW + 2000 }],
      challengers: { 99: [{ address: MEMBER_ADDRESS, stake: 10 }] },
    });
    const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);

    assert.strictEqual(result.pending.length, 0);
    assert.strictEqual(result.ineligible.length, 1);

    const item = result.ineligible[0];
    assert.strictEqual(item.reason satisfies MirrorIneligibilityReason, "stale_composition");
    assert.strictEqual(item.claimId, 99);
    assert.strictEqual(item.basketId, "b");
    // agentId and agentName are absent because the agent could not be resolved.
    assert.strictEqual(item.agentId, undefined);
    assert.strictEqual(item.agentName, undefined);
    assert.strictEqual(item.memberStakeUsdc, undefined);
  }));

  it("produces stale_composition when the first member is stale even if another member is live", withFixedClock(async () => {
    // The basket lists "gone" first; the loop breaks on the first member so
    // the stale entry is emitted and the live member is never reached.
    const twoMemberBasket = {
      id: "b2",
      name: "Two Members",
      members: [
        { agentId: "gone", weightBps: 5_000 },
        { agentId: "a1",   weightBps: 5_000 },
      ],
    };
    const deps = makeDeps({
      subscriptions: ["b2"],
      definitions: [twoMemberBasket],
      agents: [AGENT], // "gone" is missing from directory
      openClaims: [{ id: 50, deadline: NOW + 3000 }],
      challengers: {
        50: [{ address: MEMBER_ADDRESS, stake: 8 }],
      },
    });
    const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);

    assert.strictEqual(result.ineligible.length, 1);
    assert.strictEqual(result.ineligible[0].reason, "stale_composition");
    assert.strictEqual(result.pending.length, 0);
  }));
});

// ---------------------------------------------------------------------------
// Mixed scenarios
// ---------------------------------------------------------------------------

describe("pendingMirrorsFor – mixed scenarios", () => {
  it("separates pending, already_mirrored, and closed_market across different claims", withFixedClock(async () => {
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [BASKET],
      agents: [AGENT],
      openClaims: [
        { id: 1, deadline: NOW + 1000 }, // → pending
        { id: 2, deadline: NOW + 2000 }, // → already_mirrored
      ],
      closedClaims: [
        { id: 3, deadline: NOW - 100 },  // → closed_market
      ],
      challengers: {
        1: [{ address: MEMBER_ADDRESS, stake: 10 }],
        2: [{ address: MEMBER_ADDRESS, stake: 20 }, { address: SUBSCRIBER, stake: 5 }],
        3: [{ address: MEMBER_ADDRESS, stake: 30 }],
      },
    });

    const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);

    assert.deepStrictEqual(result.pending.map((r) => r.claimId), [1]);

    const reasons = new Map(result.ineligible.map((r) => [r.claimId, r.reason]));
    assert.strictEqual(reasons.get(2), "already_mirrored");
    assert.strictEqual(reasons.get(3), "closed_market");
  }));

  it("sorts ineligible list by deadline ascending", withFixedClock(async () => {
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [BASKET],
      agents: [AGENT],
      closedClaims: [
        { id: 30, deadline: NOW - 100 },
        { id: 20, deadline: NOW - 500 },
        { id: 40, deadline: NOW -  50 },
      ],
      challengers: {
        20: [{ address: MEMBER_ADDRESS, stake: 5 }],
        30: [{ address: MEMBER_ADDRESS, stake: 5 }],
        40: [{ address: MEMBER_ADDRESS, stake: 5 }],
      },
    });
    const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);
    const deadlines = result.ineligible.map((r) => r.deadline);
    assert.deepStrictEqual(deadlines, [...deadlines].sort((a, b) => a - b));
  }));

  it("multi-basket subscriber with different ineligibility reasons per basket", withFixedClock(async () => {
    // basket b1: claim 1 pending (member staked, subscriber not)
    // basket b2: same claim 1 → stale_composition (agent "b2agent" missing)
    const deps = makeDeps({
      subscriptions: ["b1", "b2"],
      definitions: [
        { id: "b1", name: "B1", members: [{ agentId: "a1",     weightBps: 10_000 }] },
        { id: "b2", name: "B2", members: [{ agentId: "b2agent", weightBps: 10_000 }] },
      ],
      agents: [AGENT], // "b2agent" absent
      openClaims: [{ id: 1, deadline: NOW + 1000 }],
      challengers: { 1: [{ address: MEMBER_ADDRESS, stake: 10 }] },
    });
    const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);

    // b1 should contribute a pending entry for claim 1.
    const pendingIds = result.pending.map((r) => r.basketId);
    assert.ok(pendingIds.includes("b1"), "b1 should have a pending mirror");

    // b2 should produce a stale_composition entry for the same claim.
    const staleEntry = result.ineligible.find((r) => r.basketId === "b2" && r.reason === "stale_composition");
    assert.ok(staleEntry !== undefined, "b2 should emit stale_composition");
  }));
});
