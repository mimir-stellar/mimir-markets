/**
 * Pure policy predicates and durable signal consumption tracking for the demo BYOA traders.
 *
 * Keeps decision criteria, claim filtering, and consumed-signal gating testable in Node
 * without needing live network connections, wallets, or databases.
 */

import fs from "node:fs";
import path from "node:path";

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
 * - Must not be blocked by restart reconciliation (uncertain outcomes)
 */
export function filterJoinableClaims<T extends JoinableClaimCandidate>(
  claims: readonly T[],
  challengersById: Map<number, { address: string }[]>,
  myAddress: string,
  nowSeconds: number,
  blockedClaimIds: ReadonlySet<number> = new Set(),
): T[] {
  const joinable: T[] = [];
  for (const claim of claims) {
    if (claim.deadline <= nowSeconds + 300) continue; // too close to settle into
    if (claim.creator === myAddress) continue; // never challenge yourself
    if (claim.visibility !== "public") continue;
    if (blockedClaimIds.has(claim.id)) continue; // uncertain prior outcome
    const challengers = challengersById.get(claim.id) ?? [];
    if (challengers.some((c) => c.address === myAddress)) continue; // one position each
    joinable.push(claim);
  }
  return joinable;
}

/**
 * Rounding rule applied when converting a fractional stake into atomic USDC
 * units. Recorded in every dry-run report so the result is auditable.
 *
 * - `policyVersion` bumps whenever the rule changes.
 * - `rounding` is always `"floor"`: a stake never exceeds the requested
 *   fraction of the budget, so spending limits are never breached.
 */
export const STAKE_ROUNDING_POLICY = {
  policyVersion: 1,
  rounding: "floor",
  atomicDecimals: 7,
} as const;

export interface StakeSizingResult {
  /** Stake in atomic USDC units (7 decimals). Integer. */
  stakeAtomic: bigint;
  /** Budget remainder left after the stake, in atomic units. Integer. */
  remainderAtomic: bigint;
  policyVersion: number;
  rounding: string;
}

/**
 * Size a stake as `budgetAtomic * fractionBps / 10000`, rounded down to an
 * integer number of atomic units. `fractionBps` is basis points (0..10000).
 * All arithmetic is integer; no floating point is involved.
 */
export function computeStakeSizing(
  budgetAtomic: bigint,
  fractionBps: number,
): StakeSizingResult {
  if (budgetAtomic < 0n) {
    throw new Error("budgetAtomic must be non-negative");
  }
  if (!Number.isInteger(fractionBps) || fractionBps < 0 || fractionBps > 10000) {
    throw new Error("fractionBps must be an integer in [0, 10000]");
  }
  const product = budgetAtomic * BigInt(fractionBps);
  const stakeAtomic = product / 10000n; // BigInt division floors for non-negative values
  const remainderAtomic = budgetAtomic - stakeAtomic;
  return {
    stakeAtomic,
    remainderAtomic,
    policyVersion: STAKE_ROUNDING_POLICY.policyVersion,
    rounding: STAKE_ROUNDING_POLICY.rounding,
  };
}

export interface SecondOpinionClaimFields {
  question?: string | null;
  creator_position?: string | null;
  counter_position?: string | null;
  resolution_url?: string | null;
  settlement_rule?: string | null;
}

export interface SignalConsumptionRecord {
  signalId: string;
  consumedAt: number;
  outcome?: string;
}

export interface SignalConsumptionStore {
  isConsumed(signalId: string): boolean;
  markConsumed(signalId: string, outcome?: string, nowMs?: number): SignalConsumptionRecord;
}

/**
 * Build a deterministic signal identity for a trader's decision on a claim.
 */
export function buildSignalIdentity(agentId: string, claimId: number | string): string {
  const normalizedAgent = agentId.trim();
  if (!normalizedAgent) {
    throw new Error("signal identity requires a non-empty agentId");
  }
  const normalizedClaim =
    typeof claimId === "number"
      ? Number.isFinite(claimId)
        ? String(claimId)
        : ""
      : claimId.trim();
  if (!normalizedClaim) {
    throw new Error("signal identity requires a valid claimId");
  }
  return `${normalizedAgent}:${normalizedClaim}`;
}

/**
 * File-backed durable store of consumed signal identities.
 *
 * Persists a JSON object mapping `signalId -> SignalConsumptionRecord` using
 * atomic temp-file + rename writes so repeat polling or worker restarts never
 * repurchase paid quotes for an already-completed decision.
 */
export class FileSignalConsumptionStore implements SignalConsumptionStore {
  private readonly filePath: string;
  private readonly records = new Map<string, SignalConsumptionRecord>();

  constructor(filePath: string) {
    const resolved = filePath.trim();
    if (!resolved) {
      throw new Error("signal consumption store requires a non-empty file path");
    }
    this.filePath = resolved;
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT") return;
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `corrupt signal consumption store at ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`invalid signal consumption store format at ${this.filePath}`);
    }

    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!key.trim() || !value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as Partial<SignalConsumptionRecord>;
      const consumedAt = typeof entry.consumedAt === "number" && Number.isFinite(entry.consumedAt)
        ? entry.consumedAt
        : 0;
      const record: SignalConsumptionRecord = {
        signalId: typeof entry.signalId === "string" && entry.signalId.trim() ? entry.signalId.trim() : key.trim(),
        consumedAt,
        ...(typeof entry.outcome === "string" && entry.outcome ? { outcome: entry.outcome } : {}),
      };
      this.records.set(record.signalId, record);
    }
  }

  private persist(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload: Record<string, SignalConsumptionRecord> = {};
    for (const [key, record] of this.records.entries()) {
      payload[key] = record;
    }
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, this.filePath);
  }

  isConsumed(signalId: string): boolean {
    const key = signalId.trim();
    if (!key) return false;
    return this.records.has(key);
  }

  markConsumed(signalId: string, outcome?: string, nowMs: number = Date.now()): SignalConsumptionRecord {
    const key = signalId.trim();
    if (!key) {
      throw new Error("cannot consume an empty signal identity");
    }
    const existing = this.records.get(key);
    if (existing) return existing;

    const record: SignalConsumptionRecord = {
      signalId: key,
      consumedAt: nowMs,
      ...(outcome ? { outcome } : {}),
    };
    this.records.set(key, record);
    this.persist();
    return record;
  }

  size(): number {
    return this.records.size;
  }
}

export interface ShouldBuySecondOpinionOptions {
  buySecondOpinion?: boolean;
  mimirUrl?: string | null;
  dryRun?: boolean;
  claim?: SecondOpinionClaimFields | null;
  /** Stable identity for this trader+claim decision signal (e.g. from `buildSignalIdentity`). */
  signalId?: string | null;
  /** Durable store or set of already-consumed signal identities. */
  consumedSignals?: Pick<SignalConsumptionStore, "isConsumed"> | ReadonlySet<string> | null;
}

/**
 * Pure predicate to determine if a trader should purchase an oracle second opinion over x402.
 *
 * Requirements:
 * - DRY_RUN must be false (dry runs must spend nothing, skipping paid x402 reads)
 * - BUY_SECOND_OPINION must be true
 * - MIMIR_URL must be a non-empty string
 * - claim must have a valid question and resolution_url
 * - If `consumedSignals` is provided, `signalId` must be non-empty and not already consumed
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
      firstArg.signalId,
      firstArg.consumedSignals,
    );
  }
  return evaluateShouldBuySecondOpinion(
    Boolean(firstArg),
    mimirUrl,
    Boolean(dryRun),
    claim,
  );
}

function isSignalAlreadyConsumed(
  signalId: string | null | undefined,
  consumedSignals: Pick<SignalConsumptionStore, "isConsumed"> | ReadonlySet<string> | null | undefined,
): boolean {
  if (!consumedSignals) return false;
  const key = typeof signalId === "string" ? signalId.trim() : "";
  if (!key) return true; // Fail closed when a consumption store is supplied without a valid signalId.
  if ("isConsumed" in consumedSignals && typeof consumedSignals.isConsumed === "function") {
    return consumedSignals.isConsumed(key);
  }
  return consumedSignals.has(key);
}

function evaluateShouldBuySecondOpinion(
  buySecondOpinion: boolean,
  mimirUrl: string | null | undefined,
  dryRun: boolean,
  claim: SecondOpinionClaimFields | null | undefined,
  signalId?: string | null,
  consumedSignals?: Pick<SignalConsumptionStore, "isConsumed"> | ReadonlySet<string> | null,
): boolean {
  if (dryRun) return false;
  if (!buySecondOpinion) return false;
  if (!mimirUrl || !mimirUrl.trim()) return false;
  if (!claim) return false;
  if (!claim.question || !claim.question.trim()) return false;
  if (!claim.resolution_url || !claim.resolution_url.trim()) return false;
  if (isSignalAlreadyConsumed(signalId, consumedSignals)) return false;
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
