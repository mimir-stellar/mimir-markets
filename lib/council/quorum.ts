/**
 * Council quorum + fallback rules for settlement (äagents / RFB council boundary).
 *
 * `gatherCouncilVerdict` buys persona votes and tallies them. This module is the
 * pure policy layer that decides whether that tally is allowed to settle a claim,
 * or whether the oracle must fall back to its own (solo) verdict — and what to do
 * when a vote is invalid, stale, duplicated, cancelled, or a dependency failure.
 *
 * Chain remains source of truth: a cancelled or already-resolved claim never
 * produces a council settlement from this path. Below-quorum and dependency
 * failures degrade to solo oracle settlement rather than inventing a majority.
 *
 * Pure: no I/O. Callers classify each attempt, then ask {@link evaluateQuorum}.
 */

import { isVerdict, type Verdict } from "../verdict";

/** Claim lifecycle states the quorum gate cares about. */
export type ClaimSettleState = "open" | "active" | "resolved" | "cancelled" | "paused" | "expired";

/**
 * What happened to one persona vote attempt before it may enter the ballot.
 *
 * - **valid** — well-formed verdict for the claim being settled; may be decisive
 *   or an explicit abstention (DRAW / UNRESOLVABLE).
 * - **invalid** — malformed slug/verdict/body; never counts.
 * - **stale** — wrong claim id, already-resolved claim, or aged past maxAgeMs.
 * - **duplicated** — same persona already accepted onto this ballot.
 * - **cancelled** — claim is cancelled; council must not settle it.
 * - **paused** — persona or claim is paused; council must not settle it.
 * - **dependency_failure** — network / timeout / 5xx; treated as abstention for
 *   tally purposes but recorded so fallback reasons stay auditable.
 * - **equivocation** — persona submitted contradictory/conflicting votes.
 * - **expired** — ballot or vote submission deadline has elapsed.
 */
export type VoteDisposition =
  | "valid"
  | "invalid"
  | "stale"
  | "duplicated"
  | "cancelled"
  | "paused"
  | "dependency_failure"
  | "equivocation"
  | "expired";

export type FallbackAction =
  /** Decisive votes met quorum — use the council tally. */
  | "use_council"
  /** Not enough decisive votes (or only dependency failures) — oracle settles solo. */
  | "fallback_solo"
  /** Claim cancelled on-chain — do not settle via council or invent a solo win. */
  | "abort_cancelled"
  /** Claim already resolved — a new council pass would be stale. */
  | "abort_resolved"
  /** Claim is paused — council must not settle it. */
  | "abort_paused"
  /** Ballot or settlement window has expired — council settlement aborted. */
  | "abort_expired"
  /** Quorum config is unusable after normalization refusal. */
  | "abort_invalid_config";

export interface QuorumConfig {
  /**
   * Minimum decisive (CREATOR_WINS | CHALLENGERS_WIN) votes required to trust
   * the council. Defaults to {@link DEFAULT_COUNCIL_QUORUM}.
   */
  quorum: number;
}

/** Default matches `COUNCIL_QUORUM` / oracle worker env. */
export const DEFAULT_COUNCIL_QUORUM = 3;

/** Hard ceiling so a typo cannot demand more jurors than exist. */
export const MAX_COUNCIL_QUORUM = 20;

export interface VoteAttemptInput {
  slug: string;
  /** Claim id the response claims to be about (from body or request). */
  claimId: number;
  /** Claim id the oracle is currently settling. */
  expectedClaimId: number;
  claimState: ClaimSettleState;
  /** True when this persona is currently paused and must not vote. */
  personaPaused?: boolean;
  /**
   * Transport outcome before JSON validation.
   * - `ok` — HTTP 2xx with a body to inspect
   * - `http_error` — non-2xx (see httpStatus)
   * - `network_error` / `timeout` — dependency failure
   */
  status: "ok" | "http_error" | "network_error" | "timeout";
  httpStatus?: number;
  verdict?: unknown;
  confidence?: unknown;
  /** Age of the response when known (ms). */
  ageMs?: number;
  /** Responses older than this are stale (optional). */
  maxAgeMs?: number;
  /** True when this vote submission or ballot is explicitly expired. */
  expired?: boolean;
  /** Deadline timestamp in ms; submission past this is marked expired. */
  ballotDeadlineMs?: number;
  /** Submission timestamp in ms. */
  submittedAtMs?: number;
  /** Explicitly marks this attempt as an equivocation / conflicting vote. */
  equivocated?: boolean;
}

export interface ClassifiedVote {
  slug: string;
  disposition: VoteDisposition;
  reason: string;
  verdict?: Verdict;
  confidence?: number;
  /** True when disposition is valid and verdict is CREATOR_WINS or CHALLENGERS_WIN. */
  decisive: boolean;
}

export interface QuorumEvaluation {
  action: FallbackAction;
  quorum: number;
  decisiveCount: number;
  acceptedCount: number;
  dispositions: Record<VoteDisposition, number>;
  reason: string;
  acceptedSlugs: string[];
  /** Valid votes in ballot order (duplicates / rejects excluded). */
  ballot: ClassifiedVote[];
}

const EMPTY_DISPOSITIONS = (): Record<VoteDisposition, number> => ({
  valid: 0,
  invalid: 0,
  stale: 0,
  duplicated: 0,
  cancelled: 0,
  paused: 0,
  dependency_failure: 0,
  equivocation: 0,
  expired: 0,
});

export function isDecisiveVerdict(verdict: Verdict): boolean {
  return verdict === "CREATOR_WINS" || verdict === "CHALLENGERS_WIN";
}

/**
 * Normalize a raw quorum (env Number, caller override, …).
 *
 * Invalid values (NaN, non-finite, &lt; 1) become the default so a typo cannot
 * silently disable the gate (`quorum: 0` would otherwise accept an empty jury).
 * Values above {@link MAX_COUNCIL_QUORUM} clamp rather than reject — demanding
 * more jurors than the roster has is a config smell, not a settle-time abort.
 */
export function normalizeQuorum(raw: unknown, fallback = DEFAULT_COUNCIL_QUORUM): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(MAX_COUNCIL_QUORUM, Math.trunc(n));
}

/**
 * True when the raw value was unusable (callers that want strict refusal can
 * abort instead of normalizing). Empty / missing is not invalid — it means default.
 */
export function isInvalidQuorumConfig(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === "") return false;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return !Number.isFinite(n) || n < 1;
}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(Math.round(n), 100));
}

/**
 * Classify a single vote attempt. Duplicates are handled by
 * {@link buildBallot} so this function stays order-independent.
 */
export function classifyVoteAttempt(input: VoteAttemptInput): ClassifiedVote {
  const slug = (input.slug ?? "").trim().toLowerCase();
  if (!slug) {
    return {
      slug: "",
      disposition: "invalid",
      reason: "missing persona slug",
      decisive: false,
    };
  }

  if (input.personaPaused) {
    return {
      slug,
      disposition: "paused",
      reason: "persona is paused",
      decisive: false,
    };
  }

  if (input.claimState === "expired" || input.expired) {
    return {
      slug,
      disposition: "expired",
      reason: "ballot or vote submission has expired",
      decisive: false,
    };
  }

  if (
    input.ballotDeadlineMs != null &&
    input.submittedAtMs != null &&
    input.submittedAtMs > input.ballotDeadlineMs
  ) {
    return {
      slug,
      disposition: "expired",
      reason: `vote submitted at ${input.submittedAtMs}ms exceeds deadline ${input.ballotDeadlineMs}ms`,
      decisive: false,
    };
  }

  if (input.equivocated) {
    return {
      slug,
      disposition: "equivocation",
      reason: "conflicting vote attempt detected (equivocation)",
      decisive: false,
    };
  }

  if (input.claimState === "cancelled") {
    return {
      slug,
      disposition: "cancelled",
      reason: "claim is cancelled on-chain",
      decisive: false,
    };
  }

  if (input.claimState === "resolved") {
    return {
      slug,
      disposition: "stale",
      reason: "claim is already resolved",
      decisive: false,
    };
  }

  if (
    !Number.isInteger(input.expectedClaimId) ||
    input.expectedClaimId < 1 ||
    !Number.isInteger(input.claimId) ||
    input.claimId !== input.expectedClaimId
  ) {
    return {
      slug,
      disposition: "stale",
      reason: `vote claimId ${input.claimId} does not match settling claim ${input.expectedClaimId}`,
      decisive: false,
    };
  }

  if (
    input.maxAgeMs != null &&
    Number.isFinite(input.maxAgeMs) &&
    input.maxAgeMs >= 0 &&
    input.ageMs != null &&
    Number.isFinite(input.ageMs) &&
    input.ageMs > input.maxAgeMs
  ) {
    return {
      slug,
      disposition: "stale",
      reason: `vote age ${input.ageMs}ms exceeds maxAgeMs ${input.maxAgeMs}`,
      decisive: false,
    };
  }

  if (input.status === "network_error" || input.status === "timeout") {
    return {
      slug,
      disposition: "dependency_failure",
      reason: input.status === "timeout" ? "vote request timed out" : "vote request network failure",
      decisive: false,
    };
  }

  if (input.status === "http_error") {
    const code = input.httpStatus ?? 0;
    // 5xx / 502-style upstream failures are dependency problems; 4xx are invalid
    // requests or persona/policy refusals — not something retrying the roster fixes.
    if (code >= 500 || code === 0) {
      return {
        slug,
        disposition: "dependency_failure",
        reason: `vote endpoint HTTP ${code || "error"}`,
        decisive: false,
      };
    }
    if (code === 404) {
      return {
        slug,
        disposition: "stale",
        reason: "claim not found at vote endpoint",
        decisive: false,
      };
    }
    return {
      slug,
      disposition: "invalid",
      reason: `vote endpoint HTTP ${code}`,
      decisive: false,
    };
  }

  if (!isVerdict(input.verdict)) {
    return {
      slug,
      disposition: "invalid",
      reason: "missing or unknown verdict",
      decisive: false,
    };
  }

  const confidence = clampConfidence(input.confidence);
  return {
    slug,
    disposition: "valid",
    reason: "accepted",
    verdict: input.verdict,
    confidence,
    decisive: isDecisiveVerdict(input.verdict),
  };
}

export interface BuildBallotOptions {
  /**
   * When true, detecting conflicting verdicts for the same persona treats
   * them as equivocation rather than benign duplicates.
   */
  rejectEquivocation?: boolean;
  /**
   * Strategy when a persona submits conflicting votes:
   * - "disqualify_all": remove prior vote from ballot and reject both attempts
   *   with disposition "equivocation" (conservative default when rejectEquivocation is true).
   * - "reject_subsequent": keep prior vote, reject subsequent conflicting vote as "equivocation".
   * - "drop_duplicate": legacy behavior (keep prior vote, mark subsequent as "duplicated").
   */
  equivocationPolicy?: "disqualify_all" | "reject_subsequent" | "drop_duplicate";
}

/**
 * Fold classified attempts into a ballot: first valid vote per slug wins;
 * later attempts for the same slug are marked duplicated and dropped
 * (or handled according to equivocation policy when configured).
 */
export function buildBallot(
  classified: ClassifiedVote[],
  opts?: BuildBallotOptions,
): {
  ballot: ClassifiedVote[];
  rejected: ClassifiedVote[];
} {
  const policy =
    opts?.equivocationPolicy ??
    (opts?.rejectEquivocation ? "disqualify_all" : "drop_duplicate");

  const seen = new Map<string, ClassifiedVote>();
  const disqualified = new Set<string>();
  const ballot: ClassifiedVote[] = [];
  const rejected: ClassifiedVote[] = [];

  for (const vote of classified) {
    if (vote.disposition !== "valid") {
      rejected.push(vote);
      continue;
    }

    if (disqualified.has(vote.slug)) {
      rejected.push({
        ...vote,
        disposition: "equivocation",
        reason: `persona '${vote.slug}' is disqualified for equivocation`,
        decisive: false,
        verdict: undefined,
        confidence: undefined,
      });
      continue;
    }

    const prior = seen.get(vote.slug);
    if (prior) {
      const isConflict = prior.verdict !== vote.verdict;
      if (!isConflict) {
        // Benign duplicate (same verdict)
        rejected.push({
          ...vote,
          disposition: "duplicated",
          reason: `duplicate vote for persona '${vote.slug}'`,
          decisive: false,
          verdict: undefined,
          confidence: undefined,
        });
        continue;
      }

      // Conflicting verdicts (equivocation)
      if (policy === "drop_duplicate") {
        rejected.push({
          ...vote,
          disposition: "duplicated",
          reason: `duplicate vote for persona '${vote.slug}'`,
          decisive: false,
          verdict: undefined,
          confidence: undefined,
        });
        continue;
      }

      if (policy === "reject_subsequent") {
        rejected.push({
          ...vote,
          disposition: "equivocation",
          reason: `conflicting vote for persona '${vote.slug}' (equivocation)`,
          decisive: false,
          verdict: undefined,
          confidence: undefined,
        });
        continue;
      }

      // policy === "disqualify_all" (conservative default)
      disqualified.add(vote.slug);
      const priorIndex = ballot.findIndex((v) => v.slug === vote.slug);
      if (priorIndex !== -1) {
        const [evicted] = ballot.splice(priorIndex, 1);
        rejected.push({
          ...evicted,
          disposition: "equivocation",
          reason: `disqualified for conflicting votes (equivocation)`,
          decisive: false,
          verdict: undefined,
          confidence: undefined,
        });
      }
      rejected.push({
        ...vote,
        disposition: "equivocation",
        reason: `conflicting vote for persona '${vote.slug}' (equivocation)`,
        decisive: false,
        verdict: undefined,
        confidence: undefined,
      });
      continue;
    }

    seen.set(vote.slug, vote);
    ballot.push(vote);
  }

  return { ballot, rejected };
}

function countDispositions(
  votes: ClassifiedVote[],
): Record<VoteDisposition, number> {
  const counts = EMPTY_DISPOSITIONS();
  for (const vote of votes) counts[vote.disposition] += 1;
  return counts;
}

export interface QuorumEvaluationOptions extends BuildBallotOptions {
  claimState?: ClaimSettleState;
  strictConfig?: boolean;
  /** True when the ballot or settlement period has expired. */
  ballotExpired?: boolean;
  /** Age of the ballot in ms. */
  ballotAgeMs?: number;
  /** Max allowed age for a ballot in ms before it is considered expired. */
  maxBallotAgeMs?: number;
  /** Timestamp in ms after which the ballot is expired. */
  ballotDeadlineMs?: number;
  /** Reference timestamp in ms (defaults to Date.now()). */
  nowMs?: number;
}

/**
 * Decide whether the council ballot may settle the claim, or how to fall back.
 *
 * @param strictConfig — when set and {@link isInvalidQuorumConfig} is true,
 *   returns `abort_invalid_config` instead of normalizing.
 */
export function evaluateQuorum(
  attempts: ClassifiedVote[],
  quorumRaw: unknown = DEFAULT_COUNCIL_QUORUM,
  opts?: QuorumEvaluationOptions,
): QuorumEvaluation {
  const claimState = opts?.claimState;

  if (claimState === "cancelled") {
    return {
      action: "abort_cancelled",
      quorum: normalizeQuorum(quorumRaw),
      decisiveCount: 0,
      acceptedCount: 0,
      dispositions: countDispositions(attempts),
      reason: "claim is cancelled — council settlement aborted",
      acceptedSlugs: [],
      ballot: [],
    };
  }

  if (claimState === "resolved") {
    return {
      action: "abort_resolved",
      quorum: normalizeQuorum(quorumRaw),
      decisiveCount: 0,
      acceptedCount: 0,
      dispositions: countDispositions(attempts),
      reason: "claim is already resolved — council pass is stale",
      acceptedSlugs: [],
      ballot: [],
    };
  }

  if (claimState === "paused") {
    return {
      action: "abort_paused",
      quorum: normalizeQuorum(quorumRaw),
      decisiveCount: 0,
      acceptedCount: 0,
      dispositions: countDispositions(attempts),
      reason: "claim is paused — council settlement aborted",
      acceptedSlugs: [],
      ballot: [],
    };
  }

  const isExpired =
    claimState === "expired" ||
    opts?.ballotExpired === true ||
    (opts?.maxBallotAgeMs != null &&
      opts?.ballotAgeMs != null &&
      opts.ballotAgeMs > opts.maxBallotAgeMs) ||
    (opts?.ballotDeadlineMs != null &&
      (opts.nowMs ?? Date.now()) > opts.ballotDeadlineMs);

  if (isExpired) {
    return {
      action: "abort_expired",
      quorum: normalizeQuorum(quorumRaw),
      decisiveCount: 0,
      acceptedCount: 0,
      dispositions: countDispositions(attempts),
      reason: "ballot expired — council settlement aborted",
      acceptedSlugs: [],
      ballot: [],
    };
  }

  if (opts?.strictConfig && isInvalidQuorumConfig(quorumRaw)) {
    return {
      action: "abort_invalid_config",
      quorum: 0,
      decisiveCount: 0,
      acceptedCount: 0,
      dispositions: countDispositions(attempts),
      reason: `invalid COUNCIL_QUORUM value: ${String(quorumRaw)}`,
      acceptedSlugs: [],
      ballot: [],
    };
  }

  const quorum = normalizeQuorum(quorumRaw);
  const { ballot, rejected } = buildBallot(attempts, opts);
  const all = [...ballot, ...rejected];
  const dispositions = countDispositions(all);
  const decisiveCount = ballot.filter((v) => v.decisive).length;
  const acceptedSlugs = ballot.map((v) => v.slug);

  if (decisiveCount >= quorum) {
    return {
      action: "use_council",
      quorum,
      decisiveCount,
      acceptedCount: ballot.length,
      dispositions,
      reason: `quorum met: ${decisiveCount} decisive ≥ ${quorum}`,
      acceptedSlugs,
      ballot,
    };
  }

  const dep = dispositions.dependency_failure;
  const paused = dispositions.paused;
  const equiv = dispositions.equivocation;
  const expired = dispositions.expired;
  const reasonParts = [
    `below quorum: ${decisiveCount} decisive < ${quorum}`,
    dispositions.invalid ? `${dispositions.invalid} invalid` : null,
    dispositions.stale ? `${dispositions.stale} stale` : null,
    dispositions.duplicated ? `${dispositions.duplicated} duplicated` : null,
    dispositions.cancelled ? `${dispositions.cancelled} cancelled` : null,
    paused ? `${paused} paused` : null,
    dep ? `${dep} dependency_failure` : null,
    equiv ? `${equiv} equivocation` : null,
    expired ? `${expired} expired` : null,
  ].filter(Boolean);

  return {
    action: "fallback_solo",
    quorum,
    decisiveCount,
    acceptedCount: ballot.length,
    dispositions,
    reason: reasonParts.join("; "),
    acceptedSlugs,
    ballot,
  };
}

/** True when the oracle should settle with its own evidence (not abort). */
export function shouldFallbackSolo(evaluation: QuorumEvaluation): boolean {
  return evaluation.action === "fallback_solo";
}

/** True when council tally is authoritative for this settlement. */
export function shouldUseCouncil(evaluation: QuorumEvaluation): boolean {
  return evaluation.action === "use_council";
}

/** True when council settlement aborted due to ballot or deadline expiration. */
export function isExpiredQuorumEvaluation(evaluation: QuorumEvaluation): boolean {
  return evaluation.action === "abort_expired";
}

/** True when vote attempt was classified or rejected as equivocation. */
export function isEquivocatedVote(vote: ClassifiedVote): boolean {
  return vote.disposition === "equivocation";
}

export interface SyntheticScenarioInput {
  slug: string;
  verdict?: Verdict | "error" | "timeout" | "delayed";
  confidence?: number;
  equivocateWith?: Verdict;
  delayedByMs?: number;
  maxAgeMs?: number;
  httpStatus?: number;
}

/**
 * Simulate a council voting scenario covering equivocation, delayed votes,
 * and partial provider outages without making any live network or LLM calls.
 */
export function simulateCouncilScenario(
  scenarios: SyntheticScenarioInput[],
  quorumRaw: unknown = DEFAULT_COUNCIL_QUORUM,
  opts?: QuorumEvaluationOptions,
): QuorumEvaluation {
  const attempts: ClassifiedVote[] = [];

  for (const s of scenarios) {
    if (s.verdict === "error") {
      attempts.push(
        classifyVoteAttempt({
          slug: s.slug,
          claimId: 42,
          expectedClaimId: 42,
          claimState: opts?.claimState ?? "active",
          status: "http_error",
          httpStatus: s.httpStatus ?? 503,
        }),
      );
      continue;
    }

    if (s.verdict === "timeout") {
      attempts.push(
        classifyVoteAttempt({
          slug: s.slug,
          claimId: 42,
          expectedClaimId: 42,
          claimState: opts?.claimState ?? "active",
          status: "timeout",
        }),
      );
      continue;
    }

    const isDelayed =
      s.verdict === "delayed" ||
      (s.delayedByMs != null && s.maxAgeMs != null && s.delayedByMs > s.maxAgeMs);

    const voteAttempt: VoteAttemptInput = {
      slug: s.slug,
      claimId: 42,
      expectedClaimId: 42,
      claimState: opts?.claimState ?? "active",
      status: "ok",
      verdict: s.verdict === "delayed" ? "CREATOR_WINS" : s.verdict ?? "CREATOR_WINS",
      confidence: s.confidence ?? 80,
      ageMs: s.delayedByMs,
      maxAgeMs: s.maxAgeMs,
      expired: isDelayed,
    };
    attempts.push(classifyVoteAttempt(voteAttempt));

    if (s.equivocateWith) {
      attempts.push(
        classifyVoteAttempt({
          slug: s.slug,
          claimId: 42,
          expectedClaimId: 42,
          claimState: opts?.claimState ?? "active",
          status: "ok",
          verdict: s.equivocateWith,
          confidence: s.confidence ?? 80,
        }),
      );
    }
  }

  return evaluateQuorum(attempts, quorumRaw, opts);
}

/** Minimal shape of a claim as read from chain for joinability selection. */
export interface JoinableClaimInput {
  id: number;
  /** Claim lifecycle state as reported by the contract. */
  state?: ClaimSettleState | string;
  /** Unix seconds deadline for joining, when known. */
  joinDeadline?: number | bigint | null;
  /** Unix seconds when the claim was created, when known. */
  createdAt?: number | bigint | null;
  /** True when the claim has already been settled/resolved. */
  resolved?: boolean;
  /** True when the claim has been cancelled. */
  cancelled?: boolean;
  /** True when the claim is paused. */
  paused?: boolean;
  /** Number of jurors already on the claim, when known. */
  jurCount?: number;
  /** Maximum jurors allowed on the claim, when known. */
  maxJurors?: number;
}

const TERMINAL_STATES = new Set<string>(["cancelled", "resolved"]);

function toSeconds(value: number | bigint | null | undefined): number | null {
  if (value == null || value === undefined) return null;
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return Number.isFinite(value) ? value : null;
}

/**
 * Select claims that are still joinable at `totalSeconds`: open/active,
 * not cancelled/resolved/paused, join deadline not yet passed, and juror
 * slots remaining. Pure so the poll loop can delegate the filter to it and
 * tests can exercise it without a chain.
 *
 * @param claims — batched reads from `readClaimsBatch`
 * @param now — current time in Unix seconds (matches contract timestamps)
 */
export function selectJoinableClaims(
  claims: readonly JoinableClaimInput[],
  now: number,
): JoinableClaimInput[] {
  if (!Number.isFinite(now)) return [];
  const out: JoinableClaimInput[] = [];
  for (const claim of claims) {
    if (!claim || !Number.isInteger(claim.id) || claim.id < 1) continue;
    if (claim.resolved || claim.cancelled || claim.paused) continue;
    if (claim.state != null && TERMINAL_STATES.has(String(claim.state).toLowerCase())) continue;
    if (claim.state != null && String(claim.state).toLowerCase() === "paused") continue;

    const deadline = toSeconds(claim.joinDeadline);
    if (deadline != null && deadline > 0 && now >= deadline) continue;

    if (
      claim.maxJurors != null &&
      Number.isFinite(claim.maxJurors) &&
      claim.jurCount != null &&
      Number.isFinite(claim.jurCount) &&
      claim.jurCount >= claim.maxJurors
    ) {
      continue;
    }

    out.push(claim);
  }
  return out;
}


