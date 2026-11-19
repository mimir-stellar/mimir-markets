import assert from "node:assert/strict";
import Module from "node:module";
import test, { describe } from "node:test";
import {
  type BasketPolicy,
  DEFAULT_BASKET_POLICY,
  computePortfolioExposure,
  previewFollowerMirrorExposure,
  type FollowerPosition,
} from "../../lib/baskets";

// Stub Next.js "server-only" before loading lib/server/mirror-queue
const moduleLoader = Module as unknown as {
  _load: (request: string, parent: { filename?: string } | null, isMain: boolean) => unknown;
};
const originalLoad = moduleLoader._load;
moduleLoader._load = function stubLoad(request, parent, isMain) {
  if (request === "server-only") return {};
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  pendingMirrorsFor,
  previewFollowerMirror,
  previewFollowerMirrors,
} = require("../../lib/server/mirror-queue") as typeof import("../../lib/server/mirror-queue");

moduleLoader._load = originalLoad;

type MirrorQueueDependencies = import("../../lib/server/mirror-queue").MirrorQueueDependencies;

// Valid Stellar strkeys with verified CRC-16 checksums
const SUBSCRIBER = "GBAHBL3NSW3KH3HZENA4H6NKTWLDZESHQLNAB2O5HORMZH6GK5FWTTKO";
const MEMBER_ADDRESS = "GBKAYYLD3NZ2JKDCS4ZSI4MTDQCTTR37CTXAFZBHAT7APSEPNSBV4V6N";
const NOW = Math.floor(Date.now() / 1000);

function makeDeps(opts: {
  subscriptions?: string[];
  definitions?: Array<{ id: string; name: string; members: Array<{ agentId: string; weightBps: number }> }>;
  agents?: Array<{ id: string; displayName: string; address: string }>;
  claims?: Array<{
    id: number;
    question?: string | null;
    deadline: number;
    creator?: string | null;
    category?: string | null;
    market_type?: string | null;
  }>;
  challengers?: Record<number, Array<{ address: string; stake: number }>>;
  followerPositions?: FollowerPosition[];
}): MirrorQueueDependencies {
  return {
    listSubscriptions: async () => opts.subscriptions ?? [],
    listDefinitions: async () => opts.definitions ?? [],
    listAgents: async () => opts.agents ?? [],
    listOpenClaims: async () => opts.claims ?? [],
    listChallengers: async (claimId) => opts.challengers?.[claimId] ?? [],
    listFollowerPositions: opts.followerPositions ? async () => opts.followerPositions! : undefined,
  };
}

const BASKET = {
  id: "b",
  name: "Basket",
  members: [{ agentId: "a1", weightBps: 10_000 }],
};

const AGENT = { id: "a1", displayName: "Agent One", address: MEMBER_ADDRESS };

describe("pendingMirrorsFor", () => {
  test("returns an empty list when the follower has no subscriptions", async () => {
    const deps = makeDeps({
      subscriptions: [],
      definitions: [BASKET],
      agents: [AGENT],
      claims: [{ id: 1, deadline: NOW + 1000 }],
      challengers: { 1: [{ address: MEMBER_ADDRESS, stake: 10 }] },
    });
    const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);
    assert.deepEqual(result, []);
  });

  test("excludes markets the follower already mirrored", async () => {
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
          { address: SUBSCRIBER, stake: 5 },
        ],
        2: [{ address: MEMBER_ADDRESS, stake: 20 }],
      },
    });
    const result = await pendingMirrorsFor(SUBSCRIBER, {}, deps);
    assert.deepEqual(result.map((r) => r.claimId), [2]);
  });

  test("excludes expired markets", async () => {
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [BASKET],
      agents: [AGENT],
      claims: [
        { id: 1, deadline: NOW - 1000 },
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

  test("deduplicates markets shared across multiple baskets", async () => {
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

  test("carries the per-market amount through", async () => {
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [BASKET],
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
    const result = await pendingMirrorsFor(SUBSCRIBER, { b: 50 }, deps);
    const byId = new Map(result.map((r) => [r.claimId, r.mirrorUsdc]));
    assert.equal(byId.get(1), 50);
    assert.equal(byId.get(2), 50);
  });

  test("enforces non-custodial fields and calculates remaining budget", async () => {
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [
        {
          id: "b",
          name: "Alpha Basket",
          members: [{ agentId: "a1", weightBps: 5_000 }],
        },
      ],
      agents: [AGENT],
      claims: [
        {
          id: 42,
          question: "Will Stellar exceed 100M operations?",
          deadline: NOW + 1000,
          category: "crypto",
          market_type: "pool",
        },
      ],
      challengers: {
        42: [{ address: MEMBER_ADDRESS, stake: 100 }],
      },
    });

    // 10 USDC budget, 50% member weight => 5 USDC mirror, remaining 5 USDC
    const mirrors = await pendingMirrorsFor(SUBSCRIBER, { b: 10 }, deps);
    assert.equal(mirrors.length, 1);
    const mirror = mirrors[0];
    assert.equal(mirror.claimId, 42);
    assert.equal(mirror.category, "crypto");
    assert.equal(mirror.mode, "pool");
    assert.equal(mirror.mirrorUsdc, 5);
    assert.equal(mirror.remainingBudgetUsdc, 5);
    assert.equal(mirror.requiresUserSignature, true);
    assert.equal(mirror.delegatedAuthority, false);
  });
});

describe("portfolio exposure impact & follower mirror preview", () => {
  const policy: BasketPolicy = {
    maxSingleAgentBps: 4_000, // 40% max per agent
    maxCategoryBps: 6_000, // 60% max per category
    staleSignalAction: "skip",
    failedCopyAction: "keep_idle",
  };

  test("computes baseline portfolio exposure across categories, modes, and agents", () => {
    const positions: FollowerPosition[] = [
      { claimId: 1, agentId: "agent-a", category: "crypto", mode: "pool", amountUsdc: 40 },
      { claimId: 2, agentId: "agent-b", category: "sports", mode: "duel", amountUsdc: 60 },
    ];

    const exposure = computePortfolioExposure(positions, policy);
    assert.equal(exposure.totalUsdc, 100);
    assert.equal(exposure.categoryBps.crypto, 4_000);
    assert.equal(exposure.categoryBps.sports, 6_000);
    assert.equal(exposure.modeBps.pool, 4_000);
    assert.equal(exposure.modeBps.duel, 6_000);
    assert.equal(exposure.agentBps["agent-a"], 4_000);
    assert.equal(exposure.agentBps["agent-b"], 6_000);

    // Sports is right at 60%, agent-b is at 60% (> 40% limit)
    const agentBBar = exposure.agentBars.find((b) => b.key === "agent-b");
    assert.ok(agentBBar?.overLimit);
    const agentABar = exposure.agentBars.find((b) => b.key === "agent-a");
    assert.equal(agentABar?.overLimit, false);
  });

  test("generates ready preview with remaining budget and projected exposure", () => {
    // Current positions: 40 USDC crypto (agent-a), 30 USDC macro (agent-c) -> 70 USDC total
    const currentPositions: FollowerPosition[] = [
      { claimId: 1, agentId: "agent-a", category: "crypto", mode: "pool", amountUsdc: 40 },
      { claimId: 2, agentId: "agent-c", category: "macro", mode: "pool", amountUsdc: 30 },
    ];

    // Mirror: 30 USDC sports (agent-b)
    // Projected total: 100 USDC
    // crypto: 40% (<= 60%), macro: 30% (<= 60%), sports: 30% (<= 60%)
    // agent-a: 40% (<= 40%), agent-c: 30% (<= 40%), agent-b: 30% (<= 40%) -> all ready!
    const preview = previewFollowerMirrorExposure({
      currentPositions,
      pendingMirror: {
        claimId: 3,
        agentId: "agent-b",
        category: "sports",
        mode: "duel",
        mirrorUsdc: 30,
      },
      configuredBudgetUsdc: 50,
      policy,
    });

    assert.equal(preview.status, "ready");
    assert.equal(preview.configuredBudgetUsdc, 50);
    assert.equal(preview.remainingBudgetUsdc, 20);
    assert.equal(preview.requiresUserSignature, true);
    assert.equal(preview.delegatedAuthority, false);
    assert.deepEqual(preview.policyViolations, []);

    // Current: 70 USDC
    assert.equal(preview.currentExposure.totalUsdc, 70);

    // Projected: 100 USDC total
    assert.equal(preview.projectedExposure.totalUsdc, 100);
    assert.equal(preview.projectedExposure.categoryBps.crypto, 4_000);
    assert.equal(preview.projectedExposure.categoryBps.sports, 3_000);
    assert.equal(preview.projectedExposure.categoryBps.macro, 3_000);
    assert.equal(preview.newPosition.claimId, 3);
    assert.equal(preview.newPosition.amountUsdc, 30);
  });

  test("detects insufficient configured budget boundary", () => {
    const preview = previewFollowerMirrorExposure({
      currentPositions: [],
      pendingMirror: {
        claimId: 5,
        agentId: "agent-a",
        category: "crypto",
        mode: "pool",
        mirrorUsdc: 50,
      },
      configuredBudgetUsdc: 25,
      policy,
    });

    assert.equal(preview.status, "insufficient_budget");
    assert.ok(preview.policyViolations.includes("insufficient_budget"));
    assert.equal(preview.remainingBudgetUsdc, 0);
  });

  test("detects category exposure cap violation in projected portfolio", () => {
    const currentPositions: FollowerPosition[] = [
      { claimId: 1, agentId: "agent-a", category: "crypto", mode: "pool", amountUsdc: 50 },
    ];

    // Adding 50 USDC more crypto -> crypto is 100 USDC out of 100 USDC (100% > 60% cap)
    const preview = previewFollowerMirrorExposure({
      currentPositions,
      pendingMirror: {
        claimId: 2,
        agentId: "agent-b",
        category: "crypto",
        mode: "pool",
        mirrorUsdc: 50,
      },
      configuredBudgetUsdc: 100,
      policy,
    });

    assert.equal(preview.status, "policy_breach");
    assert.ok(
      preview.policyViolations.some((v) => v.startsWith("category_exposure_exceeded:crypto")),
    );
  });

  test("detects single agent concentration cap violation in projected portfolio", () => {
    const currentPositions: FollowerPosition[] = [
      { claimId: 1, agentId: "whale-agent", category: "crypto", mode: "pool", amountUsdc: 30 },
      { claimId: 2, agentId: "other-agent", category: "macro", mode: "duel", amountUsdc: 50 },
    ];

    // whale-agent already has 30. Adding 30 more whale-agent makes 60 / 110 (~54.5% > 40% cap)
    const preview = previewFollowerMirrorExposure({
      currentPositions,
      pendingMirror: {
        claimId: 3,
        agentId: "whale-agent",
        category: "sports",
        mode: "pool",
        mirrorUsdc: 30,
      },
      configuredBudgetUsdc: 100,
      policy,
    });

    assert.equal(preview.status, "policy_breach");
    assert.ok(
      preview.policyViolations.some((v) => v.startsWith("single_agent_exposure_exceeded:whale-agent")),
    );
  });

  test("handles already mirrored market boundary", () => {
    const currentPositions: FollowerPosition[] = [
      { claimId: 10, agentId: "agent-a", category: "crypto", mode: "pool", amountUsdc: 25 },
    ];

    const preview = previewFollowerMirrorExposure({
      currentPositions,
      pendingMirror: {
        claimId: 10,
        agentId: "agent-a",
        category: "crypto",
        mode: "pool",
        mirrorUsdc: 25,
      },
      configuredBudgetUsdc: 50,
      policy,
    });

    assert.equal(preview.status, "already_mirrored");
    assert.ok(preview.policyViolations.includes("already_mirrored"));
  });

  test("handles invalid inputs gracefully", () => {
    const preview = previewFollowerMirrorExposure({
      currentPositions: [],
      pendingMirror: {
        claimId: 1,
        agentId: "agent-a",
        category: "crypto",
        mode: "pool",
        mirrorUsdc: -10,
      },
      configuredBudgetUsdc: -5,
      policy,
    });

    assert.equal(preview.status, "invalid");
    assert.ok(preview.policyViolations.includes("invalid_input"));
  });
});

describe("previewFollowerMirror and previewFollowerMirrors service methods", () => {
  test("generates preview for a specific open claim", async () => {
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [
        {
          id: "b",
          name: "Test Basket",
          members: [{ agentId: "a1", weightBps: 10_000 }],
        },
      ],
      agents: [AGENT],
      claims: [
        {
          id: 101,
          question: "Will test pass?",
          deadline: NOW + 1000,
          category: "tech",
          market_type: "pool",
        },
      ],
      challengers: {
        101: [{ address: MEMBER_ADDRESS, stake: 50 }],
      },
      followerPositions: [
        { claimId: 99, agentId: "other", category: "macro", mode: "duel", amountUsdc: 50 },
      ],
    });

    const preview = await previewFollowerMirror({
      subscriber: SUBSCRIBER,
      claimId: 101,
      perMarketUsdc: { b: 50 },
      dependencies: deps,
    });

    assert.ok(preview);
    assert.equal(preview.newPosition.claimId, 101);
    assert.equal(preview.newPosition.amountUsdc, 50);
    assert.equal(preview.remainingBudgetUsdc, 0);
    assert.equal(preview.requiresUserSignature, true);
    assert.equal(preview.delegatedAuthority, false);
    assert.equal(preview.currentExposure.totalUsdc, 50);
    assert.equal(preview.projectedExposure.totalUsdc, 100);
    assert.equal(preview.projectedExposure.categoryBps.macro, 5_000);
    assert.equal(preview.projectedExposure.categoryBps.tech, 5_000);
  });

  test("generates previews for all open mirrors", async () => {
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [
        {
          id: "b",
          name: "Test Basket",
          members: [{ agentId: "a1", weightBps: 10_000 }],
        },
      ],
      agents: [AGENT],
      claims: [
        { id: 201, deadline: NOW + 1000, category: "crypto", market_type: "pool" },
        { id: 202, deadline: NOW + 2000, category: "sports", market_type: "duel" },
      ],
      challengers: {
        201: [{ address: MEMBER_ADDRESS, stake: 20 }],
        202: [{ address: MEMBER_ADDRESS, stake: 30 }],
      },
      followerPositions: [],
    });

    const previews = await previewFollowerMirrors({
      subscriber: SUBSCRIBER,
      perMarketUsdc: { b: 10 },
      dependencies: deps,
    });

    assert.equal(previews.length, 2);
    assert.equal(previews[0].newPosition.claimId, 201);
    assert.equal(previews[0].remainingBudgetUsdc, 0);
    assert.equal(previews[0].requiresUserSignature, true);
    assert.equal(previews[0].delegatedAuthority, false);

    assert.equal(previews[1].newPosition.claimId, 202);
    assert.equal(previews[1].requiresUserSignature, true);
    assert.equal(previews[1].delegatedAuthority, false);
  });

  test("returns null for non-existent claim or empty preview", async () => {
    const deps = makeDeps({
      subscriptions: ["b"],
      definitions: [BASKET],
      agents: [AGENT],
      claims: [],
      challengers: {},
    });

    const preview = await previewFollowerMirror({
      subscriber: SUBSCRIBER,
      claimId: 9999,
      dependencies: deps,
    });
    assert.equal(preview, null);
  });
});
