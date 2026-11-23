/**
 * Per-track and combined council consensus (§04).
 *
 * Two juries now vote on the same claim: the classic personas and the philosopher
 * track. Their tallies must be reported separately AND together, because the whole
 * reason for a second track is to see when the two frames disagree — and a single
 * merged number is exactly what hides that.
 *
 * The combined tally weights the two tracks EQUALLY rather than counting heads.
 * Otherwise adding a philosopher moves the combined verdict simply by making that
 * track larger, which would let jury size decide outcomes instead of jury
 * reasoning. Ten philosophers and two classic personas is still one vote each way.
 *
 * Abstentions are counted, never dropped: a claim where most of the jury declined
 * to call it is a different result from one where the jury split, and averaging
 * only the confident voters would report them identically.
 *
 * Deadline abstentions are distinct from substantive abstentions. A persona that
 * ran out of its deliberation budget (`timedOut: true`) did not reason its way to
 * a position, so it is recorded separately in `deadlineAbstentions` rather than
 * being folded into the substantive `abstentions` count. Neither kind carries
 * weight, and a missing vote is never converted into agreement with any verdict.
 */

export type ConsensusVerdict = "creator" | "challengers" | "draw" | "unresolvable" | "abstain";

export interface TrackVote {
  slug: string;
  track: "classic" | "philosopher";
  verdict: ConsensusVerdict;
  /** 0..10000. Weight within its own track. */
  confidenceBps: number;
  /**
   * True when the persona hit its deliberation deadline before producing a
   * verdict. Such a vote is treated as a deadline abstention, not a substantive one.
   */
  timedOut?: boolean;
}

export interface Tally {
  /** Votes per verdict. */
  counts: Record<ConsensusVerdict, number>;
  /** Confidence-weighted share per verdict, in bps of the track's total weight. */
  weightBps: Record<ConsensusVerdict, number>;
  /** Verdict with the most weight, or null when nothing carries weight. */
  leading: ConsensusVerdict | null;
  /** Leading verdict's share of the total weight, in bps. */
  leadingBps: number;
  voters: number;
  /** Voters who declined to call it on substance. */
  abstentions: number;
  /** Voters whose deliberation hit its deadline before a verdict was reached. */
  deadlineAbstentions: number;
}

export interface ConsensusReport {
  classic: Tally;
  philosopher: Tally;
  /** Both tracks, each contributing half the weight regardless of size. */
  combined: Tally;
  /** True when the two tracks lead on different verdicts — the interesting case. */
  tracksDisagree: boolean;
  /** True when either track had no voters, so "agreement" would be meaningless. */
  singleTrackOnly: boolean;
}

const VERDICTS: ConsensusVerdict[] = ["creator", "challengers", "draw", "unresolvable", "abstain"];

function emptyRecord(): Record<ConsensusVerdict, number> {
  return { creator: 0, challengers: 0, draw: 0, unresolvable: 0, abstain: 0 };
}

function emptyTally(): Tally {
  return {
    counts: emptyRecord(),
    weightBps: emptyRecord(),
    leading: null,
    leadingBps: 0,
    voters: 0,
    abstentions: 0,
    deadlineAbstentions: 0,
  };
}

/**
 * An abstention carries no confidence weight however confident the persona claims
 * to be about abstaining — otherwise a jury that all abstained would report a
 * confident "abstain" verdict competing with real positions. A deadline timeout
 * likewise carries no weight: a vote that never finished deliberating is not a
 * position on either side.
 */
function voteWeight(vote: TrackVote): number {
  if (vote.verdict === "abstain") return 0;
  if (vote.timedOut) return 0;
  return Math.max(0, Math.min(10_000, Math.trunc(vote.confidenceBps)));
}

function tally(votes: TrackVote[]): Tally {
  const result = emptyTally();
  result.voters = votes.length;

  const rawWeight = emptyRecord();
  let totalWeight = 0;
  for (const vote of votes) {
    if (vote.timedOut) {
      // Deadline abstention: recorded under its own counter, never as a verdict
      // for consensus purposes, so a timeout cannot masquerade as a position.
      result.deadlineAbstentions += 1;
    } else {
      result.counts[vote.verdict] += 1;
      if (vote.verdict === "abstain") result.abstentions += 1;
    }
    const weight = voteWeight(vote);
    rawWeight[vote.verdict] += weight;
    totalWeight += weight;
  }

  if (totalWeight > 0) {
    for (const verdict of VERDICTS) {
      // Integer bps: a share is a display and comparison value, and a float here
      // would make two equal tallies compare unequal.
      result.weightBps[verdict] = Math.round((rawWeight[verdict] * 10_000) / totalWeight);
    }
    result.leading = leadingVerdict(result.weightBps);
    result.leadingBps = result.leading ? result.weightBps[result.leading] : 0;
  }

  return result;
}

/**
 * Highest weight wins; an exact tie has no leader.
 *
 * Returning the first of a tie would make the verdict depend on the order of the
 * verdict list, which is not a fact about the claim.
 */
function leadingVerdict(weightBps: Record<ConsensusVerdict, number>): ConsensusVerdict | null {
  let best: ConsensusVerdict | null = null;
  let bestValue = 0;
  let tied = false;
  for (const verdict of VERDICTS) {
    const value = weightBps[verdict];
    if (value > bestValue) {
      best = verdict;
      bestValue = value;
      tied = false;
    } else if (value === bestValue && value > 0) {
      tied = true;
    }
  }
  return tied ? null : best;
}

export function councilConsensus(votes: TrackVote[]): ConsensusReport {
  const classic = tally(votes.filter((vote) => vote.track === "classic"));
  const philosopher = tally(votes.filter((vote) => vote.track === "philosopher"));

  const combined = emptyTally();
  combined.voters = classic.voters + philosopher.voters;
  combined.abstentions = classic.abstentions + philosopher.abstentions;
  combined.deadlineAbstentions = classic.deadlineAbstentions + philosopher.deadlineAbstentions;
  for (const verdict of VERDICTS) {
    combined.counts[verdict] = classic.counts[verdict] + philosopher.counts[verdict];
  }

  const tracksWithWeight = [classic, philosopher].filter((t) => t.leadingBps > 0 || hasWeight(t));
  if (tracksWithWeight.length > 0) {
    for (const verdict of VERDICTS) {
      // Equal weight per track: adding a philosopher must not move the combined
      // verdict merely by making that jury larger.
      const sum = tracksWithWeight.reduce((acc, t) => acc + t.weightBps[verdict], 0);
      combined.weightBps[verdict] = Math.round(sum / tracksWithWeight.length);
    }
    combined.leading = leadingVerdict(combined.weightBps);
    combined.leadingBps = combined.leading ? combined.weightBps[combined.leading] : 0;
  }

  const singleTrackOnly = classic.voters === 0 || philosopher.voters === 0;
  return {
    classic,
    philosopher,
    combined,
    // Only a disagreement when both tracks actually reached a verdict.
    tracksDisagree:
      !singleTrackOnly &&
      classic.leading !== null &&
      philosopher.leading !== null &&
      classic.leading !== philosopher.leading,
    singleTrackOnly,
  };
}

function hasWeight(t: Tally): boolean {
  return VERDICTS.some((verdict) => t.weightBps[verdict] > 0);
}
