import { isValidBps } from "./money";

/**
 * What the creator signs when composing a basket. Readable, because a hardware
 * wallet shows it verbatim.
 *
 * The address is interpolated verbatim: a Stellar strkey is case-sensitive
 * base32, so any toLowerCase() on it would produce a string no wallet ever signed.
 *
 * The message also carries a nonce and an expiry timestamp, exactly like
 * transferMessage:
 *
 *  - `nonce`    — a client-generated UUID, consumed on the server after
 *                  first use so the same signed message is rejected on replay.
 *  - `expiresAt` — an ISO-8601 timestamp; the server rejects the message
 *                  if the current time is past this value.
 *
 * This means a captured basket-creation signature cannot be replayed to
 * insert duplicate baskets.
 */
export function basketMessage(args: {
  name: string; creator: string; members: Array<{ agentId: string; weightBps: number }>;
  nonce: string; expiresAt: number;
}): string {
  return [
    "Mimir basket",
    `name: ${args.name}`,
    `creator: ${args.creator}`,
    `members: ${args.members.map((m) => `${m.agentId}:${m.weightBps}`).join(",")}`,
    `nonce: ${args.nonce}`,
    `expiresAt: ${new Date(args.expiresAt).toISOString()}`,
  ].join("\n");
}

/**
 * How long a basket-creation authorisation is valid from the moment it is
 * signed. Matches TRANSFER_EXPIRY_MS so the clock-skew budget is the same
 * across all signed mutations.
 */
export const BASKET_CREATION_EXPIRY_MS = 5 * 60_000; // 5 minutes
export const BASKET_EXPIRY_MS = BASKET_CREATION_EXPIRY_MS;

/**
 * How long a transfer authorisation is valid from the moment it is signed.
 *
 * Five minutes matches the agent-request clock-skew window
 * (`AGENT_REQUEST_MAX_SKEW_MS` in lib/agents/api.ts`). A signer generates the
 * message, signs it in their wallet, and submits — that round-trip is well
 * inside five minutes. Any captured signature is useless after the window.
 */
export const TRANSFER_EXPIRY_MS = 5 * 60_000; // 5 minutes

/**
 * What the CURRENT owner signs to authorise a transfer.
 *
 * Both addresses are interpolated verbatim — Stellar strkeys are case-sensitive
 * base32 and must never be lowercased. The message now also includes:
 *
 *  - `nonce`    — a client-generated UUID, stored on the server after first use
 *                  so the same signed message is rejected on any replay attempt.
 *  - `expiresAt` — an ISO-8601 timestamp; the server rejects the message if the
 *                  current time is past this value. Limits the replay window even before
 *                  the nonce has been persisted (e.g. during a DB outage).
 *
 * Together these two fields mean:
 *   - A signature captured in transit cannot be replayed after TRANSFER_EXPIRY_MS.
 *   - Even within the window, submitting the same signed payload twice is rejected
 *     by the UNIQUE(nonce) constraint on basket_ownership_transfers.
 *   - If ownership cycles A–B→…, the old A–B→… signature is still unusable because
 *     its nonce was consumed on first use.
 */
export function transferMessage(args: {
  basketId: string;
  currentOwner: string;
  newOwner: string;
  nonce: string;
  expiresAt: number;
}): string {
  return [
    "Mimir basket transfer",
    `basket: ${args.basketId}`,
    `from: ${args.currentOwner}`,
    `to: ${args.newOwner}`,
    `nonce: ${args.nonce}`,
    `expiresAt: ${new Date(args.expiresAt).toISOString()}`,
  ].join("\n");
}

/**
 * What a subscriber signs to follow or unfollow a basket.
 *
 * The action is part of the signed text, so a subscribe signature can never be
 * presented as an unsubscribe (or the reverse), and the nonce plus a short
 * expiry make each signature single-use. The address is interpolated
 * VERBATIM: a Stellar strkey is case-sensitive base32. Shared by the route and
 * the browser so both build the message byte for byte.
 */
export function subscriptionMessage(args: {
  action: "subscribe" | "unsubscribe";
  basketId: string;
  subscriber: string;
  perMarketUsdc: number;
  nonce: string;
  expiresAt: number;
}): string {
  return [
    "Mimir basket subscription",
    `action: ${args.action}`,
    `basket: ${args.basketId}`,
    `subscriber: ${args.subscriber}`,
    `per market: ${args.perMarketUsdc} USD`,
    `nonce: ${args.nonce}`,
    `expiresAt: ${new Date(args.expiresAt).toISOString()}`,
    "Mimir never holds your funds. Every stake is signed by you.",
  ].join("\n");
}

/** Minimum per-market amount in USDC that a follower can set. */
export const PER_MARKET_MIN_USDC = 1;

/** Maximum per-market amount in USDC that a follower can set. */
export const PER_MARKET_MAX_USDC = 100;

export type PerMarketParseResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

/**
 * Parse the raw string from the per-market input into a valid USDC amount.
 *
 * The input keeps the raw string in state while editing so the field can be
 * cleared and retyped freely; this helper is the single source of truth for
 * whether the current value is acceptable and what error to show if not.
 */
export function parsePerMarketUsdc(raw: string): PerMarketParseResult {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return {
      ok: false,
      error: `Enter an amount between ${PER_MARKET_MIN_USDC} and ${PER_MARKET_MAX_USDC} USDC.`,
    };
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    return { ok: false, error: "Enter a valid number." };
  }
  if (!Number.isInteger(n)) {
    return { ok: false, error: "Use a whole number of USDC." };
  }
  if (n < PER_MARKET_MIN_USDC || n > PER_MARKET_MAX_USDC) {
    return {
      ok: false,
      error: `Enter an amount between ${PER_MARKET_MIN_USDC} and ${PER_MARKET_MAX_USDC} USDC.`,
    };
  }
  return { ok: true, value: n };
}

/**
 * The ids of curated baskets that ship with Mimir.
 *
 * Kept here (the pure computation module, no server-only dependency) so that
 * tests and non-server code can verify the curated-basket guard without pulling
 * in lib/server/basket-directory which carries `import "server-only"".
 *
 * This list must stay in sync with BASKT
 */
export const CURATED_BASKET_IDS: readonly string[] = [
  "council-core",
  "philosopher-spread",
  "byoa-traders",
  "house-and-street",
];

/**
 * A single point on a basket's NAV series.
 */
export interface NavPoint {
  /** ISO-8601 timestamp for the point. */
  t: string;
  /** Net asset value, indexed to 100 at the first point. */
  nav: number;
}

/**
 * A member's contribution to the basket NAV.
 */
export interface NavMember {
  agentId: string;
  weightBps: number;
  /** Per-period returns for this member, as decimals (e.g. 0.01 = +1%). */
  returns: number[];
}

export interface BasketAgentWeight {
  agentId: string;
  weightBps: number;
  category: string;
  mode: string;
  paused?: boolean;
  stale?: boolean;
}

export interface BasketReturnPoint {
  timestamp: number;
  returnsBps: Record<string, number>;
}

export interface BasketPolicy {
  maxSingleAgentBps: number;
  maxCategoryBps: number;
  staleSignalAction: "skip" | "pause";
  failedCopyAction: "keep_idle" | "pause";
}

export interface BasketSnapshot {
  timestamp: number;
  navAtomic: bigint;
  drawdownBps: number;
}

export const VIRTUAL_BASKET_INITIAL_NAV_ATOMIC = 1_000_000_000n;

export const DEFAULT_BASKET_POLICY: BasketPolicy = {
  maxSingleAgentBps: 4_000,
  maxCategoryBps: 6_000,
  staleSignalAction: "skip",
  failedCopyAction: "keep_idle",
};

export type BasketExposurePreviewStatus = "empty" | "incomplete" | "invalid" | "ready";

export interface BasketExposureBar {
  key: string;
  bps: number;
  /** True when this bar alone breaches the matching policy cap. */
  overLimit: boolean;
}

export interface BasketExposurePreview {
  status: BasketExposurePreviewStatus;
  totalBps: number;
  categories: Record<string, number>;
  modes: Record<string, number>;
  categoryBars: BasketExposureBar[];
  modeBars: BasketExposureBar[];
  agentBars: BasketExposureBar[];
  errors: string[];
  policy: BasketPolicy;
}

export function validateBasket(weights: BasketAgentWeight[], policy: BasketPolicy): string[] {
  const errors: string[] = [];
  if (weights.some((item) => !Number.isInteger(item.weightBps))) errors.push("weights_must_be_integers");
  if (weights.reduce((sum, item) => sum + item.weightBps, 0) !== 10_000) errors.push("weights_must_total_10000_bps");
  if (new Set(weights.map((item) => item.agentId)).size !== weights.length) errors.push("duplicate_agent");
  if (weights.some((item) => item.weightBps <= 0 || item.weightBps > policy.maxSingleAgentBps)) errors.push("single_agent_exposure");
  const categories = new Map<string, number>();
  for (const item of weights) categories.set(item.category, (categories.get(item.category) ?? 0) + item.weightBps);
  if ([...categories.values()].some((value) => value > policy.maxCategoryBps)) errors.push("category_exposure");
  return errors;
}

/** Read-only backtest. Missing, paused and stale signals remain idle USDC (0% return). */
export function simulateVirtualBasket(weights: BasketAgentWeight[], points: BasketReturnPoint[], initialNavAtomic = VIRTUAL_BASKET_INITIAL_NAV_ATOMIC): BasketSnapshot[] {
  let nav = initialNavAtomic;
  let high = nav;
  return [...points].sort((a, b) => a.timestamp - b.timestamp).map((point) => {
    let weightedReturn = 0n;
    for (const agent of weights) {
      if (agent.paused || agent.stale) continue;
      weightedReturn += BigInt(point.returnsBps[agent.agentId] ?? 0) * BigInt(agent.weightBps);
    }
    nav = nav + (nav * weightedReturn) / 100_000_000n;
    if (nav > high) high = nav;
    const drawdownBps = high === 0n ? 0 : Number(((high - nav) * 10_000n) / high);
    return { timestamp: point.timestamp, navAtomic: nav, drawdownBps };
  });
}

export function basketExposure(weights: BasketAgentWeight[]) {
  const categories: Record<string, number> = {};
  const modes: Record<string, number> = {};
  for (const item of weights) {
    categories[item.category] = (categories[item.category] ?? 0) + item.weightBps;
    modes[item.mode] = (modes[item.mode] ?? 0) + item.weightBps;
  }
  return { categories, modes };
}

function barsFromRecord(
  record: Record<string, number>,
  limitBps: number | null,
): BasketExposureBar[] {
  return Object.entries(record)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, bps]) => ({
      key,
      bps,
      overLimit: limitBps !== null && bps > limitBps,
    }));
}

/**
 * Preview category / mode / agent concentration before a basket is created.
 *
 * - empty: no positive weights
 * - incomplete: weights present but do not total 10_000 bps (still shows bars)
 * - invalid: totals 10_000 but fails policy (or has duplicates / non-positive)
 * - ready: passes `validateBasket`
 */
export function previewBasketExposureBeforeCreate(
  weights: BasketAgentWeight[],
  policy: BasketPolicy = DEFAULT_BASKET_POLICY,
): BasketExposurePreview {
  const active = weights.filter((item) => item.weightBps > 0);
  const exposure = basketExposure(active);
  const totalBps = active.reduce((sum, item) => sum + item.weightBps, 0);
  const errors = active.length === 0 ? [] : validateBasket(active, policy);

  let status: BasketExposurePreviewStatus;
  if (active.length === 0) status = "empty";
  else if (totalBps !== 10_000) status = "incomplete";
  else if (errors.length > 0) status = "invalid";
  else status = "ready";

  const agentRecord: Record<string, number> = {};
  for (const item of active) {
    agentRecord[item.agentId] = (agentRecord[item.agentId] ?? 0) + item.weightBps;
  }

  return {
    status,
    totalBps,
    categories: exposure.categories,
    modes: exposure.modes,
    categoryBars: barsFromRecord(exposure.categories, policy.maxCategoryBps),
    modeBars: barsFromRecord(exposure.modes, null),
    agentBars: barsFromRecord(agentRecord, policy.maxSingleAgentBps),
    errors,
    policy,
  };
}

/**
 * An existing or prospective position taken by a follower.
 *
 * Values are denominated in integer/display USDC.
 */
export interface FollowerPosition {
  claimId: number;
  agentId: string;
  category: string;
  mode: string;
  amountUsdc: number;
}

/**
 * Portfolio-level exposure breakdown across categories, modes, and agents.
 */
export interface PortfolioExposureBreakdown {
  totalUsdc: number;
  categories: Record<string, number>;
  modes: Record<string, number>;
  agents: Record<string, number>;
  categoryBps: Record<string, number>;
  modeBps: Record<string, number>;
  agentBps: Record<string, number>;
  categoryBars: BasketExposureBar[];
  modeBars: BasketExposureBar[];
  agentBars: BasketExposureBar[];
}

/**
 * Candidate position under evaluation for mirroring.
 */
export interface MirrorCandidatePosition {
  claimId: number;
  agentId: string;
  category?: string;
  mode?: string;
  mirrorUsdc: number;
}

export type FollowerMirrorPreviewStatus =
  | "ready"
  | "policy_breach"
  | "insufficient_budget"
  | "already_mirrored"
  | "invalid";

/**
 * Detailed preview of taking a mirror position, showing remaining configured budget,
 * before-and-after portfolio exposure, and explicit non-custodial assertions.
 */
export interface FollowerMirrorPreview {
  status: FollowerMirrorPreviewStatus;
  newPosition: FollowerPosition;
  configuredBudgetUsdc: number;
  remainingBudgetUsdc: number;
  requiresUserSignature: true;
  delegatedAuthority: false;
  currentExposure: PortfolioExposureBreakdown;
  projectedExposure: PortfolioExposureBreakdown;
  policyViolations: string[];
  policy: BasketPolicy;
}

/**
 * Compute portfolio exposure breakdown across categories, modes, and agents.
 */
export function computePortfolioExposure(
  positions: readonly FollowerPosition[],
  policy: BasketPolicy = DEFAULT_BASKET_POLICY,
): PortfolioExposureBreakdown {
  const categories: Record<string, number> = {};
  const modes: Record<string, number> = {};
  const agents: Record<string, number> = {};
  let totalUsdc = 0;

  for (const pos of positions) {
    if (pos.amountUsdc <= 0) continue;
    totalUsdc += pos.amountUsdc;
    const cat = pos.category || "general";
    const mode = pos.mode || "pool";
    categories[cat] = (categories[cat] ?? 0) + pos.amountUsdc;
    modes[mode] = (modes[mode] ?? 0) + pos.amountUsdc;
    agents[pos.agentId] = (agents[pos.agentId] ?? 0) + pos.amountUsdc;
  }

  const categoryBps: Record<string, number> = {};
  const modeBps: Record<string, number> = {};
  const agentBps: Record<string, number> = {};

  if (totalUsdc > 0) {
    for (const [k, v] of Object.entries(categories)) {
      categoryBps[k] = Math.round((v / totalUsdc) * 10_000);
    }
    for (const [k, v] of Object.entries(modes)) {
      modeBps[k] = Math.round((v / totalUsdc) * 10_000);
    }
    for (const [k, v] of Object.entries(agents)) {
      agentBps[k] = Math.round((v / totalUsdc) * 10_000);
    }
  }

  return {
    totalUsdc: Math.round(totalUsdc * 100) / 100,
    categories,
    modes,
    agents,
    categoryBps,
    modeBps,
    agentBps,
    categoryBars: barsFromRecord(categoryBps, policy.maxCategoryBps),
    modeBars: barsFromRecord(modeBps, null),
    agentBars: barsFromRecord(agentBps, policy.maxSingleAgentBps),
  };
}

/**
 * Preview how taking a mirror candidate affects the follower's overall portfolio exposure,
 * checking remaining budget, category caps, and single-agent concentration limits.
 */
export function previewFollowerMirrorExposure(args: {
  currentPositions: readonly FollowerPosition[];
  pendingMirror: MirrorCandidatePosition;
  configuredBudgetUsdc: number;
  policy?: BasketPolicy;
}): FollowerMirrorPreview {
  const policy = args.policy ?? DEFAULT_BASKET_POLICY;
  const { currentPositions, pendingMirror, configuredBudgetUsdc } = args;

  const violations: string[] = [];
  const mirrorUsdc = pendingMirror.mirrorUsdc;

  if (
    typeof mirrorUsdc !== "number" ||
    !Number.isFinite(mirrorUsdc) ||
    mirrorUsdc <= 0 ||
    typeof configuredBudgetUsdc !== "number" ||
    !Number.isFinite(configuredBudgetUsdc) ||
    configuredBudgetUsdc < 0
  ) {
    violations.push("invalid_input");
  }

  const alreadyMirrored = currentPositions.some(
    (p) => p.claimId === pendingMirror.claimId,
  );
  if (alreadyMirrored) {
    violations.push("already_mirrored");
  }

  const roundedMirrorUsdc = Math.round((mirrorUsdc || 0) * 100) / 100;
  const remainingBudgetUsdc = Math.max(
    0,
    Math.round(((configuredBudgetUsdc || 0) - roundedMirrorUsdc) * 100) / 100,
  );

  if (roundedMirrorUsdc > configuredBudgetUsdc) {
    violations.push("insufficient_budget");
  }

  const newPosition: FollowerPosition = {
    claimId: pendingMirror.claimId,
    agentId: pendingMirror.agentId,
    category: pendingMirror.category || "general",
    mode: pendingMirror.mode || "pool",
    amountUsdc: roundedMirrorUsdc,
  };

  const currentExposure = computePortfolioExposure(currentPositions, policy);
  const projectedPositions = alreadyMirrored
    ? [...currentPositions]
    : [...currentPositions, newPosition];
  const projectedExposure = computePortfolioExposure(projectedPositions, policy);

  for (const bar of projectedExposure.categoryBars) {
    if (bar.overLimit) {
      violations.push(`category_exposure_exceeded:${bar.key}`);
    }
  }

  for (const bar of projectedExposure.agentBars) {
    if (bar.overLimit) {
      violations.push(`single_agent_exposure_exceeded:${bar.key}`);
    }
  }

  let status: FollowerMirrorPreviewStatus;
  if (violations.includes("invalid_input")) {
    status = "invalid";
  } else if (violations.includes("already_mirrored")) {
    status = "already_mirrored";
  } else if (violations.includes("insufficient_budget")) {
    status = "insufficient_budget";
  } else if (violations.length > 0) {
    status = "policy_breach";
  } else {
    status = "ready";
  }

  return {
    status,
    newPosition,
    configuredBudgetUsdc: Math.round(configuredBudgetUsdc * 100) / 100,
    remainingBudgetUsdc,
    requiresUserSignature: true as const,
    delegatedAuthority: false as const,
    currentExposure,
    projectedExposure,
    policyViolations: violations,
    policy,
  };
}

/**
 * Build a NAV series from basket member performance.
 *
 * The series is indexed to 100 at the first point. Each subsequent point is the
 * weighted return of the members for that period. Members whose weights do not
 * sum to 10000 baps are normalised against the total weight, so a partially-
 * composed basket still produces a sensible series. Returns an empty array when
 * there is not enough information to draw a line.
 */
export function buildNavSeries(
  members: readonly NavMember[],
  startsAt: Date = new Date(0),
  periodMs: number = 24 * 60 * 60 * 1000,
): NavPoint[] {
  if (members.length === 0) return [];

  const validMembers = members.filter(
    (m) => isValidBps(m.weightBps) && m.weightBps > 0 && m.returns.length > 0,
  );
  if (validMembers.length === 0) return [];

  const totalWeight = validMembers.reduce((sum, m) => sum + m.weightBps, 0);
  if (totalWeight <= 0) return [];

  const periods = Math.min(...validMembers.map((m) => m.returns.length));
  if (periods < 1 || !completeSeries(validMembers, periods)) return [];

  const points: NavPoint[] = [];
  let nav = 100;
  points.push({ t: new Date(startsAt.getTime()).toISOString(), nav });

  for (let period = 0; period < periods; period++) {
    let weightedReturn = 0;
    for (const member of validMembers) {
      weightedReturn += (member.weightBps / totalWeight) * member.returns[period];
    }
    nav *= 1 + weightedReturn;
    const t = new Date(startsAt.getTime() + (period + 1) * periodMs).toISOString();
    points.push({ t, nav: Number(nav.toFixed(4)) });
  }

  return points;
}

/** Performance fee applies only to realized NAV above the previous high-water mark. */
export function highWaterMarkFee(navAtomic: bigint, highWaterMarkAtomic: bigint, performanceFeeBps: bigint) {
  if (performanceFeeBps < 0n || performanceFeeBps > 1_000n) throw new Error("performance fee cap");
  const gain = navAtomic > highWaterMarkAtomic ? navAtomic - highWaterMarkAtomic : 0n;
  const feeAtomic = (gain * performanceFeeBps) / 10_000n;
  return { feeAtomic, nextHighWaterMarkAtomic: navAtomic > highWaterMarkAtomic ? navAtomic : highWaterMarkAtomic };
}

export function sharesForDeposit(assetsAtomic: bigint, totalAssetsAtomic: bigint, totalSharesAtomic: bigint): bigint {
  if (assetsAtomic <= 0n) throw new Error("zero deposit");
  if (totalSharesAtomic === 0n) return assetsAtomic;
  if (totalAssetsAtomic <= 0n) throw new Error("invalid insolvent vault");
  return (assetsAtomic * totalSharesAtomic) / totalAssetsAtomic;
}

export function assetsForRedemption(sharesAtomic: bigint, totalAssetsAtomic: bigint, totalSharesAtomic: bigint): bigint {
  if (sharesAtomic <= 0n || totalSharesAtomic <= 0n) throw new Error("invalid redemption");
  return (sharesAtomic * totalAssetsAtomic) / totalSharesAtomic;
}

const DAY_MS = 86_400_000;

/** One agent's settled result, as the basket engine needs to see it. */
export interface BasketAgentResult {
  agentId: string;
  /** Milliseconds. */
  settledAt: number;
  pnlAtomic: bigint;
  stakeAtomic: bigint;
}

/**
 * Daily return per agent, in basis points of what that agent staked that day.
 *
 * Weighted by stake rather than counting trades: a 10 USDC decision and a 1 USDC one
 * are not two equal votes, and averaging them as if they were flatters whoever bets
 * small and often.
 *
 * Days with no settlement produce no point at all, so an idle agent contributes a
 * flat line rather than a zero that drags the basket's average down.
 */
export function dailyReturnPoints(results: readonly BasketAgentResult[]): BasketReturnPoint[] {
  const byDay = new Map<number, Map<string, { pnl: bigint; stake: bigint }>>();

  for (const result of results) {
    if (result.stakeAtomic <= 0n) continue;
    const day = Math.floor(result.settledAt / DAY_MS) * DAY_MS;
    const agents = byDay.get(day) ?? new Map();
    const prev = agents.get(result.agentId) ?? { pnl: 0n, stake: 0n };
    agents.set(result.agentId, { pnl: prev.pnl + result.pnlAtomic, stake: prev.stake + result.stakeAtomic });
    byDay.set(day, agents);
  }

  const points: BasketReturnPoint[] = [];
  for (const [day, agents] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    const returnsBps: Record<string, number> = {};
    for (const [agentId, { pnl, stake }] of agents) {
      if (stake <= 0n) continue;
      returnsBps[agentId] = Number((pnl * 10_000n ) / stake);
    }
    points.push({ timestamp: day, returnsBps });
  }
  return points;
}

function completeSeries(members: readonly NavMember[], periods: number): boolean {
  return members.every((m) =>
    m.returns.slice(0, periods).every((r) => Number.isFinite(r)),
  );
}