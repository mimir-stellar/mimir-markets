/**
 * Council quorum + fallback rules for settlement (agents / RFB council boundary).
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
export type ClaimSettleState = "open" | "active" | "resolved" | "cancelled" | "paused";

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
 */
export type VoteDisposition =
  | "valid"
  | "invalid"
  | "stale"
  | "duplicated"
  | "cancelled"
  | "paused"
  | "dependency_failure";

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
  /** Statement digest of the claim when reasoning/vote was generated. */
  statementDigest?: string;
  /** Expected statement digest; mismatch classifies attempt as stale. */
  expectedStatementDigest?: string;
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
});

export function isDecisiveVerdict(verdict: Verdict): boolean {
  return verdict === "CREATOR_WINS" || verdict === "CHALLENGERS_WIN" || (verdict as string) === "CHALLENGERS_WINS";
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
  return Math.min(Math.floor(n), MAX_COUNCIL_QUORUM);
}

/**
 * Tell whether a raw quorum value is clearly broken, so strict mode can abort
 * before settling.
 */
export function isInvalidQuorumConfig(raw: unknown): boolean {
  if (raw == null || raw === undefined || raw === "") return false;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return !Number.isFinite(n) || n < 1;
}

/**
 * Classify a raw persona response into a disposition for the ballot.
 *
 * Precedence:
 *   1. Persona paused → paused (must not vote)
 *   2. Claim cancelled → cancelled (must not settle)
 *   3. Claim already resolved → stale (must not replay)
 *   4. Mismatched claimId → stale (cross-claim leakage)
 *   5. Mismatched statementDigest → stale (claim wording or source commitment changed)
 *   6. Response aged past maxAgeMs → stale (cached verdict too old)
 *   7. Transport failure (network / timeout / 5xx) → dependency_failure
 *   8. Missing slug or unknown verdict → invalid
 *   9. Otherwise → valid (decisive iff CREATOR_WINS | CHALLENGERS_WIN)
 */
export function classifyVoteAttempt(input: VoteAttemptInput): ClassifiedVote {
  const slug = (input.slug ?? "").trim().toLowerCase();
  if (!slug) {
    return {
      slug: "",
      disposition: "invalid",
      reason: "missing or empty persona slug",
      decisive: false,
    };
  }

  if (input.personaPaused) {
    return {
      slug,
      disposition: "paused",
      reason: "persona is currently paused",
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
    input.expectedStatementDigest &&
    input.statementDigest &&
    input.statementDigest !== input.expectedStatementDigest
  ) {
    return {
      slug,
      disposition: "stale",
      reason: "claim statement digest mismatch (statement wording or source commitment changed)",
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
        reason: `vote endpoint HTTP ${code}`,
        decisive: false,
      };
    }
    if (code === 404) {
      return {
        slug,
        disposition: "stale",
        reason: "vote endpoint 404 — claim not found",
        decisive: false,
      };
    }
    return {
      slug,
      disposition: "invalid",
      reason: `vote endpoint rejected request (HTTP ${code})`,
      decisive: false,
    };
  }

  if (!isVerdict(input.verdict)) {
    return {
      slug,
      disposition: "invalid",
      reason: `verdict '${String(input.verdict)}' is not one of CREATOR_WINS | CHALLENGERS_WIN | DRAW | UNRESOLVABLE`,
      decisive: false,
    };
  }

  const confidenceRaw =
    typeof input.confidence === "number"
      ? input.confidence
      : typeof input.confidence === "string"
        ? Number(input.confidence)
        : 0;
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(100, Math.round(confidenceRaw)))
    : 0;

  return {
    slug,
    disposition: "valid",
    reason: "well-formed vote",
    verdict: input.verdict,
    confidence,
    decisive: isDecisiveVerdict(input.verdict),
  };
}

/**
 * Fold classified attempts into a ballot: first valid vote per slug wins;
 * later attempts for the same slug become `duplicated`. Non-valid attempts
 * pass through to `rejected` unchanged.
 */
export function buildBallot(attempts: readonly ClassifiedVote[]): {
  ballot: ClassifiedVote[];
  rejected: ClassifiedVote[];
} {
  const ballot: ClassifiedVote[] = [];
  const rejected: ClassifiedVote[] = [];
  const seenSlugs = new Set<string>();

  for (const attempt of attempts) {
    if (attempt.disposition !== "valid") {
      rejected.push(attempt);
      continue;
    }
    if (seenSlugs.has(attempt.slug)) {
      rejected.push({
        ...attempt,
        disposition: "duplicated",
        reason: `persona '${attempt.slug}' already submitted a vote on this ballot`,
        decisive: false,
      });
      continue;
    }
    seenSlugs.add(attempt.slug);
    ballot.push(attempt);
  }

  return { ballot, rejected };
}

function countDispositions(votes: readonly ClassifiedVote[]): Record<VoteDisposition, number> {
  const counts = EMPTY_DISPOSITIONS();
  for (const v of votes) {
    counts[v.disposition] = (counts[v.disposition] ?? 0) + 1;
  }
  return counts;
}

export interface QuorumEvaluationOptions {
  /**
   * On-chain claim state. Checked before counting votes so a cancelled or
   * already-resolved claim aborts even if every attempt looks valid.
   */
  claimState?: ClaimSettleState;
  /**
   * Reject unparseable quorum config with `abort_invalid_config` instead of
   * falling back to the default.
   */
  strictConfig?: boolean;
}

/**
 * Pure policy gate: evaluates whether a set of vote attempts meets quorum.
 *
 * Rules:
 *   - Cancelled claim aborts (`abort_cancelled`).
 *   - Resolved claim aborts (`abort_resolved`).
 *   - Strict-config aborts on junk quorum (`abort_invalid_config`).
 *   - Duplicate persona attempts are deduplicated (first valid wins).
 *   - Decisive votes (CREATOR_WINS | CHALLENGERS_WIN) must meet or exceed quorum.
 *   - If decisive votes >= quorum → `use_council`.
 *   - Otherwise → `fallback_solo` with the shortfall in `reason`.
 */
export function evaluateQuorum(
  attempts: readonly ClassifiedVote[],
  quorumRaw: unknown = DEFAULT_COUNCIL_QUORUM,
  opts?: QuorumEvaluationOptions,
): QuorumEvaluation {
  if (opts?.claimState === "cancelled") {
    return {
      action: "abort_cancelled",
      quorum: 0,
      decisiveCount: 0,
      acceptedCount: 0,
      dispositions: countDispositions(attempts),
      reason: "claim is cancelled on-chain — council settlement aborted",
      acceptedSlugs: [],
      ballot: [],
    };
  }

  if (opts?.claimState === "resolved") {
    return {
      action: "abort_resolved",
      quorum: 0,
      decisiveCount: 0,
      acceptedCount: 0,
      dispositions: countDispositions(attempts),
      reason: "claim is already resolved — council settlement aborted",
      acceptedSlugs: [],
      ballot: [],
    };
  }

  if (opts?.claimState === "paused") {
    return {
      action: "abort_paused",
      quorum: 0,
      decisiveCount: 0,
      acceptedCount: 0,
      dispositions: countDispositions(attempts),
      reason: "claim is paused — council settlement aborted",
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
  const { ballot, rejected } = buildBallot(attempts);
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
      reason: `council quorum met (${decisiveCount}/${quorum} decisive votes)`,
      acceptedSlugs,
      ballot,
    };
  }

  const dep = dispositions.dependency_failure;
  const paused = dispositions.paused;
  const reasonParts = [
    `below quorum: ${decisiveCount} decisive < ${quorum}`,
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

export {
  claimStatementDigest,
  type ClaimStatementInput,
} from "../../agents/council/shared/peer-reasoning";
