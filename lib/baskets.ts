import { isHash32Hex, sha256Hex } from "./content-hash";
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
 *  - `nonce`     — a client-generated UUID, consumed on the server after
 *                  first use so the same signed message is rejected on replay.
 *  - `expiresAt` — an ISO-8601 timestamp; the server rejects the message
 *                  if the current time is past this value.
 *
 * This means a captured basket-creation signature cannot be replayed to
 * insert duplicate baskets.
 */
export function basketMessage(args: {
  name: string;
  creator: string;
  members: Array<{ agentId: string; weightBps: number }>;
  nonce: string;
  expiresAt: number;
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
export const BASKET_EXPIRY_MS = 5 * 60_000; // 5 minutes
export const BASKET_CREATION_EXPIRY_MS = BASKET_EXPIRY_MS;

/**
 * How long a transfer authorisation is valid from the moment it is signed.
 *
 * Five minutes matches the agent-request clock-skew window
 * (`AGENT_REQUEST_MAX_SKEW_MS` in lib/agents/api.ts). A signer generates the
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
 *  - `nonce`     — a client-generated UUID, stored on the server after first use
 *                  so the same signed message is rejected on any replay attempt.
 *  - `expiresAt` — an ISO-8601 timestamp; the server rejects the message if the
 *                  current time is past this value. Limits the replay window even
 *                  before the nonce has been persisted (e.g. during a DB outage).
 *
 * Together these two fields mean:
 *   - A signature captured in transit cannot be replayed after TRANSFER_EXPIRY_MS.
 *   - Even within the window, submitting the same signed payload twice is rejected
 *     by the UNIQUE(nonce) constraint on basket_ownership_transfers.
 *   - If ownership cycles A→B→A, the old A→B signature is still unusable because
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
  compositionVersion?: number;
  compositionDigest?: string;
}): string {
  const lines = [
    "Mimir basket subscription",
    `action: ${args.action}`,
    `basket: ${args.basketId}`,
    `subscriber: ${args.subscriber}`,
    `per market: ${args.perMarketUsdc} USDC`,
  ];
  if (args.compositionVersion !== undefined) {
    lines.push(`compositionVersion: ${args.compositionVersion}`);
  }
  if (args.compositionDigest !== undefined) {
    lines.push(`compositionDigest: ${args.compositionDigest}`);
  }
  lines.push(
    `nonce: ${args.nonce}`,
    `expiresAt: ${new Date(args.expiresAt).toISOString()}`,
    "Mimir never holds your funds. Every stake is signed by you.",
  );
  return lines.join("\n");
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
 * in lib/server/basket-directory which carries `import "server-only"`.
 *
 * This list must stay in sync with BASKET_DEFINITIONS in
 * lib/server/basket-directory.ts — a schema-backlog-style test in
 * tests/node/basket-ownership.test.ts pins the correspondence.
 */
export const CURATED_BASKET_IDS: readonly string[] = [
  "council-core",
  "philosopher-spread",
  "byoa-traders",
  "house-and-street",
];

// ── Versioned basket composition snapshots for follower review ────────────────

export interface BasketCompositionMember {
  agentId: string;
  weightBps: number;
}

/**
 * An immutable, versioned snapshot of a basket's member identities and weights.
 *
 * Followers mirror positions from their own wallet rather than depositing into
 * a custodial pool. Binding the exact (agentId, weightBps) set to a canonical
 * SHA-256 digest and a monotonic version lets the mirror queue detect when a
 * basket's composition has changed materially since the follower reviewed it,
 * invalidating stale pending mirror previews before they can be signed.
 */
export interface BasketCompositionSnapshot {
  basketId: string;
  /** Monotonically increasing 1-indexed composition version. */
  version: number;
  /** Canonical 64-character lowercase SHA-256 hex digest over sorted members and weights. */
  compositionDigest: string;
  /** Canonical member allocations sorted deterministically by agentId. */
  members: BasketCompositionMember[];
  /** Sum of member weights in basis points (10,000 for a complete basket). */
  totalWeightBps: number;
  /** Epoch milliseconds when this snapshot was captured. */
  capturedAt: number;
  /** Digest of the preceding composition version when evolved from a prior snapshot. */
  previousDigest: string | null;
}

export interface CreateBasketCompositionSnapshotInput {
  basketId: string;
  members: readonly BasketCompositionMember[];
  version?: number;
  capturedAt?: number;
  previousDigest?: string | null;
  /** When true (default), requires member weights to total exactly 10,000 bps. */
  requireFullAllocation?: boolean;
}

export interface BasketMemberWeightDelta {
  agentId: string;
  previousWeightBps: number;
  currentWeightBps: number;
  deltaBps: number;
}

export type BasketCompositionChangeReason =
  | "unchanged"
  | "within_tolerance"
  | "members_changed"
  | "weights_changed";

export interface BasketCompositionDiff {
  previousDigest: string;
  currentDigest: string;
  digestChanged: boolean;
  addedMembers: BasketCompositionMember[];
  removedMembers: BasketCompositionMember[];
  weightChanges: BasketMemberWeightDelta[];
  maxWeightDeltaBps: number;
  /** One-way turnover in basis points across the member set. */
  turnoverBps: number;
  materialDriftBps: number;
  materialChange: boolean;
  reason: BasketCompositionChangeReason;
}

/**
 * Default weight-drift threshold (in basis points) considered material when
 * member identities are unchanged. At 1 bps, any integer basis-point shift or
 * member addition/removal invalidates pending mirror previews by default, while
 * callers may pass a higher tolerance to permit minor rebalancing drift.
 */
export const DEFAULT_MATERIAL_COMPOSITION_DRIFT_BPS = 1;

const COMPOSITION_DIGEST_DOMAIN = "mimir:basket-composition:v1";
const COMPOSITION_FIELD_SEPARATOR = "\u001f";
const COMPOSITION_RECORD_SEPARATOR = "\u001e";
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

/**
 * Validate and sort basket composition members into canonical order by agentId.
 *
 * Member identities are trimmed but never case-folded (Stellar strkeys and
 * directory IDs are case-sensitive). Control characters are rejected so no
 * agentId can forge a field or record delimiter in the canonical digest preimage.
 */
export function canonicalizeBasketMembers(
  members: readonly BasketCompositionMember[],
): BasketCompositionMember[] {
  if (!Array.isArray(members) || members.length === 0) {
    throw new Error("basket_composition_empty");
  }

  const seen = new Set<string>();
  const normalized: BasketCompositionMember[] = [];

  for (const item of members) {
    if (!item || typeof item.agentId !== "string") {
      throw new Error("invalid_member_agent_id");
    }
    const agentId = item.agentId.trim();
    if (!agentId || CONTROL_CHAR_PATTERN.test(agentId)) {
      throw new Error("invalid_member_agent_id");
    }
    if (!isValidBps(item.weightBps)) {
      throw new Error("weights_must_be_integers");
    }
    if (item.weightBps <= 0) {
      throw new Error("single_agent_exposure");
    }
    if (seen.has(agentId)) {
      throw new Error("duplicate_agent");
    }
    seen.add(agentId);
    normalized.push({ agentId, weightBps: item.weightBps });
  }

  return normalized.sort((a, b) =>
    a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0,
  );
}

/**
 * Bind member identities and basis-point weights to a deterministic SHA-256 hex digest.
 *
 * Members are canonicalized and sorted by `agentId` before hashing, so reordering
 * the same `(agentId, weightBps)` pairs produces the exact same digest while any
 * change to a member identity or weight produces a distinct digest.
 */
export function basketCompositionDigest(
  input: readonly BasketCompositionMember[] | { members: readonly BasketCompositionMember[] },
): string {
  const rawMembers = Array.isArray(input)
    ? input
    : (input as { members: readonly BasketCompositionMember[] })?.members;
  const canonical = canonicalizeBasketMembers(rawMembers);
  const preimage = [
    COMPOSITION_DIGEST_DOMAIN,
    ...canonical.map(
      (member) => `${member.agentId}${COMPOSITION_FIELD_SEPARATOR}${member.weightBps}`,
    ),
  ].join(COMPOSITION_RECORD_SEPARATOR);
  return sha256Hex(preimage);
}

/**
 * Create a versioned basket composition snapshot for follower review.
 */
export function createBasketCompositionSnapshot(
  input: CreateBasketCompositionSnapshotInput,
): BasketCompositionSnapshot {
  const basketId = typeof input?.basketId === "string" ? input.basketId.trim() : "";
  if (!basketId || CONTROL_CHAR_PATTERN.test(basketId)) {
    throw new Error("invalid_basket_id");
  }

  const version = input.version ?? 1;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("invalid_composition_version");
  }

  const capturedAt = input.capturedAt ?? Date.now();
  if (!Number.isSafeInteger(capturedAt) || capturedAt < 0) {
    throw new Error("invalid_captured_at");
  }

  const previousDigest = input.previousDigest ?? null;
  if (previousDigest !== null && !isHash32Hex(previousDigest)) {
    throw new Error("invalid_previous_digest");
  }

  const members = canonicalizeBasketMembers(input.members);
  const totalWeightBps = members.reduce((sum, member) => sum + member.weightBps, 0);
  const requireFull = input.requireFullAllocation ?? true;
  if (requireFull && totalWeightBps !== 10_000) {
    throw new Error("weights_must_total_10000_bps");
  }

  const compositionDigest = basketCompositionDigest(members);
  if (previousDigest !== null && previousDigest.toLowerCase() === compositionDigest) {
    throw new Error("self_referential_previous_digest");
  }

  return {
    basketId,
    version,
    compositionDigest,
    members,
    totalWeightBps,
    capturedAt,
    previousDigest: previousDigest ? previousDigest.toLowerCase() : null,
  };
}

export const snapshotBasketComposition = createBasketCompositionSnapshot;

/**
 * Verify the structural and cryptographic integrity of a composition snapshot.
 */
export function verifyBasketCompositionSnapshot(
  snapshot: BasketCompositionSnapshot | null | undefined,
  options: { requireFullAllocation?: boolean } = {},
): { ok: true } | { ok: false; error: string } {
  if (!snapshot || typeof snapshot !== "object") {
    return { ok: false, error: "invalid_snapshot" };
  }
  const basketId = typeof snapshot.basketId === "string" ? snapshot.basketId.trim() : "";
  if (!basketId || CONTROL_CHAR_PATTERN.test(basketId)) {
    return { ok: false, error: "invalid_basket_id" };
  }
  if (!Number.isSafeInteger(snapshot.version) || snapshot.version < 1) {
    return { ok: false, error: "invalid_composition_version" };
  }
  if (!Number.isSafeInteger(snapshot.capturedAt) || snapshot.capturedAt < 0) {
    return { ok: false, error: "invalid_captured_at" };
  }
  if (!isHash32Hex(snapshot.compositionDigest)) {
    return { ok: false, error: "invalid_composition_digest" };
  }
  if (snapshot.previousDigest !== null && snapshot.previousDigest !== undefined) {
    if (!isHash32Hex(snapshot.previousDigest)) {
      return { ok: false, error: "invalid_previous_digest" };
    }
  }

  let canonical: BasketCompositionMember[];
  try {
    canonical = canonicalizeBasketMembers(snapshot.members);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "invalid_members" };
  }

  const totalWeightBps = canonical.reduce((sum, member) => sum + member.weightBps, 0);
  if (snapshot.totalWeightBps !== undefined && snapshot.totalWeightBps !== totalWeightBps) {
    return { ok: false, error: "total_weight_mismatch" };
  }
  const requireFull = options.requireFullAllocation ?? true;
  if (requireFull && totalWeightBps !== 10_000) {
    return { ok: false, error: "weights_must_total_10000_bps" };
  }

  const expectedDigest = basketCompositionDigest(canonical);
  if (snapshot.compositionDigest !== expectedDigest) {
    return { ok: false, error: "composition_digest_mismatch" };
  }
  if (snapshot.previousDigest && snapshot.previousDigest.toLowerCase() === expectedDigest) {
    return { ok: false, error: "self_referential_previous_digest" };
  }

  return { ok: true };
}

/**
 * Advance a basket composition snapshot when its canonical composition changes.
 *
 * If the new member list produces the exact same canonical digest (for example,
 * when the array order was permuted without altering any member identity or
 * weight), the existing version and digest are preserved unchanged.
 */
export function evolveBasketCompositionSnapshot(
  previous: BasketCompositionSnapshot,
  nextMembers: readonly BasketCompositionMember[],
  options: { capturedAt?: number; requireFullAllocation?: boolean } = {},
): BasketCompositionSnapshot {
  const verdict = verifyBasketCompositionSnapshot(previous, {
    requireFullAllocation: options.requireFullAllocation,
  });
  if (!verdict.ok) {
    throw new Error(verdict.error);
  }

  const canonicalNext = canonicalizeBasketMembers(nextMembers);
  const totalWeightBps = canonicalNext.reduce((sum, member) => sum + member.weightBps, 0);
  const requireFull = options.requireFullAllocation ?? true;
  if (requireFull && totalWeightBps !== 10_000) {
    throw new Error("weights_must_total_10000_bps");
  }

  const nextDigest = basketCompositionDigest(canonicalNext);
  if (nextDigest === previous.compositionDigest) {
    return {
      ...previous,
      members: canonicalNext,
    };
  }

  return createBasketCompositionSnapshot({
    basketId: previous.basketId,
    version: previous.version + 1,
    members: canonicalNext,
    capturedAt: options.capturedAt ?? Date.now(),
    previousDigest: previous.compositionDigest,
    requireFullAllocation: requireFull,
  });
}

function extractVerifiedMembers(
  input:
    | readonly BasketCompositionMember[]
    | { members: readonly BasketCompositionMember[]; compositionDigest?: string },
): { members: BasketCompositionMember[]; digest: string } {
  if (Array.isArray(input)) {
    const members = canonicalizeBasketMembers(input);
    return { members, digest: basketCompositionDigest(members) };
  }
  const container = input as {
    members: readonly BasketCompositionMember[];
    compositionDigest?: string;
  };
  const members = canonicalizeBasketMembers(container?.members);
  const digest = basketCompositionDigest(members);
  if (
    container.compositionDigest !== undefined &&
    container.compositionDigest !== digest
  ) {
    throw new Error("composition_digest_mismatch");
  }
  return { members, digest };
}

/**
 * Compare two basket compositions and determine whether the composition changed
 * materially for follower mirror review.
 *
 * A composition change is material when:
 *  - any member agent is added, removed, or replaced (`reason: "members_changed"`), or
 *  - any member's weight shifts by at least `materialDriftBps` (defaults to 1 bps,
 *    `reason: "weights_changed"`).
 *
 * Reordering the member list without changing identities or weights produces
 * identical digests (`digestChanged: false`, `materialChange: false`,
 * `reason: "unchanged"`). When a caller configures `materialDriftBps > 1`,
 * weight adjustments strictly below the threshold with the same member set
 * report `materialChange: false` and `reason: "within_tolerance"`.
 */
export function compareBasketCompositions(
  previous:
    | readonly BasketCompositionMember[]
    | { members: readonly BasketCompositionMember[]; compositionDigest?: string },
  current:
    | readonly BasketCompositionMember[]
    | { members: readonly BasketCompositionMember[]; compositionDigest?: string },
  options: { materialDriftBps?: number } = {},
): BasketCompositionDiff {
  const materialDriftBps =
    options.materialDriftBps ?? DEFAULT_MATERIAL_COMPOSITION_DRIFT_BPS;
  if (
    !Number.isInteger(materialDriftBps) ||
    materialDriftBps < 1 ||
    materialDriftBps > 10_000
  ) {
    throw new Error("invalid_material_drift_bps");
  }

  const prev = extractVerifiedMembers(previous);
  const curr = extractVerifiedMembers(current);
  const digestChanged = prev.digest !== curr.digest;

  const prevByAgent = new Map(prev.members.map((m) => [m.agentId, m.weightBps]));
  const currByAgent = new Map(curr.members.map((m) => [m.agentId, m.weightBps]));

  const addedMembers: BasketCompositionMember[] = [];
  const removedMembers: BasketCompositionMember[] = [];
  const weightChanges: BasketMemberWeightDelta[] = [];

  for (const member of curr.members) {
    if (!prevByAgent.has(member.agentId)) {
      addedMembers.push(member);
    }
  }
  for (const member of prev.members) {
    if (!currByAgent.has(member.agentId)) {
      removedMembers.push(member);
    }
  }

  const allAgentIds = [...new Set([...prevByAgent.keys(), ...currByAgent.keys()])].sort(
    (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  );

  let maxWeightDeltaBps = 0;
  let totalAbsDeltaBps = 0;

  for (const agentId of allAgentIds) {
    const previousWeightBps = prevByAgent.get(agentId) ?? 0;
    const currentWeightBps = currByAgent.get(agentId) ?? 0;
    const deltaBps = currentWeightBps - previousWeightBps;
    if (deltaBps !== 0) {
      const absDelta = Math.abs(deltaBps);
      if (absDelta > maxWeightDeltaBps) {
        maxWeightDeltaBps = absDelta;
      }
      totalAbsDeltaBps += absDelta;
      weightChanges.push({
        agentId,
        previousWeightBps,
        currentWeightBps,
        deltaBps,
      });
    }
  }

  const turnoverBps = Math.ceil(totalAbsDeltaBps / 2);

  let materialChange = false;
  let reason: BasketCompositionChangeReason = "unchanged";

  if (!digestChanged) {
    materialChange = false;
    reason = "unchanged";
  } else if (addedMembers.length > 0 || removedMembers.length > 0) {
    materialChange = true;
    reason = "members_changed";
  } else if (maxWeightDeltaBps >= materialDriftBps) {
    materialChange = true;
    reason = "weights_changed";
  } else {
    materialChange = false;
    reason = "within_tolerance";
  }

  return {
    previousDigest: prev.digest,
    currentDigest: curr.digest,
    digestChanged,
    addedMembers,
    removedMembers,
    weightChanges,
    maxWeightDeltaBps,
    turnoverBps,
    materialDriftBps,
    materialChange,
    reason,
  };
}

export const diffBasketComposition = compareBasketCompositions;

export function isMaterialCompositionChange(
  previous:
    | readonly BasketCompositionMember[]
    | { members: readonly BasketCompositionMember[]; compositionDigest?: string },
  current:
    | readonly BasketCompositionMember[]
    | { members: readonly BasketCompositionMember[]; compositionDigest?: string },
  options: { materialDriftBps?: number } = {},
): boolean {
  return compareBasketCompositions(previous, current, options).materialChange;
}

// ── Virtual basket policy, NAV simulation and exposure preview ────────────────

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

/**
 * Default create/follow policy: no agent over 40%, no category (track) over 60%.
 * Kept in the shared lib so the create UI preview matches the API gate exactly.
 */
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

/**
 * Live exposure snapshot for the basket create form — same math as `basketExposure`
 * + `validateBasket`, with UI-ready bars and a discrete status.
 *
 * Does not touch wallets, deposits, or analytics; pure allocation arithmetic.
 */
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
  if (weights.some((item) => !isValidBps(item.weightBps))) errors.push("weights_must_be_integers");
  if (weights.reduce((sum, item) => sum + item.weightBps, 0) !== 10_000) errors.push("weights_must_total_10000_bps");
  if (new Set(weights.map((item) => item.agentId)).size !== weights.length) errors.push("duplicate_agent");
  if (weights.some((item) => item.weightBps <= 0 || item.weightBps > policy.maxSingleAgentBps)) errors.push("single_agent_exposure");
  const categories = new Map<string, number>();
  for (const item of weights) categories.set(item.category, (categories.get(item.category) ?? 0) + item.weightBps);
  if ([...categories.values()].some((value) => value > policy.maxCategoryBps)) errors.push("category_exposure");
  return errors;
}

/** Read-only backtest. Missing, paused and stale signals remain idle USDC (0% return). */
export function simulateVirtualBasket(
  weights: BasketAgentWeight[],
  points: BasketReturnPoint[],
  initialNavAtomic = VIRTUAL_BASKET_INITIAL_NAV_ATOMIC,
): BasketSnapshot[] {
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
    const agents = byDay.get(day) ?? new Map<string, { pnl: bigint; stake: bigint }>();
    const running = agents.get(result.agentId) ?? { pnl: 0n, stake: 0n };
    agents.set(result.agentId, {
      pnl: running.pnl + result.pnlAtomic,
      stake: running.stake + result.stakeAtomic,
    });
    byDay.set(day, agents);
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([timestamp, agents]) => {
      const returnsBps: Record<string, number> = {};
      for (const [agentId, { pnl, stake }] of agents) {
        returnsBps[agentId] = stake === 0n ? 0 : Number((pnl * 10_000n) / stake);
      }
      return { timestamp, returnsBps };
    });
}

/**
 * A single point on a basket's chart-ready NAV series.
 */
export interface NavPoint {
  timestamp: number;
  navAtomic: number;
  /** Net asset value indexed to 100 at the initial point. */
  index: number;
  drawdownBps: number;
}

/**
 * Build a chart-ready NAV series from simulated virtual basket snapshots.
 *
 * Prepends an initial baseline point (index 100) one day before the first settled
 * point so a single day of settlement still draws a two-point segment.
 */
export function navSeries(
  snapshots: readonly BasketSnapshot[],
  initialNavAtomic: bigint = VIRTUAL_BASKET_INITIAL_NAV_ATOMIC,
): NavPoint[] {
  if (snapshots.length === 0) return [];
  const sorted = [...snapshots].sort((a, b) => a.timestamp - b.timestamp);
  const base = Number(initialNavAtomic);
  const startTimestamp = sorted[0]!.timestamp - DAY_MS;

  return [
    {
      timestamp: startTimestamp,
      navAtomic: base,
      index: 100,
      drawdownBps: 0,
    },
    ...sorted.map((snapshot) => ({
      timestamp: snapshot.timestamp,
      navAtomic: Number(snapshot.navAtomic),
      index:
        initialNavAtomic > 0n
          ? Number((snapshot.navAtomic * 10_000n) / initialNavAtomic) / 100
          : 100,
      drawdownBps: snapshot.drawdownBps,
    })),
  ];
}

export const buildNavSeries = navSeries;
