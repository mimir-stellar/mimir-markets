/**
 * Synthetic basket rebalance and mirror-race scenarios.
 *
 * Verifies that:
 *  - basket composition changes (rebalances, member additions/removals, zero-weight
 *    dust) update only unmirrored open claims;
 *  - repeated subscriptions and overlapping baskets never emit duplicate
 *    user-signed suggestions for the same claimId;
 *  - late position observations (indexer lag / mirror races) exclude claims
 *    already staked by the subscriber, even across rebalances or re-subscriptions.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  computePendingMirrors,
  MIRROR_DEADLINE_BUFFER_SECONDS,
  type MirrorQueueDependencies,
} from "../../lib/mirror-queue";

const INVALID_SUBSCRIBER = "NOT_A_STELLAR_ADDRESS";
const SUBSCRIBER_VALID = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const AGENT_A_ADDR = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const AGENT_B_ADDR = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const AGENT_C_ADDR = "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
const NOW = 1_700_000_000;

interface SyntheticState {
  subscriptions: string[];
  definitions: Array<{
    id: string;
    name: string;
    members: Array<{ agentId: string; weightBps: number }>;
  }>;
  agents: Array<{ id: string; displayName: string; address: string }>;
  claims: Array<{ id: number; question?: string | null; deadline: number; creator?: string | null }>;
  challengers: Record<number, Array<{ address: string; stake: number }>>;
  nowSeconds?: number;
}

function makeDeps(
  state: SyntheticState,
  overrides: Partial<MirrorQueueDependencies> = {},
): MirrorQueueDependencies {
  return {
    listSubscriptions: async () => [...state.subscriptions],
    listDefinitions: async () => state.definitions.map((d) => ({ ...d, members: [...d.members] })),
    listAgents: async () => [...state.agents],
    listOpenClaims: async () => [...state.claims],
    listChallengers: async (claimId) => [...(state.challengers[claimId] ?? [])],
    nowSeconds: () => state.nowSeconds ?? NOW,
    ...overrides,
  };
}

const DEFAULT_AGENTS = [
  { id: "agent-a", displayName: "Agent A", address: AGENT_A_ADDR },
  { id: "agent-b", displayName: "Agent B", address: AGENT_B_ADDR },
  { id: "agent-c", displayName: "Agent C", address: AGENT_C_ADDR },
];

test("rebalance: weight change updates mirrorUsdc for unmirrored open claims", async () => {
  const state: SyntheticState = {
    subscriptions: ["basket-1"],
    definitions: [
      {
        id: "basket-1",
        name: "Core Basket",
        members: [
          { agentId: "agent-a", weightBps: 6_000 },
          { agentId: "agent-b", weightBps: 4_000 },
        ],
      },
    ],
    agents: DEFAULT_AGENTS,
    claims: [
      { id: 101, question: "Will X happen?", deadline: NOW + 3_600 },
      { id: 102, question: "Will Y happen?", deadline: NOW + 7_200 },
    ],
    challengers: {
      101: [{ address: AGENT_A_ADDR, stake: 50 }],
      102: [{ address: AGENT_B_ADDR, stake: 25 }],
    },
  };

  const before = await computePendingMirrors(SUBSCRIBER_VALID, { "basket-1": 10 }, makeDeps(state));
  assert.equal(before.length, 2);
  assert.equal(before[0]!.claimId, 101);
  assert.equal(before[0]!.mirrorUsdc, 6);
  assert.equal(before[0]!.weightBps, 6_000);
  assert.equal(before[1]!.claimId, 102);
  assert.equal(before[1]!.mirrorUsdc, 4);
  assert.equal(before[1]!.weightBps, 4_000);

  // Rebalance basket weights: 60/40 -> 25/75
  state.definitions[0]!.members = [
    { agentId: "agent-a", weightBps: 2_500 },
    { agentId: "agent-b", weightBps: 7_500 },
  ];

  const after = await computePendingMirrors(SUBSCRIBER_VALID, { "basket-1": 10 }, makeDeps(state));
  assert.equal(after.length, 2);
  assert.equal(after[0]!.claimId, 101);
  assert.equal(after[0]!.mirrorUsdc, 2.5);
  assert.equal(after[0]!.weightBps, 2_500);
  assert.equal(after[1]!.claimId, 102);
  assert.equal(after[1]!.mirrorUsdc, 7.5);
  assert.equal(after[1]!.weightBps, 7_500);
});

test("rebalance: removing a member drops their open claim and adding a member surfaces theirs", async () => {
  const state: SyntheticState = {
    subscriptions: ["basket-1"],
    definitions: [
      {
        id: "basket-1",
        name: "Dynamic Basket",
        members: [{ agentId: "agent-a", weightBps: 10_000 }],
      },
    ],
    agents: DEFAULT_AGENTS,
    claims: [
      { id: 201, deadline: NOW + 1_000 },
      { id: 202, deadline: NOW + 2_000 },
    ],
    challengers: {
      201: [{ address: AGENT_A_ADDR, stake: 15 }],
      202: [{ address: AGENT_C_ADDR, stake: 30 }],
    },
  };

  const before = await computePendingMirrors(SUBSCRIBER_VALID, { "basket-1": 10 }, makeDeps(state));
  assert.deepEqual(
    before.map((m) => ({ claimId: m.claimId, agentId: m.agentId })),
    [{ claimId: 201, agentId: "agent-a" }],
  );

  // Swap member A out for member C
  state.definitions[0]!.members = [{ agentId: "agent-c", weightBps: 10_000 }];

  const after = await computePendingMirrors(SUBSCRIBER_VALID, { "basket-1": 10 }, makeDeps(state));
  assert.deepEqual(
    after.map((m) => ({ claimId: m.claimId, agentId: m.agentId })),
    [{ claimId: 202, agentId: "agent-c" }],
  );
});

test("rebalance: zero-weight or sub-cent dust member is skipped in favor of next eligible member", async () => {
  const state: SyntheticState = {
    subscriptions: ["basket-1"],
    definitions: [
      {
        id: "basket-1",
        name: "Dust Test",
        members: [
          { agentId: "agent-a", weightBps: 0 },
          { agentId: "agent-b", weightBps: 1 }, // 0.01% of 2 USDC = 0.0002 -> rounds to 0
          { agentId: "agent-c", weightBps: 5_000 },
        ],
      },
    ],
    agents: DEFAULT_AGENTS,
    claims: [{ id: 301, deadline: NOW + 2_000 }],
    challengers: {
      301: [
        { address: AGENT_A_ADDR, stake: 10 },
        { address: AGENT_B_ADDR, stake: 10 },
        { address: AGENT_C_ADDR, stake: 10 },
      ],
    },
  };

  const result = await computePendingMirrors(SUBSCRIBER_VALID, { "basket-1": 2 }, makeDeps(state));
  assert.equal(result.length, 1);
  assert.equal(result[0]!.agentId, "agent-c");
  assert.equal(result[0]!.mirrorUsdc, 1);
});

test("repeated subscriptions: duplicate basket IDs never emit duplicate user-signed suggestions", async () => {
  const state: SyntheticState = {
    subscriptions: ["basket-1", "basket-1", "basket-1"],
    definitions: [
      {
        id: "basket-1",
        name: "Core Basket",
        members: [{ agentId: "agent-a", weightBps: 10_000 }],
      },
    ],
    agents: DEFAULT_AGENTS,
    claims: [{ id: 401, deadline: NOW + 2_000 }],
    challengers: {
      401: [{ address: AGENT_A_ADDR, stake: 20 }],
    },
  };

  const result = await computePendingMirrors(SUBSCRIBER_VALID, { "basket-1": 5 }, makeDeps(state));
  assert.equal(result.length, 1);
  assert.equal(result[0]!.claimId, 401);
  assert.equal(result[0]!.mirrorUsdc, 5);
});

test("overlapping baskets: shared claimId across multiple baskets emits only one suggestion", async () => {
  const state: SyntheticState = {
    subscriptions: ["basket-1", "basket-2"],
    definitions: [
      {
        id: "basket-1",
        name: "Basket One",
        members: [{ agentId: "agent-a", weightBps: 5_000 }],
      },
      {
        id: "basket-2",
        name: "Basket Two",
        members: [{ agentId: "agent-b", weightBps: 8_000 }],
      },
    ],
    agents: DEFAULT_AGENTS,
    claims: [{ id: 501, deadline: NOW + 2_000 }],
    challengers: {
      501: [
        { address: AGENT_A_ADDR, stake: 10 },
        { address: AGENT_B_ADDR, stake: 20 },
      ],
    },
  };

  const result = await computePendingMirrors(
    SUBSCRIBER_VALID,
    { "basket-1": 10, "basket-2": 10 },
    makeDeps(state),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.claimId, 501);
  assert.equal(result[0]!.basketId, "basket-1");
});

test("mirror-race: late position observation removes claim and prevents re-offering after rebalance or re-subscribe", async () => {
  const state: SyntheticState = {
    subscriptions: ["basket-1"],
    definitions: [
      {
        id: "basket-1",
        name: "Core Basket",
        members: [{ agentId: "agent-a", weightBps: 5_000 }],
      },
    ],
    agents: DEFAULT_AGENTS,
    claims: [
      { id: 601, deadline: NOW + 1_500 },
      { id: 602, deadline: NOW + 2_500 },
    ],
    challengers: {
      601: [{ address: AGENT_A_ADDR, stake: 10 }],
      602: [{ address: AGENT_A_ADDR, stake: 10 }],
    },
  };

  // Poll 1: subscriber has signed claim 601, but read index has not observed it yet.
  const poll1 = await computePendingMirrors(SUBSCRIBER_VALID, { "basket-1": 10 }, makeDeps(state));
  assert.deepEqual(
    poll1.map((m) => m.claimId),
    [601, 602],
  );

  // Late position observation arrives for claim 601.
  state.challengers[601]!.push({ address: SUBSCRIBER_VALID, stake: 5 });

  // Poll 2: claim 601 is now excluded.
  const poll2 = await computePendingMirrors(SUBSCRIBER_VALID, { "basket-1": 10 }, makeDeps(state));
  assert.deepEqual(
    poll2.map((m) => m.claimId),
    [602],
  );

  // Basket rebalances to add agent-b (who also challenged 601) and subscriber re-subscribes.
  state.challengers[601]!.push({ address: AGENT_B_ADDR, stake: 40 });
  state.definitions[0]!.members = [
    { agentId: "agent-b", weightBps: 7_000 },
    { agentId: "agent-a", weightBps: 3_000 },
  ];
  state.subscriptions = ["basket-1", "basket-1"];

  // Poll 3: claim 601 must STILL be excluded (never treated as a new stake).
  const poll3 = await computePendingMirrors(SUBSCRIBER_VALID, { "basket-1": 10 }, makeDeps(state));
  assert.deepEqual(
    poll3.map((m) => m.claimId),
    [602],
  );
  assert.equal(poll3[0]!.mirrorUsdc, 3);
});

test("boundary cases: deadline cutoff, self-created claims, invalid addresses, and partial read failures", async () => {
  const state: SyntheticState = {
    subscriptions: ["basket-1"],
    definitions: [
      {
        id: "basket-1",
        name: "Boundary Basket",
        members: [{ agentId: "agent-a", weightBps: 10_000 }],
      },
    ],
    agents: DEFAULT_AGENTS,
    claims: [
      { id: 701, deadline: NOW + MIRROR_DEADLINE_BUFFER_SECONDS }, // exact cutoff -> excluded
      { id: 702, deadline: NOW + MIRROR_DEADLINE_BUFFER_SECONDS + 1 }, // 1s past cutoff -> included
      { id: 703, deadline: NOW + 2_000, creator: SUBSCRIBER_VALID }, // own claim -> excluded
      { id: 704, deadline: NOW + 3_000 }, // challenger lookup rejects -> skipped safely
    ],
    challengers: {
      701: [{ address: AGENT_A_ADDR, stake: 10 }],
      702: [{ address: AGENT_A_ADDR, stake: 10 }],
      703: [{ address: AGENT_A_ADDR, stake: 10 }],
      704: [{ address: AGENT_A_ADDR, stake: 10 }],
    },
  };

  // Invalid address returns empty list
  assert.deepEqual(await computePendingMirrors(INVALID_SUBSCRIBER, {}, makeDeps(state)), []);

  // Non-positive budget returns empty list
  assert.deepEqual(
    await computePendingMirrors(SUBSCRIBER_VALID, { "basket-1": 0 }, makeDeps(state)),
    [],
  );

  // Partial failure on claim 704 does not break claim 702
  const result = await computePendingMirrors(
    SUBSCRIBER_VALID,
    { "basket-1": 4 },
    makeDeps(state, {
      listChallengers: async (claimId) => {
        if (claimId === 704) throw new Error("transient read-index timeout");
        return state.challengers[claimId] ?? [];
      },
    }),
  );
  assert.deepEqual(
    result.map((m) => ({ claimId: m.claimId, mirrorUsdc: m.mirrorUsdc })),
    [{ claimId: 702, mirrorUsdc: 4 }],
  );
});
