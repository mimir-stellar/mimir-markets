import assert from "node:assert/strict";
import test from "node:test";

import {
  StatementRevisionError,
  assertStatementApprovedForSigning,
  buildDraftingPrompt,
  buildRevisionReviewPrompt,
  buildSourceCommitment,
  canonicalStatementRevisionBytes,
  computeStatementRevisionDigest,
  draftClaimCandidates,
  filterUnsafeCryptoThresholds,
  parseDraftedCandidates,
  parseRevisionReviewResponse,
  reviewDraftedCandidates,
  reviewStatementRevision,
  signApprovedCandidate,
  verifyStatementForSigning,
  type ClaimCandidate,
} from "../../agents/market-creator/drafting";
import {
  buildCandidateSignature,
  canonicaliseResolutionSourceUrl,
  canonicaliseStatementDeadline,
  filterDuplicateCandidates,
} from "../../agents/market-creator/dedupe";

const BASE_SOURCE_TEXT =
  "Bitcoin (BTC, slug=bitcoin): $96,450.00 as of 2026-11-20T12:00:00.000Z";

function makeCandidate(overrides: Partial<ClaimCandidate> = {}): ClaimCandidate {
  return {
    question: "Will Bitcoin trade above $98,000 at 2026-11-22T12:00:00Z?",
    resolutionUrl: "https://www.coingecko.com/en/coins/bitcoin",
    deadline: "2026-11-22T12:00:00.000Z",
    category: "crypto",
    threshold: 98_000,
    settlementRule:
      "Resolve YES if CoinGecko reports BTC above $98,000 at the deadline.",
    creatorPosition: "Yes — momentum holds above $98,000",
    counterPosition: "No — BTC stays at or below $98,000",
    ...overrides,
  };
}

// ── Digest binding: wording, deadline, and source commitment ──────────────────

test("reviewStatementRevision binds approved wording, deadline, and source commitment to a SHA-256 digest", () => {
  const draft = makeCandidate();
  const review = reviewStatementRevision(draft, {
    sourceText: BASE_SOURCE_TEXT,
    reviewer: "creator-reviewer",
  });

  assert.equal(review.approved, true);
  assert.match(review.digest, /^[0-9a-f]{64}$/);
  assert.equal(review.statementDigest, review.digest);
  assert.match(review.sourceCommitment, /^[0-9a-f]{64}$/);
  assert.equal(review.revised, false);
  assert.deepEqual(review.revisedFields, []);

  assert.equal(review.statement.question, draft.question);
  assert.equal(review.statement.wording, draft.question);
  assert.equal(review.statement.deadline, "2026-11-22T12:00:00.000Z");
  assert.equal(review.statement.resolutionUrl, draft.resolutionUrl);
  assert.equal(
    review.statement.sourceCommitment,
    buildSourceCommitment({
      resolutionUrl: draft.resolutionUrl,
      sourceText: BASE_SOURCE_TEXT,
    }),
  );

  // Recomputing the digest over the approved statement yields the exact bound digest.
  assert.equal(
    computeStatementRevisionDigest(review.statement),
    review.digest,
  );
});

test("reviewStatementRevision records revised fields and binds the revised values into the digest", () => {
  const draft = makeCandidate({
    question: "  Will Bitcoin top $98k soon?  ",
    deadline: "2026-11-22T12:00:00Z",
  });
  const unrevisedReview = reviewStatementRevision(draft, {
    sourceText: BASE_SOURCE_TEXT,
  });

  const revisedReview = reviewStatementRevision(draft, {
    sourceText: BASE_SOURCE_TEXT,
    revision: {
      question: "Will Bitcoin trade above $99,500 at 2026-11-22T18:00:00.000Z?",
      deadline: "2026-11-22T18:00:00.000Z",
      threshold: 99_500,
    },
  });

  assert.equal(revisedReview.revised, true);
  assert.deepEqual(revisedReview.revisedFields, [
    "question",
    "deadline",
    "threshold",
  ]);
  assert.notEqual(revisedReview.digest, unrevisedReview.digest);
  assert.equal(
    revisedReview.candidate.question,
    "Will Bitcoin trade above $99,500 at 2026-11-22T18:00:00.000Z?",
  );
  assert.equal(revisedReview.candidate.deadline, "2026-11-22T18:00:00.000Z");
  assert.equal(revisedReview.candidate.threshold, 99_500);
});

test("source commitment changes when either the resolution URL or the source text snapshot changes", () => {
  const baseCommitment = buildSourceCommitment({
    resolutionUrl: "https://www.coingecko.com/en/coins/bitcoin",
    sourceText: "BTC: $96,450",
  });
  const differentUrlCommitment = buildSourceCommitment({
    resolutionUrl: "https://www.coingecko.com/en/coins/ethereum",
    sourceText: "BTC: $96,450",
  });
  const differentSourceTextCommitment = buildSourceCommitment({
    resolutionUrl: "https://www.coingecko.com/en/coins/bitcoin",
    sourceText: "BTC: $97,100",
  });

  assert.notEqual(baseCommitment, differentUrlCommitment);
  assert.notEqual(baseCommitment, differentSourceTextCommitment);
  assert.notEqual(differentUrlCommitment, differentSourceTextCommitment);
});

// ── Pre-signing verification: positive path ───────────────────────────────────

test("signApprovedCandidate invokes the signer when no reviewed statement field changed", async () => {
  const review = reviewStatementRevision(makeCandidate(), {
    sourceText: BASE_SOURCE_TEXT,
  });

  let signerCalls = 0;
  const txResult = await signApprovedCandidate(
    review.candidate,
    review,
    async (approved, meta) => {
      signerCalls += 1;
      assert.equal(meta.digest, review.digest);
      assert.equal(approved.question, review.statement.question);
      assert.equal(approved.deadline, review.statement.deadline);
      assert.equal(approved.sourceCommitment, review.statement.sourceCommitment);
      return { claimId: 42, txHash: "deadbeef".repeat(8) };
    },
  );

  assert.equal(signerCalls, 1);
  assert.equal(txResult.claimId, 42);
});

// ── Pre-signing verification: reject signing if any reviewed field changed ────

test("rejects signing if the approved question wording changed after review", async () => {
  const review = reviewStatementRevision(makeCandidate(), {
    sourceText: BASE_SOURCE_TEXT,
  });

  const tampered = {
    ...review.candidate,
    question: "Will Bitcoin trade above $90,000 at 2026-11-22T12:00:00Z?",
  };

  const check = verifyStatementForSigning(tampered, review);
  assert.equal(check.ok, false);
  assert.equal(check.allowed, false);
  assert.equal(check.reason, "statement_modified");
  assert.deepEqual(check.changedFields, ["question"]);

  let signerCalls = 0;
  await assert.rejects(
    () =>
      signApprovedCandidate(tampered, review, () => {
        signerCalls += 1;
        return "signed";
      }),
    (err: unknown) => {
      assert.ok(err instanceof StatementRevisionError);
      assert.equal(err.reason, "statement_modified");
      assert.deepEqual(err.changedFields, ["question"]);
      return true;
    },
  );
  assert.equal(signerCalls, 0);
});

test("rejects signing on subtle wording changes that fuzzy dedupe would ignore (punctuation, case, whitespace)", () => {
  const review = reviewStatementRevision(makeCandidate(), {
    sourceText: BASE_SOURCE_TEXT,
  });

  const variants = [
    // Punctuation removed
    review.statement.question.replace("?", ""),
    // Case changed
    review.statement.question.toLowerCase(),
    // Trailing whitespace appended after approval
    `${review.statement.question} `,
  ];

  for (const mutatedQuestion of variants) {
    const mutated = { ...review.candidate, question: mutatedQuestion };
    const check = verifyStatementForSigning(mutated, review);
    assert.equal(
      check.ok,
      false,
      `expected mutation "${mutatedQuestion}" to be rejected`,
    );
    assert.ok(check.changedFields.includes("question"));
  }
});

test("rejects signing if the reviewed deadline changed after review", async () => {
  const review = reviewStatementRevision(makeCandidate(), {
    sourceText: BASE_SOURCE_TEXT,
  });

  // Shift deadline by 1 second
  const tampered = {
    ...review.candidate,
    deadline: "2026-11-22T12:00:01.000Z",
  };

  const check = verifyStatementForSigning(tampered, review);
  assert.equal(check.ok, false);
  assert.equal(check.reason, "statement_modified");
  assert.deepEqual(check.changedFields, ["deadline"]);

  let signerCalls = 0;
  await assert.rejects(
    () =>
      signApprovedCandidate(tampered, review, () => {
        signerCalls += 1;
        return "signed";
      }),
    (err: unknown) =>
      err instanceof StatementRevisionError &&
      err.changedFields.includes("deadline"),
  );
  assert.equal(signerCalls, 0);
});

test("rejects signing if the resolutionUrl or sourceCommitment changed after review", async () => {
  const weatherUrlNy =
    "https://api.open-meteo.com/v1/forecast?latitude=40.71&longitude=-74.01&daily=temperature_2m_max";
  const weatherUrlLondon =
    "https://api.open-meteo.com/v1/forecast?latitude=51.51&longitude=-0.13&daily=temperature_2m_max";

  const review = reviewStatementRevision(
    makeCandidate({
      question: "Will New York daily high exceed 18°C on 2026-11-22?",
      resolutionUrl: weatherUrlNy,
      category: "weather",
      threshold: undefined,
    }),
    { sourceText: "New York (US) — forecast high 16.5°C on 2026-11-22" },
  );

  // Tamper with query parameters in resolutionUrl
  const urlTampered = {
    ...review.candidate,
    resolutionUrl: weatherUrlLondon,
  };
  const urlCheck = verifyStatementForSigning(urlTampered, review);
  assert.equal(urlCheck.ok, false);
  assert.ok(urlCheck.changedFields.includes("resolutionUrl"));

  // Tamper with sourceCommitment directly while keeping resolutionUrl intact
  const commitmentTampered = {
    ...review.candidate,
    sourceCommitment: "f".repeat(64),
  };
  const commitmentCheck = verifyStatementForSigning(commitmentTampered, review);
  assert.equal(commitmentCheck.ok, false);
  assert.deepEqual(commitmentCheck.changedFields, ["sourceCommitment"]);

  let signerCalls = 0;
  await assert.rejects(
    () =>
      signApprovedCandidate(commitmentTampered, review, () => {
        signerCalls += 1;
        return "signed";
      }),
    (err: unknown) =>
      err instanceof StatementRevisionError &&
      err.changedFields.includes("sourceCommitment"),
  );
  assert.equal(signerCalls, 0);
});

test("rejects signing if settlementRule, creatorPosition, counterPosition, category, or threshold changed", () => {
  const review = reviewStatementRevision(makeCandidate(), {
    sourceText: BASE_SOURCE_TEXT,
  });

  const fieldMutations: Array<{
    field:
      | "settlementRule"
      | "creatorPosition"
      | "counterPosition"
      | "category"
      | "threshold";
    patch: Partial<ClaimCandidate>;
  }> = [
    {
      field: "settlementRule",
      patch: {
        settlementRule:
          "Resolve YES if CoinGecko reports BTC above $85,000 at deadline.",
      },
    },
    {
      field: "creatorPosition",
      patch: { creatorPosition: "Yes — modified creator position" },
    },
    {
      field: "counterPosition",
      patch: { counterPosition: "No — modified counter position" },
    },
    {
      field: "category",
      patch: { category: "stocks" },
    },
    {
      field: "threshold",
      patch: { threshold: 95_000 },
    },
  ];

  for (const { field, patch } of fieldMutations) {
    const mutated = { ...review.candidate, ...patch };
    const check = verifyStatementForSigning(mutated, review);
    assert.equal(check.ok, false, `expected ${field} mutation to be rejected`);
    assert.deepEqual(check.changedFields, [field]);
    assert.throws(
      () => assertStatementApprovedForSigning(mutated, review),
      (err: unknown) =>
        err instanceof StatementRevisionError &&
        err.changedFields.includes(field),
    );
  }
});

test("rejects signing when candidate is mutated in place and verified without a separate review argument", () => {
  const review = reviewStatementRevision(makeCandidate(), {
    sourceText: BASE_SOURCE_TEXT,
  });

  // Mutate the candidate in place
  review.candidate.question =
    "Will Bitcoin trade above $105,000 at 2026-11-22T12:00:00Z?";

  const singleArgCheck = verifyStatementForSigning(review.candidate);
  assert.equal(singleArgCheck.ok, false);
  assert.equal(singleArgCheck.reason, "statement_modified");
  assert.deepEqual(singleArgCheck.changedFields, ["question"]);

  const envelopeCheck = verifyStatementForSigning(review);
  assert.equal(envelopeCheck.ok, false);
  assert.deepEqual(envelopeCheck.changedFields, ["question"]);
});

test("rejects signing when review is missing, unapproved, or has a malformed/forged digest", async () => {
  const unreviewed = makeCandidate();
  const missingCheck = verifyStatementForSigning(unreviewed);
  assert.equal(missingCheck.ok, false);
  assert.equal(missingCheck.reason, "missing_review");

  const rejectedReview = reviewStatementRevision(makeCandidate(), {
    approved: false,
    notes: "ambiguous settlement metric",
  });
  const rejectedCheck = verifyStatementForSigning(
    rejectedReview.candidate,
    rejectedReview,
  );
  assert.equal(rejectedCheck.ok, false);
  assert.equal(rejectedCheck.reason, "review_rejected");

  const validReview = reviewStatementRevision(makeCandidate());
  const badDigestCheck = verifyStatementForSigning(
    validReview.candidate,
    "not-a-sha256-digest",
  );
  assert.equal(badDigestCheck.ok, false);
  assert.equal(badDigestCheck.reason, "invalid_digest");

  const forgedDigestCheck = verifyStatementForSigning(
    validReview.candidate,
    "0".repeat(64),
  );
  assert.equal(forgedDigestCheck.ok, false);
  assert.equal(forgedDigestCheck.reason, "digest_mismatch");
});

// ── Boundary and failure cases ────────────────────────────────────────────────

test("boundary: length framing prevents field-boundary forgery across statement fields", () => {
  // Control characters (newlines or boundary injection) inside question are rejected outright.
  assert.throws(
    () =>
      canonicalStatementRevisionBytes({
        question: "Will A happen?\ndeadline:24:2026-11-22T12:00:00.000Z",
        deadline: "2026-11-22T12:00:00.000Z",
        resolutionUrl: "https://example.com/source",
      }),
    (err: unknown) =>
      err instanceof StatementRevisionError && err.reason === "invalid_wording",
  );

  assert.throws(
    () =>
      canonicalStatementRevisionBytes({
        question: "Line 1\nLine 2",
        deadline: "2026-11-22T12:00:00.000Z",
        resolutionUrl: "https://example.com/source",
      }),
    (err: unknown) =>
      err instanceof StatementRevisionError && err.reason === "invalid_wording",
  );

  const b = canonicalStatementRevisionBytes({
    question: "Will A happen?",
    deadline: "2026-11-22T12:00:00.000Z",
    resolutionUrl: "https://example.com/source",
  });
  assert.ok(b.length > 0);
});

test("boundary: length framing separates colons and delimiters in question vs settlementRule", () => {
  const digestA = computeStatementRevisionDigest({
    question: "Will BTC close above $100k? settlementRule:10:abcdefghij",
    deadline: "2026-11-22T12:00:00.000Z",
    resolutionUrl: "https://www.coingecko.com/en/coins/bitcoin",
    settlementRule: "Exact rule",
  });
  const digestB = computeStatementRevisionDigest({
    question: "Will BTC close above $100k?",
    deadline: "2026-11-22T12:00:00.000Z",
    resolutionUrl: "https://www.coingecko.com/en/coins/bitcoin",
    settlementRule: "settlementRule:10:abcdefghij Exact rule",
  });

  assert.notEqual(digestA, digestB);
});

test("boundary: deadline exactly at reference now is rejected as stale, 1s later is accepted", () => {
  const referenceNow = "2026-11-20T12:00:00.000Z";

  assert.throws(
    () =>
      reviewStatementRevision(
        makeCandidate({ deadline: "2026-11-20T12:00:00.000Z" }),
        { now: referenceNow },
      ),
    (err: unknown) =>
      err instanceof StatementRevisionError &&
      err.reason === "invalid_deadline",
  );

  const justInFuture = reviewStatementRevision(
    makeCandidate({ deadline: "2026-11-20T12:00:01.000Z" }),
    { now: referenceNow },
  );
  assert.equal(justInFuture.approved, true);
  assert.equal(justInFuture.deadline, "2026-11-20T12:00:01.000Z");
});

test("boundary: equivalent deadline formats canonicalise identically while a 1-second shift diverges", () => {
  const isoWithoutMs = "2026-11-22T12:00:00Z";
  const isoWithMs = "2026-11-22T12:00:00.000Z";
  const unixSeconds = Math.floor(Date.parse(isoWithMs) / 1000);

  assert.equal(canonicaliseStatementDeadline(isoWithoutMs), isoWithMs);
  assert.equal(canonicaliseStatementDeadline(unixSeconds), isoWithMs);

  const d1 = computeStatementRevisionDigest(
    makeCandidate({ deadline: isoWithoutMs }),
  );
  const d2 = computeStatementRevisionDigest(
    makeCandidate({ deadline: isoWithMs }),
  );
  const d3 = computeStatementRevisionDigest(
    makeCandidate({ deadline: unixSeconds as unknown as string }),
  );
  const dShifted = computeStatementRevisionDigest(
    makeCandidate({ deadline: (unixSeconds + 1) as unknown as string }),
  );

  assert.equal(d1, d2);
  assert.equal(d2, d3);
  assert.notEqual(d1, dShifted);
});

test("failure: rejects malformed wording, invalid deadlines, non-http URLs, unallowlisted URLs, and unsafe thresholds", () => {
  // Blank wording
  assert.throws(
    () => reviewStatementRevision(makeCandidate({ question: "   " })),
    (err: unknown) =>
      err instanceof StatementRevisionError && err.reason === "invalid_wording",
  );

  // Unpaired UTF-16 surrogate in wording
  assert.throws(
    () =>
      reviewStatementRevision(
        makeCandidate({ question: `Bad surrogate \uD800 in question` }),
      ),
    (err: unknown) =>
      err instanceof StatementRevisionError && err.reason === "invalid_wording",
  );

  // Identical creator and counter positions
  assert.throws(
    () =>
      reviewStatementRevision(
        makeCandidate({
          creatorPosition: "Yes — BTC rises",
          counterPosition: "  yes — btc rises  ",
        }),
      ),
    (err: unknown) =>
      err instanceof StatementRevisionError && err.reason === "invalid_wording",
  );

  // Invalid deadline
  assert.throws(
    () => reviewStatementRevision(makeCandidate({ deadline: "not-a-date" })),
    (err: unknown) =>
      err instanceof StatementRevisionError &&
      err.reason === "invalid_deadline",
  );

  // Non-http(s) resolutionUrl
  assert.equal(canonicaliseResolutionSourceUrl("ftp://example.com/feed"), null);
  assert.equal(canonicaliseResolutionSourceUrl("javascript:alert(1)"), null);
  assert.throws(
    () =>
      reviewStatementRevision(
        makeCandidate({ resolutionUrl: "ftp://example.com/feed" }),
      ),
    (err: unknown) =>
      err instanceof StatementRevisionError && err.reason === "invalid_source",
  );

  // Resolution URL outside allowlist
  assert.throws(
    () =>
      reviewStatementRevision(makeCandidate(), {
        allowedResolutionUrls: ["https://www.coingecko.com/en/coins/ethereum"],
      }),
    (err: unknown) =>
      err instanceof StatementRevisionError && err.reason === "invalid_source",
  );

  // Unsafe crypto threshold (< $1)
  assert.throws(
    () => reviewStatementRevision(makeCandidate({ threshold: 0.25 })),
    (err: unknown) =>
      err instanceof StatementRevisionError &&
      err.reason === "invalid_threshold",
  );
});

// ── End-to-end batch review + post-revision deduplication ─────────────────────

test("reviewDraftedCandidates applies revisions, binds digests, and deduplicates colliding revised statements", async () => {
  const drafted = parseDraftedCandidates(
    JSON.stringify([
      {
        question: "Will BTC exceed $98,000 by 2026-11-22T12:00:00Z?",
        resolutionUrl: "https://www.coingecko.com/en/coins/bitcoin",
        deadline: "2026-11-22T12:00:00Z",
        category: "crypto",
        threshold: 98_000,
      },
      {
        question: "Will Bitcoin trade above $98.5k at noon on Nov 22?",
        resolutionUrl: "https://www.coingecko.com/en/coins/bitcoin",
        deadline: "2026-11-22T12:00:00Z",
        category: "crypto",
        threshold: 98_500,
      },
      {
        question: "Will ETH exceed $3,600 by 2026-11-22T12:00:00Z?",
        resolutionUrl: "https://www.coingecko.com/en/coins/ethereum",
        deadline: "2026-11-22T12:00:00Z",
        category: "crypto",
        threshold: 3_600,
      },
    ]),
  );

  // Reviewer normalises candidate #2 to the same question/threshold as #1 and
  // approves #3 with a tightened wording.
  const reviewed = await reviewDraftedCandidates(drafted, {
    sourceText: BASE_SOURCE_TEXT,
    reviewer: (candidate, index) => {
      if (index === 1) {
        return {
          approved: true,
          question: "Will BTC exceed $98,000 by 2026-11-22T12:00:00Z?",
          threshold: 98_000,
        };
      }
      if (index === 2) {
        return {
          approved: true,
          question:
            "Will Ethereum (ETH) trade above $3,600 at 2026-11-22T12:00:00.000Z?",
        };
      }
      return { approved: true };
    },
  });

  // Candidate #2 collapsed into #1 after revision dedupe, leaving 2 markets.
  assert.equal(reviewed.length, 2);
  assert.equal(
    reviewed[0]?.question,
    "Will BTC exceed $98,000 by 2026-11-22T12:00:00Z?",
  );
  assert.equal(
    reviewed[1]?.question,
    "Will Ethereum (ETH) trade above $3,600 at 2026-11-22T12:00:00.000Z?",
  );

  for (const candidate of reviewed) {
    assert.match(candidate.statementDigest, /^[0-9a-f]{64}$/);
    assert.match(candidate.sourceCommitment, /^[0-9a-f]{64}$/);
    assert.equal(verifyStatementForSigning(candidate).ok, true);
  }
});

test("reviewDraftedCandidates supports an LLM completer and drops rejected candidates", async () => {
  const drafted: ClaimCandidate[] = [
    makeCandidate(),
    makeCandidate({
      question: "Will SOL exceed $220 by 2026-11-22T12:00:00Z?",
      resolutionUrl: "https://www.coingecko.com/en/coins/solana",
      threshold: 220,
    }),
  ];

  const prompt = buildRevisionReviewPrompt(drafted, {
    sourceText: BASE_SOURCE_TEXT,
    category: "crypto",
  });
  assert.match(prompt, /reviewing drafted prediction market statements/i);

  const fakeReviewCompleter = async () =>
    "```json\n" +
    JSON.stringify([
      {
        approved: true,
        question: "Will Bitcoin trade above $98,000 at 2026-11-22T12:00:00.000Z?",
        resolutionUrl: "https://www.coingecko.com/en/coins/bitcoin",
        deadline: "2026-11-22T12:00:00.000Z",
        category: "crypto",
        threshold: 98_000,
      },
      {
        approved: false,
        notes: "No live SOL source in context",
      },
    ]) +
    "\n```";

  const parsedDecisions = parseRevisionReviewResponse(
    await fakeReviewCompleter(),
    drafted,
  );
  assert.equal(parsedDecisions.length, 2);
  assert.equal(parsedDecisions[0]?.approved, true);
  assert.equal(parsedDecisions[1]?.approved, false);

  const approved = await reviewDraftedCandidates(drafted, {
    completer: fakeReviewCompleter,
    sourceText: BASE_SOURCE_TEXT,
  });

  assert.equal(approved.length, 1);
  assert.equal(
    approved[0]?.question,
    "Will Bitcoin trade above $98,000 at 2026-11-22T12:00:00.000Z?",
  );
  assert.equal(verifyStatementForSigning(approved[0]!).ok, true);
});

// ── Regression: existing drafting & dedupe behavior remains compatible ────────

test("regression: existing draftClaimCandidates, filterUnsafeCryptoThresholds, and filterDuplicateCandidates remain compatible", async () => {
  const prompt = buildDraftingPrompt({
    sourceText: BASE_SOURCE_TEXT,
    existingQuestions: ["Will BTC hit $100k?"],
    maxCandidates: 2,
    category: "crypto",
  });
  assert.match(prompt, /Return at most 2 candidates/);

  const rawResponse = JSON.stringify([
    {
      question: "Will BTC trade above $98,000?",
      resolutionUrl: "https://www.coingecko.com/en/coins/bitcoin",
      deadline: "2026-11-22T12:00:00Z",
      category: "crypto",
      threshold: 98_000,
    },
    {
      question: "will btc trade above 98 000",
      resolutionUrl: "https://www.coingecko.com/en/coins/bitcoin/",
      deadline: "2026-11-22T12:00:00.000Z",
      category: "crypto",
      threshold: 98_000,
    },
    {
      question: "Will micro-token exceed $0.001?",
      resolutionUrl: "https://www.coingecko.com/en/coins/micro",
      deadline: "2026-11-22T12:00:00Z",
      category: "crypto",
      threshold: 0.001,
    },
  ]);

  const drafted = await draftClaimCandidates(async () => rawResponse, {
    sourceText: BASE_SOURCE_TEXT,
  });
  assert.equal(drafted.length, 2);
  assert.equal(filterUnsafeCryptoThresholds(drafted).length, 2);

  const seen = new Set<string>();
  const deduped = filterDuplicateCandidates(drafted, seen);
  assert.equal(deduped.length, 1);
  assert.equal(seen.has(buildCandidateSignature(drafted[0]!)), true);
});
