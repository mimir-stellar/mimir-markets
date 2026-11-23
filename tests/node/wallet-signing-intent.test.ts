/**
 * Focused automated test coverage for wallet signing intent generation and
 * obsolete result rejection (Issue: Ignore a late wallet result belonging to an
 * obsolete signing intent).
 *
 * Verifies that:
 * 1. Signing responses are strictly bound to the active intent generation.
 * 2. Late wallet results belonging to superseded intents are ignored and rejected.
 * 3. Account switches prevent stale signing results from applying to the new wallet.
 * 4. Trustline additions via `ensureUsdcTrustline` abort submission if the intent
 *    generation is obsolete or the account has switched.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Account, Keypair } from "@stellar/stellar-sdk";

import type { StellarSigner } from "../../lib/stellar";
import {
  ensureUsdcTrustline,
  type HorizonAccount,
  type HorizonBalanceLine,
} from "../../lib/stellar-trustline";
import {
  assertActiveIntent,
  bindIntentToSigner,
  isIntentActive,
  isObsoleteSigningIntentError,
  ObsoleteSigningIntentError,
  type SigningIntent,
} from "../../lib/wallet";

const ACCOUNT_A = "GBO43ZBS4RBC2QFDKB23U6TBFEEK47ZLGSXDJSRV2H3PNQK5ZDEYXVLE";
const ACCOUNT_B = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

const NATIVE_LINE: HorizonBalanceLine = {
  balance: "100.0000000",
  buying_liabilities: "0.0000000",
  selling_liabilities: "0.0000000",
  asset_type: "native",
};

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

// ── Pure Intent Logic ─────────────────────────────────────────────────────────

test("isIntentActive: returns true only when both generation and address match", () => {
  const intent: SigningIntent = { generation: 1, address: ACCOUNT_A };

  assert.equal(isIntentActive(intent, { generation: 1, address: ACCOUNT_A }), true);
  assert.equal(isIntentActive(intent, { generation: 2, address: ACCOUNT_A }), false);
  assert.equal(isIntentActive(intent, { generation: 1, address: ACCOUNT_B }), false);
  assert.equal(isIntentActive(intent, { generation: 1, address: null }), false);
});

test("assertActiveIntent: throws ObsoleteSigningIntentError with accurate metadata on mismatch", () => {
  const intent: SigningIntent = { generation: 3, address: ACCOUNT_A };

  assert.doesNotThrow(() => {
    assertActiveIntent(intent, { generation: 3, address: ACCOUNT_A });
  });

  // Obsolete generation
  assert.throws(
    () => {
      assertActiveIntent(intent, { generation: 4, address: ACCOUNT_A });
    },
    (err: unknown) => {
      assert(err instanceof ObsoleteSigningIntentError);
      assert.equal(err.generation, 3);
      assert.equal(err.activeGeneration, 4);
      assert.equal(err.expectedAddress, ACCOUNT_A);
      assert.equal(err.currentAddress, ACCOUNT_A);
      assert.match(err.message, /generation 3 is obsolete/);
      return true;
    },
  );

  // Switched account
  assert.throws(
    () => {
      assertActiveIntent(intent, { generation: 4, address: ACCOUNT_B });
    },
    (err: unknown) => {
      assert(err instanceof ObsoleteSigningIntentError);
      assert.equal(err.expectedAddress, ACCOUNT_A);
      assert.equal(err.currentAddress, ACCOUNT_B);
      assert.match(err.message, /account switched from/);
      return true;
    },
  );
});

test("isObsoleteSigningIntentError: recognizes error instances and error message patterns", () => {
  const typedErr = new ObsoleteSigningIntentError({
    generation: 1,
    activeGeneration: 2,
    expectedAddress: ACCOUNT_A,
    currentAddress: ACCOUNT_B,
  });
  assert.equal(isObsoleteSigningIntentError(typedErr), true);

  const plainErr = new Error("Wallet signing result ignored: signing intent is obsolete.");
  assert.equal(isObsoleteSigningIntentError(plainErr), true);

  const unrelatedErr = new Error("User rejected the transaction");
  assert.equal(isObsoleteSigningIntentError(unrelatedErr), false);
  assert.equal(isObsoleteSigningIntentError("some string"), false);
  assert.equal(isObsoleteSigningIntentError(null), false);
});

// ── bindIntentToSigner ────────────────────────────────────────────────────────

test("bindIntentToSigner: signs successfully when active generation and address remain unchanged", async () => {
  let activeState = { generation: 1, address: ACCOUNT_A as string | null };
  const mockSigner: StellarSigner = {
    publicKey: ACCOUNT_A,
    signTransaction: async (xdr) => ({
      signedTxXdr: `signed:${xdr}`,
      signerAddress: ACCOUNT_A,
    }),
  };

  const bound = bindIntentToSigner(
    mockSigner,
    { generation: 1, address: ACCOUNT_A },
    () => activeState,
  );

  const result = await bound.signTransaction("dummy_xdr");
  assert.deepEqual(result, {
    signedTxXdr: "signed:dummy_xdr",
    signerAddress: ACCOUNT_A,
  });
});

test("bindIntentToSigner: ignores late result when intent generation advances during signing", async () => {
  let activeState = { generation: 1, address: ACCOUNT_A as string | null };

  const delayedSigner: StellarSigner = {
    publicKey: ACCOUNT_A,
    signTransaction: async (xdr) => {
      // Simulate intent generation incrementing (superseding intent) while awaiting wallet
      activeState = { generation: 2, address: ACCOUNT_A };
      return { signedTxXdr: `late_signed:${xdr}`, signerAddress: ACCOUNT_A };
    },
  };

  const bound = bindIntentToSigner(
    delayedSigner,
    { generation: 1, address: ACCOUNT_A },
    () => activeState,
  );

  await assert.rejects(
    async () => {
      await bound.signTransaction("tx_xdr_payload");
    },
    (err: unknown) => {
      assert(isObsoleteSigningIntentError(err));
      const obsolete = err as ObsoleteSigningIntentError;
      assert.equal(obsolete.generation, 1);
      assert.equal(obsolete.activeGeneration, 2);
      return true;
    },
  );
});

test("bindIntentToSigner: prevents account switch from applying a stale result to new wallet", async () => {
  let activeState = { generation: 1, address: ACCOUNT_A as string | null };

  const delayedSigner: StellarSigner = {
    publicKey: ACCOUNT_A,
    signTransaction: async (xdr) => {
      // Simulate account switch to ACCOUNT_B while wallet extension was open
      activeState = { generation: 2, address: ACCOUNT_B };
      return { signedTxXdr: `late_signed_A:${xdr}`, signerAddress: ACCOUNT_A };
    },
  };

  const bound = bindIntentToSigner(
    delayedSigner,
    { generation: 1, address: ACCOUNT_A },
    () => activeState,
  );

  await assert.rejects(
    async () => {
      await bound.signTransaction("account_a_tx");
    },
    (err: unknown) => {
      assert(isObsoleteSigningIntentError(err));
      const obsolete = err as ObsoleteSigningIntentError;
      assert.equal(obsolete.expectedAddress, ACCOUNT_A);
      assert.equal(obsolete.currentAddress, ACCOUNT_B);
      assert.match(obsolete.message, /account switched/);
      return true;
    },
  );
});

test("bindIntentToSigner: ignores late result when wallet disconnects during signing", async () => {
  let activeState = { generation: 1, address: ACCOUNT_A as string | null };

  const delayedSigner: StellarSigner = {
    publicKey: ACCOUNT_A,
    signTransaction: async (xdr) => {
      // Simulate wallet disconnect while awaiting approval
      activeState = { generation: 2, address: null };
      return { signedTxXdr: `late_signed_disconnected:${xdr}`, signerAddress: ACCOUNT_A };
    },
  };

  const bound = bindIntentToSigner(
    delayedSigner,
    { generation: 1, address: ACCOUNT_A },
    () => activeState,
  );

  await assert.rejects(
    async () => {
      await bound.signTransaction("disconnected_tx");
    },
    (err: unknown) => {
      assert(isObsoleteSigningIntentError(err));
      const obsolete = err as ObsoleteSigningIntentError;
      assert.equal(obsolete.currentAddress, null);
      assert.match(obsolete.message, /disconnected/);
      return true;
    },
  );
});

test("bindIntentToSigner: auth entry signing also enforces intent generation", async () => {
  let activeState = { generation: 1, address: ACCOUNT_A as string | null };

  const authSigner: StellarSigner = {
    publicKey: ACCOUNT_A,
    signTransaction: async () => ({ signedTxXdr: "tx", signerAddress: ACCOUNT_A }),
    signAuthEntry: async (entry) => {
      activeState = { generation: 2, address: ACCOUNT_B };
      return { signedAuthEntry: `signed:${entry}`, signerAddress: ACCOUNT_A };
    },
  };

  const bound = bindIntentToSigner(
    authSigner,
    { generation: 1, address: ACCOUNT_A },
    () => activeState,
  );

  assert.equal(typeof bound.signAuthEntry, "function");
  await assert.rejects(
    async () => {
      await bound.signAuthEntry!("auth_entry_xdr");
    },
    (err: unknown) => {
      assert(isObsoleteSigningIntentError(err));
      return true;
    },
  );
});

// ── ensureUsdcTrustline ───────────────────────────────────────────────────────

test("ensureUsdcTrustline: signs and submits changeTrust when intent remains active", async () => {
  const kp = Keypair.random();
  const publicKey = kp.publicKey();
  const accountFixture = horizonAccountFixture([NATIVE_LINE], publicKey);
  const mockHorizonAccount = new Account(publicKey, "12345");

  let submittedTx: unknown = null;
  const signer: StellarSigner = {
    publicKey,
    signTransaction: async (xdr) => ({
      signedTxXdr: xdr,
      signerAddress: publicKey,
    }),
  };

  const result = await ensureUsdcTrustline(signer, {
    loadAccount: async () => accountFixture,
    server: {
      loadAccount: async () => mockHorizonAccount as any,
      submitTransaction: async (tx) => {
        submittedTx = tx;
        return { hash: "tx_hash_success_001" };
      },
    },
    intentGeneration: 1,
    getActiveIntentGeneration: () => 1,
    getActiveAddress: () => publicKey,
  });

  assert.notEqual(submittedTx, null);
  assert.deepEqual(result, { added: true, hash: "tx_hash_success_001" });
});

test("ensureUsdcTrustline: ignores late wallet result and does NOT submit when generation increments", async () => {
  const kp = Keypair.random();
  const publicKey = kp.publicKey();
  const accountFixture = horizonAccountFixture([NATIVE_LINE], publicKey);
  const mockHorizonAccount = new Account(publicKey, "12345");

  let currentGeneration = 1;
  let submitCalled = false;

  const signer: StellarSigner = {
    publicKey,
    signTransaction: async (xdr) => {
      // Simulate intent bump while wallet was open
      currentGeneration = 2;
      return {
        signedTxXdr: xdr,
        signerAddress: publicKey,
      };
    },
  };

  await assert.rejects(
    async () => {
      await ensureUsdcTrustline(signer, {
        loadAccount: async () => accountFixture,
        server: {
          loadAccount: async () => mockHorizonAccount as any,
          submitTransaction: async () => {
            submitCalled = true;
            return { hash: "should_not_be_called" };
          },
        },
        intentGeneration: 1,
        getActiveIntentGeneration: () => currentGeneration,
        getActiveAddress: () => publicKey,
      });
    },
    (err: unknown) => {
      assert(isObsoleteSigningIntentError(err));
      assert.equal((err as ObsoleteSigningIntentError).generation, 1);
      assert.equal((err as ObsoleteSigningIntentError).activeGeneration, 2);
      return true;
    },
  );

  // Submitter must NOT have been called with the stale transaction
  assert.equal(submitCalled, false, "Stale trustline transaction must not be submitted to Horizon");
});

test("ensureUsdcTrustline: ignores late wallet result and does NOT submit when account switches", async () => {
  const kpA = Keypair.random();
  const kpB = Keypair.random();
  const publicKeyA = kpA.publicKey();
  const publicKeyB = kpB.publicKey();
  const accountFixture = horizonAccountFixture([NATIVE_LINE], publicKeyA);
  const mockHorizonAccount = new Account(publicKeyA, "12345");

  let currentAddress: string | null = publicKeyA;
  let submitCalled = false;

  const signer: StellarSigner = {
    publicKey: publicKeyA,
    signTransaction: async (xdr) => {
      // User switched to account B in extension while waiting
      currentAddress = publicKeyB;
      return {
        signedTxXdr: xdr,
        signerAddress: publicKeyA,
      };
    },
  };

  await assert.rejects(
    async () => {
      await ensureUsdcTrustline(signer, {
        loadAccount: async () => accountFixture,
        server: {
          loadAccount: async () => mockHorizonAccount as any,
          submitTransaction: async () => {
            submitCalled = true;
            return { hash: "should_not_be_called" };
          },
        },
        intentGeneration: 1,
        getActiveIntentGeneration: () => 1,
        getActiveAddress: () => currentAddress,
      });
    },
    (err: unknown) => {
      assert(isObsoleteSigningIntentError(err));
      const obsolete = err as ObsoleteSigningIntentError;
      assert.equal(obsolete.expectedAddress, publicKeyA);
      assert.equal(obsolete.currentAddress, publicKeyB);
      assert.match(obsolete.message, /account switched/);
      return true;
    },
  );

  assert.equal(submitCalled, false, "Stale result from previous account must not be submitted for new wallet");
});

test("ensureUsdcTrustline: aborts before signing if active account already switched", async () => {
  const kpA = Keypair.random();
  const kpB = Keypair.random();
  let signCalled = false;

  const signer: StellarSigner = {
    publicKey: kpA.publicKey(),
    signTransaction: async () => {
      signCalled = true;
      return { signedTxXdr: "", signerAddress: kpA.publicKey() };
    },
  };

  await assert.rejects(
    async () => {
      await ensureUsdcTrustline(signer, {
        intentGeneration: 1,
        getActiveIntentGeneration: () => 1,
        getActiveAddress: () => kpB.publicKey(),
      });
    },
    (err: unknown) => {
      assert(isObsoleteSigningIntentError(err));
      assert.match((err as Error).message, /aborted.*account switched before signing/);
      return true;
    },
  );

  assert.equal(signCalled, false, "Signer must not be prompted if account already switched");
});
