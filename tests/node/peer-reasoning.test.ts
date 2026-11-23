import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BallotCommitmentError,
  PEER_REASONING_COMMITMENT_VERSION,
  buyPeerReasoning,
  createPeerReasoningCommitment,
  selectPeerSellers,
  verifyPeerReasoningCommitment,
  type PeerReasoningCommitment,
} from "../../agents/council/shared/peer-reasoning";
import { COUNCIL_PERSONAS, type PersonaSpec } from "../../agents/council/personas";
import type { PayingWallet } from "../../lib/x402/buyer";

const FAKE_PAYER: PayingWallet = {
  address: "GBUYER111111111111111111111111111111111111111111111111111",
  signX402Payment: async () => "fake-signature",
} as unknown as PayingWallet;

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("selectPeerSellers", () => {
  const personas = COUNCIL_PERSONAS;
  const buyer = personas[0]; // optimist

  it("excludes the buyer from selected peer sellers", () => {
    for (const p of personas) {
      const sellers = selectPeerSellers(p, personas, 1, 5);
      assert.equal(sellers.some((s) => s.slug === p.slug), false);
    }
  });

  it("returns all peers when fewer peers than count", () => {
    const subset: PersonaSpec[] = [personas[0], personas[1], personas[2]];
    const b = subset[0];
    const sellers = selectPeerSellers(b, subset, 10, 10);
    assert.equal(sellers.length, 2);
    assert.deepEqual(
      sellers.map((s) => s.slug).sort(),
      [subset[1].slug, subset[2].slug].sort(),
    );
    assert.equal(sellers.some((s) => s.slug === b.slug), false);
  });

  it("ensures rotation differs per claimId", () => {
    const claim1Sellers = selectPeerSellers(buyer, personas, 1, 3);
    const claim2Sellers = selectPeerSellers(buyer, personas, 2, 3);
    const claim3Sellers = selectPeerSellers(buyer, personas, 3, 3);

    const slugs1 = claim1Sellers.map((s) => s.slug);
    const slugs2 = claim2Sellers.map((s) => s.slug);
    const slugs3 = claim3Sellers.map((s) => s.slug);

    assert.notDeepEqual(slugs1, slugs2);
    assert.notDeepEqual(slugs2, slugs3);
    assert.notDeepEqual(slugs1, slugs3);
  });

  it("produces deterministic output for same inputs", () => {
    const run1 = selectPeerSellers(buyer, personas, 42, 4);
    const run2 = selectPeerSellers(buyer, personas, 42, 4);

    assert.deepEqual(
      run1.map((s) => s.slug),
      run2.map((s) => s.slug),
    );
  });
});

describe("versioned peer-reasoning ballot commitment", () => {
  const buyer = COUNCIL_PERSONAS[0]!; // optimist
  const active = COUNCIL_PERSONAS.slice(0, 4); // optimist, pessimist, contrarian, statistician

  it("binds participant identities, claim revision, and eligible vote set before outcome evaluation", async () => {
    const boundaryMs = 1_750_000_000_000;
    const expectedSellers = selectPeerSellers(buyer, active, 12, 2);
    let capturedCommitment: PeerReasoningCommitment | undefined;

    const reads = await buyPeerReasoning({
      buyer,
      activePersonas: active,
      claimId: 12,
      claimRevision: "rev-7",
      eligibleVoteSet: expectedSellers.map((s) => s.slug),
      participantIdentities: [
        { slug: buyer.slug, address: "GBUYER111", track: "classic" },
        ...expectedSellers.map((s, idx) => ({
          slug: s.slug,
          address: `GSELLER${idx}`,
          track: "classic" as const,
        })),
      ],
      votingBoundaryMs: boundaryMs,
      baseUrl: "http://council.local",
      readsPerPersona: 2,
      capUsdc: 0.003,
      delayMs: 0,
      payer: FAKE_PAYER,
      now: () => boundaryMs - 100,
      onCommitment: (c) => {
        capturedCommitment = c;
      },
      fetchWithBudgetFn: async (url) => {
        const parsed = new URL(url);
        const slug = parsed.searchParams.get("persona")!;
        const idx = expectedSellers.findIndex((s) => s.slug === slug);
        return {
          response: fakeResponse(200, {
            claimId: 12,
            claimRevision: "rev-7",
            reasoning: `Independent analysis from ${slug}`,
            paidTo: `GSELLER${idx}`,
            recordedAtMs: boundaryMs - 50,
            persona: { slug, name: expectedSellers[idx]?.displayName ?? slug },
          }),
          payment: { priceUnits: 10_000n, txHash: "a".repeat(64) },
        };
      },
    });

    assert.equal(reads.length, 2);
    assert.ok(capturedCommitment, "expected a sealed peer-reasoning commitment");
    assert.equal(capturedCommitment.version, PEER_REASONING_COMMITMENT_VERSION);
    assert.equal(capturedCommitment.claimId, 12);
    assert.equal(capturedCommitment.claimRevision, "rev-7");
    assert.equal(capturedCommitment.buyerSlug, buyer.slug);
    assert.deepEqual(
      capturedCommitment.eligibleVoteSet,
      expectedSellers.map((s) => s.slug).sort(),
    );
    assert.match(capturedCommitment.commitmentHash, /^[0-9a-f]{64}$/);

    const verified = verifyPeerReasoningCommitment(capturedCommitment, reads, {
      claimId: 12,
      claimRevision: "rev-7",
      buyerSlug: buyer.slug,
      eligibleVoteSet: expectedSellers.map((s) => s.slug),
      votingBoundaryMs: boundaryMs,
    });
    assert.equal(verified.ok, true);
  });

  it("rejects peer-reasoning ballots altered after the approved voting boundary", () => {
    const boundaryMs = 1_750_000_000_000;
    const reads = [
      {
        sellerSlug: "pessimist",
        sellerName: "The Pessimist",
        reasoning: "Bearish outlook based on primary data.",
        pricePaidUnits: "10000",
        claimRevision: "rev-1",
        recordedAtMs: boundaryMs - 100,
      },
      {
        sellerSlug: "statistician",
        sellerName: "The Statistician",
        reasoning: "Base rate supports challenger side.",
        pricePaidUnits: "10000",
        claimRevision: "rev-1",
        recordedAtMs: boundaryMs,
      },
    ];

    const commitment = createPeerReasoningCommitment({
      claimId: 99,
      claimRevision: "rev-1",
      buyerSlug: "optimist",
      eligibleVoteSet: ["pessimist", "statistician"],
      votingBoundaryMs: boundaryMs,
      reads,
    });

    // Mutated reasoning text after boundary lock.
    const tamperedText = [
      { ...reads[0]!, reasoning: "Altered reasoning after boundary." },
      reads[1]!,
    ];
    const verifyText = verifyPeerReasoningCommitment(commitment, tamperedText);
    assert.equal(verifyText.ok, false);
    assert.equal(verifyText.reason, "altered_after_boundary");

    // Mutated timestamp showing alteration after votingBoundaryMs.
    const tamperedTime = [
      { ...reads[0]!, alteredAtMs: boundaryMs + 1 },
      reads[1]!,
    ];
    const verifyTime = verifyPeerReasoningCommitment(commitment, tamperedTime);
    assert.equal(verifyTime.ok, false);
    assert.equal(verifyTime.reason, "altered_after_boundary");

    // Dropped read after boundary lock.
    const verifyDropped = verifyPeerReasoningCommitment(commitment, [reads[0]!]);
    assert.equal(verifyDropped.ok, false);
    assert.equal(verifyDropped.reason, "altered_after_boundary");

    // Claim revision mismatch.
    const verifyRevision = verifyPeerReasoningCommitment(commitment, reads, {
      claimRevision: "rev-2",
    });
    assert.equal(verifyRevision.ok, false);
    assert.equal(verifyRevision.reason, "claim_revision_mismatch");
  });

  it("filters out spoofed seller identities, mismatched revisions, and post-boundary responses in buyPeerReasoning", async () => {
    const boundaryMs = 1_750_000_000_000;
    const sellers = selectPeerSellers(buyer, active, 7, 3);

    const reads = await buyPeerReasoning({
      buyer,
      activePersonas: active,
      claimId: 7,
      claimRevision: "rev-4",
      eligibleVoteSet: sellers.map((s) => s.slug),
      votingBoundaryMs: boundaryMs,
      baseUrl: "http://council.local",
      readsPerPersona: 3,
      capUsdc: 0.005,
      delayMs: 0,
      payer: FAKE_PAYER,
      now: () => boundaryMs,
      fetchWithBudgetFn: async (url) => {
        const slug = new URL(url).searchParams.get("persona")!;
        if (slug === sellers[0]!.slug) {
          // Spoofed persona slug in response body -> must be rejected.
          return {
            response: fakeResponse(200, {
              claimId: 7,
              claimRevision: "rev-4",
              reasoning: "Spoofed seller response",
              persona: { slug: "doomer", name: "The Doomer" },
            }),
            payment: { priceUnits: 10_000n, txHash: "1".repeat(64) },
          };
        }
        if (slug === sellers[1]!.slug) {
          // Altered after voting boundary -> must be rejected.
          return {
            response: fakeResponse(200, {
              claimId: 7,
              claimRevision: "rev-4",
              reasoning: "Late altered response",
              recordedAtMs: boundaryMs - 20,
              alteredAtMs: boundaryMs + 1,
              persona: { slug, name: sellers[1]!.displayName },
            }),
            payment: { priceUnits: 10_000n, txHash: "2".repeat(64) },
          };
        }
        // Valid response exactly on the boundary.
        return {
          response: fakeResponse(200, {
            claimId: 7,
            claimRevision: "rev-4",
            reasoning: "Valid boundary response",
            recordedAtMs: boundaryMs,
            persona: { slug, name: sellers[2]!.displayName },
          }),
          payment: { priceUnits: 10_000n, txHash: "3".repeat(64) },
        };
      },
    });

    assert.equal(reads.length, 1);
    assert.equal(reads[0]!.sellerSlug, sellers[2]!.slug);
    assert.equal(reads[0]!.claimRevision, "rev-4");
  });

  it("throws BallotCommitmentError when buyer is included in eligible peer set or version is invalid", () => {
    assert.throws(
      () =>
        createPeerReasoningCommitment({
          claimId: 1,
          claimRevision: 1,
          buyerSlug: "optimist",
          eligibleVoteSet: ["optimist", "pessimist"],
          reads: [],
        }),
      (err: unknown) => err instanceof BallotCommitmentError && err.reason === "ineligible_voter",
    );

    assert.throws(
      () =>
        createPeerReasoningCommitment({
          version: 9,
          claimId: 1,
          claimRevision: 1,
          buyerSlug: "optimist",
          eligibleVoteSet: ["pessimist"],
          reads: [],
        }),
      (err: unknown) => err instanceof BallotCommitmentError && err.reason === "invalid_version",
    );
  });
});
