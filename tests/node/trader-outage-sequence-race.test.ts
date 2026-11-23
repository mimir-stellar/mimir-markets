/**
 * Focused automated coverage for deterministic trader outage and sequence-race
 * fixtures:
 * - Simultaneous opportunities competing for daily exposure limits
 * - Exposure boundary and invalid-input guards (integer USDC)
 * - Horizon sequence-read outages and clean recovery
 * - Stale cached sequences (`tx_bad_seq`) and `resync()` recovery
 * - Late submission results (delayed landing and delayed failure)
 * - Out-of-order sequence holes and incident pause/resume kill-switch
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateExposureAuthorization,
  TraderExposureGuard,
} from "../../agents/traders/policy";
import { TraderRaceHarness } from "./trader-outage-fixtures";

test("simultaneous opportunities never exceed authorized daily exposure or duplicate sequences", async () => {
  const limits = { maxPositionUsdc: 25, maxDailyExposureUsdc: 60 };
  const harness = new TraderRaceHarness({ limits, initialLedgerSequence: 500n });

  // Five simultaneous 25 USDC opportunities (125 USDC total) against a 60 USDC daily cap.
  const opportunities = harness.makeOpportunities([25, 25, 25, 25, 25]);
  const outcomes = await harness.attemptSimultaneous(opportunities);

  const landed = outcomes.filter((o) => o.status === "landed");
  const rejected = outcomes.filter((o) => o.status === "policy_rejected");

  assert.equal(landed.length, 2, "only two 25 USDC stakes fit within the 60 USDC daily cap");
  assert.equal(rejected.length, 3);
  assert.ok(rejected.every((o) => o.reason === "exceeds_daily_limit"));

  const sequences = landed.map((o) => o.sequence);
  assert.deepEqual(sequences, [501n, 502n]);
  assert.equal(new Set(sequences).size, sequences.length);

  assert.equal(harness.transport.landedTotalUsdc(), 50);
  assert.equal(harness.exposure.snapshot().committedUsdc, 50);
  assert.equal(harness.exposure.snapshot().inFlightUsdc, 0);
  assert.ok(
    harness.exposure.highWaterExposureUsdc() <= limits.maxDailyExposureUsdc,
    "high-water exposure must never exceed maxDailyExposureUsdc",
  );
  assert.equal(harness.transport.reads(), 1, "ledger sequence is read once across concurrent reservations");
});

test("exposure policy enforces exact integer USDC boundaries and rejects invalid values", () => {
  const limits = { maxPositionUsdc: 25, maxDailyExposureUsdc: 50 };

  // Exact position and daily boundaries are allowed.
  assert.deepEqual(
    evaluateExposureAuthorization(25, { committedUsdc: 25, inFlightUsdc: 0 }, limits),
    { allowed: true, nextInFlightUsdc: 25, totalExposureUsdc: 50 },
  );

  // Exceeding position limit by 1 USDC is rejected.
  assert.deepEqual(
    evaluateExposureAuthorization(26, { committedUsdc: 0, inFlightUsdc: 0 }, limits),
    { allowed: false, reason: "exceeds_position_limit", totalExposureUsdc: 0 },
  );

  // Exceeding daily limit by 1 USDC (accounting for in-flight) is rejected.
  assert.deepEqual(
    evaluateExposureAuthorization(11, { committedUsdc: 20, inFlightUsdc: 20 }, limits),
    { allowed: false, reason: "exceeds_daily_limit", totalExposureUsdc: 40 },
  );

  // Zero, negative, and fractional USDC stakes are rejected.
  for (const invalidStake of [0, -5, 1.5, Number.NaN]) {
    const res = evaluateExposureAuthorization(invalidStake, { committedUsdc: 0, inFlightUsdc: 0 }, limits);
    assert.equal(res.allowed, false);
    if (!res.allowed) assert.equal(res.reason, "invalid_stake");
  }

  // Duplicate reservation keys are rejected without double-counting exposure.
  const guard = new TraderExposureGuard(limits);
  assert.equal(guard.tryReserve("claim:1", 20).allowed, true);
  const dup = guard.tryReserve("claim:1", 20);
  assert.equal(dup.allowed, false);
  if (!dup.allowed) assert.equal(dup.reason, "duplicate_reservation");
  assert.equal(guard.totalExposureUsdc(), 20);
});

test("Horizon read outage releases reserved exposure cleanly and recovers on retry", async () => {
  const limits = { maxPositionUsdc: 30, maxDailyExposureUsdc: 30 };
  const harness = new TraderRaceHarness({ limits, initialLedgerSequence: 200n });
  harness.transport.failNextReads(1, "horizon 503 outage");

  const [first, second] = harness.makeOpportunities([30, 30]);

  const failed = await harness.attemptOpportunity(first);
  assert.equal(failed.status, "sequence_error");
  if (failed.status === "sequence_error") {
    assert.match(failed.message, /horizon 503 outage/);
  }
  assert.equal(harness.exposure.snapshot().inFlightUsdc, 0, "failed reserve must not leak in-flight exposure");
  assert.equal(harness.exposure.snapshot().committedUsdc, 0);

  // Once Horizon recovers, the full 30 USDC limit is still available.
  const recovered = await harness.attemptOpportunity(second);
  assert.equal(recovered.status, "landed");
  if (recovered.status === "landed") {
    assert.equal(recovered.sequence, 201n);
  }
  assert.equal(harness.transport.landedTotalUsdc(), 30);
  assert.equal(harness.exposure.highWaterExposureUsdc(), 30);
});

test("stale sequence (tx_bad_seq) triggers resync and retries without exceeding exposure limits", async () => {
  const limits = { maxPositionUsdc: 20, maxDailyExposureUsdc: 40 };
  const harness = new TraderRaceHarness({
    limits,
    initialLedgerSequence: 300n,
    maxBadSeqRetries: 1,
  });

  const [prime, staleTarget] = harness.makeOpportunities([20, 20]);

  // Prime SequenceManager cache at 301 -> next becomes 302.
  const first = await harness.attemptOpportunity(prime);
  assert.equal(first.status, "landed");
  if (first.status === "landed") assert.equal(first.sequence, 301n);

  // An out-of-band submission advances the authoritative ledger to 305.
  harness.transport.bumpExternalSequence(4n);
  assert.equal(harness.transport.currentSequence(), 305n);

  // Next attempt tries stale 302 -> tx_bad_seq -> resyncs to 306 -> lands.
  const second = await harness.attemptOpportunity(staleTarget);
  assert.equal(second.status, "landed");
  if (second.status === "landed") {
    assert.equal(second.sequence, 306n);
    assert.equal(second.retries, 1);
  }
  assert.equal(harness.transport.landedTotalUsdc(), 40);
  assert.equal(harness.exposure.highWaterExposureUsdc(), 40);
  assert.deepEqual(harness.sequences.holes(harness.walletAddress), []);
});

test("late submission results hold in-flight exposure so concurrent opportunities cannot breach limits", async () => {
  const limits = { maxPositionUsdc: 25, maxDailyExposureUsdc: 40 };
  const harness = new TraderRaceHarness({ limits, initialLedgerSequence: 400n });

  // First submission is delayed (late result).
  harness.transport.enqueueSubmit({ kind: "deferred" });

  const [lateOpp, blockedOpp, fittingOpp] = harness.makeOpportunities([25, 20, 15]);

  // Start the late opportunity; it reserves 25 USDC in-flight and sequence 401.
  const latePromise = harness.attemptOpportunity(lateOpp);
  await harness.transport.waitForPendingSubmissions(1);

  assert.equal(harness.transport.pendingSubmissions().length, 1);
  assert.equal(harness.exposure.snapshot().inFlightUsdc, 25);

  // While 25 USDC is in-flight, a 20 USDC opportunity would reach 45 > 40 and must be rejected.
  const blocked = await harness.attemptOpportunity(blockedOpp);
  assert.equal(blocked.status, "policy_rejected");
  if (blocked.status === "policy_rejected") {
    assert.equal(blocked.reason, "exceeds_daily_limit");
  }

  // Resolve the late submission as landed on-chain.
  harness.transport.pendingSubmissions()[0]!.resolveLanded();
  const lateOutcome = await latePromise;
  assert.equal(lateOutcome.status, "landed");
  assert.equal(harness.exposure.snapshot().committedUsdc, 25);
  assert.equal(harness.exposure.snapshot().inFlightUsdc, 0);

  // Now a 15 USDC opportunity fits exactly within the remaining 15 USDC budget.
  const fitting = await harness.attemptOpportunity(fittingOpp);
  assert.equal(fitting.status, "landed");
  assert.equal(harness.transport.landedTotalUsdc(), 40);
  assert.equal(harness.exposure.highWaterExposureUsdc(), 40);
});

test("late submission failure frees exposure and records out-of-order sequence hole until resync", async () => {
  const limits = { maxPositionUsdc: 20, maxDailyExposureUsdc: 40 };
  const harness = new TraderRaceHarness({
    limits,
    initialLedgerSequence: 600n,
    maxBadSeqRetries: 0,
  });

  // Both submissions are deferred so we can resolve them out of order.
  harness.transport.enqueueSubmit({ kind: "deferred" }, { kind: "deferred" });

  const [oppA, oppB] = harness.makeOpportunities([20, 20]);
  const promiseA = harness.attemptOpportunity(oppA);
  const promiseB = harness.attemptOpportunity(oppB);

  await harness.transport.waitForPendingSubmissions(2);

  assert.equal(harness.transport.pendingSubmissions().length, 2);
  assert.equal(harness.exposure.totalExposureUsdc(), 40);

  // First submission (seq 601) fails late with an RPC outage while 602 is still reserved.
  const [handleA, handleB] = harness.transport.pendingSubmissions();
  handleA!.resolveOutage("rpc dropped connection");
  const outcomeA = await promiseA;

  assert.equal(outcomeA.status, "submit_failed");
  assert.deepEqual(
    harness.sequences.holes(harness.walletAddress),
    [601n],
    "releasing an older sequence while a newer one is pending records a hole",
  );
  assert.equal(harness.exposure.snapshot().inFlightUsdc, 20, "failed submission released its 20 USDC");

  // Second submission (seq 602) now fails with tx_bad_seq because 601 never landed.
  handleB!.resolveLanded();
  const outcomeB = await promiseB;
  assert.equal(outcomeB.status, "submit_failed");
  if (outcomeB.status === "submit_failed") {
    assert.equal(outcomeB.reason, "tx_bad_seq");
  }
  assert.equal(harness.exposure.totalExposureUsdc(), 0);
  assert.equal(harness.transport.landedTotalUsdc(), 0);

  // After an external fill advances the ledger past 601, resync clears the hole.
  harness.transport.bumpExternalSequence(2n);
  await harness.sequences.resync(harness.walletAddress);
  assert.deepEqual(harness.sequences.holes(harness.walletAddress), []);
});

test("pause halts new sequence reservations while in-flight submissions finish within limits", async () => {
  const limits = { maxPositionUsdc: 25, maxDailyExposureUsdc: 50 };
  const harness = new TraderRaceHarness({ limits, initialLedgerSequence: 700n });
  harness.transport.enqueueSubmit({ kind: "deferred" });

  const [inFlightOpp, pausedOpp, resumedOpp] = harness.makeOpportunities([25, 25, 25]);
  const inFlightPromise = harness.attemptOpportunity(inFlightOpp);
  await harness.transport.waitForPendingSubmissions(1);

  // Trigger incident kill-switch while inFlightOpp is still pending.
  harness.sequences.pause();
  const blockedByPause = await harness.attemptOpportunity(pausedOpp);
  assert.equal(blockedByPause.status, "sequence_error");
  if (blockedByPause.status === "sequence_error") {
    assert.match(blockedByPause.message, /paused/);
  }
  assert.equal(harness.exposure.snapshot().inFlightUsdc, 25, "paused rejection released its reservation");

  // In-flight submission still settles cleanly.
  harness.transport.pendingSubmissions()[0]!.resolveLanded();
  const settled = await inFlightPromise;
  assert.equal(settled.status, "landed");

  // Resuming allows the remaining 25 USDC budget to be used.
  harness.sequences.resume();
  const afterResume = await harness.attemptOpportunity(resumedOpp);
  assert.equal(afterResume.status, "landed");
  assert.equal(harness.transport.landedTotalUsdc(), 50);
  assert.equal(harness.exposure.highWaterExposureUsdc(), 50);
});
