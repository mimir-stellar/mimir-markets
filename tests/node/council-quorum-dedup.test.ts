import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBallot,
  classifyVoteAttempt,
  evaluateQuorum,
  type VoteAttemptInput,
} from "../../lib/council/quorum";

function attempt(
  partial: Partial<VoteAttemptInput> & Pick<VoteAttemptInput, "slug">,
): VoteAttemptInput {
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

test("identical retries preserve the original vote arrival identity and stay idempotent", () => {
  const first = classifyVoteAttempt(
    attempt({
      slug: "optimist",
      verdict: "CREATOR_WINS",
      confidence: 80,
      arrivalId: "req-orig-1",
    }),
  );
  const retry1 = classifyVoteAttempt(
    attempt({
      slug: "optimist",
      verdict: "CREATOR_WINS",
      confidence: 80,
      arrivalId: "req-retry-2",
    }),
  );
  const retry2 = classifyVoteAttempt(
    attempt({
      slug: "optimist",
      verdict: "CREATOR_WINS",
      confidence: 80,
      arrivalId: "req-retry-3",
    }),
  );

  const { ballot, rejected, conflicts } = buildBallot([first, retry1, retry2]);

  assert.equal(ballot.length, 1);
  assert.equal(ballot[0].slug, "optimist");
  assert.equal(ballot[0].arrivalId, "req-orig-1");
  assert.equal(ballot[0].verdict, "CREATOR_WINS");
  assert.equal(ballot[0].confidence, 80);

  assert.equal(conflicts.length, 0);
  assert.equal(rejected.length, 2);
  for (const [idx, dup] of rejected.entries()) {
    assert.equal(dup.disposition, "duplicated");
    assert.equal(dup.decisive, false);
    assert.equal(dup.conflict, false);
    assert.equal(dup.originalArrivalId, "req-orig-1");
    assert.equal(dup.arrivalId, idx === 0 ? "req-retry-2" : "req-retry-3");
    assert.match(dup.reason, /idempotent retry/);
    assert.match(dup.reason, /req-orig-1/);
  }
});

test("conflicting duplicate verdict is surfaced as an explicit inconsistency while preserving original arrival", () => {
  const original = classifyVoteAttempt(
    attempt({
      slug: "doomer",
      verdict: "CREATOR_WINS",
      confidence: 85,
      arrivalId: "arr-first",
    }),
  );
  const conflicting = classifyVoteAttempt(
    attempt({
      slug: "doomer",
      verdict: "CHALLENGERS_WIN",
      confidence: 85,
      arrivalId: "arr-conflict",
    }),
  );

  const { ballot, rejected, conflicts } = buildBallot([original, conflicting]);

  assert.equal(ballot.length, 1);
  assert.equal(ballot[0].arrivalId, "arr-first");
  assert.equal(ballot[0].verdict, "CREATOR_WINS");

  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].disposition, "duplicated");
  assert.equal(rejected[0].conflict, true);
  assert.equal(rejected[0].originalArrivalId, "arr-first");
  assert.equal(rejected[0].arrivalId, "arr-conflict");
  assert.equal(rejected[0].decisive, false);

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].slug, "doomer");
  assert.equal(conflicts[0].originalArrivalId, "arr-first");
  assert.equal(conflicts[0].duplicateArrivalId, "arr-conflict");
  assert.equal(conflicts[0].originalVerdict, "CREATOR_WINS");
  assert.equal(conflicts[0].duplicateVerdict, "CHALLENGERS_WIN");
  assert.equal(conflicts[0].originalConfidence, 85);
  assert.equal(conflicts[0].duplicateConfidence, 85);
  assert.match(conflicts[0].reason, /conflicting duplicate vote/);
});

test("conflicting duplicate confidence is also surfaced as an inconsistency", () => {
  const original = classifyVoteAttempt(
    attempt({
      slug: "contrarian",
      verdict: "CREATOR_WINS",
      confidence: 60,
      arrivalId: "arr-1",
    }),
  );
  const conflicting = classifyVoteAttempt(
    attempt({
      slug: "contrarian",
      verdict: "CREATOR_WINS",
      confidence: 95,
      arrivalId: "arr-2",
    }),
  );

  const { ballot, conflicts } = buildBallot([original, conflicting]);

  assert.equal(ballot.length, 1);
  assert.equal(ballot[0].arrivalId, "arr-1");
  assert.equal(ballot[0].confidence, 60);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].originalConfidence, 60);
  assert.equal(conflicts[0].duplicateConfidence, 95);
});

test("boundary: missing or whitespace-only arrivalId omits arrival fields cleanly", () => {
  const original = classifyVoteAttempt(
    attempt({
      slug: "whale-follow",
      verdict: "CREATOR_WINS",
      confidence: 70,
      arrivalId: "   ",
    }),
  );
  const retry = classifyVoteAttempt(
    attempt({
      slug: "whale-follow",
      verdict: "CREATOR_WINS",
      confidence: 70,
    }),
  );

  assert.equal(original.arrivalId, undefined);
  const { ballot, rejected, conflicts } = buildBallot([original, retry]);
  assert.equal(ballot.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].originalArrivalId, undefined);
  assert.equal(rejected[0].conflict, false);
  assert.equal(conflicts.length, 0);
});

test("evaluateQuorum surfaces conflicts and preserves original arrival identities without padding quorum", () => {
  const attempts = [
    classifyVoteAttempt(
      attempt({ slug: "optimist", verdict: "CREATOR_WINS", confidence: 80, arrivalId: "a-1" }),
    ),
    classifyVoteAttempt(
      attempt({ slug: "optimist", verdict: "CREATOR_WINS", confidence: 80, arrivalId: "a-1-retry" }),
    ),
    classifyVoteAttempt(
      attempt({ slug: "optimist", verdict: "CHALLENGERS_WIN", confidence: 90, arrivalId: "a-1-conflict" }),
    ),
    classifyVoteAttempt(
      attempt({ slug: "doomer", verdict: "CREATOR_WINS", confidence: 75, arrivalId: "a-2" }),
    ),
  ];

  const evaluation = evaluateQuorum(attempts, 3, { claimState: "active" });

  assert.equal(evaluation.action, "fallback_solo");
  assert.equal(evaluation.decisiveCount, 2);
  assert.equal(evaluation.dispositions.duplicated, 2);
  assert.deepEqual(
    evaluation.ballot.map((v) => ({ slug: v.slug, arrivalId: v.arrivalId })),
    [
      { slug: "optimist", arrivalId: "a-1" },
      { slug: "doomer", arrivalId: "a-2" },
    ],
  );
  assert.equal(evaluation.conflicts.length, 1);
  assert.equal(evaluation.conflicts[0].slug, "optimist");
  assert.equal(evaluation.conflicts[0].originalArrivalId, "a-1");
  assert.equal(evaluation.conflicts[0].duplicateArrivalId, "a-1-conflict");
});
