/**
 * Deterministic unit coverage for `readUsdcTrustline` in `lib/stellar-trustline.ts`.
 *
 * Pins how Horizon `/accounts/{id}` JSON responses and transport errors map onto
 * `TrustlineState` (`ready`, `missing`, `unfunded`, `unknown`) without touching
 * the network.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Account, Keypair, StrKey } from "@stellar/stellar-sdk";

import {
  ensureUsdcTrustline,
  formatTrustlineError,
  readUsdcTrustline,
  sanitizeTrustlineDiagnostic,
  USDC_TRUSTLINE_DESCRIPTOR,
  type HorizonAccount,
  type HorizonBalanceLine,
  type TrustlineStatus,
} from "../../lib/stellar-trustline";
import { type StellarSigner } from "../../lib/stellar";
import { USDC_CODE, USDC_ISSUER } from "../../lib/usdc";
import { evaluateUsdcTrustlineGate, usdcTrustlineGateFixture } from "../../lib/usdcTrustlineGate";
import { sanitizeWalletMessage, toWalletError } from "../../lib/wallet";

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

// ── Asset Identification and Seed Redaction Coverage ─────────────────────────

test("USDC_TRUSTLINE_DESCRIPTOR exports safe asset code and issuer metadata", () => {
  assert.equal(USDC_TRUSTLINE_DESCRIPTOR.code, USDC_CODE);
  assert.equal(USDC_TRUSTLINE_DESCRIPTOR.issuer, USDC_ISSUER);
  assert.equal(USDC_TRUSTLINE_DESCRIPTOR.code, "USDC");
  assert.equal(
    USDC_TRUSTLINE_DESCRIPTOR.issuer,
    "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  );
});

test("sanitizeTrustlineDiagnostic: redacts secret seeds and sensitive tokens without altering public keys", () => {
  const kp = Keypair.random();
  const secretSeed = kp.secret();
  const publicKey = kp.publicKey();

  // Plain seed redaction
  const leak1 = `connector error at seed ${secretSeed}`;
  const clean1 = sanitizeTrustlineDiagnostic(leak1);
  assert.equal(clean1.includes(secretSeed), false);
  assert.equal(clean1, "connector error at seed [redacted-seed]");

  // Seed with secret= key pattern
  const leak2 = `failed submission secret=${secretSeed}`;
  const clean2 = sanitizeTrustlineDiagnostic(leak2);
  assert.equal(clean2.includes(secretSeed), false);
  assert.equal(clean2, "failed submission secret=[redacted-seed]");

  // Lowercase secret seed redaction
  const leak3 = `leaked lowercase: ${secretSeed.toLowerCase()}`;
  const clean3 = sanitizeTrustlineDiagnostic(leak3);
  assert.equal(clean3.includes(secretSeed.toLowerCase()), false);
  assert.equal(clean3, "leaked lowercase: [redacted-seed]");

  // Sensitive auth / token redactions
  const leak4 = "api_key=secret-xyz bearer=token-abc";
  const clean4 = sanitizeTrustlineDiagnostic(leak4);
  assert.equal(clean4, "api_key=[redacted] bearer=[redacted]");

  // Boundary check: Public key, contract address, and official USDC issuer must NEVER be redacted
  const safeMessage = `Asset USDC with issuer ${USDC_ISSUER} for account ${publicKey} and contract ${CONTRACT_A}`;
  const safeClean = sanitizeTrustlineDiagnostic(safeMessage);
  assert.equal(safeClean, safeMessage);
  assert.equal(safeClean.includes(USDC_ISSUER), true);
  assert.equal(safeClean.includes(publicKey), true);
});

test("formatTrustlineError: identifies asset metadata and omits private connector payloads", () => {
  // Generic error gets asset identification
  const genericErr = formatTrustlineError(new Error("network timeout"));
  assert.equal(genericErr.message.includes(USDC_CODE), true);
  assert.equal(genericErr.message.includes(USDC_ISSUER), true);
  assert.equal(genericErr.message.includes("network timeout"), true);

  // Private connector payloads (ext, payload, data) are strictly excluded
  const connectorErrObj = {
    code: -32603,
    message: "Hardware wallet prompt failed",
    ext: { privatePayload: "sensitive_transport_dump", internalSignature: 99 },
    payload: { seedLeak: "private_data" },
  };
  const formattedConnectorErr = formatTrustlineError(connectorErrObj);
  assert.equal(formattedConnectorErr.message.includes(USDC_CODE), true);
  assert.equal(formattedConnectorErr.message.includes(USDC_ISSUER), true);
  assert.equal(formattedConnectorErr.message.includes("Hardware wallet prompt failed"), true);
  assert.equal(formattedConnectorErr.message.includes("sensitive_transport_dump"), false);
  assert.equal(formattedConnectorErr.message.includes("privatePayload"), false);
  assert.equal(formattedConnectorErr.message.includes("seedLeak"), false);

  // Secret seed inside cause message is redacted
  const kp = Keypair.random();
  const seedInCause = formatTrustlineError(new Error(`Failed with seed ${kp.secret()}`));
  assert.equal(seedInCause.message.includes(kp.secret()), false);
  assert.equal(seedInCause.message.includes("[redacted-seed]"), true);
  assert.equal(seedInCause.message.includes(USDC_CODE), true);
  assert.equal(seedInCause.message.includes(USDC_ISSUER), true);

  // Error already identifying asset and issuer is preserved
  const preformatted = new Error(`Already identified: ${USDC_CODE} trustline for ${USDC_ISSUER}`);
  assert.equal(formatTrustlineError(preformatted).message, preformatted.message);
});

test("ensureUsdcTrustline: unfunded error identifies the asset and safe issuer", async () => {
  const kp = Keypair.random();
  const signer: StellarSigner = {
    publicKey: kp.publicKey(),
    signTransaction: async (xdr) => ({ signedTxXdr: xdr, signerAddress: kp.publicKey() }),
  };

  await assert.rejects(
    async () => {
      await ensureUsdcTrustline(signer, {
        loadAccount: async () => {
          throw horizonError(404, "Not Found");
        },
      });
    },
    (err: unknown) => {
      assert(err instanceof Error);
      const error = err as Error;
      assert.equal(error.message.includes(USDC_CODE), true);
      assert.equal(error.message.includes(USDC_ISSUER), true);
      assert.match(error.message, /does not exist on the Stellar ledger yet/);
      assert.match(error.message, /Fund it with XLM first/);
      // Compatible with UsdcTrustlineGate regex: /fund|account.*exist|not exist/i
      assert.equal(/fund|account.*exist|not exist/i.test(error.message), true);
      return true;
    },
  );
});

test("ensureUsdcTrustline: rejects secret seed as signer.publicKey without exposing seed", async () => {
  const kp = Keypair.random();
  const secretSeed = kp.secret();

  const badSigner: StellarSigner = {
    publicKey: secretSeed,
    signTransaction: async (xdr) => ({ signedTxXdr: xdr, signerAddress: secretSeed }),
  };

  await assert.rejects(
    async () => {
      await ensureUsdcTrustline(badSigner);
    },
    (err: unknown) => {
      assert(err instanceof Error);
      const error = err as Error;
      // Asset and issuer are identified
      assert.equal(error.message.includes(USDC_CODE), true);
      assert.equal(error.message.includes(USDC_ISSUER), true);
      // The secret seed MUST NOT be exposed in the error message
      assert.equal(error.message.includes(secretSeed), false);
      assert.match(error.message, /secret seed must not be used as public key/i);
      return true;
    },
  );
});

test("ensureUsdcTrustline: wraps connector signing failures, redacting seeds and omitting private payloads", async () => {
  const kp = Keypair.random();
  const secretSeed = kp.secret();
  const publicKey = kp.publicKey();
  const mockAccount = new Account(publicKey, "100");

  const signer: StellarSigner = {
    publicKey,
    signTransaction: async () => {
      // Simulate kit error with private connector payloads and leaked seed
      throw {
        code: -32603,
        message: `Connector failed to sign with seed ${secretSeed}`,
        ext: { privatePayload: "ext_private_connector_state" },
        payload: { secretConnectorField: true },
      };
    },
  };

  await assert.rejects(
    async () => {
      await ensureUsdcTrustline(signer, {
        loadAccount: async () => horizonAccountFixture([NATIVE_BALANCE_LINE], publicKey),
        server: {
          loadAccount: async () => mockAccount as any,
          submitTransaction: async () => ({ hash: "tx_ok" }),
        },
      });
    },
    (err: unknown) => {
      assert(err instanceof Error);
      const error = err as Error;
      // Asset and issuer are identified
      assert.equal(error.message.includes(USDC_CODE), true);
      assert.equal(error.message.includes(USDC_ISSUER), true);
      // Secret seed is redacted
      assert.equal(error.message.includes(secretSeed), false);
      assert.equal(error.message.includes("[redacted-seed]"), true);
      // Private connector payload is omitted
      assert.equal(error.message.includes("ext_private_connector_state"), false);
      assert.equal(error.message.includes("secretConnectorField"), false);
      return true;
    },
  );
});

test("ensureUsdcTrustline: preserves user rejection keywords for UI gating compatibility", async () => {
  const kp = Keypair.random();
  const publicKey = kp.publicKey();
  const mockAccount = new Account(publicKey, "100");

  const signer: StellarSigner = {
    publicKey,
    signTransaction: async () => {
      throw new Error("User rejected the transaction in wallet modal");
    },
  };

  await assert.rejects(
    async () => {
      await ensureUsdcTrustline(signer, {
        loadAccount: async () => horizonAccountFixture([NATIVE_BALANCE_LINE], publicKey),
        server: {
          loadAccount: async () => mockAccount as any,
          submitTransaction: async () => ({ hash: "tx_ok" }),
        },
      });
    },
    (err: unknown) => {
      assert(err instanceof Error);
      const error = err as Error;
      assert.equal(error.message.includes(USDC_CODE), true);
      assert.equal(error.message.includes(USDC_ISSUER), true);
      // Rejection keyword preserved for UI regex
      assert.equal(/reject|denied|cancel/i.test(error.message), true);
      return true;
    },
  );
});

test("toWalletError and sanitizeWalletMessage: keep private connector payloads out and redact seeds", () => {
  const kp = Keypair.random();
  const secretSeed = kp.secret();

  const kitError = {
    code: -32603,
    message: `Sign failed with seed ${secretSeed}`,
    ext: { privatePayload: "sensitive_connector_token_payload" },
    payload: { internalKey: "abc123secret" },
  };

  const walletErr = toWalletError(kitError, "sign transaction");
  assert.equal(walletErr.message.includes(secretSeed), false);
  assert.equal(walletErr.message.includes("[redacted-seed]"), true);
  assert.equal(walletErr.message.includes("sensitive_connector_token_payload"), false);
  assert.equal(walletErr.message.includes("internalKey"), false);

  const sanitized = sanitizeWalletMessage(`secret_seed: ${secretSeed} for issuer ${USDC_ISSUER}`);
  assert.equal(sanitized.includes(secretSeed), false);
  assert.equal(sanitized.includes("[redacted-seed]"), true);
  assert.equal(sanitized.includes(USDC_ISSUER), true);
});
