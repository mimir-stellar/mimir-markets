import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";

const permissionsTable = new Map<string, Record<string, unknown>>();
const noncesTable = new Set<string>();

function installFakePool(): void {
  const handler = async (sql: string, args: unknown[] = []) => {
    const s = sql.trim();
    if (s.includes("INSERT INTO agent_api_nonces")) {
      const nonce = String(args[0]);
      if (noncesTable.has(nonce)) return { rows: [] };
      noncesTable.add(nonce);
      return { rows: [{ nonce }] };
    }
    if (s.includes("FROM agent_api_nonces")) {
      return { rows: noncesTable.has(String(args[0])) ? [{ one: 1 }] : [] };
    }
    if (s.includes("INSERT INTO copy_permissions")) {
      const [permission_id, owner_wallet, execution_agent_id, signal_agent_id, policy_json, signed_policy_hash, status, at] = args as unknown[];
      permissionsTable.set(String(permission_id), {
        permission_id, owner_wallet, execution_agent_id, signal_agent_id,
        policy_json, signed_policy_hash, status, updated_at: Number(at),
      });
      return { rows: [] };
    }
    if (s.includes("FROM copy_permissions") && s.includes("permission_id =")) {
      const row = permissionsTable.get(String(args[0]));
      return row ? { rows: [row] } : { rows: [] };
    }
    return { rows: [] };
  };
  const pool = {
    query: (sql: string, args: unknown[] = []) => handler(sql, args),
    connect: async () => ({
      query: (sql: string, args: unknown[] = []) => handler(sql, args),
      release: () => {},
    }),
  };
  process.env.DATABASE_URL = "postgres://fake/mimir";
  const g = globalThis as unknown as Record<string, unknown>;
  g.__mimirDbPool = pool;
  g.__mimirDbReady = Promise.resolve(pool);
}

installFakePool();

import {
  buildCopyPermissionReviewDigest,
  copyGrantMessage,
  copyPermissionReviewDigest,
  copyPolicyHash,
  verifyCopyPermissionReviewDigest,
  type CopyPermission,
} from "../../lib/copy-trading";
import { POST as reviewPost } from "../../app/api/copy/permissions/review/route";
import { POST as permissionsPost } from "../../app/api/copy/permissions/route";
import { getUsdcSacId } from "../../lib/stellar";
import { configuredSpender } from "../../lib/agents/spend-permissions";

const ownerKeypair = Keypair.random();
const OWNER = ownerKeypair.publicKey();
const USDC = getUsdcSacId() || "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const SPENDER = configuredSpender() || "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const NOW = 1_780_000_000_000;

function basePermission(overrides: Partial<Omit<CopyPermission, "signedPolicyHash">> = {}): Omit<CopyPermission, "signedPolicyHash"> {
  return {
    permissionId: "review-perm-1",
    ownerWallet: OWNER,
    executionAgentId: "agent-exec-1",
    signalAgentId: "agent-signal-1",
    maxPerPositionUsdc: 5,
    dailyCapUsdc: 20,
    weeklyCapUsdc: 50,
    totalOpenExposureUsdc: 30,
    maxRealizedLossAtomic: "100000000",
    allowedCategories: ["crypto"],
    allowedModes: ["pool"],
    minConfidenceBps: 7000,
    minPayoutBps: 12000,
    expiresAt: NOW + 86_400_000,
    depth: 1,
    status: "active",
    spendPermission: {
      token: USDC,
      spender: SPENDER,
      allowanceAtomic: 1_000_000_000n,
      periodSeconds: 86400,
    },
    ...overrides,
  };
}

function toJsonPermission(p: Omit<CopyPermission, "signedPolicyHash">) {
  return {
    ...p,
    spendPermission: {
      ...p.spendPermission,
      allowanceAtomic: p.spendPermission.allowanceAtomic.toString(),
    },
  };
}

test("buildCopyPermissionReviewDigest binds agent, category, expiry, and all spending limits", () => {
  const perm = basePermission();
  const built = buildCopyPermissionReviewDigest(perm, NOW);
  assert.equal(built.ok, true);
  if (!built.ok) return;

  assert.match(built.digest.reviewDigest, /^[0-9a-f]{64}$/);
  assert.equal(built.digest.reviewDigest, copyPermissionReviewDigest(perm));
  assert.equal(built.digest.policyHash, copyPolicyHash(perm));
  assert.deepEqual(built.digest.agents, {
    executionAgentId: "agent-exec-1",
    signalAgentId: "agent-signal-1",
  });
  assert.deepEqual(built.digest.categories, ["crypto"]);
  assert.equal(built.digest.expiresAt, NOW + 86_400_000);
  assert.deepEqual(built.digest.spendingLimits, {
    maxPerPositionUsdc: 5,
    dailyCapUsdc: 20,
    weeklyCapUsdc: 50,
    totalOpenExposureUsdc: 30,
    maxRealizedLossAtomic: "100000000",
    spendPermission: {
      token: USDC,
      spender: SPENDER,
      allowanceAtomic: "1000000000",
      periodSeconds: 86400,
    },
  });
  assert.equal(verifyCopyPermissionReviewDigest(perm, built.digest.reviewDigest).ok, true);
});

test("mutating any bound field before signature invalidates the review digest", () => {
  const perm = basePermission();
  const digest = copyPermissionReviewDigest(perm);

  const mutations: Array<[string, Omit<CopyPermission, "signedPolicyHash">]> = [
    ["executionAgentId", { ...perm, executionAgentId: "agent-exec-2" }],
    ["signalAgentId", { ...perm, signalAgentId: "agent-signal-2" }],
    ["allowedCategories", { ...perm, allowedCategories: ["crypto", "sports"] }],
    ["allowedModes", { ...perm, allowedModes: ["pool", "orderbook"] }],
    ["expiresAt", { ...perm, expiresAt: perm.expiresAt + 1000 }],
    ["maxPerPositionUsdc", { ...perm, maxPerPositionUsdc: 6 }],
    ["dailyCapUsdc", { ...perm, dailyCapUsdc: 25 }],
    ["weeklyCapUsdc", { ...perm, weeklyCapUsdc: 60 }],
    ["totalOpenExposureUsdc", { ...perm, totalOpenExposureUsdc: 35 }],
    ["maxRealizedLossAtomic", { ...perm, maxRealizedLossAtomic: "200000000" }],
    ["minConfidenceBps", { ...perm, minConfidenceBps: 7500 }],
    ["minPayoutBps", { ...perm, minPayoutBps: 12500 }],
    ["spendPermission.allowanceAtomic", { ...perm, spendPermission: { ...perm.spendPermission, allowanceAtomic: 2_000_000_000n } }],
    ["spendPermission.periodSeconds", { ...perm, spendPermission: { ...perm.spendPermission, periodSeconds: 43200 } }],
  ];

  for (const [field, mutated] of mutations) {
    const check = verifyCopyPermissionReviewDigest(mutated, digest);
    assert.deepEqual(check, { ok: false, reason: "review_digest_mismatch" }, `expected mismatch when ${field} changes`);
  }

  assert.deepEqual(verifyCopyPermissionReviewDigest(perm, "not-a-hex-digest"), {
    ok: false,
    reason: "invalid_review_digest",
  });
});

test("buildCopyPermissionReviewDigest rejects invalid or expired permissions", () => {
  const expired = buildCopyPermissionReviewDigest(basePermission({ expiresAt: NOW }), NOW);
  assert.deepEqual(expired, { ok: false, error: "invalid_lifecycle" });

  const badBudget = buildCopyPermissionReviewDigest(basePermission({ dailyCapUsdc: 1, maxPerPositionUsdc: 5 }), NOW);
  assert.deepEqual(badBudget, { ok: false, error: "invalid_budget" });
});

test("POST /api/copy/permissions/review exposes digest and POST /api/copy/permissions enforces it", async () => {
  const perm = basePermission({ permissionId: "route-review-perm-1", expiresAt: Date.now() + 86_400_000 });
  const reviewRes = await reviewPost(new Request("http://localhost/api/copy/permissions/review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ permission: toJsonPermission(perm) }),
  }));
  assert.equal(reviewRes.status, 200);
  const reviewBody = await reviewRes.json();
  const reviewDigest: string = reviewBody.review.reviewDigest;
  assert.match(reviewDigest, /^[0-9a-f]{64}$/);
  assert.equal(reviewBody.review.spendingLimits.dailyCapUsdc, 20);

  // Tamper with a spending limit after review and before signing -> 409 review_digest_mismatch
  const tampered = { ...perm, dailyCapUsdc: 25 };
  const nonce1 = `nonce-review-tamper-${Date.now()}`;
  const expiresAt1 = Date.now() + 60_000;
  const msg1 = copyGrantMessage({
    permissionId: tampered.permissionId,
    ownerWallet: tampered.ownerWallet,
    policyHash: copyPolicyHash(tampered),
    reviewDigest,
    nonce: nonce1,
    expiresAt: expiresAt1,
  });
  const sig1 = ownerKeypair.sign(Buffer.from(msg1, "utf8")).toString("base64");
  const tamperRes = await permissionsPost(new Request("http://localhost/api/copy/permissions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      permission: toJsonPermission(tampered),
      reviewDigest,
      signature: sig1,
      nonce: nonce1,
      expiresAt: expiresAt1,
    }),
  }));
  assert.equal(tamperRes.status, 409);
  const tamperBody = await tamperRes.json();
  assert.equal(tamperBody.error, "review_digest_mismatch");

  // Unmodified permission with matching reviewDigest -> 200 OK
  const nonce2 = `nonce-review-ok-${Date.now()}`;
  const expiresAt2 = Date.now() + 60_000;
  const msg2 = copyGrantMessage({
    permissionId: perm.permissionId,
    ownerWallet: perm.ownerWallet,
    policyHash: copyPolicyHash(perm),
    reviewDigest,
    nonce: nonce2,
    expiresAt: expiresAt2,
  });
  const sig2 = ownerKeypair.sign(Buffer.from(msg2, "utf8")).toString("base64");
  const okRes = await permissionsPost(new Request("http://localhost/api/copy/permissions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      permission: toJsonPermission(perm),
      reviewDigest,
      signature: sig2,
      nonce: nonce2,
      expiresAt: expiresAt2,
    }),
  }));
  assert.equal(okRes.status, 200);
  const okBody = await okRes.json();
  assert.equal(okBody.reviewDigest, reviewDigest);
});
