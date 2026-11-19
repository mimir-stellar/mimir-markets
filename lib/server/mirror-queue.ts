/*
 * What a basket subscriber has not mirrored yet.
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
  /** What that member staked, display USDC. */
  memberStakeUsdc: number;
  /** What the subscriber would stake: their per-market cap scaled by weight. */
  mirrorUsdc: number;
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

/** The data sources the queue is built from, injectable for testing. */
export interface MirrorQueueDependencies {
  listSubscriptions: (wallet: string) => Promise<string[]>;
  listDefinitions: () => Promise<MirrorQueueBasketDefinition[]>;
  listAgents: () => Promise<Array<{ id: string; displayName: string; address: string }>>;
  listOpenClaims: () => Promise<Array<{ id: number; question?: string | null; deadline: number; creator?: string | null }>>;
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
 * Compute pending mirror previews alongside versioned composition snapshots and
 * any baskets invalidated due to material composition changes since follower review.
 */
export async function reviewPendingMirrorsFor(
  subscriber: string,
  perMarketUsdc: Record<string, number> = {},
  dependencies: MirrorQueueDependencies = defaultDependencies,
  options: MirrorQueueOptions = {},
): Promise<MirrorReviewQueueResult> {
  // Strkey check, and the address is then used verbatim throughout. The EVM regex
  // this replaced rejected every Stellar address, so the mirror queue was empty
  // for every real user; the `toLowerCase()` beside it would then have failed to
  // match any stored strkey even if the guard had let one through.
  const wallet = parseAddressParam(subscriber);
  if (!wallet) {
    return { mirrors: [], snapshots: {}, invalidated: [] };
  }

  const subscribed = await dependencies.listSubscriptions(wallet).catch(() => []);
  if (subscribed.length === 0) {
    return { mirrors: [], snapshots: {}, invalidated: [] };
  }

  const [definitions, directory, openClaims, depReviewed] = await Promise.all([
    dependencies.listDefinitions().catch(() => []),
    dependencies.listAgents().catch(() => []),
    dependencies.listOpenClaims().catch(() => []),
    dependencies.listReviewedCompositions
      ? dependencies.listReviewedCompositions(wallet).catch(() => ({}))
      : Promise.resolve({} as Record<string, ReviewedBasketComposition>),
  ]);

  const reviewedCompositions: Record<string, ReviewedBasketComposition> = {
    ...depReviewed,
    ...(options.reviewedCompositions ?? {}),
  };
  const materialDriftBps =
    options.materialDriftBps ??
    dependencies.materialDriftBps ??
    DEFAULT_MATERIAL_COMPOSITION_DRIFT_BPS;

  const agentById = new Map(directory.map((agent) => [agent.id, agent]));
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);

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

    for (const claim of openClaims) {
      // No point offering a mirror that cannot be staked before it settles.
      if (claim.deadline <= nowSeconds + 300) continue;
      if (claim.creator === wallet) continue;
      if (offeredClaims.has(claim.id)) continue;

      const challengers = await dependencies.listChallengers(claim.id).catch(() => []);
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

  return {
    mirrors: pending.sort((a, b) => a.deadline - b.deadline),
    snapshots,
    invalidated,
  };
}

/**
 * Mirrors still open to a subscriber.
 *
 * Weighted, not flat: a member at 10% of a basket should pull 10% of the
 * subscriber's per-market budget, or following a basket would just be following
 * whichever member happened to act first.
 *
 * When the follower has a pinned/reviewed composition snapshot for a basket and
 * the basket's composition has since changed materially, previews for that basket
 * are invalidated and excluded from the returned list.
 */
export async function pendingMirrorsFor(
  subscriber: string,
  perMarketUsdc: Record<string, number> = {},
  dependencies: MirrorQueueDependencies = defaultDependencies,
  options: MirrorQueueOptions = {},
): Promise<PendingMirror[]> {
  const result = await reviewPendingMirrorsFor(
    subscriber,
    perMarketUsdc,
    dependencies,
    options,
  );
  return result.mirrors;
}

/**
 * Validate previously generated pending mirror previews against the latest
 * basket definitions, invalidating any preview whose basket composition has
 * changed materially.
 */
export function validatePendingMirrorPreviews(
  previews: readonly PendingMirror[],
  definitions: readonly MirrorQueueBasketDefinition[],
  options: MirrorQueueOptions = {},
): ValidateMirrorPreviewsResult {
  const defaultDriftBps =
    options.materialDriftBps ?? DEFAULT_MATERIAL_COMPOSITION_DRIFT_BPS;
  const defById = new Map(definitions.map((d) => [d.id, d]));
  const nowMs = Date.now();

  const valid: PendingMirror[] = [];
  const invalidated: InvalidatedMirrorPreview[] = [];

  for (const preview of previews) {
    const definition = defById.get(preview.basketId);
    if (!definition) {
      invalidated.push({
        mirror: preview,
        reason: "basket_not_found",
      });
      continue;
    }

    const liveSnapshot = resolveLiveSnapshot(definition, nowMs);
    if (!liveSnapshot) {
      invalidated.push({
        mirror: preview,
        reason: "invalid_basket_composition",
      });
      continue;
    }

    if (
      !isHash32Hex(preview.compositionDigest) ||
      !Number.isSafeInteger(preview.compositionVersion) ||
      preview.compositionVersion < 1 ||
      !Number.isInteger(preview.weightBps) ||
      preview.weightBps <= 0
    ) {
      invalidated.push({
        mirror: preview,
        reason: "invalid_reviewed_snapshot",
        currentVersion: liveSnapshot.version,
        currentDigest: liveSnapshot.compositionDigest,
      });
      continue;
    }

    const previewDigest = preview.compositionDigest.toLowerCase();

    if (liveSnapshot.version < preview.compositionVersion) {
      invalidated.push({
        mirror: preview,
        reason: "version_regression",
        currentVersion: liveSnapshot.version,
        currentDigest: liveSnapshot.compositionDigest,
      });
      continue;
    }

    const currentMember = liveSnapshot.members.find(
      (member) => member.agentId === preview.agentId,
    );
    if (!currentMember) {
      invalidated.push({
        mirror: preview,
        reason: "member_removed",
        currentVersion: liveSnapshot.version,
        currentDigest: liveSnapshot.compositionDigest,
      });
      continue;
    }

    const reviewed = options.reviewedCompositions?.[preview.basketId];
    const thresholdBps =
      (typeof reviewed === "object" &&
      reviewed !== null &&
      "materialDriftBps" in reviewed &&
      reviewed.materialDriftBps !== undefined
        ? reviewed.materialDriftBps
        : undefined) ?? defaultDriftBps;

    if (
      !Number.isInteger(thresholdBps) ||
      thresholdBps < 1 ||
      thresholdBps > 10_000
    ) {
      invalidated.push({
        mirror: preview,
        reason: "invalid_reviewed_snapshot",
        currentVersion: liveSnapshot.version,
        currentDigest: liveSnapshot.compositionDigest,
      });
      continue;
    }

    if (
      typeof reviewed === "object" &&
      reviewed !== null &&
      reviewed.members !== undefined
    ) {
      let reviewedDigest: string;
      try {
        reviewedDigest = basketCompositionDigest(reviewed.members);
      } catch {
        invalidated.push({
          mirror: preview,
          reason: "invalid_reviewed_snapshot",
          currentVersion: liveSnapshot.version,
          currentDigest: liveSnapshot.compositionDigest,
        });
        continue;
      }

      if (
        reviewedDigest !== previewDigest ||
        (typeof reviewed.compositionDigest === "string" &&
          reviewed.compositionDigest.trim().toLowerCase() !== previewDigest)
      ) {
        invalidated.push({
          mirror: preview,
          reason: "invalid_reviewed_snapshot",
          currentVersion: liveSnapshot.version,
          currentDigest: liveSnapshot.compositionDigest,
        });
        continue;
      }

      const diff = compareBasketCompositions(
        reviewed.members,
        liveSnapshot.members,
        { materialDriftBps: thresholdBps },
      );

      if (diff.materialChange) {
        invalidated.push({
          mirror: preview,
          reason:
            diff.reason === "members_changed"
              ? "members_changed"
              : "weights_changed_materially",
          currentVersion: liveSnapshot.version,
          currentDigest: liveSnapshot.compositionDigest,
          diff,
        });
        continue;
      }

      if (Math.abs(currentMember.weightBps - preview.weightBps) >= thresholdBps) {
        invalidated.push({
          mirror: preview,
          reason: "weights_changed_materially",
          currentVersion: liveSnapshot.version,
          currentDigest: liveSnapshot.compositionDigest,
          diff,
        });
        continue;
      }

      valid.push(preview);
      continue;
    }

    if (Math.abs(currentMember.weightBps - preview.weightBps) >= thresholdBps) {
      invalidated.push({
        mirror: preview,
        reason: "weights_changed_materially",
        currentVersion: liveSnapshot.version,
        currentDigest: liveSnapshot.compositionDigest,
      });
      continue;
    }

    if (previewDigest !== liveSnapshot.compositionDigest) {
      invalidated.push({
        mirror: preview,
        reason: "composition_digest_mismatch",
        currentVersion: liveSnapshot.version,
        currentDigest: liveSnapshot.compositionDigest,
      });
      continue;
    }

    valid.push(preview);
  }

  return { valid, invalidated };
}

/**
 * Filter a list of pending mirror previews down to those still valid under
 * the current basket definitions.
 */
export function invalidateStaleMirrorPreviews(
  previews: readonly PendingMirror[],
  definitions: readonly MirrorQueueBasketDefinition[],
  options: MirrorQueueOptions = {},
): PendingMirror[] {
  return validatePendingMirrorPreviews(previews, definitions, options).valid;
}
