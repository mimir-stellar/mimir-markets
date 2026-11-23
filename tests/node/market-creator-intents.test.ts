import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCandidateSignature,
  buildDeduplicationIdentity,
  computeStatementDigest,
  DurableIntentStore,
  filterDuplicateCandidates,
  isAmbiguousMatch,
  normalizeComparableText,
  normalizeResolutionUrl,
  reconcileSubmission,
  type CandidateLike,
  type ExistingClaimSignature,
  type MarketCreationIntent,
} from "../../agents/market-creator/dedupe";
import {
  createMarketCreationIntent,
  parseDraftedCandidates,
  type ClaimCandidate,
} from "../../agents/market-creator/drafting";

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "mimir-market-intents-"));
}

test("buildDeduplicationIdentity produces deterministic 64-char hex identity", () => {
  const candidate1: CandidateLike = {
    question: "Will Bitcoin reach $100,000 before December 31, 2026?",
    resolutionUrl: "https://www.coingecko.com/en/coins/bitcoin?utm_source=test#price",
    deadline: "2026-12-31T23:59:59.000Z",
    category: "crypto",
  };

  const candidate2: CandidateLike = {
    question: "   bitcoin reach $100k before december 31 2026?  ",
    resolutionUrl: "https://www.coingecko.com/en/coins/bitcoin/",
    deadline: "2026-12-31T23:59:59Z",
    category: "CRYPTO",
  };

  const id1 = buildDeduplicationIdentity(candidate1);
  const id2 = buildDeduplicationIdentity(candidate2);

  assert.equal(typeof id1, "string");
  assert.equal(id1.length, 64);
  assert.match(id1, /^[0-9a-f]{64}$/);
  // Both candidates normalize to the same deduplication identity
  assert.equal(id1, id2);
});

test("buildDeduplicationIdentity distinguishes truly different candidates", () => {
  const candA: CandidateLike = {
    question: "Will Bitcoin exceed $100k?",
    resolutionUrl: "https://coingecko.com/en/coins/bitcoin",
    deadline: "2026-12-31T00:00:00Z",
  };

  const candB: CandidateLike = {
    question: "Will Ethereum exceed $5k?",
    resolutionUrl: "https://coingecko.com/en/coins/ethereum",
    deadline: "2026-12-31T00:00:00Z",
  };

  assert.notEqual(buildDeduplicationIdentity(candA), buildDeduplicationIdentity(candB));
});

test("computeStatementDigest is deterministic and sensitive to statement changes", () => {
  const base: CandidateLike = {
    question: "Will SpaceX Starship launch successfully on Flight 7?",
    resolutionUrl: "https://ll.thespacedevs.com/2.2.0/launch/starship-flight-7/",
    deadline: "2026-06-01T12:00:00.000Z",
    category: "technology",
    creatorPosition: "Yes — Flight 7 achieves orbit and booster catch",
    counterPosition: "No — Flight 7 fails to reach orbit or launch slips",
    settlementRule: "Resolve YES if launch status is Success at deadline.",
  };

  const digest1 = computeStatementDigest(base);
  const digest2 = computeStatementDigest({ ...base });

  assert.equal(digest1, digest2);
  assert.match(digest1, /^[0-9a-f]{64}$/);

  // Altering settlement rule changes the digest
  const alteredRule = computeStatementDigest({
    ...base,
    settlementRule: "Resolve YES if launch status is Confirmed Success.",
  });
  assert.notEqual(digest1, alteredRule);

  // Altering creator position changes the digest
  const alteredPosition = computeStatementDigest({
    ...base,
    creatorPosition: "Yes — Flight 7 launches.",
  });
  assert.notEqual(digest1, alteredPosition);
});

test("reconcileSubmission handles exact match and statement digest match", () => {
  const candidate: CandidateLike = {
    question: "Will the Lakers beat the Celtics on Christmas Day?",
    resolutionUrl: "https://www.espn.com/nba/game/_/gameId/401584000",
    deadline: "2026-12-25T20:00:00Z",
    category: "sports",
    creatorPosition: "Yes",
    counterPosition: "No",
    settlementRule: "Resolve YES if Lakers win.",
  };

  const id = buildDeduplicationIdentity(candidate);
  const digest = computeStatementDigest(candidate);

  const existingIntent: MarketCreationIntent = {
    id,
    statementDigest: digest,
    question: candidate.question!,
    resolutionUrl: candidate.resolutionUrl!,
    deadline: "2026-12-25T20:00:00.000Z",
    category: "sports",
    status: "reviewed",
    aliases: [candidate.question!],
    createdAt: Date.now() - 1000,
    updatedAt: Date.now() - 1000,
  };

  const result = reconcileSubmission(candidate, [existingIntent]);
  assert.equal(result.action, "duplicate");
  assert.equal(result.intentId, id);
});

test("reconcileSubmission reconciles ambiguous wording variants into the canonical intent", () => {
  const canonicalIntent: MarketCreationIntent = {
    id: "canonical-intent-123",
    statementDigest: "a".repeat(64),
    question: "Will Apple close up on the day?",
    resolutionUrl: "https://stockanalysis.com/stocks/aapl/",
    deadline: "2026-11-20T21:00:00.000Z",
    category: "stocks",
    status: "reviewed",
    aliases: ["Will Apple close up on the day?"],
    createdAt: Date.now() - 2000,
    updatedAt: Date.now() - 2000,
  };

  // Ambiguous phrasing with diacritics/punctuation/casing variations
  const ambiguousSubmission: CandidateLike = {
    question: "Does Apple close up on the day???",
    resolutionUrl: "https://stockanalysis.com/stocks/aapl",
    deadline: "2026-11-20T21:00:00.000Z",
    category: "stocks",
  };

  const result = reconcileSubmission(ambiguousSubmission, [canonicalIntent]);
  assert.equal(result.action, "reconcile");
  assert.equal(result.intentId, canonicalIntent.id);
  assert.equal(result.matchedBy, "normalized_question");
  assert.ok(canonicalIntent.aliases?.includes("Does Apple close up on the day???"));
});

test("reconcileSubmission reconciles ambiguous submissions against on-chain active claims", () => {
  const existingClaims: ExistingClaimSignature[] = [
    {
      id: 42,
      category: "crypto",
      questionKey: normalizeComparableText("bitcoin exceed 100000 usd"),
      resolutionUrlKey: normalizeResolutionUrl("https://www.coingecko.com/en/coins/bitcoin"),
    },
  ];

  const candidate: CandidateLike = {
    question: "Will BTC exceed $100k?",
    resolutionUrl: "https://coingecko.com/en/coins/bitcoin",
    deadline: "2026-12-31T00:00:00Z",
    category: "crypto",
  };

  const result = reconcileSubmission(candidate, [], existingClaims);
  assert.equal(result.action, "reconcile");
  assert.equal(result.matchedBy, "existing_claim");
  assert.equal(result.existingClaimId, 42);
  assert.equal(result.intent.claimId, 42);
  assert.equal(result.intent.status, "reconciled");
});

test("DurableIntentStore persists reviewed statement digest to disk across restarts", () => {
  const stateDir = makeTempDir();
  try {
    const store1 = new DurableIntentStore({ stateDir });

    const candidate: CandidateLike = {
      question: "Will Paris exceed 30C on July 14, 2026?",
      resolutionUrl: "https://api.open-meteo.com/v1/forecast?latitude=48.85&longitude=2.35",
      deadline: "2026-07-14T18:00:00Z",
      category: "weather",
      creatorPosition: "Yes — maximum temperature >= 30.0C",
      counterPosition: "No — maximum temperature < 30.0C",
      settlementRule: "Resolve YES if daily maximum >= 30.0C in weather feed.",
      qualityScore: 85,
    };

    const digest = computeStatementDigest(candidate);
    const persisted = store1.persistReviewedDigest(candidate, digest);

    assert.equal(persisted.status, "reviewed");
    assert.equal(persisted.statementDigest, digest);

    // Verify file exists on disk
    const filePath = path.join(stateDir, "creation-intents.json");
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(Array.isArray(parsed), true);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].statementDigest, digest);

    // Simulate process restart: new store instance reading same stateDir
    const store2 = new DurableIntentStore({ stateDir });
    const recovered = store2.getIntent(persisted.id);
    assert.ok(recovered !== null);
    assert.equal(recovered?.id, persisted.id);
    assert.equal(recovered?.statementDigest, digest);
    assert.equal(recovered?.status, "reviewed");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("prepareForSigning validates persisted reviewed statement digest before signing", () => {
  const stateDir = makeTempDir();
  try {
    const store = new DurableIntentStore({ stateDir });

    const candidate: CandidateLike = {
      question: "Will ETH reach $4000 before end of month?",
      resolutionUrl: "https://www.coingecko.com/en/coins/ethereum",
      deadline: "2026-11-30T23:59:59Z",
      category: "crypto",
    };

    const digest = computeStatementDigest(candidate);
    const intent = store.persistReviewedDigest(candidate, digest);

    // Success path: digest matches persisted digest
    const signingIntent = store.prepareForSigning(intent.id, digest);
    assert.equal(signingIntent.status, "signing");

    // Success: mark created on-chain
    const createdIntent = store.markCreated(intent.id, 999, "0xtxhash123");
    assert.equal(createdIntent.status, "created");
    assert.equal(createdIntent.claimId, 999);
    assert.equal(createdIntent.txHash, "0xtxhash123");

    // Failure case: re-signing an already created intent fails closed
    assert.throws(
      () => store.prepareForSigning(intent.id, digest),
      /already been created/,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("prepareForSigning fails closed if intent is not persisted or digest was tampered", () => {
  const stateDir = makeTempDir();
  try {
    const store = new DurableIntentStore({ stateDir });

    // 1. Unpersisted intent fails closed
    assert.throws(
      () => store.prepareForSigning("non-existent-id"),
      /no persisted intent found/,
    );

    // 2. Digest mismatch / statement tampering fails closed
    const candidate: CandidateLike = {
      question: "Will AAPL close green?",
      resolutionUrl: "https://stockanalysis.com/stocks/aapl",
      deadline: "2026-11-20T21:00:00Z",
    };

    const legitimateDigest = computeStatementDigest(candidate);
    const intent = store.persistReviewedDigest(candidate, legitimateDigest);

    const tamperedDigest = "f".repeat(64);
    assert.throws(
      () => store.prepareForSigning(intent.id, tamperedDigest),
      /Statement digest mismatch/,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("filterDuplicateCandidates handles existing claims, Sets, and ambiguous submissions", () => {
  const existingClaims: ExistingClaimSignature[] = [
    {
      id: 10,
      category: "crypto",
      questionKey: normalizeComparableText("bitcoin reach 100000 usd"),
      resolutionUrlKey: normalizeResolutionUrl("https://www.coingecko.com/en/coins/bitcoin"),
    },
  ];

  const candidates: CandidateLike[] = [
    // 1. Matches existing on-chain claim -> should be dropped
    {
      question: "Will Bitcoin reach $100k?",
      resolutionUrl: "https://www.coingecko.com/en/coins/bitcoin",
      deadline: "2026-12-31T00:00:00Z",
      category: "crypto",
    },
    // 2. New unique candidate -> should be kept
    {
      question: "Will SpaceX Starship Flight 7 succeed?",
      resolutionUrl: "https://ll.thespacedevs.com/2.2.0/launch/starship-flight-7/",
      deadline: "2026-06-01T12:00:00Z",
      category: "technology",
    },
    // 3. Ambiguous variation of candidate 2 within the same batch -> should be reconciled/dropped
    {
      question: "Does SpaceX Starship Flight 7 succeed?",
      resolutionUrl: "https://ll.thespacedevs.com/2.2.0/launch/starship-flight-7/",
      deadline: "2026-06-01T12:00:00Z",
      category: "technology",
    },
    // 4. Another new unique candidate -> should be kept
    {
      question: "Will Paris exceed 35C on August 1?",
      resolutionUrl: "https://api.open-meteo.com/v1/forecast?latitude=48.85&longitude=2.35",
      deadline: "2026-08-01T18:00:00Z",
      category: "weather",
    },
  ];

  const filtered = filterDuplicateCandidates(candidates, existingClaims);

  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].question, "Will SpaceX Starship Flight 7 succeed?");
  assert.equal(filtered[1].question, "Will Paris exceed 35C on August 1?");
});

test("createMarketCreationIntent in drafting binds candidate to identity and statement digest", () => {
  const rawDrafts = JSON.stringify([
    {
      question: "Will Solana hit $250 by Friday?",
      resolutionUrl: "https://www.coingecko.com/en/coins/solana",
      deadline: "2026-11-20T23:59:59Z",
      category: "crypto",
      threshold: 250,
    },
  ]);

  const candidates = parseDraftedCandidates(rawDrafts);
  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].statementDigest);
  assert.ok(candidates[0].deduplicationId);

  const intent = createMarketCreationIntent(candidates[0], { qualityScore: 88 });
  assert.equal(intent.id, candidates[0].deduplicationId);
  assert.equal(intent.statementDigest, candidates[0].statementDigest);
  assert.equal(intent.qualityScore, 88);
  assert.equal(intent.status, "draft");
});
