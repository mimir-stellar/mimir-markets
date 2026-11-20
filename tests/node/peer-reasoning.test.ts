import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  selectPeerSellers,
  claimStatementDigest,
  peerReasoningCacheKey,
  getCachedPeerReasoning,
  setCachedPeerReasoning,
  clearPeerReasoningCache,
  peerReasoningCacheSize,
  prunePeerReasoningCache,
  invalidatePeerReasoning,
  simulatePeerReasoningScenario,
  PEER_REASONING_CACHE_MAX_ENTRIES,
  type ClaimStatementInput,
  type PeerReasoningRead,
} from "../../agents/council/shared/peer-reasoning";
import { COUNCIL_PERSONAS, type PersonaSpec } from "../../agents/council/personas";

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

describe("claimStatementDigest", () => {
  const baseClaim: ClaimStatementInput = {
    question: "Will Stellar protocol 22 activate by December 2026?",
    creatorPosition: "YES",
    counterPosition: "NO",
    resolutionUrl: "https://stellar.org/protocol-22-schedule",
    settlementRule: "Official stellar.org announcement or network vote",
    contextHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  };

  it("produces a deterministic 64-character hex digest", () => {
    const d1 = claimStatementDigest(baseClaim);
    const d2 = claimStatementDigest(baseClaim);
    assert.equal(d1.length, 64);
    assert.match(d1, /^[0-9a-f]{64}$/);
    assert.equal(d1, d2);
  });

  it("invalidates digest when wording changes", () => {
    const original = claimStatementDigest(baseClaim);

    // Question wording change
    const qChanged = claimStatementDigest({
      ...baseClaim,
      question: "Will Stellar protocol 22 activate by November 2026?",
    });
    assert.notEqual(original, qChanged);

    // Creator position wording change
    const cpChanged = claimStatementDigest({
      ...baseClaim,
      creatorPosition: "CERTAINLY_YES",
    });
    assert.notEqual(original, cpChanged);

    // Counter position wording change
    const ctpChanged = claimStatementDigest({
      ...baseClaim,
      counterPosition: "PROBABLY_NO",
    });
    assert.notEqual(original, ctpChanged);
  });

  it("invalidates digest when source commitment changes", () => {
    const original = claimStatementDigest(baseClaim);

    // Resolution URL change
    const urlChanged = claimStatementDigest({
      ...baseClaim,
      resolutionUrl: "https://github.com/stellar/stellar-core/releases",
    });
    assert.notEqual(original, urlChanged);

    // Settlement rule change
    const ruleChanged = claimStatementDigest({
      ...baseClaim,
      settlementRule: "Only network vote counts, press releases excluded",
    });
    assert.notEqual(original, ruleChanged);

    // Context hash change
    const ctxChanged = claimStatementDigest({
      ...baseClaim,
      contextHash: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    });
    assert.notEqual(original, ctxChanged);
  });

  it("normalizes whitespace and handles casing variations identically", () => {
    const original = claimStatementDigest(baseClaim);

    // Leading and trailing whitespace should trim to same digest
    const trimmed = claimStatementDigest({
      question: "  " + baseClaim.question + "  \n",
      creatorPosition: "\t" + baseClaim.creatorPosition + " ",
      counterPosition: " " + baseClaim.counterPosition + " ",
      resolutionUrl: " " + baseClaim.resolutionUrl + "\t",
      settlementRule: "\n" + baseClaim.settlementRule + " ",
      contextHash: " " + baseClaim.contextHash + " ",
    });
    assert.equal(original, trimmed);

    // Upper vs lowercase context hash hex normalizes
    const upperHex = claimStatementDigest({
      ...baseClaim,
      contextHash: (baseClaim.contextHash ?? "").toUpperCase(),
    });
    assert.equal(original, upperHex);
  });

  it("supports snake_case and alternate property aliases interchangeably", () => {
    const camel = claimStatementDigest({
      question: "Will asset X list on DEX?",
      creatorPosition: "YES",
      counterPosition: "NO",
      resolutionUrl: "https://example.com/res",
      settlementRule: "Listing confirmed",
      contextHash: "1234abcd".repeat(8),
    });

    const snake = claimStatementDigest({
      question: "Will asset X list on DEX?",
      creator_position: "YES",
      counter_position: "NO",
      resolution_url: "https://example.com/res",
      settlement_rule: "Listing confirmed",
      context_hash: "1234abcd".repeat(8),
    });

    const legacySides = claimStatementDigest({
      question: "Will asset X list on DEX?",
      sideA: "YES",
      sideB: "NO",
      resolution_url: "https://example.com/res",
      settlement_rule: "Listing confirmed",
      context_hash: "1234abcd".repeat(8),
    });

    assert.equal(camel, snake);
    assert.equal(camel, legacySides);
  });

  it("boundary: handles empty, undefined, and partial objects without throwing", () => {
    const empty = claimStatementDigest({});
    assert.equal(empty.length, 64);
    assert.match(empty, /^[0-9a-f]{64}$/);

    const partial = claimStatementDigest({ question: "Partial question only" });
    assert.equal(partial.length, 64);
    assert.notEqual(empty, partial);
  });
});

describe("peer reasoning cache binding and invalidation", () => {
  beforeEach(() => {
    clearPeerReasoningCache();
  });

  const sampleReads: PeerReasoningRead[] = [
    {
      sellerSlug: "contrarian",
      sellerName: "Contrarian",
      reasoning: "Counter evidence suggests a delay.",
      pricePaidUnits: "10000",
    },
  ];

  it("constructs cache keys with and without statement digest", () => {
    assert.equal(peerReasoningCacheKey(101, "optimist"), "101:optimist");
    assert.equal(
      peerReasoningCacheKey(101, "optimist", "abcdef123456"),
      "101:optimist:abcdef123456",
    );
  });

  it("serves cached reasoning when statement digest matches", () => {
    const digest = "d1".repeat(32);
    setCachedPeerReasoning(42, "optimist", sampleReads, digest);

    const hit = getCachedPeerReasoning(42, "optimist", digest);
    assert.ok(hit);
    assert.equal(hit.length, 1);
    assert.equal(hit[0].sellerSlug, "contrarian");
    assert.equal(hit[0].reasoning, sampleReads[0].reasoning);
  });

  it("invalidates cache when wording or source commitment changes digest", () => {
    const digestOriginal = "11".repeat(32);
    const digestWordingChanged = "22".repeat(32);
    const digestSourceChanged = "33".repeat(32);

    setCachedPeerReasoning(42, "optimist", sampleReads, digestOriginal);

    // Exact match hits
    assert.ok(getCachedPeerReasoning(42, "optimist", digestOriginal));

    // Mismatched wording digest misses / invalidates
    assert.equal(getCachedPeerReasoning(42, "optimist", digestWordingChanged), null);

    // Mismatched source commitment digest misses / invalidates
    assert.equal(getCachedPeerReasoning(42, "optimist", digestSourceChanged), null);
  });

  it("preserves independent cache entries for unrelated claims", () => {
    const digestClaim1 = "aa".repeat(32);
    const digestClaim2 = "bb".repeat(32);
    const digestClaim1Updated = "cc".repeat(32);

    const reads1: PeerReasoningRead[] = [
      { sellerSlug: "s1", sellerName: "Seller 1", reasoning: "R1", pricePaidUnits: "10" },
    ];
    const reads2: PeerReasoningRead[] = [
      { sellerSlug: "s2", sellerName: "Seller 2", reasoning: "R2", pricePaidUnits: "20" },
    ];

    setCachedPeerReasoning(101, "optimist", reads1, digestClaim1);
    setCachedPeerReasoning(202, "optimist", reads2, digestClaim2);

    // Both present
    assert.equal(getCachedPeerReasoning(101, "optimist", digestClaim1)?.[0].reasoning, "R1");
    assert.equal(getCachedPeerReasoning(202, "optimist", digestClaim2)?.[0].reasoning, "R2");

    // Invalidate claim 1 by updating its cache entry under new digest
    setCachedPeerReasoning(101, "optimist", [{ ...reads1[0], reasoning: "R1-new" }], digestClaim1Updated);

    // Claim 1 old digest misses
    assert.equal(getCachedPeerReasoning(101, "optimist", digestClaim1), null);
    // Claim 1 new digest hits
    assert.equal(getCachedPeerReasoning(101, "optimist", digestClaim1Updated)?.[0].reasoning, "R1-new");

    // Unrelated Claim 2 is unaffected and preserves its entry
    const claim2Hit = getCachedPeerReasoning(202, "optimist", digestClaim2);
    assert.ok(claim2Hit);
    assert.equal(claim2Hit[0].reasoning, "R2");
  });

  it("bounds cache size at PEER_REASONING_CACHE_MAX_ENTRIES", () => {
    clearPeerReasoningCache();
    assert.equal(peerReasoningCacheSize(), 0);

    for (let id = 1; id <= PEER_REASONING_CACHE_MAX_ENTRIES + 25; id++) {
      const digest = `digest_${id}`;
      setCachedPeerReasoning(id, "optimist", sampleReads, digest);
    }

    assert.equal(peerReasoningCacheSize(), PEER_REASONING_CACHE_MAX_ENTRIES);
    // Oldest evicted
    assert.equal(getCachedPeerReasoning(1, "optimist", "digest_1"), null);
    // Newest retained
    const newest = getCachedPeerReasoning(
      PEER_REASONING_CACHE_MAX_ENTRIES + 25,
      "optimist",
      `digest_${PEER_REASONING_CACHE_MAX_ENTRIES + 25}`,
    );
    assert.ok(newest);
  });

  it("prunes cache entries for inactive claims while keeping active claims", () => {
    setCachedPeerReasoning(1, "optimist", sampleReads, "d1");
    setCachedPeerReasoning(2, "optimist", sampleReads, "d2");
    setCachedPeerReasoning(3, "optimist", sampleReads, "d3");

    // Only claim 2 is active
    prunePeerReasoningCache(new Set([2]));

    assert.equal(getCachedPeerReasoning(1, "optimist", "d1"), null);
    assert.ok(getCachedPeerReasoning(2, "optimist", "d2"));
    assert.equal(getCachedPeerReasoning(3, "optimist", "d3"), null);
  });

  it("explicitly invalidates targeted claim entries with invalidatePeerReasoning", () => {
    setCachedPeerReasoning(10, "optimist", sampleReads, "d10");
    setCachedPeerReasoning(10, "pessimist", sampleReads, "d10");
    setCachedPeerReasoning(20, "optimist", sampleReads, "d20");

    // Invalidate claim 10 only
    invalidatePeerReasoning(10);

    assert.equal(getCachedPeerReasoning(10, "optimist", "d10"), null);
    assert.equal(getCachedPeerReasoning(10, "pessimist", "d10"), null);
    // Unrelated claim 20 remains
    assert.ok(getCachedPeerReasoning(20, "optimist", "d20"));
  });
});

describe("peer reasoning scenario with statement digest binding", () => {
  beforeEach(() => {
    clearPeerReasoningCache();
  });

  const personas = COUNCIL_PERSONAS;
  const buyer = personas[0]; // optimist
  const seller = personas[1]; // pessimist
  const testPersonas = [buyer, seller];
  const claim: ClaimStatementInput = {
    question: "Will Soroban fees remain under 0.01 XLM?",
    creatorPosition: "YES",
    counterPosition: "NO",
    resolutionUrl: "https://stellar.org/fees",
    settlementRule: "Average transaction fee over 30 days",
  };

  it("warm cache serves reasoning without additional transport fetches", async () => {
    const digest = claimStatementDigest(claim);

    const scenarios = {
      pessimist: {
        sellerSlug: "pessimist",
        reasoning: "Fees may fluctuate with surges.",
      },
    };

    // First call: cold cache, populates cache
    const firstOutcome = await simulatePeerReasoningScenario({
      buyer,
      activePersonas: testPersonas,
      claimId: 77,
      statementDigest: digest,
      claim,
      scenarios,
    });

    assert.equal(firstOutcome.reads.length, 1);
    assert.equal(firstOutcome.reads[0].sellerSlug, "pessimist");
    assert.equal(getCachedPeerReasoning(77, buyer.slug, digest)?.length, 1);

    // Second call: warm cache serves cached reads directly
    const secondOutcome = await simulatePeerReasoningScenario({
      buyer,
      activePersonas: testPersonas,
      claimId: 77,
      statementDigest: digest,
      claim,
      scenarios: {}, // empty scenarios would fail if fetch was attempted!
    });

    assert.equal(secondOutcome.reads.length, 1);
    assert.equal(secondOutcome.reads[0].sellerSlug, "pessimist");
    assert.equal(secondOutcome.reads[0].reasoning, "Fees may fluctuate with surges.");

    // Changing wording invalidates cache and attempts fresh fetch (which sees empty scenarios)
    const modifiedClaim: ClaimStatementInput = {
      ...claim,
      question: "Will Soroban fees remain under 0.05 XLM?", // modified question
    };
    const modifiedDigest = claimStatementDigest(modifiedClaim);

    const thirdOutcome = await simulatePeerReasoningScenario({
      buyer,
      activePersonas: testPersonas,
      claimId: 77,
      statementDigest: modifiedDigest,
      claim: modifiedClaim,
      scenarios: {}, // empty scenarios -> cache missed -> fetch attempted -> 0 reads
    });

    assert.equal(thirdOutcome.reads.length, 0);
  });

  it("skipCache option forces fresh evaluation even when cache is warm", async () => {
    const digest = claimStatementDigest(claim);
    setCachedPeerReasoning(
      88,
      buyer.slug,
      [{ sellerSlug: "stale-seller", sellerName: "Stale", reasoning: "old", pricePaidUnits: "1" }],
      digest,
    );

    const outcome = await simulatePeerReasoningScenario({
      buyer,
      activePersonas: testPersonas,
      claimId: 88,
      statementDigest: digest,
      claim,
      skipCache: true,
      scenarios: {
        pessimist: {
          sellerSlug: "pessimist",
          reasoning: "fresh reasoning",
        },
      },
    });

    assert.equal(outcome.reads[0].sellerSlug, "pessimist");
    assert.equal(outcome.reads[0].reasoning, "fresh reasoning");
  });
});
