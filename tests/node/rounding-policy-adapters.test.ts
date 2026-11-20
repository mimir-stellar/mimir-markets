import assert from "node:assert/strict";
import test from "node:test";
import { StrKey } from "@stellar/stellar-sdk";
import { AssembledTransaction, Ok, type AssembledTransactionOptions } from "@stellar/stellar-sdk/contract";

import { claimChallengerPayoutVersioned, quoteChallengerPayoutVersioned } from "../../lib/contract";
import { UnsupportedRoundingPolicyVersion } from "../../lib/rounding-policy";
import { MimirMarket } from "../../sdk/contracts";
import { StellarTransactionError } from "../../lib/settlement-retry";
import fixtures from "../../fixtures/payout-rounding/v1.json";

const contractId = StrKey.encodeContract(Buffer.alloc(32));
const challenger = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));

function configureSyntheticMarket(t: test.TestContext): void {
  const previous = process.env.NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID;
  process.env.NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID = contractId;
  t.after(() => {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID;
    else process.env.NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID = previous;
  });
}

test("unsupported quote policy is rejected before transport", async () => {
  await assert.rejects(() => quoteChallengerPayoutVersioned(0, "synthetic-example", 0), UnsupportedRoundingPolicyVersion);
});

test("unsupported claim policy is rejected before requesting a wallet signature", async () => {
  let reads = 0;
  const wallet = new Proxy({}, { get() { reads++; throw new Error("Wallet must not be read"); } });
  await assert.rejects(() => claimChallengerPayoutVersioned(wallet as Parameters<typeof claimChallengerPayoutVersioned>[0], 0, 2), UnsupportedRoundingPolicyVersion);
  assert.equal(reads, 0);
});

test("versioned preview decodes the shared atomic fixture through the generated binding", async (t) => {
  configureSyntheticMarket(t);
  const row = fixtures.feeVectors[0];
  const quote = { gross: BigInt(row.gross), fee: BigInt(row.fee), net: BigInt(row.net), claimed: false };
  const binding = new MimirMarket.Client({ contractId, rpcUrl: "http://127.0.0.1:1", allowHttp: true,
    networkPassphrase: "Test SDF Network ; September 2015" });
  const returnType = binding.spec.getFunc("quote_payout_versioned").outputs()[0].result().okType();
  const encoded = binding.spec.nativeToScVal({ rounding_policy_version: 1, quote }, returnType);
  const fakeBuild = t.mock.method(AssembledTransaction, "build", async (options: AssembledTransactionOptions<unknown>) => {
    assert.equal(options.method, "quote_payout_versioned");
    assert.deepEqual(options.args?.map((arg) => arg.toXDR("base64")),
      binding.spec.funcArgsToScVals("quote_payout_versioned", {
        claim_id: 7n, challenger, required_version: 1,
      }).map((arg) => arg.toXDR("base64")));
    return { result: options.parseResultXdr(encoded) } as AssembledTransaction<unknown>;
  });
  assert.deepEqual(await quoteChallengerPayoutVersioned(7, challenger, 1), {
    roundingPolicyVersion: 1, gross: 2.0132013, fee: 0.00002, net: 2.0131813, claimed: false,
  });
  assert.equal(fakeBuild.mock.callCount(), 1);
});

test("versioned preview refuses an unsupported version returned by the contract", async (t) => {
  configureSyntheticMarket(t);
  t.mock.method(AssembledTransaction, "build", async () => ({ result: new Ok({
    rounding_policy_version: 2, quote: { gross: 0n, fee: 0n, net: 0n, claimed: false },
  }) }) as AssembledTransaction<unknown>);
  await assert.rejects(() => quoteChallengerPayoutVersioned(7, challenger, 1), UnsupportedRoundingPolicyVersion);
});

test("versioned pull carries the required policy and signer and reports the credited net", async (t) => {
  configureSyntheticMarket(t);
  const signer = { publicKey: challenger, async signTransaction(): Promise<never> {
    throw new Error("No real wallet signing in this test");
  } };
  const binding = new MimirMarket.Client({ contractId, rpcUrl: "http://127.0.0.1:1", allowHttp: true,
    networkPassphrase: "Test SDF Network ; September 2015" });
  let submissions = 0;
  t.mock.method(AssembledTransaction, "build", async (options: AssembledTransactionOptions<unknown>) => {
    assert.equal(options.method, "claim_payout_versioned");
    assert.equal(options.publicKey, challenger);
    assert.equal(options.signTransaction, signer.signTransaction);
    assert.deepEqual(options.args?.map((arg) => arg.toXDR("base64")),
      binding.spec.funcArgsToScVals("claim_payout_versioned", {
        challenger, claim_id: 7n, required_version: 1,
      }).map((arg) => arg.toXDR("base64")));
    return { async signAndSend() {
      submissions++;
      return { result: new Ok(20131813n) };
    } } as unknown as AssembledTransaction<unknown>;
  });
  const result = await claimChallengerPayoutVersioned(signer, 7, 1);
  assert.equal(result.claimId, 7);
  assert.equal(result.netPayout, 2.0131813);
  assert.equal(submissions, 1);
});

test("versioned pull preserves a failed submission for reconciliation without another attempt", async (t) => {
  configureSyntheticMarket(t);
  const signer = { publicKey: challenger, async signTransaction(): Promise<never> {
    throw new Error("No real wallet signing in this test");
  } };
  const failure = new Error("Synthetic submission timeout");
  let submissions = 0;
  t.mock.method(AssembledTransaction, "build", async () => ({ async signAndSend() {
    submissions++;
    throw failure;
  } }) as unknown as AssembledTransaction<unknown>);
  await assert.rejects(() => claimChallengerPayoutVersioned(signer, 7, 1), (error: unknown) => {
    assert.ok(error instanceof StellarTransactionError);
    assert.equal(error.phase, "submit");
    assert.equal((error as Error & { cause: unknown }).cause, failure);
    return true;
  });
  assert.equal(submissions, 1);
});

test("generated payout encoding preserves legacy quotes and integers beyond Number precision", () => {
  const binding = new MimirMarket.Client({ contractId, rpcUrl: "http://127.0.0.1:1", allowHttp: true,
    networkPassphrase: "Test SDF Network ; September 2015" });
  for (const row of fixtures.feeVectors) {
    const quote = { gross: BigInt(row.gross), fee: BigInt(row.fee), net: BigInt(row.net), claimed: false };
    const legacyType = binding.spec.getFunc("quote_challenger_payout").outputs()[0].result().okType();
    const versionedType = binding.spec.getFunc("quote_payout_versioned").outputs()[0].result().okType();
    const legacy = binding.spec.funcResToNative("quote_challenger_payout",
      binding.spec.nativeToScVal(quote, legacyType)).unwrap();
    const versioned = binding.spec.funcResToNative("quote_payout_versioned",
      binding.spec.nativeToScVal({ rounding_policy_version: 1, quote }, versionedType)).unwrap();
    assert.deepEqual(legacy, quote);
    assert.deepEqual(versioned, { rounding_policy_version: 1, quote });
  }
});
