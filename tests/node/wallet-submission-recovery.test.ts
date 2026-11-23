/**
 * Focused automated coverage for uncertain-submission recovery in wallet flows
 * (`lib/wallet-submission-recovery.ts`, `lib/stellar-trustline.ts`).
 *
 * Uses synthetic Stellar keypairs, fake Horizon transports, and deterministic
 * reconciliation probes with zero network calls.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Account, Keypair, TransactionBuilder, type Horizon } from "@stellar/stellar-sdk";

import { NETWORK_PASSPHRASE, type StellarSigner } from "../../lib/stellar";
import {
  ensureUsdcTrustline,
  UncertainTrustlineSubmissionError,
  type HorizonTrustlineServer,
} from "../../lib/stellar-trustline";
import {
  canResubmitPayment,
  createUncertainSubmission,
  DEFAULT_MAX_RECONCILIATION_ATTEMPTS,
  isUncertainSubmissionError,
  MAX_RECONCILIATION_ATTEMPTS,
  MIN_RECONCILIATION_ATTEMPTS,
  reconcileUncertainSubmission,
} from "../../lib/wallet-submission-recovery";

const SAMPLE_HASH = "a1b2c3d4".repeat(8);

function httpError(status: number, message = `HTTP ${status}`): Error & {
  response: { status: number };
} {
  return Object.assign(new Error(message), { response: { status } });
}

test("createUncertainSubmission exposes normalized hash and blocks resubmission", () => {
  const state = createUncertainSubmission({
    hash: `  ${SAMPLE_HASH.toUpperCase()}  `,
    action: "stake",
    now: 1_700_000_000_000,
  });

  assert.equal(state.hash, SAMPLE_HASH);
  assert.equal(state.action, "stake");
  assert.equal(state.status, "uncertain");
  assert.equal(state.canResubmit, false);
  assert.equal(canResubmitPayment(state), false);
  assert.equal(state.attempts, 0);
  assert.equal(state.maxAttempts, DEFAULT_MAX_RECONCILIATION_ATTEMPTS);
  assert.equal(state.reconciliationExhausted, false);
  assert.equal(state.recordedAt, 1_700_000_000_000);
  assert.match(state.guidance, new RegExp(SAMPLE_HASH));
  assert.match(state.guidance, /do not resubmit/i);
});

test("boundary: invalid hash is rejected and maxAttempts is clamped", () => {
  assert.throws(
    () => createUncertainSubmission({ hash: "not-a-valid-hash" }),
    /Invalid Stellar transaction hash/,
  );

  const tooLow = createUncertainSubmission({ hash: SAMPLE_HASH, maxAttempts: 0 });
  const tooHigh = createUncertainSubmission({ hash: SAMPLE_HASH, maxAttempts: 999 });

  assert.equal(tooLow.maxAttempts, MIN_RECONCILIATION_ATTEMPTS);
  assert.equal(tooHigh.maxAttempts, MAX_RECONCILIATION_ATTEMPTS);
});

test("reconcileUncertainSubmission transitions pending -> confirmed without allowing resubmission", async () => {
  const initial = createUncertainSubmission({ hash: SAMPLE_HASH, action: "payment", maxAttempts: 3 });
  let probeCalls = 0;

  const afterPending = await reconcileUncertainSubmission(initial, {
    checkTransaction: async (hash) => {
      probeCalls += 1;
      assert.equal(hash, SAMPLE_HASH);
      return "pending";
    },
  });

  assert.equal(probeCalls, 1);
  assert.equal(afterPending.status, "uncertain");
  assert.equal(afterPending.attempts, 1);
  assert.equal(afterPending.canResubmit, false);
  assert.equal(canResubmitPayment(afterPending), false);
  assert.equal(afterPending.reconciliationExhausted, false);

  const afterConfirmed = await reconcileUncertainSubmission(afterPending, {
    checkTransaction: async () => {
      probeCalls += 1;
      return "succeeded";
    },
  });

  assert.equal(probeCalls, 2);
  assert.equal(afterConfirmed.status, "confirmed");
  assert.equal(afterConfirmed.attempts, 2);
  assert.equal(afterConfirmed.canResubmit, false);
  assert.equal(canResubmitPayment(afterConfirmed), false);

  // Terminal state: further reconciliation calls do not invoke the probe again.
  const repeated = await reconcileUncertainSubmission(afterConfirmed, {
    checkTransaction: async () => {
      probeCalls += 1;
      return "failed";
    },
  });
  assert.equal(probeCalls, 2);
  assert.equal(repeated.status, "confirmed");
});

test("reconcileUncertainSubmission unlocks resubmission only after definitive on-chain failure", async () => {
  const initial = createUncertainSubmission({ hash: SAMPLE_HASH, action: "payment", maxAttempts: 2 });

  const failed = await reconcileUncertainSubmission(initial, {
    checkTransaction: async () => "failed",
  });

  assert.equal(failed.status, "failed");
  assert.equal(failed.canResubmit, true);
  assert.equal(canResubmitPayment(failed), true);
  assert.equal(failed.attempts, 1);
  assert.match(failed.guidance, /safely try again/i);
});

test("boundary: reconciliation stops at maxAttempts and still blocks resubmission", async () => {
  let state = createUncertainSubmission({ hash: SAMPLE_HASH, action: "payment", maxAttempts: 2 });
  let probeCalls = 0;

  for (let i = 0; i < 4; i += 1) {
    state = await reconcileUncertainSubmission(state, {
      checkTransaction: async () => {
        probeCalls += 1;
        return "pending";
      },
    });
  }

  assert.equal(probeCalls, 2, "reconciliation probe must not exceed maxAttempts");
  assert.equal(state.attempts, 2);
  assert.equal(state.status, "uncertain");
  assert.equal(state.reconciliationExhausted, true);
  assert.equal(state.canResubmit, false);
  assert.equal(canResubmitPayment(state), false);
  assert.match(state.guidance, /do not resubmit/i);
});

test("failure case: transport error or timeout during reconciliation keeps state uncertain and blocks resubmission", async () => {
  const initial = createUncertainSubmission({ hash: SAMPLE_HASH, action: "payment", maxAttempts: 2 });

  const afterError = await reconcileUncertainSubmission(initial, {
    checkTransaction: async () => {
      throw new Error("ECONNRESET");
    },
  });

  assert.equal(afterError.status, "uncertain");
  assert.equal(afterError.canResubmit, false);
  assert.equal(afterError.attempts, 1);
  assert.equal(afterError.lastError, "ECONNRESET");

  const afterTimeout = await reconcileUncertainSubmission(afterError, {
    timeoutMs: 15,
    checkTransaction: () => new Promise(() => {}),
  });

  assert.equal(afterTimeout.status, "uncertain");
  assert.equal(afterTimeout.canResubmit, false);
  assert.equal(afterTimeout.attempts, 2);
  assert.equal(afterTimeout.reconciliationExhausted, true);
  assert.match(afterTimeout.lastError ?? "", /timed out/i);
});

test("isUncertainSubmissionError distinguishes transport/timeout failures from definitive rejections", () => {
  assert.equal(isUncertainSubmissionError(httpError(504, "Gateway Timeout")), true);
  assert.equal(isUncertainSubmissionError(httpError(503, "Service Unavailable")), true);
  assert.equal(isUncertainSubmissionError(httpError(408, "Request Timeout")), true);
  assert.equal(isUncertainSubmissionError(new Error("fetch failed: ECONNRESET")), true);

  assert.equal(isUncertainSubmissionError(httpError(400, "tx_failed")), false);
  assert.equal(isUncertainSubmissionError(new Error("User declined access")), false);
  assert.equal(isUncertainSubmissionError(new Error("tx_bad_seq")), false);
});

test("ensureUsdcTrustline exposes deterministic hash in UncertainTrustlineSubmissionError on Horizon timeout", async () => {
  const keypair = Keypair.random();
  const publicKey = keypair.publicKey();
  const syntheticAccount = new Account(publicKey, "100") as unknown as Horizon.AccountResponse;
  let signedHash = "";

  const signer: StellarSigner = {
    publicKey,
    signTransaction: async (xdr) => {
      const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
      tx.sign(keypair);
      signedHash = tx.hash().toString("hex");
      return { signedTxXdr: tx.toXDR(), signerAddress: publicKey };
    },
  };

  const server: HorizonTrustlineServer = {
    loadAccount: async () => syntheticAccount,
    submitTransaction: async () => {
      throw httpError(504, "Gateway Timeout");
    },
  };

  let caught: unknown;
  try {
    await ensureUsdcTrustline(signer, {
      server,
      readTrustline: async () => ({ status: "missing", balance: null }),
    });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught instanceof UncertainTrustlineSubmissionError);
  assert.equal(caught.hash, signedHash);
  assert.equal(caught.status, "uncertain-submission");
  assert.equal(caught.canResubmit, false);

  // Feed the recovered hash into bounded reconciliation.
  const recovery = createUncertainSubmission({ hash: caught.hash, action: "USDC trustline" });
  assert.equal(canResubmitPayment(recovery), false);
  const reconciled = await reconcileUncertainSubmission(recovery, {
    checkTransaction: async (hash) => {
      assert.equal(hash, signedHash);
      return "succeeded";
    },
  });
  assert.equal(reconciled.status, "confirmed");
  assert.equal(reconciled.canResubmit, false);
});

test("ensureUsdcTrustline rethrows definitive Horizon 400 rejections without wrapping as uncertain", async () => {
  const keypair = Keypair.random();
  const publicKey = keypair.publicKey();
  const syntheticAccount = new Account(publicKey, "100") as unknown as Horizon.AccountResponse;
  const definitiveError = httpError(400, "tx_failed");

  const signer: StellarSigner = {
    publicKey,
    signTransaction: async (xdr) => {
      const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
      tx.sign(keypair);
      return { signedTxXdr: tx.toXDR(), signerAddress: publicKey };
    },
  };

  const server: HorizonTrustlineServer = {
    loadAccount: async () => syntheticAccount,
    submitTransaction: async () => {
      throw definitiveError;
    },
  };

  await assert.rejects(
    () =>
      ensureUsdcTrustline(signer, {
        server,
        readTrustline: async () => ({ status: "missing", balance: null }),
      }),
    (err: unknown) => err === definitiveError && !(err instanceof UncertainTrustlineSubmissionError),
  );
});
