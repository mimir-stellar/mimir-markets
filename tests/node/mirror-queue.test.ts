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

const BASKET = {
  id: "b",
  name: "Basket",
  members: [{ agentId: "a1", weightBps: 10_000 }],
};

const AGENT = { id: "a1", displayName: "Agent One", address: MEMBER_ADDRESS };

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
});
