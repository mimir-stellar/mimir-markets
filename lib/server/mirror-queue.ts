/*
 * What a basket subscriber has not mirrored yet, and why past suggestions are
 * no longer actionable.
 *
 * Following a basket records an intent; it cannot move money on its own. Soroban
 * has no `msg.sender` for a top-level call, so the staking account is an explicit
 * argument that must itself authorise -- `challenge_claim(challenger, …)` cannot
 * execute without that account's signature, and Mimir holds no key for the
 * subscriber. Delegated signing would need an owner-granted USDC allowance
 * (`lib/agents/spend-permissions.ts`), which a plain basket follower has not given.
 *
 * So the honest middle is this: compute what the subscriber WOULD have mirrored,
 * show it, and let them sign it themselves in one click. No custody, no waiting on
 * infrastructure that is not configured, and the queue is exactly the input the
 * delegated executor will consume once it exists.
 *
 * Positions already taken are excluded, so a mirror is never offered twice and
 * re-following does not duplicate anything.
 *
 * Each pending mirror preview is bound to a versioned basket composition snapshot
 * and its canonical SHA-256 digest (`compositionVersion`, `compositionDigest`).
 * When a basket's member identities or weights change materially from the snapshot
 * the follower reviewed, pending mirror previews for that basket are invalidated
 * until the follower reviews the updated composition.
 */

import "server-only";

import {
  basketCompositionDigest,
  compareBasketCompositions,
  createBasketCompositionSnapshot,
  DEFAULT_MATERIAL_COMPOSITION_DRIFT_BPS,
  verifyBasketCompositionSnapshot,
  type BasketCompositionDiff,
  type BasketCompositionMember,
  type BasketCompositionSnapshot,
} from "@/lib/baskets";
import { isHash32Hex } from "@/lib/content-hash";
import { getChallengersByClaimId, getClaimsByFilter, listBasketSubscriptions } from "@/lib/db";
import { computeMirrorAmountAtomic, toUsdcAtomic } from "@/lib/baskets";
import { allBasketDefinitions } from "./basket-directory";
import { listDirectoryAgents } from "./agent-directory";
import { parseAddressParam } from "./api-validation";

export interface PendingMirror {
  basketId: string;
  basketName: string;
  claimId: number;
  question: string;
  /** The member whose position is being copied. */
  agentId: string;
  agentName: string;
  /** What that member staked, in exact 7-decimal atomic USDC units (base-10 integer string). */
  memberStakeAtomic: string;
  /** What the subscriber would stake: per-market cap scaled by weight, in exact 7-decimal atomic USDC units. */
  mirrorAmountAtomic: string;
  weightBps: number;
  deadline: number;
  /** Version of the basket composition snapshot this preview was built from. */
  compositionVersion: number;
  /** Canonical SHA-256 digest binding the basket's member identities and weights. */
  compositionDigest: string;
}

export interface MirrorQueueBasketDefinition {
  id: string;
  name: string;
  members: Array<{ agentId: string; weightBps: number }>;
  /** Monotonic composition version; defaults to 1 when omitted. */
  version?: number;
  createdAt?: number;
  /** Optional pre-built composition snapshot to verify against live members. */
  compositionSnapshot?: BasketCompositionSnapshot;
}

export interface BasketCompositionReviewPin {
  basketId?: string;
  version?: number;
  compositionDigest: string;
  members?: readonly BasketCompositionMember[];
  materialDriftBps?: number;
}

export type ReviewedBasketComposition =
  | BasketCompositionSnapshot
  | BasketCompositionReviewPin
  | string;

export type MirrorInvalidationReason =
  | "basket_not_found"
  | "invalid_basket_composition"
  | "invalid_reviewed_snapshot"
  | "version_regression"
  | "composition_digest_mismatch"
  | "members_changed"
  | "member_removed"
  | "weights_changed_materially";

export interface InvalidatedBasketComposition {
  basketId: string;
  reason: MirrorInvalidationReason;
  reviewedVersion?: number;
  currentVersion?: number;
  reviewedDigest?: string;
  currentDigest?: string;
  diff?: BasketCompositionDiff;
}

export interface InvalidatedMirrorPreview {
  mirror: PendingMirror;
  reason: MirrorInvalidationReason;
  currentVersion?: number;
  currentDigest?: string;
  diff?: BasketCompositionDiff;
}

export interface ValidateMirrorPreviewsResult {
  valid: PendingMirror[];
  invalidated: InvalidatedMirrorPreview[];
}

export interface MirrorQueueOptions {
  /**
   * Per-basket composition snapshots or digest pins the follower has reviewed.
   * When a basket's live composition changes materially from the reviewed snapshot,
   * pending mirror previews for that basket are invalidated.
   */
  reviewedCompositions?: Record<string, ReviewedBasketComposition>;
  /**
   * Weight-change threshold in basis points considered material when member
   * identities are unchanged. Defaults to DEFAULT_MATERIAL_COMPOSITION_DRIFT_BPS (1 bps).
   */
  materialDriftBps?: number;
}

export interface MirrorReviewQueueResult {
  mirrors: PendingMirror[];
  snapshots: Record<string, BasketCompositionSnapshot>;
  invalidated: InvalidatedBasketComposition[];
}

export type MirrorQueueSource =
  | "subscriptions"
  | "definitions"
  | "agents"
  | "open_claims"
  | "challengers";

export type MirrorQueueStatus =
  | "invalid_subscriber"
  | "no_subscriptions"
  | "complete"
  | "incomplete";

export interface MirrorQueueSourceFailure {
  source: MirrorQueueSource;
  /** Present when a per-claim challenger lookup failed. */
  claimId?: number;
  /** Bounded, single-line error message. */
  message: string;
}

export interface MirrorQueueFailureSummary {
  /** Total number of source failures encountered (may exceed failures.length). */
  totalFailures: number;
  /** Distinct unavailable sources in deterministic order. */
  unavailableSources: MirrorQueueSource[];
  /** Bounded list of failure details (capped at MAX_MIRROR_QUEUE_FAILURES). */
  failures: MirrorQueueSourceFailure[];
  /** True when additional failures were omitted to keep the summary bounded. */
  truncated: boolean;
  /** Short actionable summary suitable for API responses, UI, and logs. */
  summary: string;
}

export interface MirrorQueueResult {
  status: MirrorQueueStatus;
  /** True when all required sources succeeded. */
  complete: boolean;
  mirrors: PendingMirror[];
  /** Basket IDs the subscriber follows (empty when unavailable or none). */
  following: string[];
  /** Bounded failure summary when status === "incomplete"; null otherwise. */
  failureSummary: MirrorQueueFailureSummary | null;
}

export const MAX_MIRROR_QUEUE_FAILURES = 10;
export const MAX_MIRROR_QUEUE_FAILURE_MESSAGE_LENGTH = 160;

const SOURCE_ORDER: readonly MirrorQueueSource[] = [
  "subscriptions",
  "definitions",
  "agents",
  "open_claims",
  "challengers",
];

function formatSourceError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) return "Source unavailable";
  if (normalized.length <= MAX_MIRROR_QUEUE_FAILURE_MESSAGE_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_MIRROR_QUEUE_FAILURE_MESSAGE_LENGTH - 1)}…`;
}

function buildFailureSummary(
  recordedFailures: MirrorQueueSourceFailure[],
  failedSources: Set<MirrorQueueSource>,
  totalFailures: number,
): MirrorQueueFailureSummary {
  const unavailableSources = SOURCE_ORDER.filter((source) => failedSources.has(source));
  const truncated = totalFailures > recordedFailures.length;
  const sourceList = unavailableSources.join(", ");
  const countDetail = truncated
    ? `${totalFailures} failures recorded (showing first ${recordedFailures.length})`
    : `${totalFailures} failure${totalFailures === 1 ? "" : "s"} recorded`;
  const summary = `Mirror queue incomplete: unavailable ${sourceList} (${countDetail}).`;

  return {
    totalFailures,
    unavailableSources,
    failures: recordedFailures,
    truncated,
    summary,
  };
}

/** The data sources the queue is built from, injectable for testing. */
export interface MirrorQueueDependencies {
  listSubscriptions: (wallet: string) => Promise<string[]>;
  listDefinitions: () => Promise<MirrorQueueBasketDefinition[]>;
  listAgents: () => Promise<Array<{ id: string; displayName: string; address: string }>>;
  listOpenClaims: () => Promise<Array<{ id: number; question?: string | null; deadline: number; creator?: string | null }>>;
  /**
   * Recently closed/resolved claims. Used to surface `closed_market`
   * ineligibility for claims that an agent staked on but that have since
   * settled. Defaults to the last 50 resolved claims ordered by deadline.
   */
  listClosedClaims: () => Promise<Array<{ id: number; question?: string | null; deadline: number; creator?: string | null }>>;
  listChallengers: (claimId: number) => Promise<Array<{ address: string; stake: number }>>;
  listReviewedCompositions?: (wallet: string) => Promise<Record<string, ReviewedBasketComposition>>;
  materialDriftBps?: number;
}

const defaultDependencies: MirrorQueueDependencies = {
  listSubscriptions: (wallet) => listBasketSubscriptions(wallet),
  listDefinitions: () => allBasketDefinitions(),
  listAgents: () => listDirectoryAgents(),
  listOpenClaims: () =>
    getClaimsByFilter({ states: ["open", "active"], orderBy: "deadline_asc", limit: 50 }),
  listClosedClaims: () =>
    getClaimsByFilter({ states: ["resolved", "settled"], orderBy: "deadline_desc", limit: 50 }),
  listChallengers: (claimId) => getChallengersByClaimId(claimId),
};

function resolveLiveSnapshot(
  definition: MirrorQueueBasketDefinition,
  capturedAtMs: number,
): BasketCompositionSnapshot | null {
  let snapshot: BasketCompositionSnapshot;
  try {
    snapshot = createBasketCompositionSnapshot({
      basketId: definition.id,
      members: definition.members,
      version: definition.version ?? definition.compositionSnapshot?.version ?? 1,
      capturedAt:
        definition.createdAt ??
        definition.compositionSnapshot?.capturedAt ??
        capturedAtMs,
      previousDigest: definition.compositionSnapshot?.previousDigest ?? null,
      requireFullAllocation: false,
    });
  } catch {
    return null;
  }

  if (definition.compositionSnapshot) {
    const verdict = verifyBasketCompositionSnapshot(definition.compositionSnapshot, {
      requireFullAllocation: false,
    });
    if (
      !verdict.ok ||
      definition.compositionSnapshot.basketId !== snapshot.basketId ||
      definition.compositionSnapshot.version !== snapshot.version ||
      definition.compositionSnapshot.compositionDigest !== snapshot.compositionDigest
    ) {
      return null;
    }
  }

  return snapshot;
}

function evaluateReviewedComposition(
  basketId: string,
  reviewed: ReviewedBasketComposition,
  liveSnapshot: BasketCompositionSnapshot,
  defaultMaterialDriftBps: number,
): InvalidatedBasketComposition | null {
  if (typeof reviewed === "string") {
    const reviewedDigest = reviewed.trim();
    if (!isHash32Hex(reviewedDigest)) {
      return {
        basketId,
        reason: "invalid_reviewed_snapshot",
        currentVersion: liveSnapshot.version,
        currentDigest: liveSnapshot.compositionDigest,
      };
    }
    if (reviewedDigest.toLowerCase() !== liveSnapshot.compositionDigest) {
      return {
        basketId,
        reason: "composition_digest_mismatch",
        reviewedDigest: reviewedDigest.toLowerCase(),
        currentVersion: liveSnapshot.version,
        currentDigest: liveSnapshot.compositionDigest,
      };
    }
    return null;
  }

  if (!reviewed || typeof reviewed !== "object") {
    return {
      basketId,
      reason: "invalid_reviewed_snapshot",
      currentVersion: liveSnapshot.version,
      currentDigest: liveSnapshot.compositionDigest,
    };
  }

  if (
    reviewed.basketId !== undefined &&
    reviewed.basketId.trim() !== "" &&
    reviewed.basketId.trim() !== basketId
  ) {
    return {
      basketId,
      reason: "invalid_reviewed_snapshot",
      currentVersion: liveSnapshot.version,
      currentDigest: liveSnapshot.compositionDigest,
    };
  }

  const rawDigest =
    typeof reviewed.compositionDigest === "string"
      ? reviewed.compositionDigest.trim()
      : "";
  if (!isHash32Hex(rawDigest)) {
    return {
      basketId,
      reason: "invalid_reviewed_snapshot",
      currentVersion: liveSnapshot.version,
      currentDigest: liveSnapshot.compositionDigest,
    };
  }
  const reviewedDigest = rawDigest.toLowerCase();

  if (reviewed.version !== undefined) {
    if (!Number.isSafeInteger(reviewed.version) || reviewed.version < 1) {
      return {
        basketId,
        reason: "invalid_reviewed_snapshot",
        reviewedDigest,
        currentVersion: liveSnapshot.version,
        currentDigest: liveSnapshot.compositionDigest,
      };
    }
    if (liveSnapshot.version < reviewed.version) {
      return {
        basketId,
        reason: "version_regression",
        reviewedVersion: reviewed.version,
        currentVersion: liveSnapshot.version,
        reviewedDigest,
        currentDigest: liveSnapshot.compositionDigest,
      };
    }
  }

  const thresholdBps =
    ("materialDriftBps" in reviewed && reviewed.materialDriftBps !== undefined
      ? reviewed.materialDriftBps
      : undefined) ?? defaultMaterialDriftBps;

  if (
    !Number.isInteger(thresholdBps) ||
    thresholdBps < 1 ||
    thresholdBps > 10_000
  ) {
    return {
      basketId,
      reason: "invalid_reviewed_snapshot",
      reviewedVersion: reviewed.version,
      currentVersion: liveSnapshot.version,
      reviewedDigest,
      currentDigest: liveSnapshot.compositionDigest,
    };
  }

  if (reviewed.members !== undefined) {
    let computedReviewedDigest: string;
    try {
      computedReviewedDigest = basketCompositionDigest(reviewed.members);
    } catch {
      return {
        basketId,
        reason: "invalid_reviewed_snapshot",
        reviewedVersion: reviewed.version,
        currentVersion: liveSnapshot.version,
        reviewedDigest,
        currentDigest: liveSnapshot.compositionDigest,
      };
    }

    if (computedReviewedDigest !== reviewedDigest) {
      return {
        basketId,
        reason: "invalid_reviewed_snapshot",
        reviewedVersion: reviewed.version,
        currentVersion: liveSnapshot.version,
        reviewedDigest,
        currentDigest: liveSnapshot.compositionDigest,
      };
    }

    const diff = compareBasketCompositions(reviewed.members, liveSnapshot.members, {
      materialDriftBps: thresholdBps,
    });
    if (diff.materialChange) {
      return {
        basketId,
        reason:
          diff.reason === "members_changed"
            ? "members_changed"
            : "weights_changed_materially",
        reviewedVersion: reviewed.version,
        currentVersion: liveSnapshot.version,
        reviewedDigest,
        currentDigest: liveSnapshot.compositionDigest,
        diff,
      };
    }

    return null;
  }

  if (reviewedDigest !== liveSnapshot.compositionDigest) {
    return {
      basketId,
      reason: "composition_digest_mismatch",
      reviewedVersion: reviewed.version,
      currentVersion: liveSnapshot.version,
      reviewedDigest,
      currentDigest: liveSnapshot.compositionDigest,
    };
  }

  return null;
}

/**
 * Resolve pending mirrors along with completeness metadata and a bounded
 * failure summary when one or more backing sources are unavailable.
 *
 * Callers can distinguish:
 *  - `status === "invalid_subscriber"` — address failed StrKey validation
 *  - `status === "no_subscriptions"`   — subscriber follows no baskets
 *  - `status === "complete"`           — all sources succeeded (empty `mirrors`
 *                                        means genuinely no eligible opportunities)
 *  - `status === "incomplete"`         — one or more sources failed; `mirrors`
 *                                        contains any partial results and
 *                                        `failureSummary` explains what failed
 */
export async function pendingMirrorQueueFor(
  subscriber: string,
  perMarketUsdc: Record<string, number> = {},
  dependencies: MirrorQueueDependencies = defaultDependencies,
): Promise<MirrorQueueResult> {
  // Strkey check, and the address is then used verbatim throughout. The EVM regex
  // this replaced rejected every Stellar address, so the mirror queue was empty
  // for every real user; the `toLowerCase()` beside it would then have failed to
  // match any stored strkey even if the guard had let one through.
  const wallet = parseAddressParam(subscriber);
  if (!wallet) {
    return {
      status: "invalid_subscriber",
      complete: true,
      mirrors: [],
      following: [],
      failureSummary: null,
    };
  }

  const recordedFailures: MirrorQueueSourceFailure[] = [];
  const failedSources = new Set<MirrorQueueSource>();
  let totalFailures = 0;

  const recordFailure = (source: MirrorQueueSource, error: unknown, claimId?: number) => {
    totalFailures += 1;
    failedSources.add(source);
    if (recordedFailures.length < MAX_MIRROR_QUEUE_FAILURES) {
      const entry: MirrorQueueSourceFailure = {
        source,
        message: formatSourceError(error),
      };
      if (claimId !== undefined) entry.claimId = claimId;
      recordedFailures.push(entry);
    }
  };

  let subscribed: string[];
  try {
    subscribed = await dependencies.listSubscriptions(wallet);
  } catch (error) {
    recordFailure("subscriptions", error);
    return {
      status: "incomplete",
      complete: false,
      mirrors: [],
      following: [],
      failureSummary: buildFailureSummary(recordedFailures, failedSources, totalFailures),
    };
  }

  if (subscribed.length === 0) {
    return {
      status: "no_subscriptions",
      complete: true,
      mirrors: [],
      following: [],
      failureSummary: null,
    };
  }

  const [definitionsResult, directoryResult, openClaimsResult] = await Promise.allSettled([
    dependencies.listDefinitions(),
    dependencies.listAgents(),
    dependencies.listOpenClaims(),
  ]);

  const definitions =
    definitionsResult.status === "fulfilled"
      ? definitionsResult.value
      : (recordFailure("definitions", definitionsResult.reason), []);
  const directory =
    directoryResult.status === "fulfilled"
      ? directoryResult.value
      : (recordFailure("agents", directoryResult.reason), []);
  const openClaims =
    openClaimsResult.status === "fulfilled"
      ? openClaimsResult.value
      : (recordFailure("open_claims", openClaimsResult.reason), []);

  const agentById = new Map(directory.map((agent) => [agent.id, agent]));
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);

  // Cache challenger lookups per claim so shared claims across multiple baskets
  // are queried once and failures are not double-counted.
  const challengersByClaim = new Map<
    number,
    { ok: true; challengers: Array<{ address: string; stake: number }> } | { ok: false }
  >();

  // Cache challenger lookups per claim so shared claims across multiple baskets
  // are queried once and failures are not double-counted.
  const challengersByClaim = new Map<
    number,
    { ok: true; challengers: Array<{ address: string; stake: number }> } | { ok: false }
  >();

  const pending: PendingMirror[] = [];
  const snapshots: Record<string, BasketCompositionSnapshot> = {};
  const invalidated: InvalidatedBasketComposition[] = [];
  const offeredClaims = new Set<number>();

  for (const basketId of subscribed) {
    const definition = definitions.find((candidate) => candidate.id === basketId);
    if (!definition) continue;

    const liveSnapshot = resolveLiveSnapshot(definition, nowMs);
    if (!liveSnapshot) {
      invalidated.push({
        basketId,
        reason: "invalid_basket_composition",
      });
      continue;
    }

    const reviewed = reviewedCompositions[basketId];
    if (reviewed !== undefined) {
      const invalidation = evaluateReviewedComposition(
        basketId,
        reviewed,
        liveSnapshot,
        materialDriftBps,
      );
      if (invalidation) {
        invalidated.push(invalidation);
        continue;
      }
    }

    snapshots[basketId] = liveSnapshot;
    const budget = perMarketUsdc[basketId] ?? 2;

    // ── Closed-market ineligibility ──────────────────────────────────────────
    // For each recently-closed claim where an agent in this basket had a
    // position, record an ineligible entry so the subscriber can see why the
    // suggestion disappeared.
    for (const claim of closedClaims) {
      const key = `${basketId}:${claim.id}`;
      if (classified.has(key)) continue;
      if (claim.creator === wallet) continue;
      if (offeredClaims.has(claim.id)) continue;

      let cached = challengersByClaim.get(claim.id);
      if (!cached) {
        try {
          const challengers = await dependencies.listChallengers(claim.id);
          cached = { ok: true, challengers };
        } catch (error) {
          recordFailure("challengers", error, claim.id);
          cached = { ok: false };
        }
        challengersByClaim.set(claim.id, cached);
      }
      if (!cached.ok) continue;

      const challengers = cached.challengers;
      const taken = new Set(challengers.map((c) => c.address));
      if (taken.has(wallet)) continue; // already mirrored, or acted independently

      for (const member of definition.members) {
        const agent = agentById.get(member.agentId);
        if (!agent) continue;
        const position = challengers.find((c) => c.address === agent.address);
        if (!position) continue;

        const mirrorUsdc = Math.round(((budget * member.weightBps) / 10_000) * 100) / 100;
        // Below a cent there is nothing to stake; the contract's minimum would
        // reject it anyway and the row would only be noise.
        if (mirrorUsdc <= 0) continue;

        classified.add(key);
        pending.push({
          basketId,
          basketName: definition.name,
          claimId: claim.id,
          question: claim.question ?? `Claim #${claim.id}`,
          agentId: agent.id,
          agentName: agent.displayName,
          memberStakeUsdc: position.stake,
          mirrorUsdc,
          weightBps: member.weightBps,
          deadline: claim.deadline,
          compositionVersion: liveSnapshot.version,
          compositionDigest: liveSnapshot.compositionDigest,
        });
        offeredClaims.add(claim.id);
        break; // one mirror per claim: the basket takes a side, not several
      }
    }
  }

  pending.sort((a, b) => a.deadline - b.deadline);

  if (totalFailures > 0) {
    return {
      status: "incomplete",
      complete: false,
      mirrors: pending,
      following: subscribed,
      failureSummary: buildFailureSummary(recordedFailures, failedSources, totalFailures),
    };
  }

  return {
    status: "complete",
    complete: true,
    mirrors: pending,
    following: subscribed,
    failureSummary: null,
  };
}

/**
 * Mirrors still open to a subscriber.
 *
 * Weighted, not flat: a member at 10% of a basket should pull 10% of the
 * subscriber's per-market budget, or following a basket would just be following
 * whichever member happened to act first.
 *
 * Kept for callers that only need the mirror array; use `pendingMirrorQueueFor`
 * when you need to distinguish empty results from unavailable sources.
 */
export async function pendingMirrorsFor(
  subscriber: string,
  perMarketUsdc: Record<string, number> = {},
  dependencies: MirrorQueueDependencies = defaultDependencies,
): Promise<PendingMirror[]> {
  const result = await pendingMirrorQueueFor(subscriber, perMarketUsdc, dependencies);
  return result.mirrors;
}
