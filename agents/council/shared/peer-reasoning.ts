/**
 * Paid council-to-council reads and versioned peer-reasoning ballot commitments.
 *
 * A persona can buy another persona's public reasoning before making its own
 * decision. This turns the council into a small information market instead of
 * ten isolated voters.
 *
 * Deliberation deadlines: each peer read is bounded by an overall deadline.
 * Reads that do not complete before the deadline are reported as deadline
 * abstentions (kind: "deadline_abstention") rather than being silently dropped,
 * so callers can distinguish a missing opinion caused by time pressure from a
 * substantive disagreement, and never treat a missing vote as consensus.
 */

import { createHash } from "node:crypto";
import { fetchWithBudget, payingWalletFor, type PayingWallet } from "../../../lib/x402/buyer";
import { outboundTraceHeaders } from "../../../lib/ops/trace-http";
import { getCouncilWallet } from "../../../lib/agent-wallets";
import {
  BallotCommitmentError,
  COUNCIL_BALLOT_COMMITMENT_VERSION,
  createBallotCommitment,
  verifyBallotCommitment,
  type BallotCommitmentFailureReason,
  type BallotCommitmentVerification,
  type BallotParticipantIdentity,
  type BallotParticipantInput,
  type CouncilBallotCommitment,
} from "../../../lib/council/quorum";
import { usdcToUnits } from "../../../lib/usdc";
import { sha256Hex } from "../../../lib/content-hash";
import {
  type PersonaSpec,
  personaSecretEnv,
} from "../personas";

export interface ClaimStatementInput {
  question?: string;
  creatorPosition?: string;
  creator_position?: string;
  sideA?: string;
  counterPosition?: string;
  counter_position?: string;
  opponent_position?: string;
  sideB?: string;
  resolutionUrl?: string;
  resolution_url?: string;
  settlementRule?: string;
  settlement_rule?: string;
  contextHash?: string;
  context_hash?: string;
}

/**
 * Computes a deterministic SHA-256 digest over a claim's statement wording
 * (question, creator position, counter position) and source commitment
 * (resolution URL, settlement rule, context hash).
 *
 * Any change to wording or source commitment produces a different digest,
 * invalidating cached peer reasoning while preserving entries for unrelated claims.
 */
export function claimStatementDigest(claim: ClaimStatementInput): string {
  const question = (claim.question ?? "").trim();
  const creatorPos = (claim.creatorPosition ?? claim.creator_position ?? claim.sideA ?? "").trim();
  const counterPos = (claim.counterPosition ?? claim.counter_position ?? claim.opponent_position ?? claim.sideB ?? "").trim();
  const sourceUrl = (claim.resolutionUrl ?? claim.resolution_url ?? "").trim();
  const rule = (claim.settlementRule ?? claim.settlement_rule ?? "").trim();
  const ctxHash = (claim.contextHash ?? claim.context_hash ?? "").trim().toLowerCase();

  const payload = [
    `question:${question}`,
    `creator:${creatorPos}`,
    `counter:${counterPos}`,
    `source:${sourceUrl}`,
    `rule:${rule}`,
    `context:${ctxHash}`,
  ].join("\n");

  return sha256Hex(payload);
}

/** Upper bound on cached peer reasoning entries so memory stays bounded. */
export const PEER_REASONING_CACHE_MAX_ENTRIES = 500;

export interface PersistedPeerReasoning {
  claimId: number;
  buyerSlug: string;
  statementDigest: string;
  reads: PeerReasoningRead[];
  cachedAt: number;
}

const persistentPeerReasoningCache = new Map<string, PersistedPeerReasoning>();

export function peerReasoningCacheKey(
  claimId: number,
  buyerSlug: string,
  statementDigest?: string,
): string {
  return statementDigest ? `${claimId}:${buyerSlug}:${statementDigest}` : `${claimId}:${buyerSlug}`;
}

export function getCachedPeerReasoning(
  claimId: number,
  buyerSlug: string,
  statementDigest?: string,
): PeerReasoningRead[] | null {
  if (statementDigest) {
    const key = peerReasoningCacheKey(claimId, buyerSlug, statementDigest);
    const hit = persistentPeerReasoningCache.get(key);
    if (hit) return hit.reads;
    return null;
  }
  for (const [, value] of persistentPeerReasoningCache) {
    if (value.claimId === claimId && value.buyerSlug === buyerSlug) {
      return value.reads;
    }
  }
  return null;
}

export function setCachedPeerReasoning(
  claimId: number,
  buyerSlug: string,
  reads: PeerReasoningRead[],
  statementDigest = "",
  nowMs = Date.now(),
): void {
  const key = peerReasoningCacheKey(claimId, buyerSlug, statementDigest);
  persistentPeerReasoningCache.delete(key);
  persistentPeerReasoningCache.set(key, {
    claimId,
    buyerSlug,
    statementDigest,
    reads,
    cachedAt: nowMs,
  });
  while (persistentPeerReasoningCache.size > PEER_REASONING_CACHE_MAX_ENTRIES) {
    const oldest = persistentPeerReasoningCache.keys().next().value;
    if (oldest === undefined) break;
    persistentPeerReasoningCache.delete(oldest);
  }
}

export function clearPeerReasoningCache(): void {
  persistentPeerReasoningCache.clear();
}

export function peerReasoningCacheSize(): number {
  return persistentPeerReasoningCache.size;
}

export function prunePeerReasoningCache(joinableClaimIds: ReadonlySet<number>): void {
  for (const [key, value] of persistentPeerReasoningCache) {
    if (!joinableClaimIds.has(value.claimId)) {
      persistentPeerReasoningCache.delete(key);
    }
  }
}

export function invalidatePeerReasoning(claimId: number, statementDigest?: string): void {
  for (const [key, value] of persistentPeerReasoningCache) {
    if (value.claimId === claimId) {
      if (!statementDigest || value.statementDigest === statementDigest) {
        persistentPeerReasoningCache.delete(key);
      }
    }
  }
}

export interface PeerReasoningRead {
  kind: "reasoning";
  sellerSlug: string;
  sellerName: string;
  reasoning: string;
  pricePaidUnits: string | null;
  /**
   * Quorum policy revision in force when this read was taken. Recorded so
   * aggregate decisions can reference the exact policy they were made under,
   * and so historical captured ballots replay deterministically even after
   * policy defaults change.
   */
  policyRevision?: string;
  claimRevision?: string;
  recordedAtMs?: number;
  alteredAtMs?: number;
}

export interface CommittedPeerReasoningRead {
  readonly sellerSlug: string;
  readonly sellerName: string;
  readonly reasoningHash: string;
  readonly pricePaidUnits: string | null;
  readonly recordedAtMs?: number;
}

export interface PeerReasoningCommitment {
  readonly version: number;
  readonly claimId: number;
  readonly claimRevision: string;
  readonly buyerSlug: string;
  readonly votingBoundaryMs: number | null;
  readonly eligibleVoteSet: readonly string[];
  readonly participantIdentities: readonly BallotParticipantIdentity[];
  readonly reads: readonly CommittedPeerReasoningRead[];
  readonly commitmentHash: string;
  readonly digest: string;
}

export interface PeerReasoningCommitmentInput {
  version?: number;
  claimId: number;
  claimRevision: number | string;
  buyerSlug: string;
  eligibleVoteSet: readonly string[];
  participantIdentities?: readonly BallotParticipantInput[];
  votingBoundaryMs?: number | null;
  reads: readonly PeerReasoningRead[];
}

export interface PeerReasoningVerifyContext {
  claimId?: number;
  claimRevision?: number | string;
  buyerSlug?: string;
  eligibleVoteSet?: readonly string[];
  participantIdentities?: readonly BallotParticipantInput[];
  votingBoundaryMs?: number | null;
}

/**
 * A peer that was asked but did not contribute reasoning in time. This is an
 * abstention, not a disagreement: it carries no opinion and must not be counted
 * toward either side of a consensus.
 */
export interface PeerDeadlineAbstention {
  kind: "deadline_abstention";
  sellerSlug: string;
  reason: "deadline_exceeded";
}

export type PeerReadOutcome = PeerReasoningRead | PeerDeadlineAbstention;

/**
 * Stable reference for the quorum policy revision that peer reads are
 * recorded under. Pinned explicitly so that changing defaults elsewhere does
 * not silently rewrite the revision attached to previously captured ballots.
 */
export const PEER_REASONING_POLICY_REVISION = "quorum-policy/v1";

interface ReasoningResponse {
  claimId?: number;
  claimRevision?: number | string;
  reasoning?: string;
  paidTo?: string;
  recordedAtMs?: number;
  alteredAtMs?: number;
  persona?: {
    slug?: string;
    name?: string;
  };
}

const CONTROL_OR_SEP = /[\u0000-\u001f\u007f|,]/;

function normalizeSlug(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

function normalizeRevision(value: number | string | undefined | null): string | null {
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

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizePeerEligibleSet(
  raw: readonly string[],
  buyerSlug: string,
): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BallotCommitmentError(
      "invalid_eligible_vote_set",
      "eligibleVoteSet must be a non-empty array of peer persona slugs",
    );
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const slug = normalizeSlug(item);
    if (!slug || CONTROL_OR_SEP.test(slug)) {
      throw new BallotCommitmentError(
        "invalid_eligible_vote_set",
        `invalid eligible peer slug '${String(item)}'`,
      );
    }
    if (slug === buyerSlug) {
      throw new BallotCommitmentError(
        "ineligible_voter",
        `buyer '${buyerSlug}' cannot be in its own eligible peer vote set`,
      );
    }
    if (seen.has(slug)) {
      throw new BallotCommitmentError(
        "invalid_eligible_vote_set",
        `duplicate eligible peer slug '${slug}'`,
      );
    }
    seen.add(slug);
    out.push(slug);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function normalizePeerParticipants(
  raw: readonly BallotParticipantInput[] | undefined,
  buyerSlug: string,
  eligibleVoteSet: readonly string[],
): BallotParticipantIdentity[] {
  const allowed = new Set<string>([buyerSlug, ...eligibleVoteSet]);
  const bySlug = new Map<string, BallotParticipantIdentity>();

  if (raw !== undefined) {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new BallotCommitmentError(
        "invalid_participant_identity",
        "participantIdentities must be a non-empty array when provided",
      );
    }
    for (const item of raw) {
      const spec: BallotParticipantIdentity =
        typeof item === "string"
          ? { slug: item }
          : item && typeof item === "object"
            ? item
            : (() => {
                throw new BallotCommitmentError(
                  "invalid_participant_identity",
                  "participant identity must be a string or object",
                );
              })();
      const slug = normalizeSlug(spec.slug);
      if (!slug || CONTROL_OR_SEP.test(slug)) {
        throw new BallotCommitmentError(
          "invalid_participant_identity",
          `invalid participant slug '${String(spec.slug)}'`,
        );
      }
      if (!allowed.has(slug)) {
        throw new BallotCommitmentError(
          "ineligible_voter",
          `participant '${slug}' is neither buyer '${buyerSlug}' nor in eligibleVoteSet`,
        );
      }
      if (bySlug.has(slug)) {
        throw new BallotCommitmentError(
          "invalid_participant_identity",
          `duplicate participant identity for '${slug}'`,
        );
      }
      const address = spec.address !== undefined ? spec.address.trim() : undefined;
      if (address !== undefined && (!address || CONTROL_OR_SEP.test(address))) {
        throw new BallotCommitmentError(
          "invalid_participant_identity",
          `invalid participant address for '${slug}'`,
        );
      }
      const track = spec.track;
      if (track !== undefined && track !== "classic" && track !== "philosopher") {
        throw new BallotCommitmentError(
          "invalid_participant_identity",
          `invalid participant track '${String(track)}' for '${slug}'`,
        );
      }
      bySlug.set(
        slug,
        Object.freeze({
          slug,
          ...(address ? { address } : {}),
          ...(track ? { track } : {}),
        }),
      );
    }
    if (!bySlug.has(buyerSlug)) {
      throw new BallotCommitmentError(
        "participant_identity_mismatch",
        `buyer '${buyerSlug}' is missing from participantIdentities`,
      );
    }
  } else {
    for (const slug of allowed) {
      bySlug.set(slug, Object.freeze({ slug }));
    }
  }

  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

function serializePeerParticipant(p: BallotParticipantIdentity): string {
  return `${p.slug}@${p.address ?? ""}:${p.track ?? ""}`;
}

function serializeCommittedPeerRead(r: CommittedPeerReasoningRead): string {
  return [
    r.sellerSlug,
    r.sellerName,
    r.reasoningHash,
    r.pricePaidUnits ?? "",
    r.recordedAtMs !== undefined ? String(r.recordedAtMs) : "",
  ].join("|");
}

function canonicalPeerReasoningCommitmentPayload(
  commitment: Omit<PeerReasoningCommitment, "commitmentHash" | "digest">,
): string {
  return [
    "mimir-council-peer-reasoning-commitment",
    `version:${commitment.version}`,
    `claim:${commitment.claimId}`,
    `revision:${commitment.claimRevision}`,
    `buyer:${commitment.buyerSlug}`,
    `boundary:${commitment.votingBoundaryMs === null ? "none" : commitment.votingBoundaryMs}`,
    `eligible:${commitment.eligibleVoteSet.join(",")}`,
    `participants:${commitment.participantIdentities.map(serializePeerParticipant).join(",")}`,
    `reads:${commitment.reads.length}`,
    ...commitment.reads.map(serializeCommittedPeerRead),
  ].join("\n");
}

function computePeerCommitmentDigest(
  commitment: Omit<PeerReasoningCommitment, "commitmentHash" | "digest">,
): string {
  return sha256Text(canonicalPeerReasoningCommitmentPayload(commitment));
}

/**
 * Create a versioned commitment over a buyer persona's peer-reasoning ballot
 * before outcome evaluation.
 */
export function createPeerReasoningCommitment(
  input: PeerReasoningCommitmentInput,
): PeerReasoningCommitment {
  const version = input.version ?? PEER_REASONING_COMMITMENT_VERSION;
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version !== PEER_REASONING_COMMITMENT_VERSION
  ) {
    throw new BallotCommitmentError(
      "invalid_version",
      `unsupported peer-reasoning commitment version: ${String(version)}`,
    );
  }

  if (!Number.isInteger(input.claimId) || input.claimId < 1) {
    throw new BallotCommitmentError(
      "invalid_claim_id",
      `claimId must be a positive integer, got ${String(input.claimId)}`,
    );
  }

  const claimRevision = normalizeRevision(input.claimRevision);
  if (!claimRevision) {
    throw new BallotCommitmentError(
      "invalid_claim_revision",
      `claimRevision must be a non-empty string or non-negative integer, got ${String(input.claimRevision)}`,
    );
  }

  const buyerSlug = normalizeSlug(input.buyerSlug);
  if (!buyerSlug || CONTROL_OR_SEP.test(buyerSlug)) {
    throw new BallotCommitmentError(
      "invalid_participant_identity",
      `invalid buyerSlug '${String(input.buyerSlug)}'`,
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
      throw new BallotCommitmentError(
        "invalid_voting_boundary",
        `votingBoundaryMs must be a non-negative integer epoch ms, got ${String(input.votingBoundaryMs)}`,
      );
    }
    votingBoundaryMs = input.votingBoundaryMs;
  }

  const eligibleVoteSet = normalizePeerEligibleSet(input.eligibleVoteSet, buyerSlug);
  const eligibleSet = new Set(eligibleVoteSet);
  const participantIdentities = normalizePeerParticipants(
    input.participantIdentities,
    buyerSlug,
    eligibleVoteSet,
  );
  const participantBySlug = new Map(participantIdentities.map((p) => [p.slug, p]));

  if (!Array.isArray(input.reads)) {
    throw new BallotCommitmentError("ballot_altered", "reads must be an array");
  }

  const seenSellers = new Set<string>();
  const committedReads: CommittedPeerReasoningRead[] = [];

  for (const read of input.reads) {
    const sellerSlug = normalizeSlug(read?.sellerSlug);
    if (!sellerSlug || CONTROL_OR_SEP.test(sellerSlug)) {
      throw new BallotCommitmentError(
        "invalid_participant_identity",
        `invalid sellerSlug '${String(read?.sellerSlug)}'`,
      );
    }
    if (!eligibleSet.has(sellerSlug)) {
      throw new BallotCommitmentError(
        "ineligible_voter",
        `seller '${sellerSlug}' is not in the committed eligible vote set`,
      );
    }
    if (!participantBySlug.has(sellerSlug)) {
      throw new BallotCommitmentError(
        "participant_identity_mismatch",
        `seller '${sellerSlug}' has no bound participant identity`,
      );
    }
    if (seenSellers.has(sellerSlug)) {
      throw new BallotCommitmentError(
        "ballot_altered",
        `duplicate peer reasoning read from seller '${sellerSlug}'`,
      );
    }
    if (read.claimRevision !== undefined) {
      const readRev = normalizeRevision(read.claimRevision);
      if (!readRev || readRev !== claimRevision) {
        throw new BallotCommitmentError(
          "claim_revision_mismatch",
          `peer read from '${sellerSlug}' carries claimRevision '${String(read.claimRevision)}', expected '${claimRevision}'`,
        );
      }
    }
    if (votingBoundaryMs !== null) {
      if (
        read.alteredAtMs !== undefined &&
        (!Number.isFinite(read.alteredAtMs) || read.alteredAtMs > votingBoundaryMs)
      ) {
        throw new BallotCommitmentError(
          "altered_after_boundary",
          `peer read from '${sellerSlug}' was altered at ${String(read.alteredAtMs)}ms after approved voting boundary ${votingBoundaryMs}ms`,
        );
      }
      if (
        read.recordedAtMs !== undefined &&
        (!Number.isFinite(read.recordedAtMs) || read.recordedAtMs > votingBoundaryMs)
      ) {
        throw new BallotCommitmentError(
          "recorded_after_boundary",
          `peer read from '${sellerSlug}' was recorded at ${String(read.recordedAtMs)}ms after approved voting boundary ${votingBoundaryMs}ms`,
        );
      }
    }
    const reasoning = String(read.reasoning ?? "").trim();
    if (!reasoning) {
      throw new BallotCommitmentError(
        "ballot_altered",
        `peer read from '${sellerSlug}' has empty reasoning`,
      );
    }
    const sellerName = String(read.sellerName ?? sellerSlug).trim();
    if (!sellerName || CONTROL_OR_SEP.test(sellerName)) {
      throw new BallotCommitmentError(
        "invalid_participant_identity",
        `invalid sellerName for '${sellerSlug}'`,
      );
    }

    seenSellers.add(sellerSlug);
    committedReads.push(
      Object.freeze({
        sellerSlug,
        sellerName,
        reasoningHash: sha256Text(reasoning),
        pricePaidUnits: read.pricePaidUnits ?? null,
        ...(read.recordedAtMs !== undefined ? { recordedAtMs: read.recordedAtMs } : {}),
      }),
    );
  }

  const unsigned = {
    version,
    claimId: input.claimId,
    claimRevision,
    buyerSlug,
    votingBoundaryMs,
    eligibleVoteSet: Object.freeze([...eligibleVoteSet]),
    participantIdentities: Object.freeze([...participantIdentities]),
    reads: Object.freeze(committedReads),
  };

  const commitmentHash = computePeerCommitmentDigest(unsigned);

  return Object.freeze({
    ...unsigned,
    commitmentHash,
    digest: commitmentHash,
  });
}

/**
 * Verify a list of peer-reasoning reads against a sealed {@link PeerReasoningCommitment}
 * before outcome evaluation.
 */
export function verifyPeerReasoningCommitment(
  commitment: PeerReasoningCommitment | null | undefined,
  reads: readonly PeerReasoningRead[],
  context?: PeerReasoningVerifyContext,
): BallotCommitmentVerification {
  if (!commitment || typeof commitment !== "object") {
    return {
      ok: false,
      reason: "ballot_altered",
      detail: "missing peer-reasoning commitment",
    };
  }

  if (
    typeof commitment.version !== "number" ||
    !Number.isInteger(commitment.version) ||
    commitment.version !== PEER_REASONING_COMMITMENT_VERSION
  ) {
    return {
      ok: false,
      reason: "invalid_version",
      detail: `unsupported peer-reasoning commitment version ${String(commitment.version)}`,
    };
  }

  if (context?.claimId !== undefined && context.claimId !== commitment.claimId) {
    return {
      ok: false,
      reason: "invalid_claim_id",
      detail: `claimId ${context.claimId} does not match committed claimId ${commitment.claimId}`,
    };
  }

  const committedRevision = normalizeRevision(commitment.claimRevision);
  if (!committedRevision) {
    return {
      ok: false,
      reason: "invalid_claim_revision",
      detail: "committed claimRevision is invalid",
    };
  }

  if (context?.claimRevision !== undefined) {
    const contextRevision = normalizeRevision(context.claimRevision);
    if (!contextRevision || contextRevision !== committedRevision) {
      return {
        ok: false,
        reason: "claim_revision_mismatch",
        detail: `claimRevision '${String(context.claimRevision)}' does not match committed revision '${committedRevision}'`,
      };
    }
  }

  const buyerSlug = normalizeSlug(commitment.buyerSlug);
  if (context?.buyerSlug !== undefined && normalizeSlug(context.buyerSlug) !== buyerSlug) {
    return {
      ok: false,
      reason: "participant_identity_mismatch",
      detail: `buyerSlug '${context.buyerSlug}' does not match committed buyer '${buyerSlug}'`,
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
      detail: `votingBoundaryMs ${context.votingBoundaryMs} does not match committed boundary ${commitment.votingBoundaryMs}`,
    };
  }

  let committedEligible: string[];
  try {
    committedEligible = normalizePeerEligibleSet(commitment.eligibleVoteSet, buyerSlug);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof BallotCommitmentError ? err.reason : "invalid_eligible_vote_set",
      detail: err instanceof Error ? err.message : "invalid committed eligibleVoteSet",
    };
  }

  if (context?.eligibleVoteSet !== undefined) {
    let contextEligible: string[];
    try {
      contextEligible = normalizePeerEligibleSet(context.eligibleVoteSet, buyerSlug);
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
        detail: "eligible vote set does not match committed peer eligibleVoteSet",
      };
    }
  }

  let committedParticipants: BallotParticipantIdentity[];
  try {
    committedParticipants = normalizePeerParticipants(
      commitment.participantIdentities,
      buyerSlug,
      committedEligible,
    );
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof BallotCommitmentError ? err.reason : "invalid_participant_identity",
      detail: err instanceof Error ? err.message : "invalid committed participantIdentities",
    };
  }

  if (context?.participantIdentities !== undefined) {
    let contextParticipants: BallotParticipantIdentity[];
    try {
      contextParticipants = normalizePeerParticipants(
        context.participantIdentities,
        buyerSlug,
        committedEligible,
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
        (p, idx) =>
          serializePeerParticipant(p) !== serializePeerParticipant(committedParticipants[idx]!),
      )
    ) {
      return {
        ok: false,
        reason: "participant_identity_mismatch",
        detail: "participantIdentities do not match committed peer participant identities",
      };
    }
  }

  const expectedHash = computePeerCommitmentDigest({
    version: commitment.version,
    claimId: commitment.claimId,
    claimRevision: committedRevision,
    buyerSlug,
    votingBoundaryMs: commitment.votingBoundaryMs,
    eligibleVoteSet: commitment.eligibleVoteSet,
    participantIdentities: commitment.participantIdentities,
    reads: commitment.reads,
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
      detail: "peer-reasoning commitment hash does not match canonical payload",
      commitmentHash: providedHash,
      expectedHash,
    };
  }

  const effectiveBoundaryMs =
    commitment.votingBoundaryMs ??
    (context?.votingBoundaryMs !== undefined && context.votingBoundaryMs !== null
      ? context.votingBoundaryMs
      : null);
  const eligibleSet = new Set(committedEligible);

  for (const read of reads) {
    const sellerSlug = normalizeSlug(read?.sellerSlug);
    if (!sellerSlug || !eligibleSet.has(sellerSlug)) {
      return {
        ok: false,
        reason: "ineligible_voter",
        detail: `peer read seller '${sellerSlug}' is not in the committed eligible vote set`,
        commitmentHash: providedHash,
        expectedHash,
      };
    }
    if (read.claimRevision !== undefined) {
      const readRev = normalizeRevision(read.claimRevision);
      if (!readRev || readRev !== committedRevision) {
        return {
          ok: false,
          reason: "claim_revision_mismatch",
          detail: `peer read from '${sellerSlug}' has claimRevision '${String(read.claimRevision)}', expected '${committedRevision}'`,
          commitmentHash: providedHash,
          expectedHash,
        };
      }
    }
    if (effectiveBoundaryMs !== null) {
      if (
        read.alteredAtMs !== undefined &&
        (!Number.isFinite(read.alteredAtMs) || read.alteredAtMs > effectiveBoundaryMs)
      ) {
        return {
          ok: false,
          reason: "altered_after_boundary",
          detail: `peer read from '${sellerSlug}' was altered at ${String(read.alteredAtMs)}ms after approved voting boundary ${effectiveBoundaryMs}ms`,
          commitmentHash: providedHash,
          expectedHash,
        };
      }
      if (
        read.recordedAtMs !== undefined &&
        (!Number.isFinite(read.recordedAtMs) || read.recordedAtMs > effectiveBoundaryMs)
      ) {
        return {
          ok: false,
          reason: "recorded_after_boundary",
          detail: `peer read from '${sellerSlug}' was recorded at ${String(read.recordedAtMs)}ms after approved voting boundary ${effectiveBoundaryMs}ms`,
          commitmentHash: providedHash,
          expectedHash,
        };
      }
    }
  }

  if (reads.length !== commitment.reads.length) {
    return {
      ok: false,
      reason: "altered_after_boundary",
      detail: `peer-reasoning read count (${reads.length}) differs from committed ballot (${commitment.reads.length}) after voting boundary`,
      commitmentHash: providedHash,
      expectedHash,
    };
  }

  for (let i = 0; i < commitment.reads.length; i += 1) {
    const committedRead = commitment.reads[i]!;
    const actualRead = reads[i]!;
    const actualSlug = normalizeSlug(actualRead.sellerSlug);
    const actualName = String(actualRead.sellerName ?? "").trim();
    const actualHash = sha256Text(String(actualRead.reasoning ?? "").trim());

    if (
      actualSlug !== committedRead.sellerSlug ||
      actualName !== committedRead.sellerName ||
      actualHash !== committedRead.reasoningHash ||
      (actualRead.pricePaidUnits ?? null) !== (committedRead.pricePaidUnits ?? null) ||
      (committedRead.recordedAtMs !== undefined &&
        actualRead.recordedAtMs !== committedRead.recordedAtMs)
    ) {
      return {
        ok: false,
        reason: "altered_after_boundary",
        detail: `peer-reasoning read at index ${i} ('${actualSlug}') was altered after approved voting boundary`,
        commitmentHash: providedHash,
        expectedHash,
      };
    }
  }

  return {
    ok: true,
    detail: "peer-reasoning commitment verified",
    commitmentHash: expectedHash,
    expectedHash,
  };
}

function payingWalletForPersona(persona: PersonaSpec): PayingWallet | null {
  if (!process.env[personaSecretEnv(persona)]) return null;
  try {
    return payingWalletFor(getCouncilWallet(persona.slug));
  } catch {
    return null;
  }
}

/**
 * Replays a council policy over captured ballots without contacting any model
 * provider. Each fixture pairs a claim with the independent opinions gathered
 * earlier, so quorum and confidence rules can be compared on identical inputs.
 */
export interface CapturedBallot {
  persona: string;
  verdict: "yes" | "no" | "abstain";
  confidence: number;
}

export interface CouncilPolicy {
  name: string;
  quorum: number;
  minConfidence: number;
}

export interface PolicyDecision {
  policy: string;
  decision: "yes" | "no" | "undecided";
}

export function runPolicyComparison(
  ballots: CapturedBallot[],
  policies: CouncilPolicy[],
): PolicyDecision[] {
  return policies.map((policy) => {
    const counted = ballots.filter(
      (b) => b.verdict !== "abstain" && b.confidence >= policy.minConfidence,
    );
    if (counted.length < policy.quorum) {
      return { policy: policy.name, decision: "undecided" as const };
    }
    const yes = counted.filter((b) => b.verdict === "yes").length;
    const no = counted.length - yes;
    if (yes === no) return { policy: policy.name, decision: "undecided" as const };
    return { policy: policy.name, decision: yes > no ? ("yes" as const) : ("no" as const) };
  });
}

export function changedDecisions(
  baseline: PolicyDecision[],
  candidate: PolicyDecision[],
): PolicyDecision[] {
  const byName = new Map(baseline.map((d) => [d.policy, d.decision]));
  return candidate.filter((d) => byName.get(d.policy) !== d.decision);
}

export function selectPeerSellers(
  buyer: PersonaSpec,
  activePersonas: PersonaSpec[],
  claimId: number,
  count: number,
): PersonaSpec[] {
  const peers = activePersonas.filter((persona) => persona.slug !== buyer.slug);
  if (peers.length <= count) return peers;

  const buyerIndex = activePersonas.findIndex((persona) => persona.slug === buyer.slug);
  const offset = Math.max(0, buyerIndex) + claimId;
  const rotated = [...peers.slice(offset % peers.length), ...peers.slice(0, offset % peers.length)];
  return rotated.slice(0, count);
}

/**
 * Returns the peer reads that completed before the deadline, plus one
 * deadline abstention for every seller that was still outstanding when the
 * deadline elapsed. A deadline of 0 or less disables the bound (no abstentions
 * are produced from time alone).
 */
export async function buyPeerReasoning(args: {
  buyer: PersonaSpec;
  activePersonas: PersonaSpec[];
  claimId: number;
  baseUrl: string;
  readsPerPersona: number;
  capUsdc: number;
  delayMs: number;
  deadlineMs?: number;
  policyRevision?: string;
}): Promise<PeerReadOutcome[]> {
  if (args.readsPerPersona <= 0) return [];

  if (!args.skipCache && statementDigest) {
    const cached = getCachedPeerReasoning(args.claimId, args.buyer.slug, statementDigest);
    if (cached && cached.length > 0) {
      return {
        reads: cached,
        outages: [],
        conflicts: [],
        remainingUnits: capUnits,
        totalPaidUnits: 0n,
      };
    }
  }

  const payer =
    args.payer !== undefined
      ? args.payer
      : payingWalletForPersona(args.buyer);
  if (!payer) return emptyOutcome;

  const doFetch = args.fetchWithBudgetImpl ?? fetchWithBudget;
  const sleep =
    args.sleepFn ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  const policyRevision = args.policyRevision ?? PEER_REASONING_POLICY_REVISION;
  const sellers = selectPeerSellers(
    args.buyer,
    args.activePersonas,
    args.claimId,
    args.readsPerPersona,
  );
  const deadlineMs = args.deadlineMs ?? 0;
  const deadlineAt = deadlineMs > 0 ? Date.now() + deadlineMs : Number.POSITIVE_INFINITY;
  const outcomes: PeerReadOutcome[] = [];

  let remainingUnits = usdcToUnits(args.capUsdc);
  let deadlineHit = false;

  for (const seller of sellers) {
    if (Date.now() >= deadlineAt) {
      deadlineHit = true;
      break;
    }
    if (remainingUnits <= 0n) break;
    const sellerSlug = normalizeSlug(seller.slug);
    if (!eligibleSet.has(sellerSlug)) continue;
    if (args.votingBoundaryMs !== undefined && nowFn() > args.votingBoundaryMs) {
      break;
    }

    let url =
      `${args.baseUrl.replace(/\/$/, "")}/api/council/reasoning` +
      `?claimId=${encodeURIComponent(String(args.claimId))}` +
      `&persona=${encodeURIComponent(seller.slug)}` +
      (statementDigest ? `&statementDigest=${encodeURIComponent(statementDigest)}` : "");

    try {
      let fetchPromise = doFetch(url, payer, remainingUnits, {
        method: "GET",
        headers: { accept: "application/json", ...outboundTraceHeaders() },
      });
      if (!result.response.ok) {
        if (Date.now() >= deadlineAt) deadlineHit = true;
        continue;
      }

      const body = (await result.response.json()) as ReasoningResponse;
      const reasoning = String(body.reasoning ?? "").trim();
      if (!reasoning) {
        if (Date.now() >= deadlineAt) deadlineHit = true;
        continue;
      }

      outcomes.push({
        kind: "reasoning",
        sellerSlug: body.persona?.slug ?? seller.slug,
        sellerName: body.persona?.name ?? seller.displayName,
        reasoning: reasoning.slice(0, 360),
        pricePaidUnits: result.payment?.priceUnits?.toString() ?? null,
        policyRevision,
        ...(expectedRevision !== null
          ? { claimRevision: expectedRevision }
          : body.claimRevision !== undefined
            ? { claimRevision: String(body.claimRevision).trim() }
            : {}),
        ...(body.recordedAtMs !== undefined ? { recordedAtMs: body.recordedAtMs } : {}),
        ...(body.alteredAtMs !== undefined ? { alteredAtMs: body.alteredAtMs } : {}),
      };

      reads.push(readEntry);

      if (result.payment) {
        remainingUnits -= priceUnits;
        totalPaidUnits += priceUnits;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = /timeout|timed out/i.test(message);
      const outage: PeerOutageReport = {
        sellerSlug: seller.slug,
        status: isTimeout ? "timeout" : "network_error",
        message,
      };
      outages.push(outage);
      if (args.onOutage) args.onOutage(outage);

      console.warn(
        `[council:${args.buyer.slug}] peer read failed from ${seller.slug}:`,
        message,
      );
      if (Date.now() >= deadlineAt) deadlineHit = true;
    }

    if (args.delayMs > 0) {
      await sleep(args.delayMs);
    }
  }

  // Any seller we did not get a reasoning response from by the deadline is an
  // abstention. Sellers already represented in `outcomes` are excluded.
  if (deadlineHit || Date.now() >= deadlineAt) {
    const answered = new Set(
      outcomes.filter((o): o is PeerReasoningRead => o.kind === "reasoning").map((o) => o.sellerSlug),
    );
    for (const seller of sellers) {
      if (answered.has(seller.slug)) continue;
      if (outcomes.some((o) => o.kind === "deadline_abstention" && o.sellerSlug === seller.slug)) continue;
      if (!deadlineHit && Date.now() < deadlineAt) continue;
      outcomes.push({
        kind: "deadline_abstention",
        sellerSlug: seller.slug,
        reason: "deadline_exceeded",
      });
    }
  }

  return outcomes;
}

/** Narrow a mixed outcome list to substantive peer reasoning only. */
export function substantivePeerReads(outcomes: PeerReadOutcome[]): PeerReasoningRead[] {
  return outcomes.filter((o): o is PeerReasoningRead => o.kind === "reasoning");
}
