/*
 * Pure mirror-queue evaluation engine.
 *
 * Computes the set of user-signed mirror suggestions still open to a basket
 * subscriber. Kept free of `server-only` and database imports so both the
 * Next.js server layer (`lib/server/mirror-queue.ts`) and deterministic Node
 * tests can exercise rebalance, repeated-subscription, and late-observation
 * scenarios without live credentials or database access.
 */

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

/** The data sources the queue is built from, injectable for testing. */
export interface MirrorQueueDependencies {
  listSubscriptions: (wallet: string) => Promise<string[]>;
  listDefinitions: () => Promise<Array<{ id: string; name: string; members: Array<{ agentId: string; weightBps: number }> }>>;
  listAgents: () => Promise<Array<{ id: string; displayName: string; address: string }>>;
  listOpenClaims: () => Promise<Array<{ id: number; question?: string | null; deadline: number; creator?: string | null }>>;
  listChallengers: (claimId: number) => Promise<Array<{ address: string; stake: number }>>;
  /** Optional clock override (epoch seconds) for deterministic scenario tests. */
  nowSeconds?: () => number;
  /** Optional address validator override; defaults to Stellar G-strkey shape. */
  parseAddress?: (value: string) => string | null;
}

/** Minimum remaining time (seconds) before a claim deadline to offer a mirror. */
export const MIRROR_DEADLINE_BUFFER_SECONDS = 300;

/** Default per-market USDC budget when a subscriber has not set one for a basket. */
export const DEFAULT_PER_MARKET_USDC = 2;

const STELLAR_G_ADDRESS = /^G[A-Z2-7]{55}$/;

function defaultParseAddress(value: string): string | null {
  const trimmed = value.trim();
  return STELLAR_G_ADDRESS.test(trimmed) ? trimmed : null;
}

/**
 * Compute pending user-signed mirror suggestions for a subscriber.
 *
 * Invariants:
 *  - Repeated subscriptions to the same basket are deduplicated.
 *  - Overlapping subscriptions across multiple baskets never emit more than one
 *    suggestion for the same `claimId`, so no duplicate user-signed suggestion
 *    can be treated as a new stake.
 *  - Any claim where the subscriber is already observed in `listChallengers`
 *    (including late observations after a rebalance or re-subscription) is
 *    excluded.
 */
export async function computePendingMirrors(
  subscriber: string,
  perMarketUsdc: Record<string, number> = {},
  dependencies: MirrorQueueDependencies,
): Promise<PendingMirror[]> {
  const parseAddress = dependencies.parseAddress ?? defaultParseAddress;
  const wallet = parseAddress(subscriber);
  if (!wallet) return [];

  const subscribed = await dependencies.listSubscriptions(wallet).catch(() => []);
  if (subscribed.length === 0) return [];

  const [definitions, directory, openClaims] = await Promise.all([
    dependencies.listDefinitions().catch(() => []),
    dependencies.listAgents().catch(() => []),
    dependencies.listOpenClaims().catch(() => []),
  ]);
  const agentById = new Map(directory.map((agent) => [agent.id, agent]));
  const nowSeconds = dependencies.nowSeconds
    ? dependencies.nowSeconds()
    : Math.floor(Date.now() / 1000);

  const pending: PendingMirror[] = [];
  const seenBaskets = new Set<string>();
  const seenClaims = new Set<number>();

  for (const basketId of subscribed) {
    if (seenBaskets.has(basketId)) continue;
    seenBaskets.add(basketId);

    const definition = definitions.find((candidate) => candidate.id === basketId);
    if (!definition) continue;
    const budget = perMarketUsdc[basketId] ?? DEFAULT_PER_MARKET_USDC;
    if (!Number.isFinite(budget) || budget <= 0) continue;

    for (const claim of openClaims) {
      if (seenClaims.has(claim.id)) continue;
      // No point offering a mirror that cannot be staked before it settles.
      if (claim.deadline <= nowSeconds + MIRROR_DEADLINE_BUFFER_SECONDS) continue;
      if (claim.creator === wallet) continue;

      const challengers = await dependencies.listChallengers(claim.id).catch(() => []);
      const taken = new Set(challengers.map((c) => c.address));
      if (taken.has(wallet)) continue; // already mirrored, or acted independently

      for (const member of definition.members) {
        if (!Number.isFinite(member.weightBps) || member.weightBps <= 0) continue;
        const agent = agentById.get(member.agentId);
        if (!agent) continue;
        const position = challengers.find((c) => c.address === agent.address);
        if (!position) continue;

        const mirrorUsdc = Math.round((budget * member.weightBps / 10_000) * 100) / 100;
        // Below a cent there is nothing to stake; the contract's minimum would
        // reject it anyway and the row would only be noise.
        if (mirrorUsdc <= 0) continue;

        seenClaims.add(claim.id);
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
        });
        break; // one mirror per claim: the basket takes a side, not several
      }
    }
  }

  return pending.sort((a, b) => a.deadline - b.deadline);
}
