/**
 * Deterministic unit coverage for `readUsdcTrustline` in `lib/stellar-trustline.ts`.
 *
 * Pins how Horizon `/accounts/{id}` JSON responses and transport errors map onto
 * `TrustlineState` (`ready`, `missing`, `unfunded`, `unknown`) without touching
 * the network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Account, Keypair } from "@stellar/stellar-sdk";

import {
  ensureUsdcTrustline,
  isRejection,
  isTransportUnavailable,
  readUsdcTrustline,
  toWalletError,
  WalletError,
  type HorizonAccount,
  type HorizonBalanceLine,
  type TrustlineStatus,
} from "../../lib/stellar-trustline";
import type { StellarSigner } from "../../lib/stellar";
import { actionLabel, statusDescription } from "../../lib/wallet-aria";
import { USDC_CODE, USDC_ISSUER } from "../../lib/usdc";
import { evaluateUsdcTrustlineGate, usdcTrustlineGateFixture } from "../../lib/usdcTrustlineGate";

const ACCOUNT_A = "GBO43ZBS4RBC2QFDKB23U6TBFEEK47ZLGSXDJSRV2H3PNQK5ZDEYXVLE";
const IMPOSTOR_ISSUER = "GD2SI5PUEFKC7TONNX7OR72WMYUO7WZDSCDSIVWWXPDIDYW5OP3ETM5D";
const CONTRACT_A = "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR";
const EVM_ADDRESS = "0x0000000000000000000000000000000000000abc";

const NATIVE_BALANCE_LINE: HorizonBalanceLine = {
  balance: "100.0000000",
  buying_liabilities: "0.0000000",
  selling_liabilities: "0.0000000",
  asset_type: "native",
};

function usdcBalanceLine(overrides: Partial<HorizonBalanceLine> = {}): HorizonBalanceLine {
  return {
    balance: "42.5000000",
    limit: "922337203685.4775807",
    buying_liabilities: "0.0000000",
    selling_liabilities: "0.0000000",
    last_modified_ledger: 512340,
    is_authorized: true,
    is_authorized_to_maintain_liabilities: false,
    is_clawback_enabled: false,
    asset_type: "credit_alphanum4",
    asset_code: USDC_CODE,
    asset_issuer: USDC_ISSUER,
    ...overrides,
  };
}

function horizonAccountFixture(
  balances: readonly HorizonBalanceLine[],
  accountId = ACCOUNT_A,
): HorizonAccount & Record<string, unknown> {
  return JSON.parse(
    JSON.stringify({
      id: accountId,
      account_id: accountId,
      sequence: "4294967296",
      subentry_count: Math.max(0, balances.length - 1),
      thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
      last_modified_ledger: 512340,
      last_modified_time: "2026-10-18T00:00:00Z",
      flags: {
        auth_required: false,
        auth_revocable: false,
        auth_immutable: false,
        auth_clawback_enabled: false,
      },
      balances,
      signers: [{ key: accountId, weight: 1, type: "ed25519_public_key" }],
      data: {},
      num_sponsoring: 0,
      num_sponsored: 0,
    }),
  ) as HorizonAccount & Record<string, unknown>;
}

function horizonError(status: number, message = `Horizon HTTP ${status}`): Error & {
  response: { status: number };
} {
  return Object.assign(new Error(message), { response: { status } });
}

test("authorized USDC trustline fixture is classified as ready with parsed numeric balance", async () => {
  const fixture = horizonAccountFixture([usdcBalanceLine({ balance: "125.7500000" }), NATIVE_BALANCE_LINE]);
  let loadedAddress: string | null = null;

  const state = await readUsdcTrustline(ACCOUNT_A, async (addr) => {
    loadedAddress = addr;
    return fixture;
  });

  assert.equal(loadedAddress, ACCOUNT_A);
  assert.deepEqual(state, { status: "ready", balance: 125.75 });
});

test("zero-balance authorized USDC trustline is ready with 0 balance, not missing", async () => {
  const fixture = horizonAccountFixture([usdcBalanceLine({ balance: "0.0000000" }), NATIVE_BALANCE_LINE]);

  const state = await readUsdcTrustline(ACCOUNT_A, {
    loadAccount: async () => fixture,
  });

  assert.deepEqual(state, { status: "ready", balance: 0 });
});

test("frozen or deauthorized USDC trustlines still classify as ready because trustline exists and contracts park payouts", async () => {
  // Circle's USDC issuer has auth_revocable=true. A frozen trustline remains present
  // in Horizon's balances with is_authorized=false; re-submitting changeTrust cannot
  // unfreeze it, and the Soroban contracts handle frozen recipients via push_or_park.
  const frozenFixture = horizonAccountFixture([
    usdcBalanceLine({
      balance: "18.2500000",
      is_authorized: false,
      is_authorized_to_maintain_liabilities: false,
    }),
    NATIVE_BALANCE_LINE,
  ]);
  const maintainLiabilitiesOnlyFixture = horizonAccountFixture([
    usdcBalanceLine({
      balance: "5.0000000",
      is_authorized: false,
      is_authorized_to_maintain_liabilities: true,
    }),
    NATIVE_BALANCE_LINE,
  ]);

  const frozenState = await readUsdcTrustline(ACCOUNT_A, async () => frozenFixture);
  const maintainState = await readUsdcTrustline(ACCOUNT_A, async () => maintainLiabilitiesOnlyFixture);

  assert.deepEqual(frozenState, { status: "ready", balance: 18.25 });
  assert.deepEqual(maintainState, { status: "ready", balance: 5 });

  // Gate allows payout/withdraw actions to proceed so the contract can park or settle.
  const payoutGate = evaluateUsdcTrustlineGate(
    usdcTrustlineGateFixture({ action: "payout", status: frozenState.status }),
  );
  assert.equal(payoutGate.allowed, true);
  assert.equal(payoutGate.status, "ready");
});

test("trustlines with custom or exhausted limits still classify as present and report current balance", async () => {
  const cappedAtLimitFixture = horizonAccountFixture([
    usdcBalanceLine({
      balance: "10.0000000",
      limit: "10.0000000",
    }),
    NATIVE_BALANCE_LINE,
  ]);
  const zeroLimitFixture = horizonAccountFixture([
    usdcBalanceLine({
      balance: "0.0000000",
      limit: "0.0000000",
    }),
    NATIVE_BALANCE_LINE,
  ]);

  const cappedState = await readUsdcTrustline(ACCOUNT_A, {
    server: { loadAccount: async () => cappedAtLimitFixture },
  });
  const zeroLimitState = await readUsdcTrustline(ACCOUNT_A, {
    server: { loadAccount: async () => zeroLimitFixture },
  });

  assert.deepEqual(cappedState, { status: "ready", balance: 10 });
  assert.deepEqual(zeroLimitState, { status: "ready", balance: 0 });
});

test("funded account without a matching USDC trustline is classified as missing", async () => {
  const nativeOnlyFixture = horizonAccountFixture([NATIVE_BALANCE_LINE]);
  const wrongIssuerFixture = horizonAccountFixture([
    usdcBalanceLine({ asset_issuer: IMPOSTOR_ISSUER, balance: "999.0000000" }),
    NATIVE_BALANCE_LINE,
  ]);
  const wrongCodeFixture = horizonAccountFixture([
    usdcBalanceLine({ asset_code: "EURC", balance: "50.0000000" }),
    NATIVE_BALANCE_LINE,
  ]);
  const liquidityPoolOnlyFixture = horizonAccountFixture([
    {
      asset_type: "liquidity_pool_shares",
      liquidity_pool_id: "dd7b1ab831c273310ddbec6f97870aa83c2fbd78ce22aded37ecbf4f3380fac7",
      balance: "10.0000000",
      limit: "922337203685.4775807",
      is_authorized: true,
      is_authorized_to_maintain_liabilities: false,
      is_clawback_enabled: false,
    },
    NATIVE_BALANCE_LINE,
  ]);

  for (const fixture of [
    nativeOnlyFixture,
    wrongIssuerFixture,
    wrongCodeFixture,
    liquidityPoolOnlyFixture,
  ]) {
    const state = await readUsdcTrustline(ACCOUNT_A, async () => fixture);
    assert.deepEqual(state, { status: "missing", balance: null });
  }
});

test("missing account (Horizon 404) is classified as unfunded", async () => {
  const state = await readUsdcTrustline(ACCOUNT_A, async () => {
    throw horizonError(404, "Not Found");
  });

  assert.deepEqual(state, { status: "unfunded", balance: null });
});

test("non-404 Horizon failures and invalid addresses are classified as unknown", async () => {
  const http503 = await readUsdcTrustline(ACCOUNT_A, async () => {
    throw horizonError(503, "Service Unavailable");
  });
  const networkError = await readUsdcTrustline(ACCOUNT_A, async () => {
    throw new Error("ECONNRESET");
  });

  assert.deepEqual(http503, { status: "unknown", balance: null });
  assert.deepEqual(networkError, { status: "unknown", balance: null });

  let loaderCalled = false;
  for (const invalidAddress of ["", "   ", EVM_ADDRESS, CONTRACT_A, ACCOUNT_A.toLowerCase()]) {
    const state = await readUsdcTrustline(invalidAddress, async () => {
      loaderCalled = true;
      return horizonAccountFixture([usdcBalanceLine(), NATIVE_BALANCE_LINE]);
    });
    assert.deepEqual(state, { status: "unknown", balance: null });
  }
  assert.equal(loaderCalled, false, "Horizon loader must not be called for invalid account addresses");
});

test("every TrustlineStatus value is produced by at least one fixture", async () => {
  const expectedByStatus: Record<TrustlineStatus, () => Promise<TrustlineStatus>> = {
    ready: async () =>
      (
        await readUsdcTrustline(ACCOUNT_A, async () =>
          horizonAccountFixture([usdcBalanceLine(), NATIVE_BALANCE_LINE]),
        )
      ).status,
    missing: async () =>
      (
        await readUsdcTrustline(ACCOUNT_A, async () =>
          horizonAccountFixture([NATIVE_BALANCE_LINE]),
        )
      ).status,
    unfunded: async () =>
      (
        await readUsdcTrustline(ACCOUNT_A, async () => {
          throw horizonError(404);
        })
      ).status,
    unknown: async () =>
      (
        await readUsdcTrustline(ACCOUNT_A, async () => {
          throw horizonError(502);
        })
      ).status,
  };

  const produced = new Set<TrustlineStatus>();
  for (const [expected, runFixture] of Object.entries(expectedByStatus) as Array<
    [TrustlineStatus, () => Promise<TrustlineStatus>]
  >) {
    const actual = await runFixture();
    assert.equal(actual, expected);
    produced.add(actual);
  }

  assert.deepEqual(
    [...produced].sort(),
    ["missing", "ready", "unfunded", "unknown"],
  );
});

// ── Wallet Rejection vs Unavailable Transport Coverage ───────────────────────

test("isRejection: correctly classifies user cancellation across error shapes", () => {
  assert.equal(isRejection(new Error("User rejected the transaction")), true);
  assert.equal(isRejection(new Error("Transaction was declined by user")), true);
  assert.equal(isRejection(new Error("User closed the modal")), true);
  assert.equal(isRejection(new Error("Request cancelled")), true);
  assert.equal(isRejection(new Error("Signature denied")), true);
  assert.equal(isRejection({ message: "User declined" }), true);
  assert.equal(isRejection({ code: 4001, message: "User rejected request" }), true);
  assert.equal(isRejection(new WalletError("User cancelled", "rejected")), true);
  assert.equal(isRejection("user cancelled signing"), true);

  // Non-rejections must not match
  assert.equal(isRejection(new Error("Connection refused")), false);
  assert.equal(isRejection(new Error("Wallet transport unavailable")), false);
  assert.equal(isRejection(null), false);
  assert.equal(isRejection(undefined), false);
});

test("isTransportUnavailable: correctly identifies unreachable or missing wallet transport", () => {
  assert.equal(isTransportUnavailable(new Error("Wallet transport unavailable")), true);
  assert.equal(isTransportUnavailable(new Error("Freighter extension not found")), true);
  assert.equal(isTransportUnavailable(new Error("Wallet is not installed")), true);
  assert.equal(isTransportUnavailable(new Error("Device disconnected")), true);
  assert.equal(isTransportUnavailable(new Error("Hardware wallet disconnected")), true);
  assert.equal(isTransportUnavailable(new Error("Module not available")), true);
  assert.equal(isTransportUnavailable(new Error("Failed to connect to wallet")), true);
  assert.equal(isTransportUnavailable({ code: -32000, message: "Transport closed" }), true);
  assert.equal(isTransportUnavailable(new WalletError("Not installed", "unavailable")), true);

  // Non-transport errors
  assert.equal(isTransportUnavailable(new Error("Contract simulation reverted")), false);
  assert.equal(isTransportUnavailable(null), false);
});

test("boundary: user rejection takes priority over transport errors if both mentioned", () => {
  // If the user actively rejected during a transport prompt, it is a rejection, not transport failure
  const mixedErr = new Error("User rejected wallet transport connection prompt");
  assert.equal(isRejection(mixedErr), true);
  assert.equal(isTransportUnavailable(mixedErr), false);

  const walletErr = toWalletError(mixedErr, "connect");
  assert.equal(walletErr.code, "rejected");
});

test("toWalletError: shapes distinct WalletError instances with proper codes", () => {
  const rejection = toWalletError(new Error("User cancelled"), "sign");
  assert.equal(rejection instanceof WalletError, true);
  assert.equal(rejection.code, "rejected");
  assert.match(rejection.message, /User cancelled/i);

  const transport = toWalletError(new Error("Wallet transport unavailable"), "connect");
  assert.equal(transport instanceof WalletError, true);
  assert.equal(transport.code, "unavailable");
  assert.match(transport.message, /transport unavailable/i);

  const generic = toWalletError(new Error("Internal timeout"), "transact");
  assert.equal(generic instanceof WalletError, true);
  assert.equal(generic.code, "error");
  assert.match(generic.message, /Internal timeout/i);

  const empty = toWalletError({}, "sign");
  assert.equal(empty.code, "error");
  assert.equal(empty.message, "Could not sign.");
});

test("ensureUsdcTrustline: NEVER retries automatically when user rejects signature", async () => {
  const kp = Keypair.random();
  const publicKey = kp.publicKey();
  const missingFixture = horizonAccountFixture([NATIVE_BALANCE_LINE], publicKey);
  const mockAccount = new Account(publicKey, "12345");

  let signCalls = 0;
  let retryCalls = 0;

  const signer: StellarSigner = {
    publicKey,
    signTransaction: async () => {
      signCalls += 1;
      throw new Error("User declined transaction in wallet extension");
    },
  };

  await assert.rejects(
    async () => {
      await ensureUsdcTrustline(signer, {
        maxRetries: 3,
        onRetry: () => {
          retryCalls += 1;
        },
        loadAccount: async () => missingFixture,
        server: {
          loadAccount: async () => mockAccount as any,
          submitTransaction: async () => ({ hash: "tx_hash_1" }),
        },
      });
    },
    (err: unknown) => {
      assert(err instanceof Error);
      assert.equal(isRejection(err), true);
      assert.equal((err as WalletError).code, "rejected");
      return true;
    },
  );

  // CRITICAL: signTransaction must have been called EXACTLY ONCE, zero retries
  assert.equal(signCalls, 1, "User rejection must never trigger automatic retries");
  assert.equal(retryCalls, 0, "onRetry hook must not be called on user rejection");
});

test("ensureUsdcTrustline: retries transient transport errors and succeeds on recovery", async () => {
  const kp = Keypair.random();
  const publicKey = kp.publicKey();
  const missingFixture = horizonAccountFixture([NATIVE_BALANCE_LINE], publicKey);
  const mockAccount = new Account(publicKey, "12345");

  let signCalls = 0;
  let retryCalls = 0;

  const signer: StellarSigner = {
    publicKey,
    signTransaction: async (xdr) => {
      signCalls += 1;
      if (signCalls === 1) {
        throw new Error("Wallet transport disconnected");
      }
      return { signedTxXdr: xdr, signerAddress: publicKey };
    },
  };

  const result = await ensureUsdcTrustline(signer, {
    maxRetries: 2,
    onRetry: (attempt, err) => {
      retryCalls += 1;
      assert.equal(attempt, 1);
      assert.equal(isTransportUnavailable(err), true);
    },
    loadAccount: async () => missingFixture,
    server: {
      loadAccount: async () => mockAccount as any,
      submitTransaction: async () => ({ hash: "tx_success_recovered" }),
    },
  });

  assert.equal(signCalls, 2, "Should attempt retry on transient transport failure");
  assert.equal(retryCalls, 1, "Should have triggered onRetry hook once");
  assert.deepEqual(result, { added: true, hash: "tx_success_recovered" });
});

test("ensureUsdcTrustline: exhausts retries on persistent transport failure and throws unavailable error", async () => {
  const kp = Keypair.random();
  const publicKey = kp.publicKey();
  const missingFixture = horizonAccountFixture([NATIVE_BALANCE_LINE], publicKey);
  const mockAccount = new Account(publicKey, "12345");

  let signCalls = 0;
  let retryCalls = 0;

  const signer: StellarSigner = {
    publicKey,
    signTransaction: async () => {
      signCalls += 1;
      throw new Error("Wallet extension not found");
    },
  };

  await assert.rejects(
    async () => {
      await ensureUsdcTrustline(signer, {
        maxRetries: 2,
        onRetry: () => {
          retryCalls += 1;
        },
        loadAccount: async () => missingFixture,
        server: {
          loadAccount: async () => mockAccount as any,
          submitTransaction: async () => ({ hash: "never" }),
        },
      });
    },
    (err: unknown) => {
      assert(err instanceof Error);
      assert.equal(isTransportUnavailable(err), true);
      assert.equal((err as WalletError).code, "unavailable");
      return true;
    },
  );

  assert.equal(signCalls, 3, "Initial attempt plus 2 retries");
  assert.equal(retryCalls, 2, "2 retries before giving up");
});

test("evaluateUsdcTrustlineGate: distinguishes user rejection from unavailable transport", () => {
  const rejectedGate = evaluateUsdcTrustlineGate(
    usdcTrustlineGateFixture({ failureKind: "rejected" }),
  );
  assert.equal(rejectedGate.allowed, false);
  assert.equal(rejectedGate.status, "rejected");
  assert.equal(rejectedGate.messageKey, "trustlineRejected");

  const transportGate = evaluateUsdcTrustlineGate(
    usdcTrustlineGateFixture({ failureKind: "transport_unavailable" }),
  );
  assert.equal(transportGate.allowed, false);
  assert.equal(transportGate.status, "transport_unavailable");
  assert.equal(transportGate.messageKey, "trustlineTransportUnavailable");
});

test("wallet-aria: distinguishes rejected from transport_unavailable action states", () => {
  const rejectedBtn = actionLabel("add_trustline", "rejected");
  assert.equal(rejectedBtn, "Trustline signature rejected in wallet");

  const transportBtn = actionLabel("add_trustline", "transport_unavailable");
  assert.equal(transportBtn, "USDC trustline setup — wallet transport unavailable");

  const rejectedDesc = statusDescription("add_trustline", "rejected");
  assert.equal(rejectedDesc, "The transaction was rejected in your wallet. You can try again.");

  const transportDesc = statusDescription("add_trustline", "transport_unavailable");
  assert.equal(
    transportDesc,
    "Wallet transport is unavailable. Make sure your wallet extension is installed, active, and connected.",
  );
});
