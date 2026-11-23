/**
 * Offline x402 verification fixture bundle for independent third-party buyers.
 *
 * This module publishes deterministic synthetic quotes, proof envelopes,
 * Horizon response shapes, and expected outcomes across valid payments and
 * distinguished failure/boundary conditions.
 *
 * Independent buyers can consume this bundle offline to test and validate their
 * client implementations (e.g. proof message construction, Ed25519 signing,
 * header generation, and envelope verification) without connecting to a live
 * Horizon server or submitting real transactions.
 */

import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  STELLAR_PROOF_KIND,
  paymentProofMessage,
  type HorizonPaymentOperation,
  type StellarPaymentProof,
  type StellarVerifyFailure,
  type StellarVerifyResult,
} from "./stellar-scheme";
import { X402_ASSET, X402_NETWORK, X402_PAYMENT_MAX_AGE_MS, X402_SCHEME } from "./config";

// ── Deterministic keypairs and addresses ─────────────────────────────────────

export const X402_FIXTURE_BUYER_SECRET =
  "SAWXMSQ6ETHTU2HSVKCYV6IHLZWLSYNVN2INLVISMUNOZ7K5RI7VRSLD";
export const X402_FIXTURE_BUYER_KEYPAIR = Keypair.fromSecret(X402_FIXTURE_BUYER_SECRET);
export const X402_FIXTURE_BUYER_ADDRESS = X402_FIXTURE_BUYER_KEYPAIR.publicKey();

export const X402_FIXTURE_SECOND_BUYER_SECRET =
  "SAQUIBDCUPTDWPYLRZIIFKAWVIR3CGGILCWXILG3KMCY7NAF44YLG5DD";
export const X402_FIXTURE_SECOND_BUYER_KEYPAIR = Keypair.fromSecret(X402_FIXTURE_SECOND_BUYER_SECRET);
export const X402_FIXTURE_SECOND_BUYER_ADDRESS = X402_FIXTURE_SECOND_BUYER_KEYPAIR.publicKey();

export const X402_FIXTURE_SELLER_ADDRESS =
  "GCM6HPMQQISWED5UCTWXQOBXBPTOFLRKMUSZOEB6L5QMP2DMKJSLJXIJ";

export const X402_FIXTURE_OTHER_SELLER_ADDRESS =
  "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";

export const X402_FIXTURE_CONTRACT_ADDRESS =
  "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR";

export const X402_FIXTURE_ASSET_CODE = X402_ASSET.split(":")[0]!;
export const X402_FIXTURE_ASSET_ISSUER = X402_ASSET.split(":")[1]!;

// ── Fixture Horizon Types ───────────────────────────────────────────────────

export interface FixtureHorizonTransaction {
  createdAtMs: number;
  successful: boolean;
}

export interface FixtureHorizonRecord {
  transaction: FixtureHorizonTransaction;
  operations: HorizonPaymentOperation[];
}

// ── Individual Test Case Definition ─────────────────────────────────────────

export type FixtureExpectedOutcome =
  | {
      ok: true;
      payer: string;
      transaction: string;
      amountAtomic: bigint;
      settledAt: number;
    }
  | {
      ok: false;
      reason: StellarVerifyFailure;
    };

export interface X402VerificationFixtureCase {
  id: string;
  category: "valid" | "boundary" | "failure";
  description: string;
  requirements: PaymentRequirements;
  canonicalMessage: string;
  proof: StellarPaymentProof;
  paymentPayload: PaymentPayload;
  horizonRecord?: FixtureHorizonRecord;
  horizonStatus?: number; // e.g. 404 for missing
  horizonError?: string; // generic Horizon network error
  simulationNow: number;
  maxAgeMs: number;
  expected: FixtureExpectedOutcome;
}

// ── Synthetic Fixture Bundle Construction ───────────────────────────────────

export interface X402VerificationBundle {
  version: 1;
  scheme: typeof X402_SCHEME;
  network: string;
  asset: string;
  accounts: {
    buyer: {
      address: string;
      secret: string;
    };
    secondBuyer: {
      address: string;
      secret: string;
    };
    seller: {
      address: string;
    };
  };
  cases: X402VerificationFixtureCase[];
}

/**
 * Build the static offline verification fixture bundle.
 */
export function buildX402VerificationBundle(): X402VerificationBundle {
  const baseNow = 1_760_000_000_000; // Fixed deterministic timestamp (ms)
  const maxAgeMs = X402_PAYMENT_MAX_AGE_MS; // 300,000 ms (5 min)

  const defaultReq: PaymentRequirements = {
    scheme: X402_SCHEME,
    network: X402_NETWORK,
    asset: X402_ASSET,
    amount: "10000", // 10,000 atomic units = 0.001 USDC
    payTo: X402_FIXTURE_SELLER_ADDRESS,
    maxTimeoutSeconds: 300,
    extra: {},
  };

  function createSignedProof(
    txHash: string,
    req: PaymentRequirements,
    signer: Keypair = X402_FIXTURE_BUYER_KEYPAIR,
    customPayer?: string,
  ): { canonicalMessage: string; proof: StellarPaymentProof } {
    const canonicalMessage = paymentProofMessage({
      network: req.network,
      transaction: txHash.toLowerCase(),
      payTo: req.payTo,
      amount: req.amount,
      asset: req.asset,
    });
    const signature = signer
      .sign(Buffer.from(canonicalMessage, "utf8"))
      .toString("base64");
    const proof: StellarPaymentProof = {
      kind: STELLAR_PROOF_KIND,
      network: req.network,
      transaction: txHash.toLowerCase(),
      payer: customPayer ?? signer.publicKey(),
      signature,
    };
    return { canonicalMessage, proof };
  }

  function createPayload(proof: StellarPaymentProof, req: PaymentRequirements): PaymentPayload {
    return {
      x402Version: 2,
      accepted: req,
      payload: proof as unknown as Record<string, unknown>,
    };
  }

  // --- Case 1: Standard Exact Payment (Valid) ---
  const tx1 = "1111111111111111111111111111111111111111111111111111111111111111";
  const case1Proof = createSignedProof(tx1, defaultReq);
  const case1Record: FixtureHorizonRecord = {
    transaction: { createdAtMs: baseNow - 5_000, successful: true },
    operations: [
      {
        type: "payment",
        from: X402_FIXTURE_BUYER_ADDRESS,
        to: X402_FIXTURE_SELLER_ADDRESS,
        asset_type: "credit_alphanum4",
        asset_code: X402_FIXTURE_ASSET_CODE,
        asset_issuer: X402_FIXTURE_ASSET_ISSUER,
        amount: "0.0010000",
        transaction_successful: true,
      },
    ],
  };

  // --- Case 2: Overpayment (Valid) ---
  const tx2 = "2222222222222222222222222222222222222222222222222222222222222222";
  const case2Proof = createSignedProof(tx2, defaultReq);
  const case2Record: FixtureHorizonRecord = {
    transaction: { createdAtMs: baseNow - 10_000, successful: true },
    operations: [
      {
        type: "payment",
        from: X402_FIXTURE_BUYER_ADDRESS,
        to: X402_FIXTURE_SELLER_ADDRESS,
        asset_type: "credit_alphanum4",
        asset_code: X402_FIXTURE_ASSET_CODE,
        asset_issuer: X402_FIXTURE_ASSET_ISSUER,
        amount: "0.0050000", // 50,000 atomic units (> 10,000)
        transaction_successful: true,
      },
    ],
  };

  // --- Case 3: Batched Operations Sum (Valid) ---
  const tx3 = "3333333333333333333333333333333333333333333333333333333333333333";
  const case3Proof = createSignedProof(tx3, defaultReq);
  const case3Record: FixtureHorizonRecord = {
    transaction: { createdAtMs: baseNow - 2_000, successful: true },
    operations: [
      {
        type: "payment",
        from: X402_FIXTURE_BUYER_ADDRESS,
        to: X402_FIXTURE_SELLER_ADDRESS,
        asset_type: "credit_alphanum4",
        asset_code: X402_FIXTURE_ASSET_CODE,
        asset_issuer: X402_FIXTURE_ASSET_ISSUER,
        amount: "0.0004000", // 4,000 atomic
        transaction_successful: true,
      },
      {
        type: "payment",
        from: X402_FIXTURE_BUYER_ADDRESS,
        to: X402_FIXTURE_SELLER_ADDRESS,
        asset_type: "credit_alphanum4",
        asset_code: X402_FIXTURE_ASSET_CODE,
        asset_issuer: X402_FIXTURE_ASSET_ISSUER,
        amount: "0.0006000", // 6,000 atomic; sum = 10,000
        transaction_successful: true,
      },
    ],
  };

  // --- Case 4: Window Edge Freshness (Boundary Valid) ---
  const tx4 = "4444444444444444444444444444444444444444444444444444444444444444";
  const case4Proof = createSignedProof(tx4, defaultReq);
  const case4Record: FixtureHorizonRecord = {
    transaction: { createdAtMs: baseNow - maxAgeMs, successful: true }, // exact edge
    operations: [
      {
        type: "payment",
        from: X402_FIXTURE_BUYER_ADDRESS,
        to: X402_FIXTURE_SELLER_ADDRESS,
        asset_type: "credit_alphanum4",
        asset_code: X402_FIXTURE_ASSET_CODE,
        asset_issuer: X402_FIXTURE_ASSET_ISSUER,
        amount: "0.0010000",
        transaction_successful: true,
      },
    ],
  };

  // --- Case 5: 1-Stroop Atomic Payment (Boundary Valid) ---
  const tx5 = "5555555555555555555555555555555555555555555555555555555555555555";
  const stroopReq: PaymentRequirements = { ...defaultReq, amount: "1" };
  const case5Proof = createSignedProof(tx5, stroopReq);
  const case5Record: FixtureHorizonRecord = {
    transaction: { createdAtMs: baseNow - 1_000, successful: true },
    operations: [
      {
        type: "payment",
        from: X402_FIXTURE_BUYER_ADDRESS,
        to: X402_FIXTURE_SELLER_ADDRESS,
        asset_type: "credit_alphanum4",
        asset_code: X402_FIXTURE_ASSET_CODE,
        asset_issuer: X402_FIXTURE_ASSET_ISSUER,
        amount: "0.0000001", // 1 atomic unit = 0.0000001 USDC
        transaction_successful: true,
      },
    ],
  };

  // --- Case 6: Malformed Proof Discriminator (Failure) ---
  const tx6 = "6666666666666666666666666666666666666666666666666666666666666666";
  const case6Data = createSignedProof(tx6, defaultReq);
  const case6Proof: StellarPaymentProof = {
    ...case6Data.proof,
    kind: "unknown-payment-proof" as any,
  };

  // --- Case 7: Network Mismatch (Failure) ---
  const tx7 = "7777777777777777777777777777777777777777777777777777777777777777";
  const case7Data = createSignedProof(tx7, defaultReq);
  const case7Proof: StellarPaymentProof = {
    ...case7Data.proof,
    network: "stellar:mainnet", // quote asks for stellar:testnet
  };

  // --- Case 8: Unsupported Quote Asset (Failure) ---
  const tx8 = "8888888888888888888888888888888888888888888888888888888888888888";
  const unsupportedAssetReq: PaymentRequirements = {
    ...defaultReq,
    asset: "EURC:GBBD47H6Y3P4GYONKHNQUPASISPLJ5GLVI5K2BE6D6HGMD2DYGDWBSMI",
  };
  const case8Data = createSignedProof(tx8, unsupportedAssetReq);

  // --- Case 9: Unsupported Contract payTo (Failure) ---
  const tx9 = "9999999999999999999999999999999999999999999999999999999999999999";
  const contractPayToReq: PaymentRequirements = {
    ...defaultReq,
    payTo: X402_FIXTURE_CONTRACT_ADDRESS,
  };
  const case9Data = createSignedProof(tx9, contractPayToReq);

  // --- Case 10: Forged Signature (Failure) ---
  const tx10 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const case10Data = createSignedProof(tx10, defaultReq);
  // Re-sign with a second keypair while claiming it is payer 1
  const forgedSig = X402_FIXTURE_SECOND_BUYER_KEYPAIR
    .sign(Buffer.from(case10Data.canonicalMessage, "utf8"))
    .toString("base64");
  const case10Proof: StellarPaymentProof = {
    ...case10Data.proof,
    signature: forgedSig,
  };

  // --- Case 11: Transaction Not Found on Ledger (Failure 404) ---
  const tx11 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const case11Data = createSignedProof(tx11, defaultReq);

  // --- Case 12: Transaction Failed on Ledger (Failure) ---
  const tx12 = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  const case12Data = createSignedProof(tx12, defaultReq);
  const case12Record: FixtureHorizonRecord = {
    transaction: { createdAtMs: baseNow - 5_000, successful: false },
    operations: [],
  };

  // --- Case 13: Stale Payment Expired Beyond Window (Boundary Failure) ---
  const tx13 = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
  const case13Data = createSignedProof(tx13, defaultReq);
  const case13Record: FixtureHorizonRecord = {
    transaction: { createdAtMs: baseNow - (maxAgeMs + 1_000), successful: true },
    operations: [
      {
        type: "payment",
        from: X402_FIXTURE_BUYER_ADDRESS,
        to: X402_FIXTURE_SELLER_ADDRESS,
        asset_type: "credit_alphanum4",
        asset_code: X402_FIXTURE_ASSET_CODE,
        asset_issuer: X402_FIXTURE_ASSET_ISSUER,
        amount: "0.0010000",
        transaction_successful: true,
      },
    ],
  };

  // --- Case 14: Payment to Someone Else (Failure) ---
  const tx14 = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const case14Data = createSignedProof(tx14, defaultReq);
  const case14Record: FixtureHorizonRecord = {
    transaction: { createdAtMs: baseNow - 5_000, successful: true },
    operations: [
      {
        type: "payment",
        from: X402_FIXTURE_BUYER_ADDRESS,
        to: X402_FIXTURE_OTHER_SELLER_ADDRESS,
        asset_type: "credit_alphanum4",
        asset_code: X402_FIXTURE_ASSET_CODE,
        asset_issuer: X402_FIXTURE_ASSET_ISSUER,
        amount: "0.0010000",
        transaction_successful: true,
      },
    ],
  };

  // --- Case 15: Native XLM Payment Instead of USDC (Failure) ---
  const tx15 = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  const case15Data = createSignedProof(tx15, defaultReq);
  const case15Record: FixtureHorizonRecord = {
    transaction: { createdAtMs: baseNow - 5_000, successful: true },
    operations: [
      {
        type: "payment",
        from: X402_FIXTURE_BUYER_ADDRESS,
        to: X402_FIXTURE_SELLER_ADDRESS,
        asset_type: "native",
        amount: "10.0000000",
        transaction_successful: true,
      },
    ],
  };

  // --- Case 16: Insufficient Amount Paid (Failure) ---
  const tx16 = "1212121212121212121212121212121212121212121212121212121212121212";
  const case16Data = createSignedProof(tx16, defaultReq);
  const case16Record: FixtureHorizonRecord = {
    transaction: { createdAtMs: baseNow - 5_000, successful: true },
    operations: [
      {
        type: "payment",
        from: X402_FIXTURE_BUYER_ADDRESS,
        to: X402_FIXTURE_SELLER_ADDRESS,
        asset_type: "credit_alphanum4",
        asset_code: X402_FIXTURE_ASSET_CODE,
        asset_issuer: X402_FIXTURE_ASSET_ISSUER,
        amount: "0.0009999", // 9,999 atomic units (< 10,000)
        transaction_successful: true,
      },
    ],
  };

  // --- Case 17: Horizon Unavailable Network Error (Failure) ---
  const tx17 = "3434343434343434343434343434343434343434343434343434343434343434";
  const case17Data = createSignedProof(tx17, defaultReq);

  const cases: X402VerificationFixtureCase[] = [
    {
      id: "valid_exact_payment",
      category: "valid",
      description: "Fresh, exact landed USDC payment satisfies the 402 requirement.",
      requirements: defaultReq,
      canonicalMessage: case1Proof.canonicalMessage,
      proof: case1Proof.proof,
      paymentPayload: createPayload(case1Proof.proof, defaultReq),
      horizonRecord: case1Record,
      simulationNow: baseNow,
      maxAgeMs,
      expected: {
        ok: true,
        payer: X402_FIXTURE_BUYER_ADDRESS,
        transaction: tx1,
        amountAtomic: 10_000n,
        settledAt: baseNow - 5_000,
      },
    },
    {
      id: "valid_overpayment",
      category: "valid",
      description: "Payment exceeding quote is accepted; verification reports actual atomic USDC paid.",
      requirements: defaultReq,
      canonicalMessage: case2Proof.canonicalMessage,
      proof: case2Proof.proof,
      paymentPayload: createPayload(case2Proof.proof, defaultReq),
      horizonRecord: case2Record,
      simulationNow: baseNow,
      maxAgeMs,
      expected: {
        ok: true,
        payer: X402_FIXTURE_BUYER_ADDRESS,
        transaction: tx2,
        amountAtomic: 50_000n,
        settledAt: baseNow - 10_000,
      },
    },
    {
      id: "valid_batched_operations_sum",
      category: "valid",
      description: "Multiple payment operations within one transaction are summed to satisfy the quote.",
      requirements: defaultReq,
      canonicalMessage: case3Proof.canonicalMessage,
      proof: case3Proof.proof,
      paymentPayload: createPayload(case3Proof.proof, defaultReq),
      horizonRecord: case3Record,
      simulationNow: baseNow,
      maxAgeMs,
      expected: {
        ok: true,
        payer: X402_FIXTURE_BUYER_ADDRESS,
        transaction: tx3,
        amountAtomic: 10_000n,
        settledAt: baseNow - 2_000,
      },
    },
    {
      id: "boundary_window_edge",
      category: "boundary",
      description: "Payment landing at the exact freshness window limit (age == maxAgeMs) verifies successfully.",
      requirements: defaultReq,
      canonicalMessage: case4Proof.canonicalMessage,
      proof: case4Proof.proof,
      paymentPayload: createPayload(case4Proof.proof, defaultReq),
      horizonRecord: case4Record,
      simulationNow: baseNow,
      maxAgeMs,
      expected: {
        ok: true,
        payer: X402_FIXTURE_BUYER_ADDRESS,
        transaction: tx4,
        amountAtomic: 10_000n,
        settledAt: baseNow - maxAgeMs,
      },
    },
    {
      id: "boundary_one_stroop_payment",
      category: "boundary",
      description: "1 stroop (0.0000001 USDC / 1 atomic unit) payment matches a 1-stroop requirement.",
      requirements: stroopReq,
      canonicalMessage: case5Proof.canonicalMessage,
      proof: case5Proof.proof,
      paymentPayload: createPayload(case5Proof.proof, stroopReq),
      horizonRecord: case5Record,
      simulationNow: baseNow,
      maxAgeMs,
      expected: {
        ok: true,
        payer: X402_FIXTURE_BUYER_ADDRESS,
        transaction: tx5,
        amountAtomic: 1n,
        settledAt: baseNow - 1_000,
      },
    },
    {
      id: "failure_malformed_proof",
      category: "failure",
      description: "Proof envelope with missing or unknown proof kind discriminator is refused.",
      requirements: defaultReq,
      canonicalMessage: case6Data.canonicalMessage,
      proof: case6Proof,
      paymentPayload: createPayload(case6Proof, defaultReq),
      simulationNow: baseNow,
      maxAgeMs,
      expected: {
        ok: false,
        reason: "malformed_proof",
      },
    },
    {
      id: "failure_network_mismatch",
      category: "failure",
      description: "Proof specifying a different CAIP-2 network than quote is refused.",
      requirements: defaultReq,
      canonicalMessage: case7Data.canonicalMessage,
      proof: case7Proof,
      paymentPayload: createPayload(case7Proof, defaultReq),
      simulationNow: baseNow,
      maxAgeMs,
      expected: {
        ok: false,
        reason: "network_mismatch",
      },
    },
    {
      id: "failure_unsupported_asset",
      category: "failure",
      description: "Quote requesting an asset other than Circle testnet USDC is refused immediately.",
      requirements: unsupportedAssetReq,
      canonicalMessage: case8Data.canonicalMessage,
      proof: case8Data.proof,
      paymentPayload: createPayload(case8Data.proof, unsupportedAssetReq),
      simulationNow: baseNow,
      maxAgeMs,
      expected: {
        ok: false,
        reason: "unsupported_asset",
      },
    },
    {
      id: "failure_unsupported_pay_to_contract",
      category: "failure",
      description: "Quote paying to a Soroban contract C… address is refused; classic payments must target G… accounts.",
      requirements: contractPayToReq,
      canonicalMessage: case9Data.canonicalMessage,
      proof: case9Data.proof,
      paymentPayload: createPayload(case9Data.proof, contractPayToReq),
      simulationNow: baseNow,
      maxAgeMs,
      expected: {
        ok: false,
        reason: "unsupported_pay_to",
      },
    },
    {
      id: "failure_invalid_signature",
      category: "failure",
      description: "Proof with forged or invalid Ed25519 signature over canonical message is refused.",
      requirements: defaultReq,
      canonicalMessage: case10Data.canonicalMessage,
      proof: case10Proof,
      paymentPayload: createPayload(case10Proof, defaultReq),
      simulationNow: baseNow,
      maxAgeMs,
      expected: {
        ok: false,
        reason: "invalid_signature",
      },
    },
    {
      id: "failure_transaction_not_found",
      category: "failure",
      description: "Transaction hash that does not exist on Horizon (404) is refused.",
      requirements: defaultReq,
      canonicalMessage: case11Data.canonicalMessage,
      proof: case11Data.proof,
      paymentPayload: createPayload(case11Data.proof, defaultReq),
      horizonStatus: 404,
      simulationNow: baseNow,
      maxAgeMs,
      expected: {
        ok: false,
        reason: "transaction_not_found",
      },
    },
    {
      id: "failure_transaction_failed",
      category: "failure",
      description: "Transaction that landed on ledger but failed execution is refused.",
      requirements: defaultReq,
      canonicalMessage: case12Data.canonicalMessage,
      proof: case12Data.proof,
      paymentPayload: createPayload(case12Data.proof, defaultReq),
      horizonRecord: case12Record,
      simulationNow: baseNow,
      maxAgeMs,
      expected: {
        ok: false,
        reason: "transaction_failed",
      },
    },
    {
      id: "failure_payment_too_old",
      category: "boundary",
      description: "Payment older than the freshness window (age > maxAgeMs) is refused.",
      requirements: defaultReq,
      canonicalMessage: case13Data.canonicalMessage,
      proof: case13Data.proof,
      paymentPayload: createPayload(case13Data.proof, defaultReq),
      horizonRecord: case13Record,
      simulationNow: baseNow,
      maxAgeMs,
      expected: {
        ok: false,
        reason: "payment_too_old",
      },
    },
    {
      id: "failure_no_matching_payment",
      category: "failure",
      description: "Transaction containing no payment operation to the seller is refused.",
      requirements: defaultReq,
      canonicalMessage: case14Data.canonicalMessage,
      proof: case14Data.proof,
      paymentPayload: createPayload(case14Data.proof, defaultReq),
      horizonRecord: case14Record,
      simulationNow: baseNow,
      maxAgeMs,
      expected: {
        ok: false,
        reason: "no_matching_payment",
      },
    },
    {
      id: "failure_native_xlm_payment",
      category: "failure",
      description: "Native XLM payment operation cannot satisfy a USDC quote.",
      requirements: defaultReq,
      canonicalMessage: case15Data.canonicalMessage,
      proof: case15Data.proof,
      paymentPayload: createPayload(case15Data.proof, defaultReq),
      horizonRecord: case15Record,
      simulationNow: baseNow,
      maxAgeMs,
      expected: {
        ok: false,
        reason: "no_matching_payment",
      },
    },
    {
      id: "failure_insufficient_amount",
      category: "failure",
      description: "Paid amount less than quote (e.g. 9,999 atomic units vs 10,000 required) is refused.",
      requirements: defaultReq,
      canonicalMessage: case16Data.canonicalMessage,
      proof: case16Data.proof,
      paymentPayload: createPayload(case16Data.proof, defaultReq),
      horizonRecord: case16Record,
      simulationNow: baseNow,
      maxAgeMs,
      expected: {
        ok: false,
        reason: "insufficient_amount",
      },
    },
    {
      id: "failure_horizon_unavailable",
      category: "failure",
      description: "Horizon network or 5xx read failure causes fail-closed verification refusal.",
      requirements: defaultReq,
      canonicalMessage: case17Data.canonicalMessage,
      proof: case17Data.proof,
      paymentPayload: createPayload(case17Data.proof, defaultReq),
      horizonError: "Horizon service 503 unavailable (simulated network outage)",
      simulationNow: baseNow,
      maxAgeMs,
      expected: {
        ok: false,
        reason: "horizon_unavailable",
      },
    },
  ];

  return {
    version: 1,
    scheme: X402_SCHEME,
    network: X402_NETWORK,
    asset: X402_ASSET,
    accounts: {
      buyer: {
        address: X402_FIXTURE_BUYER_ADDRESS,
        secret: X402_FIXTURE_BUYER_SECRET,
      },
      secondBuyer: {
        address: X402_FIXTURE_SECOND_BUYER_ADDRESS,
        secret: X402_FIXTURE_SECOND_BUYER_SECRET,
      },
      seller: {
        address: X402_FIXTURE_SELLER_ADDRESS,
      },
    },
    cases,
  };
}

/**
 * Static instantiated bundle ready for export and offline third-party use.
 */
export const X402_VERIFICATION_BUNDLE = buildX402VerificationBundle();
