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
 * Positions already taken are excluded from the pending list. When a suggestion
 * that was previously actionable is no longer eligible, it moves to the ineligible
 * list with an explicit reason so the user can inspect what changed.
 */

import "server-only";

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
}

/**
 * Why a mirror suggestion is no longer actionable.
 *
 * - `closed_market`     — the claim has been resolved, settled, or its deadline
 *                         has already passed; there is nothing left to stake on.
 * - `already_mirrored`  — the subscriber's wallet already appears in the
 *                         challengers list for this claim (direct stake or a
 *                         previously confirmed mirror).
 * - `stale_composition` — the basket member that originally staked on this claim
 *                         is no longer present in the agent directory, so the
 *                         signal cannot be attributed to a live member.
 */
export type MirrorIneligibilityReason =
  | "closed_market"
  | "already_mirrored"
  | "stale_composition";

/**
 * A mirror suggestion that is no longer actionable, preserved so the user can
 * inspect the original position and understand what changed.
 */
export interface IneligibleMirror {
  reason: MirrorIneligibilityReason;
  basketId: string;
  basketName: string;
  claimId: number;
  question: string;
  /** The member whose original position this was. Absent for stale_composition. */
  agentId?: string;
  agentName?: string;
  /** The member's original stake, if it could be retrieved. */
  memberStakeUsdc?: number;
  deadline: number;
}

/**
 * Combined result from {@link pendingMirrorsFor}.
 */
export interface MirrorQueueResult {
  /** Suggestions the subscriber can still act on, sorted by deadline ascending. */
  pending: PendingMirror[];
  /**
   * Suggestions that were candidates but are no longer actionable, with an
   * explicit reason. Preserves the original data so the UI can show "this
   * market closed" rather than silently removing the row.
   */
  ineligible: IneligibleMirror[];
}

/** The data sources the queue is built from, injectable for testing. */
export interface MirrorQueueDependencies {
  listSubscriptions: (wallet: string) => Promise<string[]>;
  listDefinitions: () => Promise<Array<{ id: string; name: string; members: Array<{ agentId: string; weightBps: number }> }>>;
  listAgents: () => Promise<Array<{ id: string; displayName: string; address: string }>>;
  listOpenClaims: () => Promise<Array<{ id: number; question?: string | null; deadline: number; creator?: string | null }>>;
  /**
   * Recently closed/resolved claims. Used to surface `closed_market`
   * ineligibility for claims that an agent staked on but that have since
   * settled. Defaults to the last 50 resolved claims ordered by deadline.
   */
  listClosedClaims: () => Promise<Array<{ id: number; question?: string | null; deadline: number; creator?: string | null }>>;
  listChallengers: (claimId: number) => Promise<Array<{ address: string; stake: number }>>;
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

/**
 * Pending mirrors and ineligible suggestions for a subscriber.
 *
 * Weighted, not flat: a member at 10% of a basket should pull 10% of the
 * subscriber's per-market budget, or following a basket would just be following
 * whichever member happened to act first.
 *
 * Ineligible suggestions preserve the original claim and agent data so the
 * caller can display a reason ("market closed", "already mirrored", or
 * "basket member no longer active") without losing context.
 */
export async function pendingMirrorsFor(
  subscriber: string,
  perMarketUsdc: Record<string, number> = {},
  dependencies: MirrorQueueDependencies = defaultDependencies,
): Promise<MirrorQueueResult> {
  // Strkey check, and the address is then used verbatim throughout. The EVM regex
  // this replaced rejected every Stellar address, so the mirror queue was empty
  // for every real user; the `toLowerCase()` beside it would then have failed to
  // match any stored strkey even if the guard had let one through.
  const wallet = parseAddressParam(subscriber);
  if (!wallet) return { pending: [], ineligible: [] };

  const subscribed = await dependencies.listSubscriptions(wallet).catch(() => []);
  if (subscribed.length === 0) return { pending: [], ineligible: [] };

  const [definitions, directory, openClaims, closedClaims] = await Promise.all([
    dependencies.listDefinitions().catch(() => []),
    dependencies.listAgents().catch(() => []),
    dependencies.listOpenClaims().catch(() => []),
    dependencies.listClosedClaims().catch(() => []),
  ]);
  const agentById = new Map(directory.map((agent) => [agent.id, agent]));
  const nowSeconds = Math.floor(Date.now() / 1000);

  const pending: PendingMirror[] = [];
  const ineligible: IneligibleMirror[] = [];

  // Track (basketId, claimId) pairs we have already classified so a claim that
  // appears in both open and closed lists (edge case during reindexing) is not
  // double-counted, and so the same pair is not added to ineligible more than once.
  const classified = new Set<string>();

  for (const basketId of subscribed) {
    const definition = definitions.find((candidate) => candidate.id === basketId);
    if (!definition) continue;
    const budget = perMarketUsdc[basketId] ?? 2;

    // ── Closed-market ineligibility ──────────────────────────────────────────
    // For each recently-closed claim where an agent in this basket had a
    // position, record an ineligible entry so the subscriber can see why the
    // suggestion disappeared.
    for (const claim of closedClaims) {
      const key = `${basketId}:${claim.id}`;
      if (classified.has(key)) continue;
      if (claim.creator === wallet) continue;

      const challengers = await dependencies.listChallengers(claim.id).catch(() => []);

      for (const member of definition.members) {
        const agent = agentById.get(member.agentId);
        if (!agent) continue;
        const position = challengers.find((c) => c.address === agent.address);
        if (!position) continue;

        classified.add(key);
        ineligible.push({
          reason: "closed_market",
          basketId,
          basketName: definition.name,
          claimId: claim.id,
          question: claim.question ?? `Claim #${claim.id}`,
          agentId: agent.id,
          agentName: agent.displayName,
          memberStakeUsdc: position.stake,
          deadline: claim.deadline,
        });
        break; // one entry per claim per basket
      }
    }

    // ── Open-claim classification ─────────────────────────────────────────────
    for (const claim of openClaims) {
      const key = `${basketId}:${claim.id}`;
      if (classified.has(key)) continue;
      if (claim.creator === wallet) continue;

      // No point offering a mirror that cannot be staked before it settles.
      const tooLate = claim.deadline <= nowSeconds + 300;

      const challengers = await dependencies.listChallengers(claim.id).catch(() => []);
      const taken = new Set(challengers.map((c) => c.address));

      if (taken.has(wallet)) {
        // Subscriber already has a position on this claim.
        // Find the first member that staked so we can preserve context.
        for (const member of definition.members) {
          const agent = agentById.get(member.agentId);
          if (!agent) continue;
          const position = challengers.find((c) => c.address === agent.address);
          if (!position) continue;

          classified.add(key);
          ineligible.push({
            reason: "already_mirrored",
            basketId,
            basketName: definition.name,
            claimId: claim.id,
            question: claim.question ?? `Claim #${claim.id}`,
            agentId: agent.id,
            agentName: agent.displayName,
            memberStakeUsdc: position.stake,
            deadline: claim.deadline,
          });
          break;
        }
        // If no member matched, the subscriber acted independently; still mark
        // classified so the claim is not offered again.
        classified.add(key);
        continue;
      }

      if (tooLate) {
        // Deadline imminent; treat as effectively closed for mirroring purposes.
        for (const member of definition.members) {
          const agent = agentById.get(member.agentId);
          if (!agent) continue;
          const position = challengers.find((c) => c.address === agent.address);
          if (!position) continue;

          classified.add(key);
          ineligible.push({
            reason: "closed_market",
            basketId,
            basketName: definition.name,
            claimId: claim.id,
            question: claim.question ?? `Claim #${claim.id}`,
            agentId: agent.id,
            agentName: agent.displayName,
            memberStakeUsdc: position.stake,
            deadline: claim.deadline,
          });
          break;
        }
        classified.add(key);
        continue;
      }

      for (const member of definition.members) {
        const agent = agentById.get(member.agentId);
        if (!agent) {
          // The agent listed in the basket composition is no longer in the
          // directory; the composition is stale for this claim.
          classified.add(key);
          ineligible.push({
            reason: "stale_composition",
            basketId,
            basketName: definition.name,
            claimId: claim.id,
            question: claim.question ?? `Claim #${claim.id}`,
            deadline: claim.deadline,
          });
          break;
        }

        const position = challengers.find((c) => c.address === agent.address);
        if (!position) continue;

        const mirrorUsdc = Math.round((budget * member.weightBps / 10_000) * 100) / 100;
        // Below a cent there is nothing to stake; the contract's minimum would
        // reject it anyway and the row would only be noise.
        if (mirrorUsdc <= 0) continue;

        classified.add(key);
        pending.push({
          basketId, basketName: definition.name,
          claimId: claim.id, question: claim.question ?? `Claim #${claim.id}`,
          agentId: agent.id, agentName: agent.displayName,
          memberStakeUsdc: position.stake, mirrorUsdc: mirrorUsdc,
          weightBps: member.weightBps, deadline: claim.deadline,
        });
        break; // one mirror per claim: the basket takes a side, not several
      }
    }
  }

  return {
    pending: pending.sort((a, b) => a.deadline - b.deadline),
    ineligible: ineligible.sort((a, b) => a.deadline - b.deadline),
  };
}
