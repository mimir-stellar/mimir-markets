/**
 * Pure policy predicates for the demo BYOA traders.
 *
 * Keeps decision criteria and claim filtering testable in Node without
 * needing live network connections, wallets, or databases.
 */

export interface JoinableClaimCandidate {
  id: number;
  deadline: number;
  creator: string;
  visibility: string;
}

/**
 * Filter down to claims a trader is eligible to challenge:
 * - Must not be within 5 minutes (300s) of deadline
 * - Must not be created by the trader
 * - Must have public visibility
 * - Must not already have a position by this trader
 */
export function filterJoinableClaims<T extends JoinableClaimCandidate>(
  claims: readonly T[],
  challengersById: Map<number, { address: string }[]>,
  myAddress: string,
  nowSeconds: number,
): T[] {
  const joinable: T[] = [];
  for (const claim of claims) {
    if (claim.deadline <= nowSeconds + 300) continue; // too close to settle into
    if (claim.creator === myAddress) continue; // never challenge yourself
    if (claim.visibility !== "public") continue;
    const challengers = challengersById.get(claim.id) ?? [];
    if (challengers.some((c) => c.address === myAddress)) continue; // one position each
    joinable.push(claim);
  }
  return joinable;
}

export interface SecondOpinionClaimFields {
  question?: string | null;
  creator_position?: string | null;
  counter_position?: string | null;
  resolution_url?: string | null;
  settlement_rule?: string | null;
}

export interface ShouldBuySecondOpinionOptions {
  buySecondOpinion?: boolean;
  mimirUrl?: string | null;
  dryRun?: boolean;
  claim?: SecondOpinionClaimFields | null;
}

/**
 * Pure predicate to determine if a trader should purchase an oracle second opinion over x402.
 *
 * Requirements:
 * - DRY_RUN must be false (dry runs must spend nothing, skipping paid x402 reads)
 * - BUY_SECOND_OPINION must be true
 * - MIMIR_URL must be a non-empty string
 * - claim must have a valid question and resolution_url
 */
export function shouldBuySecondOpinion(
  options: ShouldBuySecondOpinionOptions,
): boolean;
export function shouldBuySecondOpinion(
  buySecondOpinion: boolean,
  mimirUrl: string | null | undefined,
  dryRun: boolean,
  claim: SecondOpinionClaimFields | null | undefined,
): boolean;
export function shouldBuySecondOpinion(
  firstArg: ShouldBuySecondOpinionOptions | boolean,
  mimirUrl?: string | null,
  dryRun?: boolean,
  claim?: SecondOpinionClaimFields | null,
): boolean {
  if (typeof firstArg === "object" && firstArg !== null) {
    return evaluateShouldBuySecondOpinion(
      Boolean(firstArg.buySecondOpinion),
      firstArg.mimirUrl,
      Boolean(firstArg.dryRun),
      firstArg.claim,
    );
  }
  return evaluateShouldBuySecondOpinion(
    Boolean(firstArg),
    mimirUrl,
    Boolean(dryRun),
    claim,
  );
}

function evaluateShouldBuySecondOpinion(
  buySecondOpinion: boolean,
  mimirUrl: string | null | undefined,
  dryRun: boolean,
  claim: SecondOpinionClaimFields | null | undefined,
): boolean {
  if (dryRun) return false;
  if (!buySecondOpinion) return false;
  if (!mimirUrl || !mimirUrl.trim()) return false;
  if (!claim) return false;
  if (!claim.question || !claim.question.trim()) return false;
  if (!claim.resolution_url || !claim.resolution_url.trim()) return false;
  return true;
}


/**
 * Authorized spending limits for an autonomous trader, denominated in integer USDC.
 *
 * Soroban contract state remains authoritative for settled stakes; these limits
 * gate new autonomous staking attempts before signing or submission.
 */
export interface TraderExposureLimits {
  /** Maximum integer USDC allowed for a single position. */
  maxPositionUsdc: number;
  /** Maximum cumulative integer USDC allowed across committed + in-flight stakes. */
  maxDailyExposureUsdc: number;
}

/** Point-in-time integer USDC exposure snapshot for a trader wallet. */
export interface TraderExposureSnapshot {
  /** Settled/landed integer USDC already committed in the current window. */
  committedUsdc: number;
  /** Unsettled integer USDC currently reserved for in-flight submissions. */
  inFlightUsdc: number;
}

export type ExposureRejectionReason =
  | "invalid_stake"
  | "invalid_limits"
  | "invalid_snapshot"
  | "exceeds_position_limit"
  | "exceeds_daily_limit"
  | "duplicate_reservation";

export type ExposureAuthorizationResult =
  | {
      allowed: true;
      nextInFlightUsdc: number;
      totalExposureUsdc: number;
    }
  | {
      allowed: false;
      reason: ExposureRejectionReason;
      totalExposureUsdc: number;
    };

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Pure predicate verifying whether staking `stakeUsdc` keeps both per-position
 * and cumulative (committed + in-flight) exposure within authorized integer USDC limits.
 */
export function evaluateExposureAuthorization(
  stakeUsdc: number,
  snapshot: TraderExposureSnapshot,
  limits: TraderExposureLimits,
): ExposureAuthorizationResult {
  if (
    !isNonNegativeInteger(snapshot.committedUsdc) ||
    !isNonNegativeInteger(snapshot.inFlightUsdc)
  ) {
    return {
      allowed: false,
      reason: "invalid_snapshot",
      totalExposureUsdc: 0,
    };
  }

  const currentTotal = snapshot.committedUsdc + snapshot.inFlightUsdc;

  if (
    !isNonNegativeInteger(limits.maxPositionUsdc) ||
    !isNonNegativeInteger(limits.maxDailyExposureUsdc)
  ) {
    return {
      allowed: false,
      reason: "invalid_limits",
      totalExposureUsdc: currentTotal,
    };
  }

  if (!Number.isSafeInteger(stakeUsdc) || stakeUsdc <= 0) {
    return {
      allowed: false,
      reason: "invalid_stake",
      totalExposureUsdc: currentTotal,
    };
  }

  if (stakeUsdc > limits.maxPositionUsdc) {
    return {
      allowed: false,
      reason: "exceeds_position_limit",
      totalExposureUsdc: currentTotal,
    };
  }

  const nextTotal = currentTotal + stakeUsdc;
  if (nextTotal > limits.maxDailyExposureUsdc) {
    return {
      allowed: false,
      reason: "exceeds_daily_limit",
      totalExposureUsdc: currentTotal,
    };
  }

  return {
    allowed: true,
    nextInFlightUsdc: snapshot.inFlightUsdc + stakeUsdc,
    totalExposureUsdc: nextTotal,
  };
}

/**
 * Deterministic in-process exposure guard for coordinating simultaneous trader
 * opportunities, sequence retries, and late submission settlements.
 *
 * Counts both committed and in-flight integer USDC against `maxDailyExposureUsdc`
 * so concurrent submissions or delayed network responses can never push exposure
 * past authorized limits.
 */
export class TraderExposureGuard {
  private readonly limits: TraderExposureLimits;
  private committedUsdc: number;
  private readonly inFlight = new Map<string, number>();
  private highWaterUsdc: number;

  constructor(limits: TraderExposureLimits, initialCommittedUsdc = 0) {
    if (
      !isNonNegativeInteger(limits.maxPositionUsdc) ||
      !isNonNegativeInteger(limits.maxDailyExposureUsdc)
    ) {
      throw new Error("TraderExposureGuard requires non-negative integer USDC limits");
    }
    if (!isNonNegativeInteger(initialCommittedUsdc)) {
      throw new Error("TraderExposureGuard requires non-negative integer initialCommittedUsdc");
    }
    this.limits = { ...limits };
    this.committedUsdc = initialCommittedUsdc;
    this.highWaterUsdc = initialCommittedUsdc;
  }

  /** Current integer USDC reserved for unsettled in-flight submissions. */
  inFlightUsdc(): number {
    let sum = 0;
    for (const amount of this.inFlight.values()) sum += amount;
    return sum;
  }

  /** Current point-in-time exposure snapshot. */
  snapshot(): TraderExposureSnapshot {
    return {
      committedUsdc: this.committedUsdc,
      inFlightUsdc: this.inFlightUsdc(),
    };
  }

  /** Total current exposure (`committedUsdc + inFlightUsdc`). */
  totalExposureUsdc(): number {
    return this.committedUsdc + this.inFlightUsdc();
  }

  /** Maximum total exposure ever observed by this guard. */
  highWaterExposureUsdc(): number {
    return this.highWaterUsdc;
  }

  /**
   * Atomically authorize and reserve `stakeUsdc` under a unique `reservationKey`.
   * Rejects duplicate keys and any stake that would breach position or daily limits.
   */
  tryReserve(reservationKey: string, stakeUsdc: number): ExposureAuthorizationResult {
    const key = reservationKey.trim();
    if (!key || this.inFlight.has(key)) {
      return {
        allowed: false,
        reason: "duplicate_reservation",
        totalExposureUsdc: this.totalExposureUsdc(),
      };
    }

    const result = evaluateExposureAuthorization(stakeUsdc, this.snapshot(), this.limits);
    if (!result.allowed) return result;

    this.inFlight.set(key, stakeUsdc);
    if (result.totalExposureUsdc > this.highWaterUsdc) {
      this.highWaterUsdc = result.totalExposureUsdc;
    }
    return result;
  }

  /**
   * Mark a reserved opportunity as landed on-chain. Idempotent: calling commit
   * more than once (or after release) is a no-op.
   */
  commit(reservationKey: string): boolean {
    const key = reservationKey.trim();
    const amount = this.inFlight.get(key);
    if (amount === undefined) return false;
    this.inFlight.delete(key);
    this.committedUsdc += amount;
    const total = this.totalExposureUsdc();
    if (total > this.highWaterUsdc) {
      this.highWaterUsdc = total;
    }
    return true;
  }

  /**
   * Release an unsettled reservation after a confirmed failure or abort.
   * Idempotent: calling release more than once (or after commit) is a no-op.
   */
  release(reservationKey: string): boolean {
    const key = reservationKey.trim();
    return this.inFlight.delete(key);
  }

  /**
   * Reconcile committed exposure against authoritative on-chain Soroban state
   * (e.g. after a late submission landed following an RPC timeout).
   */
  reconcileCommitted(authoritativeCommittedUsdc: number): void {
    if (!isNonNegativeInteger(authoritativeCommittedUsdc)) {
      throw new Error("authoritativeCommittedUsdc must be a non-negative integer");
    }
    this.committedUsdc = Math.max(this.committedUsdc, authoritativeCommittedUsdc);
    const total = this.totalExposureUsdc();
    if (total > this.highWaterUsdc) {
      this.highWaterUsdc = total;
    }
  }
}
