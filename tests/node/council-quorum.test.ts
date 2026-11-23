import assert from "node:assert/strict";
import test from "node:test";

import {
  BALLOT_COMMITMENT_VERSION,
  BallotCommitmentError,
  COUNCIL_BALLOT_COMMITMENT_VERSION,
  DEFAULT_COUNCIL_QUORUM,
  MAX_COUNCIL_QUORUM,
  buildBallot,
  canonicalBallotCommitmentPayload,
  classifyVoteAttempt,
  commitCouncilBallot,
  createBallotCommitment,
  evaluateQuorum,
  isDecisiveVerdict,
  isInvalidQuorumConfig,
  normalizeQuorum,
  shouldFallbackSolo,
  shouldUseCouncil,
  verifyBallotCommitment,
  type ClassifiedVote,
  type VoteAttemptInput,
} from "../../lib/council/quorum";

function attempt(partial: Partial<VoteAttemptInput> & Pick<VoteAttemptInput, "slug">): VoteAttemptInput {
  return {
    claimId: 42,
    expectedClaimId: 42,
    claimState: "active",
    status: "ok",
    verdict: "CREATOR_WINS",
    confidence: 80,
    ...partial,
  };
}

function valid(
  slug: string,
  verdict: "CREATOR_WINS" | "CHALLENGERS_WIN" | "DRAW" | "UNRESOLVABLE" = "CREATOR_WINS",
): ClassifiedVote {
  return classifyVoteAttempt(attempt({ slug, verdict }));
}

// ── normalizeQuorum ───────────────────────────────────────────────────────────

test("normalizeQuorum keeps a positive integer", () => {
  assert.equal(normalizeQuorum(5), 5);
  assert.equal(normalizeQuorum("4"), 4);
});

test("normalizeQuorum defaults invalid values rather than disabling the gate", () => {
  // quorum 0 would accept an empty jury — that must never pass through.
  assert.equal(normalizeQuorum(0), DEFAULT_COUNCIL_QUORUM);
  assert.equal(normalizeQuorum(-1), DEFAULT_COUNCIL_QUORUM);
  assert.equal(normalizeQuorum(Number.NaN), DEFAULT_COUNCIL_QUORUM);
  assert.equal(normalizeQuorum("abc"), DEFAULT_COUNCIL_QUORUM);
  assert.equal(normalizeQuorum(undefined), DEFAULT_COUNCIL_QUORUM);
});

test("normalizeQuorum clamps absurd highs", () => {
  assert.equal(normalizeQuorum(999), MAX_COUNCIL_QUORUM);
});

test("isInvalidQuorumConfig treats missing as ok (use default) and junk as invalid", () => {
  assert.equal(isInvalidQuorumConfig(undefined), false);
  assert.equal(isInvalidQuorumConfig(""), false);
  assert.equal(isInvalidQuorumConfig(3), false);
  assert.equal(isInvalidQuorumConfig(0), true);
  assert.equal(isInvalidQuorumConfig("nope"), true);
});

// ── classifyVoteAttempt ───────────────────────────────────────────────────────

test("a well-formed decisive vote is valid", () => {
  const v = classifyVoteAttempt(attempt({ slug: "Optimist", verdict: "CHALLENGERS_WIN", confidence: 90 }));
  assert.equal(v.disposition, "valid");
  assert.equal(v.slug, "optimist");
  assert.equal(v.decisive, true);
  assert.equal(v.confidence, 90);
});

test("DRAW and UNRESOLVABLE are valid but not decisive", () => {
  const draw = classifyVoteAttempt(attempt({ slug: "a", verdict: "DRAW" }));
  const unr = classifyVoteAttempt(attempt({ slug: "b", verdict: "UNRESOLVABLE" }));
  assert.equal(draw.disposition, "valid");
  assert.equal(draw.decisive, false);
  assert.equal(unr.disposition, "valid");
  assert.equal(unr.decisive, false);
  assert.equal(isDecisiveVerdict("DRAW"), false);
});

test("missing slug or unknown verdict is invalid", () => {
  assert.equal(classifyVoteAttempt(attempt({ slug: "  " })).disposition, "invalid");
  assert.equal(
    classifyVoteAttempt(attempt({ slug: "optimist", verdict: "MAYBE" })).disposition,
    "invalid",
  );
});

test("cancelled claim marks every attempt cancelled", () => {
  const v = classifyVoteAttempt(attempt({ slug: "optimist", claimState: "cancelled" }));
  assert.equal(v.disposition, "cancelled");
  assert.equal(v.decisive, false);
});

test("resolved claim or mismatched claimId is stale", () => {
  assert.equal(
    classifyVoteAttempt(attempt({ slug: "optimist", claimState: "resolved" })).disposition,
    "stale",
  );
  assert.equal(
    classifyVoteAttempt(attempt({ slug: "optimist", claimId: 7, expectedClaimId: 42 })).disposition,
    "stale",
  );
});

test("age past maxAgeMs is stale", () => {
  const v = classifyVoteAttempt(
    attempt({ slug: "optimist", ageMs: 60_000, maxAgeMs: 10_000 }),
  );
  assert.equal(v.disposition, "stale");
});

test("network/timeout/5xx are dependency_failure; 4xx are invalid; 404 is stale", () => {
  assert.equal(
    classifyVoteAttempt(attempt({ slug: "a", status: "timeout" })).disposition,
    "dependency_failure",
  );
  assert.equal(
    classifyVoteAttempt(attempt({ slug: "b", status: "network_error" })).disposition,
    "dependency_failure",
  );
  assert.equal(
    classifyVoteAttempt(attempt({ slug: "c", status: "http_error", httpStatus: 502 })).disposition,
    "dependency_failure",
  );
  assert.equal(
    classifyVoteAttempt(attempt({ slug: "d", status: "http_error", httpStatus: 422 })).disposition,
    "invalid",
  );
  assert.equal(
    classifyVoteAttempt(attempt({ slug: "e", status: "http_error", httpStatus: 404 })).disposition,
    "stale",
  );
});

test("confidence outside 0..100 is clamped on valid votes", () => {
  const hi = classifyVoteAttempt(attempt({ slug: "a", confidence: 250 }));
  const lo = classifyVoteAttempt(attempt({ slug: "b", confidence: -5 }));
  assert.equal(hi.confidence, 100);
  assert.equal(lo.confidence, 0);
});

// ── buildBallot / duplicates ──────────────────────────────────────────────────

test("duplicate persona slugs: first valid wins, rest marked duplicated", () => {
  const { ballot, rejected } = buildBallot([
    valid("optimist", "CREATOR_WINS"),
    valid("optimist", "CHALLENGERS_WIN"),
    valid("doomer", "CREATOR_WINS"),
  ]);
  assert.equal(ballot.length, 2);
  assert.equal(ballot[0].verdict, "CREATOR_WINS");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].disposition, "duplicated");
  assert.equal(rejected[0].decisive, false);
});

// ── evaluateQuorum ────────────────────────────────────────────────────────────

test("positive: enough decisive votes → use_council", () => {
  const eval_ = evaluateQuorum(
    [valid("a"), valid("b"), valid("c", "CHALLENGERS_WIN")],
    3,
    { claimState: "active" },
  );
  assert.equal(eval_.action, "use_council");
  assert.equal(eval_.decisiveCount, 3);
  assert.equal(shouldUseCouncil(eval_), true);
  assert.equal(shouldFallbackSolo(eval_), false);
});

test("negative: below quorum → fallback_solo with auditable reason", () => {
  const eval_ = evaluateQuorum([valid("a"), valid("b", "DRAW")], 3, { claimState: "open" });
  assert.equal(eval_.action, "fallback_solo");
  assert.equal(eval_.decisiveCount, 1);
  assert.match(eval_.reason, /below quorum/);
  assert.equal(shouldFallbackSolo(eval_), true);
});

test("boundary: decisive count exactly equal to quorum passes", () => {
  const votes = [valid("a"), valid("b"), valid("c")];
  const eval_ = evaluateQuorum(votes, 3);
  assert.equal(eval_.action, "use_council");
  assert.equal(eval_.decisiveCount, 3);
  assert.equal(eval_.quorum, 3);
});

test("cancelled claim aborts even if votes look decisive", () => {
  const eval_ = evaluateQuorum(
    [valid("a"), valid("b"), valid("c")],
    3,
    { claimState: "cancelled" },
  );
  assert.equal(eval_.action, "abort_cancelled");
  assert.equal(eval_.ballot.length, 0);
});

test("resolved claim aborts as stale settlement", () => {
  const eval_ = evaluateQuorum([valid("a")], 1, { claimState: "resolved" });
  assert.equal(eval_.action, "abort_resolved");
});

test("strict invalid quorum config aborts instead of normalizing", () => {
  const eval_ = evaluateQuorum([valid("a")], 0, { strictConfig: true });
  assert.equal(eval_.action, "abort_invalid_config");
});

test("dependency failures do not count as decisive and appear in fallback reason", () => {
  const attempts = [
    classifyVoteAttempt(attempt({ slug: "a", status: "timeout" })),
    classifyVoteAttempt(attempt({ slug: "b", status: "http_error", httpStatus: 503 })),
    valid("c"),
  ];
  const eval_ = evaluateQuorum(attempts, 3);
  assert.equal(eval_.action, "fallback_solo");
  assert.equal(eval_.decisiveCount, 1);
  assert.equal(eval_.dispositions.dependency_failure, 2);
  assert.match(eval_.reason, /dependency_failure/);
});

test("duplicates cannot pad the jury past quorum", () => {
  const attempts = [
    valid("optimist"),
    valid("optimist"),
    valid("optimist"),
    valid("doomer"),
  ];
  const eval_ = evaluateQuorum(attempts, 3);
  assert.equal(eval_.action, "fallback_solo");
  assert.equal(eval_.decisiveCount, 2);
  assert.equal(eval_.dispositions.duplicated, 2);
});

test("regression: empty jury never uses council", () => {
  const eval_ = evaluateQuorum([], DEFAULT_COUNCIL_QUORUM);
  assert.equal(eval_.action, "fallback_solo");
  assert.equal(eval_.decisiveCount, 0);
  assert.equal(shouldUseCouncil(eval_), false);
});

// ── paused ────────────────────────────────────────────────────────────────────

test("negative: paused persona is classified as paused, not valid", () => {
  const v = classifyVoteAttempt(attempt({ slug: "optimist", personaPaused: true }));
  assert.equal(v.disposition, "paused");
  assert.equal(v.decisive, false);
  assert.equal(v.verdict, undefined);
  assert.equal(v.confidence, undefined);
});

test("negative: paused claims abort quorum even with decisive votes", () => {
  const eval_ = evaluateQuorum([valid("a"), valid("b"), valid("c")], 3, { claimState: "paused" });
  assert.equal(eval_.action, "abort_paused");
  assert.equal(eval_.ballot.length, 0);
  assert.equal(eval_.decisiveCount, 0);
  assert.match(eval_.reason, /paused/);
});

test("boundary: paused dispositions appear in counts and do not pad quorum", () => {
  const attempts = [
    classifyVoteAttempt(attempt({ slug: "a", personaPaused: true })),
    classifyVoteAttempt(attempt({ slug: "b", personaPaused: true })),
    valid("c"),
  ];
  const eval_ = evaluateQuorum(attempts, 3);
  assert.equal(eval_.action, "fallback_solo");
  assert.equal(eval_.decisiveCount, 1);
  assert.equal(eval_.dispositions.paused, 2);
  assert.match(eval_.reason, /paused/);
  assert.equal(shouldUseCouncil(eval_), false);
});

// ── versioned council ballot commitment ──────────────────────────────────────

test("createBallotCommitment binds version, participant identities, claim revision, and eligible vote set", () => {
  const boundaryMs = 1_750_000_000_000;
  const votes = [
    classifyVoteAttempt(
      attempt({
        slug: "optimist",
        participantAddress: "GOPTIMIST11111111111111111111111111111111111111111111111",
        claimRevision: "rev-3",
        expectedClaimRevision: "rev-3",
        eligibleVoteSet: ["optimist", "doomer", "statistician"],
        recordedAtMs: boundaryMs - 1_000,
        votingBoundaryMs: boundaryMs,
        verdict: "CREATOR_WINS",
        confidence: 85,
      }),
    ),
    classifyVoteAttempt(
      attempt({
        slug: "doomer",
        participantAddress: "GDOOMER2222222222222222222222222222222222222222222222222",
        claimRevision: "rev-3",
        expectedClaimRevision: "rev-3",
        eligibleVoteSet: ["optimist", "doomer", "statistician"],
        recordedAtMs: boundaryMs - 500,
        votingBoundaryMs: boundaryMs,
        verdict: "CHALLENGERS_WIN",
        confidence: 78,
      }),
    ),
    classifyVoteAttempt(
      attempt({
        slug: "statistician",
        participantAddress: "GSTATS33333333333333333333333333333333333333333333333333",
        claimRevision: "rev-3",
        expectedClaimRevision: "rev-3",
        eligibleVoteSet: ["optimist", "doomer", "statistician"],
        recordedAtMs: boundaryMs,
        votingBoundaryMs: boundaryMs,
        verdict: "CREATOR_WINS",
        confidence: 92,
      }),
    ),
  ];

  const commitment = createBallotCommitment({
    claimId: 42,
    claimRevision: "rev-3",
    eligibleVoteSet: ["statistician", "optimist", "doomer"],
    participantIdentities: [
      { slug: "statistician", address: "GSTATS33333333333333333333333333333333333333333333333333", track: "classic" },
      { slug: "optimist", address: "GOPTIMIST11111111111111111111111111111111111111111111111", track: "classic" },
      { slug: "doomer", address: "GDOOMER2222222222222222222222222222222222222222222222222", track: "classic" },
    ],
    votingBoundaryMs: boundaryMs,
    votes,
  });

  assert.equal(commitment.version, COUNCIL_BALLOT_COMMITMENT_VERSION);
  assert.equal(BALLOT_COMMITMENT_VERSION, 1);
  assert.equal(commitment.claimId, 42);
  assert.equal(commitment.claimRevision, "rev-3");
  assert.deepEqual(commitment.eligibleVoteSet, ["doomer", "optimist", "statistician"]);
  assert.equal(commitment.ballot.length, 3);
  assert.match(commitment.commitmentHash, /^[0-9a-f]{64}$/);
  assert.equal(commitment.digest, commitment.commitmentHash);
  assert.match(canonicalBallotCommitmentPayload(commitment), /^mimir-council-ballot-commitment\nversion:1\n/);

  // Re-ordering eligibleVoteSet / participantIdentities produces the same canonical commitment digest.
  const reordered = commitCouncilBallot({
    claimId: 42,
    claimRevision: "rev-3",
    eligibleVoteSet: ["doomer", "optimist", "statistician"],
    participantIdentities: [
      { slug: "doomer", address: "GDOOMER2222222222222222222222222222222222222222222222222", track: "classic" },
      { slug: "optimist", address: "GOPTIMIST11111111111111111111111111111111111111111111111", track: "classic" },
      { slug: "statistician", address: "GSTATS33333333333333333333333333333333333333333333333333", track: "classic" },
    ],
    votingBoundaryMs: boundaryMs,
    votes,
  });
  assert.equal(reordered.commitmentHash, commitment.commitmentHash);

  const eval_ = evaluateQuorum(votes, 3, {
    claimState: "active",
    commitment,
    claimId: 42,
    claimRevision: "rev-3",
    eligibleVoteSet: ["optimist", "doomer", "statistician"],
    votingBoundaryMs: boundaryMs,
  });
  assert.equal(eval_.action, "use_council");
  assert.equal(eval_.commitmentValid, true);
  assert.equal(eval_.commitment?.commitmentHash, commitment.commitmentHash);
  assert.equal(shouldUseCouncil(eval_), true);
});

test("rejects ballots altered after the approved voting boundary before outcome evaluation", () => {
  const boundaryMs = 1_750_000_000_000;
  const originalVotes = [
    classifyVoteAttempt(attempt({ slug: "optimist", verdict: "CREATOR_WINS", confidence: 80, recordedAtMs: boundaryMs - 200 })),
    classifyVoteAttempt(attempt({ slug: "doomer", verdict: "CREATOR_WINS", confidence: 85, recordedAtMs: boundaryMs - 100 })),
    classifyVoteAttempt(attempt({ slug: "statistician", verdict: "CREATOR_WINS", confidence: 90, recordedAtMs: boundaryMs })),
  ];

  const commitment = createBallotCommitment({
    claimId: 42,
    claimRevision: 5,
    eligibleVoteSet: ["optimist", "doomer", "statistician", "pessimist"],
    votingBoundaryMs: boundaryMs,
    votes: originalVotes,
  });

  // 1. Verdict flipped after the voting boundary.
  const verdictFlipped = [
    originalVotes[0]!,
    { ...originalVotes[1]!, verdict: "CHALLENGERS_WIN" as const },
    originalVotes[2]!,
  ];
  const evalFlipped = evaluateQuorum(verdictFlipped, 3, { commitment });
  assert.equal(evalFlipped.action, "abort_invalid_commitment");
  assert.equal(evalFlipped.commitmentValid, false);
  assert.equal(evalFlipped.commitmentFailureReason, "altered_after_boundary");
  assert.equal(evalFlipped.ballot.length, 0);
  assert.equal(shouldUseCouncil(evalFlipped), false);

  // 2. Confidence altered after the voting boundary.
  const confidenceAltered = [
    { ...originalVotes[0]!, confidence: 99 },
    originalVotes[1]!,
    originalVotes[2]!,
  ];
  const evalConfidence = evaluateQuorum(confidenceAltered, 3, { commitment });
  assert.equal(evalConfidence.action, "abort_invalid_commitment");
  assert.equal(evalConfidence.commitmentFailureReason, "altered_after_boundary");

  // 3. Late vote injected after the approved voting boundary.
  const lateVoteAdded = [
    ...originalVotes,
    classifyVoteAttempt(attempt({ slug: "pessimist", verdict: "CHALLENGERS_WIN", confidence: 88, recordedAtMs: boundaryMs - 50 })),
  ];
  const evalAdded = evaluateQuorum(lateVoteAdded, 3, { commitment });
  assert.equal(evalAdded.action, "abort_invalid_commitment");
  assert.equal(evalAdded.commitmentFailureReason, "altered_after_boundary");

  // 4. Vote timestamp shows modification after the approved voting boundary.
  const postBoundaryTimestamp = [
    originalVotes[0]!,
    { ...originalVotes[1]!, alteredAtMs: boundaryMs + 1 },
    originalVotes[2]!,
  ];
  const evalPostTimestamp = evaluateQuorum(postBoundaryTimestamp, 3, { commitment });
  assert.equal(evalPostTimestamp.action, "abort_invalid_commitment");
  assert.equal(evalPostTimestamp.commitmentFailureReason, "altered_after_boundary");
});

test("boundary: vote recorded exactly at votingBoundaryMs passes; 1ms after is rejected", () => {
  const boundaryMs = 1_750_000_000_000;
  const exactBoundaryVote = classifyVoteAttempt(
    attempt({
      slug: "optimist",
      recordedAtMs: boundaryMs,
      alteredAtMs: boundaryMs,
      votingBoundaryMs: boundaryMs,
    }),
  );
  assert.equal(exactBoundaryVote.disposition, "valid");

  const oneMsLateRecorded = classifyVoteAttempt(
    attempt({
      slug: "optimist",
      recordedAtMs: boundaryMs + 1,
      votingBoundaryMs: boundaryMs,
    }),
  );
  assert.equal(oneMsLateRecorded.disposition, "stale");
  assert.match(oneMsLateRecorded.reason, /after approved voting boundary/);

  const oneMsLateAltered = classifyVoteAttempt(
    attempt({
      slug: "optimist",
      recordedAtMs: boundaryMs - 10,
      alteredAtMs: boundaryMs + 1,
      votingBoundaryMs: boundaryMs,
    }),
  );
  assert.equal(oneMsLateAltered.disposition, "invalid");
  assert.match(oneMsLateAltered.reason, /altered.*after approved voting boundary/);

  assert.throws(
    () =>
      createBallotCommitment({
        claimId: 42,
        claimRevision: 1,
        eligibleVoteSet: ["optimist"],
        votingBoundaryMs: boundaryMs,
        votes: [{ ...exactBoundaryVote, alteredAtMs: boundaryMs + 1 }],
      }),
    (err: unknown) =>
      err instanceof BallotCommitmentError && err.reason === "altered_after_boundary",
  );
});

test("rejects mismatched claim revision, eligible vote set, participant identities, and unsupported version", () => {
  const boundaryMs = 1_750_000_000_000;
  const votes = [
    classifyVoteAttempt(
      attempt({
        slug: "optimist",
        participantAddress: "GOPT111",
        claimRevision: 2,
        expectedClaimRevision: 2,
        recordedAtMs: boundaryMs - 100,
      }),
    ),
    classifyVoteAttempt(
      attempt({
        slug: "doomer",
        participantAddress: "GDOOM222",
        claimRevision: 2,
        expectedClaimRevision: 2,
        recordedAtMs: boundaryMs - 50,
      }),
    ),
    classifyVoteAttempt(
      attempt({
        slug: "statistician",
        participantAddress: "GSTAT333",
        claimRevision: 2,
        expectedClaimRevision: 2,
        recordedAtMs: boundaryMs,
      }),
    ),
  ];

  const commitment = createBallotCommitment({
    claimId: 42,
    claimRevision: 2,
    eligibleVoteSet: ["optimist", "doomer", "statistician"],
    participantIdentities: [
      { slug: "optimist", address: "GOPT111" },
      { slug: "doomer", address: "GDOOM222" },
      { slug: "statistician", address: "GSTAT333" },
    ],
    votingBoundaryMs: boundaryMs,
    votes,
  });

  // Claim revision mismatch at outcome evaluation time.
  const revMismatch = evaluateQuorum(votes, 3, {
    commitment,
    claimRevision: 3,
  });
  assert.equal(revMismatch.action, "abort_invalid_commitment");
  assert.equal(revMismatch.commitmentFailureReason, "claim_revision_mismatch");

  // Eligible vote set mismatch at outcome evaluation time.
  const eligibleMismatch = evaluateQuorum(votes, 3, {
    commitment,
    eligibleVoteSet: ["optimist", "doomer", "statistician", "yapper"],
  });
  assert.equal(eligibleMismatch.action, "abort_invalid_commitment");
  assert.equal(eligibleMismatch.commitmentFailureReason, "eligible_vote_set_mismatch");

  // Participant identity address mismatch.
  const tamperedAddressVotes = [
    { ...votes[0]!, participantAddress: "GWRONG999" },
    votes[1]!,
    votes[2]!,
  ];
  const participantMismatch = evaluateQuorum(tamperedAddressVotes, 3, { commitment });
  assert.equal(participantMismatch.action, "abort_invalid_commitment");
  assert.equal(participantMismatch.commitmentFailureReason, "participant_identity_mismatch");

  // Ineligible voter rejected during commitment creation.
  assert.throws(
    () =>
      createBallotCommitment({
        claimId: 42,
        claimRevision: 2,
        eligibleVoteSet: ["optimist", "doomer"],
        votes,
      }),
    (err: unknown) => err instanceof BallotCommitmentError && err.reason === "ineligible_voter",
  );

  // Unsupported version rejected.
  assert.throws(
    () =>
      createBallotCommitment({
        version: 2,
        claimId: 42,
        claimRevision: 2,
        eligibleVoteSet: ["optimist", "doomer", "statistician"],
        votes,
      }),
    (err: unknown) => err instanceof BallotCommitmentError && err.reason === "invalid_version",
  );

  const badVersionVerify = verifyBallotCommitment(
    { ...commitment, version: 99 },
    votes,
  );
  assert.equal(badVersionVerify.ok, false);
  assert.equal(badVersionVerify.reason, "invalid_version");

  // Tampered digest rejected.
  const badDigestVerify = verifyBallotCommitment(
    { ...commitment, commitmentHash: "0".repeat(64), digest: "0".repeat(64) },
    votes,
  );
  assert.equal(badDigestVerify.ok, false);
  assert.equal(badDigestVerify.reason, "digest_mismatch");
});
