/*
 * What a basket subscriber has not mirrored yet.
 *
 * Following a basket records an intent; it cannot move money on its own. Soroban
 * has no `msg.sender` for a top-level call, so the staking account is an explicit
 * argument that must itself authorise -- `challenge_claim(challenger, …#` cannot
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
  listDefinitions: () => Promise<Array<{ id: string; name: string; members: Array<{ agentId: string; weightBps: number }> }>>;
  listAgents: () => Promise<Array<{ id: string; displayName: string; address: string }>>;
  listOpenClaims: () => Promise<Array<{ id: number; question?: string | null; deadline: number; creator?: string | null }>>;
  listChallengers: (claimId: number) => Promise<Array<{ address: string; stake: number }>>;
}

const defaultDependencies: MirrorQueueDependencies = {
  listSubscriptions: (wallet) => listBasketSubscriptions(wallet),
  listDefinitions: () => allBasketDefinitions(),
  listAgents: () => listDirectoryAgents(),
  listOpenClaims: () =>
    getClaimsByFilter({ states: ["open", "active"], orderBy: "deadline_asc", limit: 50 }),
  listChallengers: (claimId) => getChallengersByClaimId(claimId),
};

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
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Cache challenger lookups per claim so shared claims across multiple baskets
  // are queried once and failures are not double-counted.
  const challengersByClaim = new Map<
    number,
    { ok: true; challengers: Array<{ address: string; stake: number }> } | { ok: false }
  >();

  const pending: PendingMirror[] = [];

  for (const basketId of subscribed) {
    const definition = definitions.find((candidate) => candidate.id === basketId);
    if (!definition) continue;
    const budget = perMarketUsdc[basketId] ?? 2;

    for (const claim of openClaims) {
      // No point offering a mirror that cannot be staked before it settles.
      if (claim.deadline <= nowSeconds + 300) continue;
      if (claim.creator === wallet) continue;

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

        const mirrorUsdc = Math.round((budget * member.weightBps / 10_000) * 100) / 100;
        // Below a cent there is nothing to stake; the contract's minimum would
        // reject it anyway and the row would only be noise.
        if (mirrorUsdc <= 0) continue;

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
