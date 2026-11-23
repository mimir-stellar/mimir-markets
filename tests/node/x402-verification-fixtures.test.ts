/**
 * Automated tests for the offline x402 verification fixture bundle.
 *
 * Validates that every synthetic test case in the bundle executes deterministically
 * through `verifyStellarPayment` offline without live Horizon requests or real funds,
 * and matches the exact expected positive outcome or distinguished failure reason.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  X402_VERIFICATION_BUNDLE,
  buildX402VerificationBundle,
  type X402VerificationFixtureCase,
} from "../../lib/x402/verification-fixtures";
import {
  verifyStellarPayment,
  type StellarHorizonReader,
} from "../../lib/x402/stellar-scheme";

function makeReaderForCase(c: X402VerificationFixtureCase): StellarHorizonReader {
  return {
    async getTransaction(txHash: string) {
      if (c.horizonError) {
        throw new Error(c.horizonError);
      }
      if (c.horizonStatus === 404 || !c.horizonRecord) {
        const error = new Error(`Transaction ${txHash} not found`) as Error & {
          response?: { status: number };
        };
        error.response = { status: 404 };
        throw error;
      }
      return {
        createdAtMs: c.horizonRecord.transaction.createdAtMs,
        successful: c.horizonRecord.transaction.successful,
      };
    },
    async getPaymentOperations(txHash: string) {
      if (c.horizonError) {
        throw new Error(c.horizonError);
      }
      if (!c.horizonRecord) {
        const error = new Error(`Transaction ${txHash} not found`) as Error & {
          response?: { status: number };
        };
        error.response = { status: 404 };
        throw error;
      }
      return c.horizonRecord.operations;
    },
  };
}

test("offline fixture bundle has valid structure and includes positive, boundary and failure cases", () => {
  const bundle = X402_VERIFICATION_BUNDLE;
  assert.equal(bundle.version, 1);
  assert.equal(bundle.scheme, "exact");
  assert.ok(bundle.cases.length >= 15, `expected at least 15 cases, got ${bundle.cases.length}`);

  const categories = new Set(bundle.cases.map((c) => c.category));
  assert.ok(categories.has("valid"), "includes valid cases");
  assert.ok(categories.has("boundary"), "includes boundary cases");
  assert.ok(categories.has("failure"), "includes failure cases");

  const validCount = bundle.cases.filter((c) => c.expected.ok).length;
  const failureCount = bundle.cases.filter((c) => !c.expected.ok).length;
  assert.ok(validCount >= 3, `expected at least 3 valid outcomes, got ${validCount}`);
  assert.ok(failureCount >= 8, `expected at least 8 failure outcomes, got ${failureCount}`);
});

test("fresh buildX402VerificationBundle is deterministic", () => {
  const b1 = buildX402VerificationBundle();
  const b2 = buildX402VerificationBundle();

  assert.equal(b1.cases.length, b2.cases.length);
  for (let i = 0; i < b1.cases.length; i++) {
    const c1 = b1.cases[i]!;
    const c2 = b2.cases[i]!;
    assert.equal(c1.id, c2.id);
    assert.equal(c1.canonicalMessage, c2.canonicalMessage);
    assert.equal(c1.proof.signature, c2.proof.signature);
    assert.deepEqual(c1.expected, c2.expected);
  }
});

for (const fixtureCase of X402_VERIFICATION_BUNDLE.cases) {
  test(`fixture [${fixtureCase.category}] ${fixtureCase.id}: ${fixtureCase.description}`, async () => {
    const reader = makeReaderForCase(fixtureCase);
    const result = await verifyStellarPayment(
      fixtureCase.proof as unknown as Record<string, unknown>,
      fixtureCase.requirements,
      {
        backend: reader,
        now: fixtureCase.simulationNow,
        maxAgeMs: fixtureCase.maxAgeMs,
      },
    );

    if (fixtureCase.expected.ok) {
      assert.equal(result.ok, true, `case ${fixtureCase.id} should verify successfully`);
      if (result.ok) {
        assert.equal(result.transaction, fixtureCase.expected.transaction);
        assert.equal(result.payer, fixtureCase.expected.payer);
        assert.equal(result.amountAtomic, fixtureCase.expected.amountAtomic);
        assert.equal(result.settledAt, fixtureCase.expected.settledAt);
      }
    } else {
      assert.equal(result.ok, false, `case ${fixtureCase.id} should fail verification`);
      if (!result.ok) {
        assert.equal(
          result.reason,
          fixtureCase.expected.reason,
          `case ${fixtureCase.id} expected reason '${fixtureCase.expected.reason}', got '${result.reason}': ${result.message}`,
        );
      }
    }
  });
}
