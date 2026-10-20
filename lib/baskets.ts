import { isValidBps } from "./money";

/**
 * What the creator signs when composing a basket. Readable, because a hardware
 * wallet shows it verbatim.
 *
 * The address is interpolated verbatim: a Stellar strkey is case-sensitive
 * base32, so any toLowerCase() on it would produce a string no wallet ever signed.
 */
export function basketMessage(args: {
  name: string; creator: string; members: Array<{ agentId: string; weightBps: number }>;
}): string {
  return [
    "Mimir basket",
    `name: ${args.name}`,
    `creator: ${args.creator}`,
    `members: ${args.members.map((m) => `${m.agentId}:${m.weightBps}`).join(",")}`,
  ].join("\n");
}

/**
 * How long a transfer authorisation is valid from the moment it is signed.
 *
 * Five minutes matches the agent-request clock-skew window
 * (`AGENT_REQUEST_MAX_SKEW_NS` in lib/agents/api.ts). A signer generates the
 * message, signs it in their wallet, and submits it — that round-trip is well
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
 *                  current time is past this value. Limits the replay window even before
 *                  the nonce has been persisted (e.g. during a DB outage).
 *
 * Together these two fields mean:
 *   - A signature captured in transit cannot be replayed after TRANSFER_EXPIRY_MS.
 *   - Even within the window, submitting the same signed payload twice is rejected
 *     by the UNIQUE(nonce) constraint on basket_ownership_transfers.
 *   - If ownership cycles ABVB→A, the old ABVB signature is still unusable because
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

/**
 * The ids of curated baskets that ship with Mimir.
 *
 * Kept here (the pure computation module, no server-only dependency) so that
 * tests and non-server code can verify the curated-basket guard without pulling
 * in lib/server/basket-directory which carries `import "server-only"".
 *
 * This list must stay in sync with BASKT
 */
export const CURATED_BASKET_IDS: readonly string[] = [];

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

function completeSeries(members: readonly NavMember[], periods: number): boolean {
  return members.every((m) =>
    m.returns.slice(0, periods).every((r) => Number.isFinite(r)),
  );
}
