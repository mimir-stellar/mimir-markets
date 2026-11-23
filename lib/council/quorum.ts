/**
 * Council quorum + fallback rules for settlement (agents / RFB council boundary).
 *
 * `gatherCouncilVerdict` buys persona votes and tallies them. This module is the
 * pure policy layer that decides whether that tally is allowed to settle a claim,
 * or whether the oracle must fall back to its own (solo) verdict — and what to do
 * when a vote is invalid, stale, duplicated, cancelled, or a dependency failure.
 *
 * Before outcome evaluation, callers can bind a versioned council ballot commitment
 * ({@link createBallotCommitment} / {@link verifyBallotCommitment}) covering
 * participant identities, claim revision, the eligible vote set, and the approved
 * voting boundary. Any ballot altered after the approved voting boundary is
 * rejected before quorum outcome evaluation.
 *
 * Chain remains source of truth: a cancelled or already-resolved claim never
 * produces a council settlement from this path. Below-quorum and dependency
 * failures degrade to solo oracle settlement rather than inventing a majority.
 *
 * Pure: no I/O. Callers classify each attempt, then ask {@link evaluateQuorum}.
 *
 * Policy revision: every evaluation carries `policyRevision`, a stable reference
 * identifying the rule set that produced the decision. It is derived from the
 * policy's *effective* parameters (quorum after normalization), not from the
 * default constants themselves, so changing a default in a future release does
 * not silently rewrite the reference recorded for historical ballots. Replaying
 * a captured ballot under a pinned revision yields the identical decision.
 */

import { createHash } from "node:crypto";
import { isVerdict, type Verdict } from "../verdict";

/** Claim lifecycle states the quorum gate cares about. */
export type ClaimSettleState = "open" | "active" | "resolved" | "cancelled" | "paused";

/**
 * What happened to one persona vote attempt before it may enter the ballot.
 *
 * - **valid** — well-formed verdict for the claim being settled; may be decisive
 *   or an explicit abstention (DRAW / UNRESOLVABLE).
 * - **invalid** — malformed slug/verdict/body, ineligible voter, or post-boundary alteration; never counts.
 * - **stale** — wrong claim id/revision, already-resolved claim, aged past maxAgeMs, or recorded after voting boundary.
 * - **duplicated** — same persona already accepted onto this ballot.
 * - **cancelled** — claim is cancelled; council must not settle it.
 * - **paused** — persona or claim is paused; vote does not count.
 * - **dependency_failure** — network / timeout / 5xx; treated as abstention for
 *   tally purposes but recorded so fallback reasons stay auditable.
 */
export type VoteDisposition =
  | "valid"
  | "invalid"
  | "stale"
  | "duplicated"
  | "cancelled"
  | "paused"
  | "dependency_failure"
  /**
   * Persona did not vote before the council deliberation deadline. Counted as
   * abstention (never as a decisive or DRAW vote) so missing votes cannot be
   * mistaken for consensus.
   */
  | "deadline_abstention";

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
  /** Quorum config is unusable after normalization refusal. */
  | "abort_invalid_config"
  /** Deadline passed with too few decisive votes — oracle settles solo, never by default consensus. */
  | "fallback_deadline";

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

/**
 * Stable identifier for the quorum rule set. Bump the leading version only when
 * the decision semantics change (not when defaults are tuned). The effective
 * quorum is appended so the reference pins the parameter actually applied.
 */
export const QUORUM_POLICY_ID = "council-quorum/v1";

/**
 * Build the policy revision reference for an effective (normalized) quorum.
 * Depends only on the effective parameter, so a default change that does not
 * alter the effective value keeps prior references valid.
 */
export function policyRevisionFor(effectiveQuorum: number): string {
  return `${QUORUM_POLICY_ID}:q=${effectiveQuorum}`;
}

/** Bumped whenever the canonical council ballot commitment byte layout changes. */
export const COUNCIL_BALLOT_COMMITMENT_VERSION = 1;

/** Alias for {@link COUNCIL_BALLOT_COMMITMENT_VERSION}. */
export const BALLOT_COMMITMENT_VERSION = COUNCIL_BALLOT_COMMITMENT_VERSION;

export interface BallotParticipantIdentity {
  /** Normalized lowercase persona slug. */
  slug: string;
  /** Optional case-sensitive participant account/wallet identifier (e.g. Stellar G… address). */
  address?: string;
  /** Optional council jury track. */
  track?: "classic" | "philosopher";
}

export type BallotParticipantInput = string | BallotParticipantIdentity;
export interface VoteAttemptInput {
  slug: string;
  /** Optional participant wallet/account address bound to this vote attempt. */
  participantAddress?: string;
  /** Claim id the response claims to be about (from body or request). */
  claimId: number;
  /** Claim id the oracle is currently settling. */
  expectedClaimId: number;
  /** Claim revision reported with the vote attempt, when revision binding is active. */
  claimRevision?: number | string;
  /** Claim revision expected at the settlement boundary, when revision binding is active. */
  expectedClaimRevision?: number | string;
  /** Optional set of eligible persona slugs allowed to vote on this claim. */
  eligibleVoteSet?: readonly string[];
  /** Epoch ms when the vote was originally recorded, when known. */
  recordedAtMs?: number;
  /** Epoch ms when the vote was altered/mutated, when known. */
  alteredAtMs?: number;
  /** Approved voting boundary timestamp (epoch ms); votes recorded or altered after this are rejected. */
  votingBoundaryMs?: number;
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
  /**
   * Optional arrival/delivery identity for this vote attempt (e.g. request id,
   * trace id, or receipt id). Preserved on the accepted ballot entry so
   * deduplicated retries reference the original arrival identity.
   */
  arrivalId?: string;
}

export interface ClassifiedVote {
  slug: string;
  disposition: VoteDisposition;
  reason: string;
  verdict?: Verdict;
  confidence?: number;
  /** True when disposition is valid and verdict is CREATOR_WINS or CHALLENGERS_WIN. */
  decisive: boolean;
  /** Arrival/delivery identity of this vote attempt, when supplied. */
  arrivalId?: string;
  /**
   * For `duplicated` votes, the arrival identity of the original accepted
   * vote for the same persona slug, when known.
   */
  originalArrivalId?: string;
  /**
   * For `duplicated` votes, true when the duplicate disagreed with the
   * original accepted vote's verdict or confidence.
   */
  conflict?: boolean;
}

export interface DuplicateVoteConflict {
  slug: string;
  originalArrivalId?: string;
  duplicateArrivalId?: string;
  originalVerdict?: Verdict;
  duplicateVerdict?: Verdict;
  originalConfidence?: number;
  duplicateConfidence?: number;
  reason: string;
}

export interface QuorumEvaluation {
  action: FallbackAction;
  quorum: number;
  /** Stable reference to the rule set (and effective quorum) that produced this decision. */
  policyRevision: string;
  decisiveCount: number;
  acceptedCount: number;
  dispositions: Record<VoteDisposition, number>;
  reason: string;
  acceptedSlugs: string[];
  /** Valid votes in ballot order (duplicates / rejects excluded). */
  ballot: ClassifiedVote[];
  /** Explicit inconsistencies where a duplicate vote conflicted with the original accepted vote. */
  conflicts: DuplicateVoteConflict[];
}

const EMPTY_DISPOSITIONS = (): Record<VoteDisposition, number> => ({
  valid: 0,
  invalid: 0,
  stale: 0,
  duplicated: 0,
  cancelled: 0,
  paused: 0,
  dependency_failure: 0,
  deadline_abstention: 0,
});

/**
 * Classify a persona that produced no response before the deliberation deadline.
 * This is an explicit abstention, distinct from a substantive DRAW / UNRESOLVABLE
 * verdict and from a dependency failure.
 */
export function classifyDeadlineAbstention(slug: string): ClassifiedVote {
  return {
    slug: (slug ?? "").trim().toLowerCase(),
    disposition: "deadline_abstention",
    reason: "no vote before council deliberation deadline",
    decisive: false,
  };
}

/**
 * Compare quorum/confidence policy outcomes across identical fixtures without
 * contacting model providers. Each fixture is a list of raw vote attempts plus
 * a quorum config; the result reports the evaluation under a baseline policy and
 * a candidate policy, and flags any decisions that changed.
 */
export interface PolicyFixture {
  name: string;
  attempts: ClassifiedVote[];
  quorum: unknown;
  claimState?: ClaimSettleState;
}

export interface PolicyComparisonRow {
  name: string;
  baseline: FallbackAction;
  candidate: FallbackAction;
  changed: boolean;
  baselineReason: string;
  candidateReason: string;
}

export interface PolicyComparisonReport {
  rows: PolicyComparisonRow[];
  changedCount: number;
}

/**
 * Run two quorum policies over the same fixtures and report changed decisions.
 * Pure: no network, no provider calls, no persisted state.
 */
export function comparePolicies(
  fixtures: PolicyFixture[],
  baselineOpts: { quorum?: unknown; strictConfig?: boolean } = {},
  candidateOpts: { quorum?: unknown; strictConfig?: boolean } = {},
): PolicyComparisonReport {
  const rows: PolicyComparisonRow[] = fixtures.map((fx) => {
    const base = evaluateQuorum(fx.attempts, baselineOpts.quorum ?? fx.quorum, {
      claimState: fx.claimState,
      strictConfig: baselineOpts.strictConfig,
    });
    const cand = evaluateQuorum(fx.attempts, candidateOpts.quorum ?? fx.quorum, {
      claimState: fx.claimState,
      strictConfig: candidateOpts.strictConfig,
    });
    return {
      name: fx.name,
      baseline: base.action,
      candidate: cand.action,
      changed: base.action !== cand.action,
      baselineReason: base.reason,
      candidateReason: cand.reason,
    };
  });
  return { rows, changedCount: rows.filter((r) => r.changed).length };
}

const CONTROL_OR_SEP = /[\u0000-\u001f\u007f|,]/;

export function isDecisiveVerdict(verdict: Verdict): boolean {
  return verdict === "CREATOR_WINS" || verdict === "CHALLENGERS_WIN";
}

/**
 * Normalize a raw quorum (env Number, caller override, …).
 *
 * Invalid values (NaN, non-finite, < 1) become the default so a typo cannot
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
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizeRevisionString(value: number | string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return null;
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || CONTROL_OR_SEP.test(trimmed)) return null;
    return trimmed;
  }
  return null;
}

function attachVoteMetadata(base: ClassifiedVote, input: VoteAttemptInput): ClassifiedVote {
  const out: ClassifiedVote = { ...base };
  if (input.participantAddress !== undefined) {
    out.participantAddress = input.participantAddress.trim();
  }
  if (input.claimRevision !== undefined) {
    const rev = normalizeRevisionString(input.claimRevision);
    out.claimRevision = rev ?? String(input.claimRevision).trim();
  }
  if (input.recordedAtMs !== undefined) {
    out.recordedAtMs = input.recordedAtMs;
  }
  if (input.alteredAtMs !== undefined) {
    out.alteredAtMs = input.alteredAtMs;
  }
  return out;
}

/**
 * Classify a single vote attempt. Duplicates are handled by
 * {@link buildBallot} so this function stays order-independent.
 */
export function classifyVoteAttempt(input: VoteAttemptInput): ClassifiedVote {
  const slug = (input.slug ?? "").trim().toLowerCase();
  const arrivalId =
    typeof input.arrivalId === "string" ? input.arrivalId.trim() || undefined : undefined;
  const arrivalMeta = arrivalId ? { arrivalId } : {};

  if (!slug) {
    return {
      slug: "",
      disposition: "invalid",
      reason: "missing persona slug",
      decisive: false,
      ...arrivalMeta,
    };
  }

  if (input.personaPaused) {
    return {
      slug,
      disposition: "paused",
      reason: "persona is paused",
      decisive: false,
      ...arrivalMeta,
    };
  }

  if (input.claimState === "cancelled") {
    return {
      slug,
      disposition: "cancelled",
      reason: "claim is cancelled on-chain",
      decisive: false,
      ...arrivalMeta,
    };
  }

  if (input.claimState === "resolved") {
    return {
      slug,
      disposition: "stale",
      reason: "claim is already resolved",
      decisive: false,
      ...arrivalMeta,
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
      ...arrivalMeta,
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
      ...arrivalMeta,
    };
  }

  if (input.status === "network_error" || input.status === "timeout") {
    return {
      slug,
      disposition: "dependency_failure",
      reason: input.status === "timeout" ? "vote request timed out" : "vote request network failure",
      decisive: false,
      ...arrivalMeta,
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
        ...arrivalMeta,
      };
    }
    if (code === 404) {
      return {
        slug,
        disposition: "stale",
        reason: "claim not found at vote endpoint",
        decisive: false,
        ...arrivalMeta,
      };
    }
    return {
      slug,
      disposition: "invalid",
      reason: `vote endpoint HTTP ${code}`,
      decisive: false,
      ...arrivalMeta,
    };
  }

  if (!isVerdict(input.verdict)) {
    return {
      slug,
      disposition: "invalid",
      reason: "missing or unknown verdict",
      decisive: false,
      ...arrivalMeta,
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
    ...arrivalMeta,
  };
}

/**
 * Fold classified attempts into a ballot: first valid vote per slug wins and
 * its original arrival identity is preserved.
 *
 * - Identical retries (same verdict and confidence) are deduplicated
 *   idempotently and reference the original arrival identity.
 * - Conflicting duplicates (different verdict or confidence) are rejected as
 *   duplicated and surfaced as explicit inconsistencies in `conflicts`.
 */
export function buildBallot(classified: ClassifiedVote[]): {
  ballot: ClassifiedVote[];
  rejected: ClassifiedVote[];
  conflicts: DuplicateVoteConflict[];
} {
  const acceptedBySlug = new Map<string, ClassifiedVote>();
  const ballot: ClassifiedVote[] = [];
  const rejected: ClassifiedVote[] = [];
  const conflicts: DuplicateVoteConflict[] = [];

  for (const vote of classified) {
    if (vote.disposition !== "valid") {
      rejected.push(vote);
      continue;
    }
    const original = acceptedBySlug.get(vote.slug);
    if (original) {
      const isConflict =
        vote.verdict !== original.verdict || vote.confidence !== original.confidence;
      const originalRef = original.arrivalId ? ` (arrival '${original.arrivalId}')` : "";
      const reason = isConflict
        ? `conflicting duplicate vote for persona '${vote.slug}': original ${original.verdict}(${original.confidence})${originalRef} vs duplicate ${vote.verdict}(${vote.confidence})${vote.arrivalId ? ` (arrival '${vote.arrivalId}')` : ""}`
        : `duplicate vote for persona '${vote.slug}' (idempotent retry${original.arrivalId ? ` of arrival '${original.arrivalId}'` : ""})`;

      if (isConflict) {
        conflicts.push({
          slug: vote.slug,
          ...(original.arrivalId ? { originalArrivalId: original.arrivalId } : {}),
          ...(vote.arrivalId ? { duplicateArrivalId: vote.arrivalId } : {}),
          originalVerdict: original.verdict,
          duplicateVerdict: vote.verdict,
          originalConfidence: original.confidence,
          duplicateConfidence: vote.confidence,
          reason,
        });
      }

      rejected.push({
        ...vote,
        disposition: "duplicated",
        reason,
        decisive: false,
        verdict: undefined,
        confidence: undefined,
        ...(original.arrivalId ? { originalArrivalId: original.arrivalId } : {}),
        conflict: isConflict,
      });
      continue;
    }
    acceptedBySlug.set(vote.slug, vote);
    ballot.push(vote);
  }

  return { ballot, rejected, conflicts };
}

function countDispositions(
  votes: ClassifiedVote[],
): Record<VoteDisposition, number> {
  const counts = EMPTY_DISPOSITIONS();
  for (const vote of votes) counts[vote.disposition] += 1;
  return counts;
}

// ── Versioned Council Ballot Commitment ──────────────────────────────────────

function failCommitment(reason: BallotCommitmentFailureReason, message: string): never {
  throw new BallotCommitmentError(reason, message);
}

function normalizeEligibleVoteSet(raw: readonly string[] | undefined): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    failCommitment("invalid_eligible_vote_set", "eligibleVoteSet must be a non-empty array of persona slugs");
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      failCommitment("invalid_eligible_vote_set", "eligibleVoteSet entries must be strings");
    }
    const slug = entry.trim().toLowerCase();
    if (!slug || CONTROL_OR_SEP.test(slug)) {
      failCommitment("invalid_eligible_vote_set", `invalid eligible persona slug '${String(entry)}'`);
    }
    if (seen.has(slug)) {
      failCommitment("invalid_eligible_vote_set", `duplicate eligible persona slug '${slug}'`);
    }
    seen.add(slug);
    normalized.push(slug);
  }
  return normalized.sort((a, b) => a.localeCompare(b));
}

function normalizeParticipantIdentities(
  raw: readonly BallotParticipantInput[] | undefined,
  eligibleVoteSet: readonly string[],
  votes: readonly ClassifiedVote[],
): BallotParticipantIdentity[] {
  const eligibleSet = new Set(eligibleVoteSet);
  const bySlug = new Map<string, BallotParticipantIdentity>();

  if (raw !== undefined) {
    if (!Array.isArray(raw) || raw.length === 0) {
      failCommitment("invalid_participant_identity", "participantIdentities must be a non-empty array when provided");
    }
    for (const item of raw) {
      const spec: BallotParticipantIdentity =
        typeof item === "string"
          ? { slug: item }
          : item && typeof item === "object"
            ? item
            : failCommitment("invalid_participant_identity", "participant identity must be a string or object");
      const slug = (spec.slug ?? "").trim().toLowerCase();
      if (!slug || CONTROL_OR_SEP.test(slug)) {
        failCommitment("invalid_participant_identity", `invalid participant slug '${String(spec.slug)}'`);
      }
      if (!eligibleSet.has(slug)) {
        failCommitment(
          "ineligible_voter",
          `participant '${slug}' is not in the eligible vote set`,
        );
      }
      if (bySlug.has(slug)) {
        failCommitment("invalid_participant_identity", `duplicate participant identity for '${slug}'`);
      }
      const address = spec.address !== undefined ? spec.address.trim() : undefined;
      if (address !== undefined && (!address || CONTROL_OR_SEP.test(address))) {
        failCommitment("invalid_participant_identity", `invalid participant address for '${slug}'`);
      }
      const track = spec.track;
      if (track !== undefined && track !== "classic" && track !== "philosopher") {
        failCommitment("invalid_participant_identity", `invalid participant track '${String(track)}' for '${slug}'`);
      }
      const entry: BallotParticipantIdentity = {
        slug,
        ...(address ? { address } : {}),
        ...(track ? { track } : {}),
      };
      bySlug.set(slug, Object.freeze(entry));
    }
  } else {
    // Derive canonical participant identities from the eligible vote set + any vote addresses.
    const voteAddresses = new Map<string, string>();
    for (const v of votes) {
      if (v.disposition === "valid" && v.participantAddress) {
        const slug = v.slug.trim().toLowerCase();
        const addr = v.participantAddress.trim();
        if (CONTROL_OR_SEP.test(addr)) {
          failCommitment("invalid_participant_identity", `invalid participantAddress on vote for '${slug}'`);
        }
        if (!voteAddresses.has(slug)) {
          voteAddresses.set(slug, addr);
        }
      }
    }
    for (const slug of eligibleVoteSet) {
      const address = voteAddresses.get(slug);
      bySlug.set(
        slug,
        Object.freeze({
          slug,
          ...(address ? { address } : {}),
        }),
      );
    }
  }

  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

function serializeParticipant(p: BallotParticipantIdentity): string {
  return `${p.slug}@${p.address ?? ""}:${p.track ?? ""}`;
}

function serializeCommittedVote(v: CommittedBallotVote): string {
  return [
    v.slug,
    v.participantAddress ?? "",
    v.verdict,
    String(v.confidence),
    v.decisive ? "1" : "0",
    v.recordedAtMs !== undefined ? String(v.recordedAtMs) : "",
  ].join("|");
}

/**
 * Deterministic canonical payload for a versioned council ballot commitment.
 */
export function canonicalBallotCommitmentPayload(
  commitment: Omit<CouncilBallotCommitment, "commitmentHash" | "digest">,
): string {
  const lines = [
    "mimir-council-ballot-commitment",
    `version:${commitment.version}`,
    `claim:${commitment.claimId}`,
    `revision:${commitment.claimRevision}`,
    `boundary:${commitment.votingBoundaryMs === null ? "none" : commitment.votingBoundaryMs}`,
    `eligible:${commitment.eligibleVoteSet.join(",")}`,
    `participants:${commitment.participantIdentities.map(serializeParticipant).join(",")}`,
    `ballot:${commitment.ballot.length}`,
    ...commitment.ballot.map(serializeCommittedVote),
  ];
  return lines.join("\n");
}

function computeCommitmentDigest(
  commitment: Omit<CouncilBallotCommitment, "commitmentHash" | "digest">,
): string {
  return createHash("sha256")
    .update(canonicalBallotCommitmentPayload(commitment), "utf8")
    .digest("hex");
}

/**
 * Create a versioned council ballot commitment before outcome evaluation.
 *
 * Binds:
 * - schema `version` ({@link COUNCIL_BALLOT_COMMITMENT_VERSION})
 * - `claimId` and `claimRevision`
 * - `eligibleVoteSet` (the approved eligible persona slugs)
 * - `participantIdentities` (persona slugs and optional wallet addresses / tracks)
 * - `votingBoundaryMs` (when provided) and the canonical `ballot` snapshot.
 *
 * Throws {@link BallotCommitmentError} if any input is malformed, if a voter is
 * outside the eligible vote set or mismatches its bound participant identity, or
 * if any vote was recorded or altered after `votingBoundaryMs`.
 */
export function createBallotCommitment(input: BallotCommitmentInput): CouncilBallotCommitment {
  const version = input.version ?? COUNCIL_BALLOT_COMMITMENT_VERSION;
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version !== COUNCIL_BALLOT_COMMITMENT_VERSION
  ) {
    failCommitment(
      "invalid_version",
      `unsupported council ballot commitment version: ${String(version)}`,
    );
  }

  if (!Number.isInteger(input.claimId) || input.claimId < 1) {
    failCommitment("invalid_claim_id", `claimId must be a positive integer, got ${String(input.claimId)}`);
  }

  const claimRevision = normalizeRevisionString(input.claimRevision);
  if (!claimRevision) {
    failCommitment(
      "invalid_claim_revision",
      `claimRevision must be a non-empty string or non-negative integer, got ${String(input.claimRevision)}`,
    );
  }

  let votingBoundaryMs: number | null = null;
  if (input.votingBoundaryMs !== undefined && input.votingBoundaryMs !== null) {
    if (
      typeof input.votingBoundaryMs !== "number" ||
      !Number.isFinite(input.votingBoundaryMs) ||
      !Number.isInteger(input.votingBoundaryMs) ||
      input.votingBoundaryMs < 0
    ) {
      failCommitment(
        "invalid_voting_boundary",
        `votingBoundaryMs must be a non-negative integer epoch ms, got ${String(input.votingBoundaryMs)}`,
      );
    }
    votingBoundaryMs = input.votingBoundaryMs;
  }

  const rawVotes = input.votes ?? input.ballot ?? [];
  if (!Array.isArray(rawVotes)) {
    failCommitment("ballot_altered", "votes must be an array");
  }

  const eligibleVoteSet = normalizeEligibleVoteSet(input.eligibleVoteSet ?? input.eligibleSlugs);
  const eligibleSet = new Set(eligibleVoteSet);
  const participantIdentities = normalizeParticipantIdentities(
    input.participantIdentities ?? input.participants,
    eligibleVoteSet,
    rawVotes,
  );
  const participantBySlug = new Map(participantIdentities.map((p) => [p.slug, p]));

  // Pre-check all attempts for post-boundary alteration or ineligible valid votes
  // before folding duplicates, so boundary violations never slip through silently.
  for (const attempt of rawVotes) {
    if (!attempt || typeof attempt !== "object") {
      failCommitment("ballot_altered", "malformed vote entry in ballot");
    }
    const slug = (attempt.slug ?? "").trim().toLowerCase();
    if (votingBoundaryMs !== null) {
      if (
        attempt.alteredAtMs !== undefined &&
        (!Number.isFinite(attempt.alteredAtMs) || attempt.alteredAtMs > votingBoundaryMs)
      ) {
        failCommitment(
          "altered_after_boundary",
          `vote for '${slug || "unknown"}' was altered at ${String(attempt.alteredAtMs)}ms after approved voting boundary ${votingBoundaryMs}ms`,
        );
      }
      if (
        attempt.recordedAtMs !== undefined &&
        (!Number.isFinite(attempt.recordedAtMs) || attempt.recordedAtMs > votingBoundaryMs)
      ) {
        failCommitment(
          "recorded_after_boundary",
          `vote for '${slug || "unknown"}' was recorded at ${String(attempt.recordedAtMs)}ms after approved voting boundary ${votingBoundaryMs}ms`,
        );
      }
    }
    if (attempt.claimRevision !== undefined) {
      const attemptRev = normalizeRevisionString(attempt.claimRevision);
      if (!attemptRev || attemptRev !== claimRevision) {
        failCommitment(
          "claim_revision_mismatch",
          `vote for '${slug || "unknown"}' targets claimRevision '${String(attempt.claimRevision)}', expected '${claimRevision}'`,
        );
      }
    }
    if (attempt.disposition === "valid") {
      if (!slug || !eligibleSet.has(slug)) {
        failCommitment(
          "ineligible_voter",
          `voter '${slug}' is not in the committed eligible vote set`,
        );
      }
      const boundParticipant = participantBySlug.get(slug);
      if (!boundParticipant) {
        failCommitment(
          "participant_identity_mismatch",
          `voter '${slug}' has no bound participant identity`,
        );
      }
      if (attempt.participantAddress !== undefined) {
        const addr = attempt.participantAddress.trim();
        if (!addr || CONTROL_OR_SEP.test(addr)) {
          failCommitment("invalid_participant_identity", `invalid participantAddress for '${slug}'`);
        }
        if (boundParticipant.address && boundParticipant.address !== addr) {
          failCommitment(
            "participant_identity_mismatch",
            `voter '${slug}' participantAddress '${addr}' does not match bound address '${boundParticipant.address}'`,
          );
        }
      }
    }
  }

  const { ballot: folded } = buildBallot([...rawVotes]);
  const committedBallot: CommittedBallotVote[] = folded.map((vote) => {
    const slug = vote.slug.trim().toLowerCase();
    if (!vote.verdict || !isVerdict(vote.verdict)) {
      failCommitment("ballot_altered", `valid ballot vote for '${slug}' is missing a valid verdict`);
    }
    const confidence = clampConfidence(vote.confidence);
    const decisive = isDecisiveVerdict(vote.verdict);
    if (vote.decisive !== decisive) {
      failCommitment("ballot_altered", `ballot vote for '${slug}' has inconsistent decisive flag`);
    }
    const bound = participantBySlug.get(slug);
    const participantAddress = vote.participantAddress?.trim() || bound?.address;
    const item: CommittedBallotVote = {
      slug,
      ...(participantAddress ? { participantAddress } : {}),
      verdict: vote.verdict,
      confidence,
      decisive,
      ...(vote.recordedAtMs !== undefined ? { recordedAtMs: vote.recordedAtMs } : {}),
    };
    return Object.freeze(item);
  });

  const unsigned = {
    version,
    claimId: input.claimId,
    claimRevision,
    votingBoundaryMs,
    eligibleVoteSet: Object.freeze([...eligibleVoteSet]),
    participantIdentities: Object.freeze([...participantIdentities]),
    ballot: Object.freeze(committedBallot),
  };

  const commitmentHash = computeCommitmentDigest(unsigned);

  return Object.freeze({
    ...unsigned,
    commitmentHash,
    digest: commitmentHash,
  });
}

/** Alias for {@link createBallotCommitment}. */
export const commitCouncilBallot = createBallotCommitment;

/**
 * Verify a candidate ballot and evaluation context against a versioned council
 * ballot commitment before outcome evaluation.
 *
 * Rejects any ballot altered after the approved voting boundary, any claim
 * revision or eligible vote set drift, any participant identity mismatch, and
 * any version or SHA-256 digest mismatch.
 */
export function verifyBallotCommitment(
  commitment: CouncilBallotCommitment | null | undefined,
  attempts: readonly ClassifiedVote[],
  context?: BallotCommitmentVerifyContext,
): BallotCommitmentVerification {
  if (!commitment || typeof commitment !== "object") {
    return {
      ok: false,
      reason: "ballot_altered",
      detail: "missing council ballot commitment",
    };
  }

  if (
    typeof commitment.version !== "number" ||
    !Number.isInteger(commitment.version) ||
    commitment.version !== COUNCIL_BALLOT_COMMITMENT_VERSION
  ) {
    return {
      ok: false,
      reason: "invalid_version",
      detail: `unsupported ballot commitment version ${String(commitment.version)} (expected ${COUNCIL_BALLOT_COMMITMENT_VERSION})`,
    };
  }

  if (!Number.isInteger(commitment.claimId) || commitment.claimId < 1) {
    return {
      ok: false,
      reason: "invalid_claim_id",
      detail: `invalid committed claimId ${String(commitment.claimId)}`,
    };
  }

  if (context?.claimId !== undefined && context.claimId !== commitment.claimId) {
    return {
      ok: false,
      reason: "invalid_claim_id",
      detail: `evaluation claimId ${context.claimId} does not match committed claimId ${commitment.claimId}`,
    };
  }

  const committedRevision = normalizeRevisionString(commitment.claimRevision);
  if (!committedRevision) {
    return {
      ok: false,
      reason: "invalid_claim_revision",
      detail: "committed claimRevision is empty or invalid",
    };
  }

  if (context?.claimRevision !== undefined) {
    const contextRevision = normalizeRevisionString(context.claimRevision);
    if (!contextRevision || contextRevision !== committedRevision) {
      return {
        ok: false,
        reason: "claim_revision_mismatch",
        detail: `evaluation claimRevision '${String(context.claimRevision)}' does not match committed revision '${committedRevision}'`,
      };
    }
  }

  if (
    commitment.votingBoundaryMs !== null &&
    (typeof commitment.votingBoundaryMs !== "number" ||
      !Number.isFinite(commitment.votingBoundaryMs) ||
      !Number.isInteger(commitment.votingBoundaryMs) ||
      commitment.votingBoundaryMs < 0)
  ) {
    return {
      ok: false,
      reason: "invalid_voting_boundary",
      detail: `invalid committed votingBoundaryMs ${String(commitment.votingBoundaryMs)}`,
    };
  }

  if (
    context?.votingBoundaryMs !== undefined &&
    context.votingBoundaryMs !== null &&
    commitment.votingBoundaryMs !== null &&
    context.votingBoundaryMs !== commitment.votingBoundaryMs
  ) {
    return {
      ok: false,
      reason: "invalid_voting_boundary",
      detail: `evaluation votingBoundaryMs ${context.votingBoundaryMs} does not match committed boundary ${commitment.votingBoundaryMs}`,
    };
  }

  const effectiveBoundaryMs =
    commitment.votingBoundaryMs ??
    (context?.votingBoundaryMs !== undefined && context.votingBoundaryMs !== null
      ? context.votingBoundaryMs
      : null);

  let committedEligible: string[];
  try {
    committedEligible = normalizeEligibleVoteSet(commitment.eligibleVoteSet);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof BallotCommitmentError ? err.reason : "invalid_eligible_vote_set",
      detail: err instanceof Error ? err.message : "invalid committed eligibleVoteSet",
    };
  }

  if (
    committedEligible.length !== commitment.eligibleVoteSet.length ||
    committedEligible.some((slug, idx) => slug !== commitment.eligibleVoteSet[idx])
  ) {
    return {
      ok: false,
      reason: "eligible_vote_set_mismatch",
      detail: "committed eligibleVoteSet is not in canonical form",
    };
  }

  if (context?.eligibleVoteSet !== undefined) {
    let contextEligible: string[];
    try {
      contextEligible = normalizeEligibleVoteSet(context.eligibleVoteSet);
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof BallotCommitmentError ? err.reason : "invalid_eligible_vote_set",
        detail: err instanceof Error ? err.message : "invalid context eligibleVoteSet",
      };
    }
    if (
      contextEligible.length !== committedEligible.length ||
      contextEligible.some((slug, idx) => slug !== committedEligible[idx])
    ) {
      return {
        ok: false,
        reason: "eligible_vote_set_mismatch",
        detail: `eligible vote set [${contextEligible.join(",")}] does not match committed set [${committedEligible.join(",")}]`,
      };
    }
  }

  let committedParticipants: BallotParticipantIdentity[];
  try {
    committedParticipants = normalizeParticipantIdentities(
      commitment.participantIdentities,
      committedEligible,
      [],
    );
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof BallotCommitmentError ? err.reason : "invalid_participant_identity",
      detail: err instanceof Error ? err.message : "invalid committed participantIdentities",
    };
  }

  if (
    committedParticipants.length !== commitment.participantIdentities.length ||
    committedParticipants.some(
      (p, idx) =>
        serializeParticipant(p) !== serializeParticipant(commitment.participantIdentities[idx]!),
    )
  ) {
    return {
      ok: false,
      reason: "participant_identity_mismatch",
      detail: "committed participantIdentities were altered or out of canonical order",
    };
  }

  if (context?.participantIdentities !== undefined) {
    let contextParticipants: BallotParticipantIdentity[];
    try {
      contextParticipants = normalizeParticipantIdentities(
        context.participantIdentities,
        committedEligible,
        [],
      );
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof BallotCommitmentError ? err.reason : "invalid_participant_identity",
        detail: err instanceof Error ? err.message : "invalid context participantIdentities",
      };
    }
    if (
      contextParticipants.length !== committedParticipants.length ||
      contextParticipants.some(
        (p, idx) => serializeParticipant(p) !== serializeParticipant(committedParticipants[idx]!),
      )
    ) {
      return {
        ok: false,
        reason: "participant_identity_mismatch",
        detail: "evaluation participantIdentities do not match committed participant identities",
      };
    }
  }

  // Recompute digest over the commitment object itself to detect any tampering with commitment fields.
  const expectedHash = computeCommitmentDigest({
    version: commitment.version,
    claimId: commitment.claimId,
    claimRevision: committedRevision,
    votingBoundaryMs: commitment.votingBoundaryMs,
    eligibleVoteSet: commitment.eligibleVoteSet,
    participantIdentities: commitment.participantIdentities,
    ballot: commitment.ballot,
  });

  const providedHash = (commitment.commitmentHash ?? commitment.digest ?? "").trim().toLowerCase();
  if (
    !providedHash ||
    providedHash !== expectedHash ||
    (commitment.digest !== undefined && commitment.digest.trim().toLowerCase() !== expectedHash)
  ) {
    return {
      ok: false,
      reason: "digest_mismatch",
      detail: "ballot commitment hash does not match canonical commitment payload",
      commitmentHash: providedHash,
      expectedHash,
    };
  }

  const eligibleSet = new Set(committedEligible);
  const participantBySlug = new Map(committedParticipants.map((p) => [p.slug, p]));

  // Inspect every attempt for post-boundary edits, revision drift, or ineligible voters.
  for (const attempt of attempts) {
    const slug = (attempt.slug ?? "").trim().toLowerCase();
    if (effectiveBoundaryMs !== null) {
      if (
        attempt.alteredAtMs !== undefined &&
        (!Number.isFinite(attempt.alteredAtMs) || attempt.alteredAtMs > effectiveBoundaryMs)
      ) {
        return {
          ok: false,
          reason: "altered_after_boundary",
          detail: `ballot vote for '${slug || "unknown"}' was altered at ${String(attempt.alteredAtMs)}ms after approved voting boundary ${effectiveBoundaryMs}ms`,
          commitmentHash: providedHash,
          expectedHash,
        };
      }
      if (
        attempt.recordedAtMs !== undefined &&
        (!Number.isFinite(attempt.recordedAtMs) || attempt.recordedAtMs > effectiveBoundaryMs)
      ) {
        return {
          ok: false,
          reason: "recorded_after_boundary",
          detail: `ballot vote for '${slug || "unknown"}' was recorded at ${String(attempt.recordedAtMs)}ms after approved voting boundary ${effectiveBoundaryMs}ms`,
          commitmentHash: providedHash,
          expectedHash,
        };
      }
    }
    if (attempt.claimRevision !== undefined) {
      const attemptRev = normalizeRevisionString(attempt.claimRevision);
      if (!attemptRev || attemptRev !== committedRevision) {
        return {
          ok: false,
          reason: "claim_revision_mismatch",
          detail: `ballot vote for '${slug || "unknown"}' carries claimRevision '${String(attempt.claimRevision)}', expected '${committedRevision}'`,
          commitmentHash: providedHash,
          expectedHash,
        };
      }
    }
    if (attempt.disposition === "valid") {
      if (!slug || !eligibleSet.has(slug)) {
        return {
          ok: false,
          reason: "ineligible_voter",
          detail: `ballot vote from '${slug}' is not in the committed eligible vote set`,
          commitmentHash: providedHash,
          expectedHash,
        };
      }
      const bound = participantBySlug.get(slug);
      if (!bound) {
        return {
          ok: false,
          reason: "participant_identity_mismatch",
          detail: `ballot vote from '${slug}' is missing a committed participant identity`,
          commitmentHash: providedHash,
          expectedHash,
        };
      }
      if (
        bound.address &&
        attempt.participantAddress !== undefined &&
        attempt.participantAddress.trim() !== bound.address
      ) {
        return {
          ok: false,
          reason: "participant_identity_mismatch",
          detail: `ballot vote from '${slug}' has participantAddress '${attempt.participantAddress.trim()}', expected '${bound.address}'`,
          commitmentHash: providedHash,
          expectedHash,
        };
      }
    }
  }

  // Compare folded valid ballot against committed ballot snapshot.
  const { ballot: candidateBallot } = buildBallot([...attempts]);
  if (candidateBallot.length !== commitment.ballot.length) {
    return {
      ok: false,
      reason: "altered_after_boundary",
      detail: `ballot vote count (${candidateBallot.length}) differs from committed ballot (${commitment.ballot.length}) after voting boundary`,
      commitmentHash: providedHash,
      expectedHash,
    };
  }

  for (let i = 0; i < commitment.ballot.length; i += 1) {
    const committedVote = commitment.ballot[i]!;
    const actualVote = candidateBallot[i]!;
    const actualSlug = actualVote.slug.trim().toLowerCase();
    const bound = participantBySlug.get(actualSlug);
    const actualAddress = actualVote.participantAddress?.trim() || bound?.address;
    const actualConfidence = clampConfidence(actualVote.confidence);

    if (actualSlug !== committedVote.slug) {
      return {
        ok: false,
        reason: "altered_after_boundary",
        detail: `ballot order or voter at position ${i} changed from '${committedVote.slug}' to '${actualSlug}' after voting boundary`,
        commitmentHash: providedHash,
        expectedHash,
      };
    }
    if ((actualAddress ?? undefined) !== (committedVote.participantAddress ?? undefined)) {
      return {
        ok: false,
        reason: "participant_identity_mismatch",
        detail: `participant address for '${actualSlug}' changed after voting boundary`,
        commitmentHash: providedHash,
        expectedHash,
      };
    }
    if (
      actualVote.verdict !== committedVote.verdict ||
      actualConfidence !== committedVote.confidence ||
      actualVote.decisive !== committedVote.decisive
    ) {
      return {
        ok: false,
        reason: "altered_after_boundary",
        detail: `ballot vote for '${actualSlug}' was altered after approved voting boundary`,
        commitmentHash: providedHash,
        expectedHash,
      };
    }
    if (
      committedVote.recordedAtMs !== undefined &&
      actualVote.recordedAtMs !== committedVote.recordedAtMs
    ) {
      return {
        ok: false,
        reason: "altered_after_boundary",
        detail: `recordedAtMs for '${actualSlug}' changed after approved voting boundary`,
        commitmentHash: providedHash,
        expectedHash,
      };
    }
  }

  return {
    ok: true,
    detail: "ballot commitment verified",
    commitmentHash: expectedHash,
    expectedHash,
  };
}

/**
 * Decide whether the council ballot may settle the claim, or how to fall back.
 *
 * Every returned evaluation carries `policyRevision`, derived from the effective
 * quorum, so a recorded decision can be replayed deterministically under the
 * same revision.
 *
 * When a ballot commitment or voting-boundary binding is supplied in `opts`,
 * it is verified BEFORE outcome evaluation. Any ballot altered after the
 * approved voting boundary (or mismatching participant identities, claim
 * revision, or eligible vote set) is rejected with `abort_invalid_commitment`.
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
  const quorum = normalizeQuorum(quorumRaw);
  const policyRevision = policyRevisionFor(quorum);

  if (claimState === "cancelled") {
    return {
      action: "abort_cancelled",
      quorum,
      policyRevision,
      decisiveCount: 0,
      acceptedCount: 0,
      dispositions: countDispositions(attempts),
      reason: "claim is cancelled — council settlement aborted",
      acceptedSlugs: [],
      ballot: [],
      conflicts: [],
    };
  }

  if (claimState === "resolved") {
    return {
      action: "abort_resolved",
      quorum,
      policyRevision,
      decisiveCount: 0,
      acceptedCount: 0,
      dispositions: countDispositions(attempts),
      reason: "claim is already resolved — council pass is stale",
      acceptedSlugs: [],
      ballot: [],
      conflicts: [],
    };
  }

  if (claimState === "paused") {
    return {
      action: "abort_paused",
      quorum,
      policyRevision,
      decisiveCount: 0,
      acceptedCount: 0,
      dispositions: countDispositions(attempts),
      reason: "claim is paused — council settlement aborted",
      acceptedSlugs: [],
      ballot: [],
      conflicts: [],
    };
  }

  if (opts?.strictConfig && isInvalidQuorumConfig(quorumRaw)) {
    return {
      action: "abort_invalid_config",
      quorum: 0,
      policyRevision: policyRevisionFor(0),
      decisiveCount: 0,
      acceptedCount: 0,
      dispositions: countDispositions(attempts),
      reason: `invalid COUNCIL_QUORUM value: ${String(quorumRaw)}`,
      acceptedSlugs: [],
      ballot: [],
      conflicts: [],
    };
  }

  const quorum = normalizeQuorum(quorumRaw);
  const { ballot, rejected, conflicts } = buildBallot(attempts);
  const all = [...ballot, ...rejected];
  const dispositions = countDispositions(all);
  const decisive = ballot.filter((v) => v.decisive);
  const decisiveCount = decisive.length;
  const acceptedSlugs = ballot.map((v) => v.slug);
  const commitmentProps =
    verifiedCommitment !== undefined
      ? { commitment: verifiedCommitment, commitmentValid: true }
      : {};

  if (decisiveCount >= quorum) {
    return {
      action: "use_council",
      quorum,
      policyRevision,
      decisiveCount,
      acceptedCount: ballot.length,
      dispositions,
      reason: `quorum met: ${decisiveCount}/${quorum} decisive votes`,
      acceptedSlugs,
      ballot,
      conflicts,
    };
  }

  const dep = dispositions.dependency_failure;
  const paused = dispositions.paused;
  const reasonParts = [
    `below quorum: ${decisiveCount}/${quorum} decisive votes — solo fallback`,
    dispositions.invalid ? `${dispositions.invalid} invalid` : null,
    dispositions.stale ? `${dispositions.stale} stale` : null,
    dispositions.duplicated ? `${dispositions.duplicated} duplicated` : null,
    dispositions.cancelled ? `${dispositions.cancelled} cancelled` : null,
    paused ? `${paused} paused` : null,
    dep ? `${dep} dependency_failure` : null,
  ].filter(Boolean);

  return {
    action: "fallback_solo",
    quorum,
    policyRevision,
    decisiveCount,
    acceptedCount: ballot.length,
    dispositions,
    reason: reasonParts.join("; "),
    acceptedSlugs,
    ballot,
    conflicts,
  };
}
