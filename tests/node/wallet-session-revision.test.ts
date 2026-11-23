import test from "node:test";
import assert from "node:assert/strict";

import {
  isSameAccountIdentity,
  shouldIncrementSessionRevision,
} from "../../lib/wallet";
import {
  clearTrustlineReadCache,
  getTrustlineReadCacheSize,
  invalidateTrustlineRead,
  readUsdcTrustline,
  ensureUsdcTrustline,
  type HorizonAccount,
} from "../../lib/stellar-trustline";
import { USDC_CODE, USDC_ISSUER } from "../../lib/usdc";
import type { StellarSigner } from "../../lib/stellar";

const ACCOUNT_A = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const ACCOUNT_B = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function makeAccountFixture(balances: Array<{ code?: string; issuer?: string; balance: string }>): HorizonAccount {
  return {
    balances: balances.map((b) => ({
      asset_type: b.code ? "credit_alphanum4" : "native",
      asset_code: b.code,
      asset_issuer: b.issuer,
      balance: b.balance,
      limit: "922337203685.4775807",
    })),
  };
}

const READY_FIXTURE = makeAccountFixture([
  { balance: "50.0000000" }, // XLM
  { code: USDC_CODE, issuer: USDC_ISSUER, balance: "100.5000000" },
]);

const MISSING_FIXTURE = makeAccountFixture([
  { balance: "50.0000000" }, // XLM only
]);

test.beforeEach(() => {
  clearTrustlineReadCache();
});

test("isSameAccountIdentity: preserves exact case-sensitive account identity", () => {
  assert.equal(isSameAccountIdentity(ACCOUNT_A, ACCOUNT_A), true);
  assert.equal(isSameAccountIdentity(null, null), true);
  assert.equal(isSameAccountIdentity(undefined, undefined), true);
  assert.equal(isSameAccountIdentity(ACCOUNT_A, ACCOUNT_B), false);
  assert.equal(isSameAccountIdentity(ACCOUNT_A, null), false);

  // Exact case sensitivity: lowercased address is NOT identical to uppercase strkey
  const lowercased = ACCOUNT_A.toLowerCase();
  assert.notEqual(ACCOUNT_A, lowercased);
  assert.equal(isSameAccountIdentity(ACCOUNT_A, lowercased), false);
});

test("shouldIncrementSessionRevision: detects account, network, and connector changes", () => {
  const base = {
    address: ACCOUNT_A,
    walletId: "freighter",
    network: "Test SDF Network ; September 2015",
  };

  // No change -> false
  assert.equal(shouldIncrementSessionRevision(base, { ...base }), false);

  // Account switch -> true
  assert.equal(
    shouldIncrementSessionRevision(base, { ...base, address: ACCOUNT_B }),
    true,
  );

  // Disconnect (address null) -> true
  assert.equal(
    shouldIncrementSessionRevision(base, { ...base, address: null, walletId: null }),
    true,
  );

  // Case-sensitive account change -> true
  assert.equal(
    shouldIncrementSessionRevision(base, { ...base, address: ACCOUNT_A.toLowerCase() }),
    true,
  );

  // Connector change -> true (same address, different wallet)
  assert.equal(
    shouldIncrementSessionRevision(base, { ...base, walletId: "xbull" }),
    true,
  );

  // Network change -> true
  assert.equal(
    shouldIncrementSessionRevision(base, {
      ...base,
      network: "Public Global Stellar Network ; September 2015",
    }),
    true,
  );
});

test("readUsdcTrustline: caches read context per session revision and avoids duplicate network reads", async () => {
  let loadCalls = 0;
  const loader = async (addr: string) => {
    loadCalls++;
    assert.equal(addr, ACCOUNT_A);
    return READY_FIXTURE;
  };

  // Initial read with sessionRevision 1
  const first = await readUsdcTrustline(ACCOUNT_A, {
    loadAccount: loader,
    sessionRevision: 1,
    useCache: true,
  });
  assert.equal(first.status, "ready");
  assert.equal(first.balance, 100.5);
  assert.equal(loadCalls, 1);
  assert.equal(getTrustlineReadCacheSize(), 1);

  // Second read with identical sessionRevision 1 returns cached read context
  const second = await readUsdcTrustline(ACCOUNT_A, {
    loadAccount: loader,
    sessionRevision: 1,
    useCache: true,
  });
  assert.deepEqual(second, first);
  assert.equal(loadCalls, 1, "loader should not be called again when session revision is unchanged");
});

test("readUsdcTrustline: invalidates read context when session revision increments", async () => {
  let loadCalls = 0;
  const loader = async () => {
    loadCalls++;
    return READY_FIXTURE;
  };

  await readUsdcTrustline(ACCOUNT_A, {
    loadAccount: loader,
    sessionRevision: 1,
    useCache: true,
  });
  assert.equal(loadCalls, 1);

  // Read with incremented session revision 2 invalidates cache and triggers new read
  const next = await readUsdcTrustline(ACCOUNT_A, {
    loadAccount: loader,
    sessionRevision: 2,
    useCache: true,
  });
  assert.equal(next.status, "ready");
  assert.equal(loadCalls, 2, "loader must be invoked after session revision increments");
});

test("invalidateTrustlineRead: preserves exact case-sensitive account identity and invalidates only affected read context", async () => {
  let loadCallsA = 0;
  let loadCallsB = 0;

  const loaderA = async () => {
    loadCallsA++;
    return READY_FIXTURE;
  };
  const loaderB = async () => {
    loadCallsB++;
    return READY_FIXTURE;
  };

  // Populate read context for Account A and Account B
  await readUsdcTrustline(ACCOUNT_A, { loadAccount: loaderA, sessionRevision: 1, useCache: true });
  await readUsdcTrustline(ACCOUNT_B, { loadAccount: loaderB, sessionRevision: 1, useCache: true });

  assert.equal(loadCallsA, 1);
  assert.equal(loadCallsB, 1);
  assert.equal(getTrustlineReadCacheSize(), 2);

  // Invalidate with a mismatched/lowercased address does NOT invalidate uppercase ACCOUNT_A
  invalidateTrustlineRead(ACCOUNT_A.toLowerCase());
  assert.equal(getTrustlineReadCacheSize(), 2, "lowercased string should not invalidate exact case-sensitive account");

  // Invalidate ONLY Account A
  invalidateTrustlineRead(ACCOUNT_A);
  assert.equal(getTrustlineReadCacheSize(), 1, "only Account A should be evicted");

  // Re-reading Account B should still be cached (loadCallsB does NOT increment)
  await readUsdcTrustline(ACCOUNT_B, { loadAccount: loaderB, sessionRevision: 1, useCache: true });
  assert.equal(loadCallsB, 1, "Account B read context was unaffected and remains cached");

  // Re-reading Account A requires a fresh load (loadCallsA increments)
  await readUsdcTrustline(ACCOUNT_A, { loadAccount: loaderA, sessionRevision: 1, useCache: true });
  assert.equal(loadCallsA, 2, "Account A read context was invalidated and refetched");
});

test("invalidateTrustlineRead: without arguments invalidates all cached read contexts", async () => {
  await readUsdcTrustline(ACCOUNT_A, { loadAccount: async () => READY_FIXTURE, sessionRevision: 1, useCache: true });
  await readUsdcTrustline(ACCOUNT_B, { loadAccount: async () => READY_FIXTURE, sessionRevision: 1, useCache: true });
  assert.equal(getTrustlineReadCacheSize(), 2);

  invalidateTrustlineRead();
  assert.equal(getTrustlineReadCacheSize(), 0);
});

test("boundary: invalid addresses and transport errors are not cached", async () => {
  let loadCalls = 0;
  const failureLoader = async () => {
    loadCalls++;
    throw new Error("Horizon 500 internal server error");
  };

  // Non-account address fails pre-flight validation
  const invalidResult = await readUsdcTrustline("NOT_A_VALID_ADDRESS", {
    loadAccount: failureLoader,
    sessionRevision: 1,
    useCache: true,
  });
  assert.equal(invalidResult.status, "unknown");
  assert.equal(loadCalls, 0);
  assert.equal(getTrustlineReadCacheSize(), 0);

  // Transport failure does not cache so subsequent retry can succeed
  const transportError = await readUsdcTrustline(ACCOUNT_A, {
    loadAccount: failureLoader,
    sessionRevision: 1,
    useCache: true,
  });
  assert.equal(transportError.status, "unknown");
  assert.equal(loadCalls, 1);
  assert.equal(getTrustlineReadCacheSize(), 0, "transport errors must not be cached");
});

test("ensureUsdcTrustline: automatically invalidates read context on successful trustline addition", async () => {
  let submitCalled = false;
  const mockAccount = {
    id: ACCOUNT_A,
    sequenceNumber: () => "100",
    incrementSequenceNumber: () => {},
  };

  const signer: StellarSigner = {
    publicKey: ACCOUNT_A,
    signTransaction: async (xdr) => ({ signedTxXdr: xdr }),
  };

  // Pre-populate read cache for ACCOUNT_A with MISSING status
  await readUsdcTrustline(ACCOUNT_A, {
    loadAccount: async () => MISSING_FIXTURE,
    sessionRevision: 1,
    useCache: true,
  });
  assert.equal(getTrustlineReadCacheSize(), 1);

  const result = await ensureUsdcTrustline(signer, {
    loadAccount: async () => MISSING_FIXTURE,
    server: {
      loadAccount: async () => mockAccount as any,
      submitTransaction: async () => {
        submitCalled = true;
        return { hash: "tx_hash_trustline_added" };
      },
    },
  });

  assert.equal(result.added, true);
  assert.equal(submitCalled, true);
  assert.equal(
    getTrustlineReadCacheSize(),
    0,
    "adding a trustline must invalidate the affected signer's read context",
  );
});
