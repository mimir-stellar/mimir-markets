/**
 * Deterministic trader outage and sequence-race fixtures.
 *
 * Models autonomous trader staking under adverse network and concurrency
 * conditions completely offline:
 * - Simultaneous joinable claim opportunities competing for daily exposure limits
 * - Horizon sequence-read outages and RPC submission failures
 * - Stale cached sequences (`tx_bad_seq`) caused by out-of-band submissions
 * - Late submission results (delayed acks / ambiguous timeouts)
 *
 * All value accounting uses integer USDC; no production credentials, live RPCs,
 * or funded wallets are required.
 */

import {
  filterJoinableClaims,
  TraderExposureGuard,
  type ExposureRejectionReason,
  type JoinableClaimCandidate,
  type TraderExposureLimits,
} from "../../agents/traders/policy";
import {
  SequenceManager,
  type SequenceProvider,
  type SequenceReservation,
} from "../../lib/agents/sequence-manager";

export const FIXTURE_TRADER_WALLET =
  "GDYJ7GZ4WDGYFE6R3HFBUK2GYMFIFP3JHFYSYAME6XISG5BEKZDJVGHN";
export const FIXTURE_CREATOR_WALLET =
  "GB5DLP3MNPUXXJ6P67XGD3OV3ZVIMZN3NZDLVDIYQN6JSC2M7QMMBL4E";

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface TraderOpportunity extends JoinableClaimCandidate {
  /** Integer USDC stake for this opportunity. */
  stakeUsdc: number;
}

export interface LandedStakeRecord {
  claimId: number;
  address: string;
  sequence: bigint;
  stakeUsdc: number;
}

export type SubmitResult =
  | { status: "landed"; sequence: bigint }
  | { status: "tx_bad_seq"; expectedSequence: bigint; receivedSequence: bigint }
  | { status: "outage"; message: string };

export interface PendingSubmissionHandle {
  readonly claimId: number;
  readonly sequence: bigint;
  readonly stakeUsdc: number;
  /** Resolve the late submission as landed on-chain (advancing ledger sequence if matching). */
  resolveLanded(): void;
  /** Resolve the late submission as a stale-sequence rejection. */
  resolveBadSeq(): void;
  /** Resolve the late submission as a transport outage. */
  resolveOutage(message?: string): void;
}

export type ScriptedSubmitBehavior =
  | { kind: "auto" }
  | { kind: "outage"; message?: string }
  | { kind: "deferred" };

/**
 * Deterministic in-memory Stellar ledger + Horizon/RPC transport.
 *
 * Enforces Stellar's exact `ledgerSequence + 1n` rule: any submission whose
 * sequence does not match `ledgerSequence + 1n` is rejected with `tx_bad_seq`.
 */
export class FakeLedgerTransport implements SequenceProvider {
  private ledgerSequence: bigint;
  private remainingReadFailures = 0;
  private readFailureMessage = "horizon unavailable";
  private readCount = 0;
  private readonly submitQueue: ScriptedSubmitBehavior[] = [];
  private readonly landed: LandedStakeRecord[] = [];
  private readonly pendingLate: PendingSubmissionHandle[] = [];
  private readonly pendingWaiters: Array<{ count: number; resolve: () => void }> = [];

  constructor(initialLedgerSequence = 100n) {
    this.ledgerSequence = initialLedgerSequence;
  }

  /** Current authoritative on-ledger sequence. */
  currentSequence(): bigint {
    return this.ledgerSequence;
  }

  /** Number of times `read()` was invoked by `SequenceManager`. */
  reads(): number {
    return this.readCount;
  }

  /** Authoritative on-chain landed stakes. */
  landedStakes(): readonly LandedStakeRecord[] {
    return this.landed;
  }

  /** Total integer USDC landed on-chain across all settled stakes. */
  landedTotalUsdc(): number {
    return this.landed.reduce((sum, item) => sum + item.stakeUsdc, 0);
  }

  /** Handles for currently in-flight deferred/late submissions. */
  pendingSubmissions(): readonly PendingSubmissionHandle[] {
    return this.pendingLate;
  }

  /** Wait deterministically until at least `count` deferred submissions are in-flight. */
  waitForPendingSubmissions(count: number): Promise<void> {
    if (this.pendingLate.length >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.pendingWaiters.push({ count, resolve });
    });
  }

  /** Inject deterministic Horizon read outages for the next `count` calls. */
  failNextReads(count: number, message = "horizon unavailable"): void {
    this.remainingReadFailures = count;
    this.readFailureMessage = message;
  }

  /**
   * Simulate an out-of-band transaction advancing the authoritative ledger
   * sequence without going through `SequenceManager`.
   */
  bumpExternalSequence(delta = 1n): bigint {
    this.ledgerSequence += delta;
    return this.ledgerSequence;
  }

  /** Queue deterministic behavior for the next `submitStake` call(s). */
  enqueueSubmit(...behaviors: ScriptedSubmitBehavior[]): void {
    this.submitQueue.push(...behaviors);
  }

  async read(_address: string): Promise<bigint> {
    this.readCount += 1;
    if (this.remainingReadFailures > 0) {
      this.remainingReadFailures -= 1;
      throw new Error(this.readFailureMessage);
    }
    return this.ledgerSequence;
  }

  private applyLanded(claimId: number, address: string, sequence: bigint, stakeUsdc: number): SubmitResult {
    const expected = this.ledgerSequence + 1n;
    if (sequence !== expected) {
      return {
        status: "tx_bad_seq",
        expectedSequence: expected,
        receivedSequence: sequence,
      };
    }
    this.ledgerSequence = sequence;
    this.landed.push({ claimId, address, sequence, stakeUsdc });
    return { status: "landed", sequence };
  }

  async submitStake(
    claimId: number,
    address: string,
    sequence: bigint,
    stakeUsdc: number,
  ): Promise<SubmitResult> {
    const behavior = this.submitQueue.shift() ?? { kind: "auto" };

    if (behavior.kind === "outage") {
      return { status: "outage", message: behavior.message ?? "soroban rpc timeout" };
    }

    if (behavior.kind === "deferred") {
      const deferred = createDeferred<SubmitResult>();
      const handle: PendingSubmissionHandle = {
        claimId,
        sequence,
        stakeUsdc,
        resolveLanded: () => {
          deferred.resolve(this.applyLanded(claimId, address, sequence, stakeUsdc));
        },
        resolveBadSeq: () => {
          deferred.resolve({
            status: "tx_bad_seq",
            expectedSequence: this.ledgerSequence + 1n,
            receivedSequence: sequence,
          });
        },
        resolveOutage: (message = "late rpc timeout") => {
          deferred.resolve({ status: "outage", message });
        },
      };
      this.pendingLate.push(handle);
      for (let i = this.pendingWaiters.length - 1; i >= 0; i -= 1) {
        const waiter = this.pendingWaiters[i]!;
        if (this.pendingLate.length >= waiter.count) {
          this.pendingWaiters.splice(i, 1);
          waiter.resolve();
        }
      }
      return deferred.promise;
    }

    return this.applyLanded(claimId, address, sequence, stakeUsdc);
  }
}

export type OpportunityOutcome =
  | {
      claimId: number;
      status: "landed";
      sequence: bigint;
      stakeUsdc: number;
      retries: number;
    }
  | {
      claimId: number;
      status: "policy_rejected";
      reason: ExposureRejectionReason | "not_joinable";
    }
  | {
      claimId: number;
      status: "sequence_error";
      message: string;
    }
  | {
      claimId: number;
      status: "submit_failed";
      reason: "tx_bad_seq" | "outage";
      sequence: bigint;
      retries: number;
    };

export interface TraderRaceHarnessOptions {
  walletAddress?: string;
  limits: TraderExposureLimits;
  initialCommittedUsdc?: number;
  initialLedgerSequence?: bigint;
  nowSeconds?: number;
  maxBadSeqRetries?: number;
}

/**
 * Deterministic harness coordinating `filterJoinableClaims`, `TraderExposureGuard`,
 * `SequenceManager`, and `FakeLedgerTransport`.
 */
export class TraderRaceHarness {
  readonly walletAddress: string;
  readonly transport: FakeLedgerTransport;
  readonly sequences: SequenceManager;
  readonly exposure: TraderExposureGuard;
  readonly nowSeconds: number;
  readonly maxBadSeqRetries: number;

  constructor(options: TraderRaceHarnessOptions) {
    this.walletAddress = options.walletAddress ?? FIXTURE_TRADER_WALLET;
    this.transport = new FakeLedgerTransport(options.initialLedgerSequence ?? 100n);
    this.sequences = new SequenceManager(this.transport);
    this.exposure = new TraderExposureGuard(
      options.limits,
      options.initialCommittedUsdc ?? 0,
    );
    this.nowSeconds = options.nowSeconds ?? 1_700_000_000;
    this.maxBadSeqRetries = options.maxBadSeqRetries ?? 1;
  }

  /** Build deterministic joinable opportunities with integer USDC stakes. */
  makeOpportunities(
    stakesUsdc: readonly number[],
    startClaimId = 1,
  ): TraderOpportunity[] {
    return stakesUsdc.map((stakeUsdc, index) => ({
      id: startClaimId + index,
      deadline: this.nowSeconds + 3600,
      creator: FIXTURE_CREATOR_WALLET,
      visibility: "public",
      stakeUsdc,
    }));
  }

  /**
   * Attempt a single staking opportunity:
   * 1. Verify claim eligibility via `filterJoinableClaims`
   * 2. Atomically reserve integer USDC exposure via `TraderExposureGuard`
   * 3. Reserve a serialized account sequence via `SequenceManager`
   * 4. Submit to `FakeLedgerTransport`, resyncing and retrying on `tx_bad_seq`
   * 5. Commit or release exposure and sequence reservations cleanly
   */
  async attemptOpportunity(
    opportunity: TraderOpportunity,
    challengersById = new Map<number, { address: string }[]>(),
  ): Promise<OpportunityOutcome> {
    const eligible = filterJoinableClaims(
      [opportunity],
      challengersById,
      this.walletAddress,
      this.nowSeconds,
    );
    if (eligible.length === 0) {
      return { claimId: opportunity.id, status: "policy_rejected", reason: "not_joinable" };
    }

    const reservationKey = `claim:${opportunity.id}`;
    const auth = this.exposure.tryReserve(reservationKey, opportunity.stakeUsdc);
    if (!auth.allowed) {
      return { claimId: opportunity.id, status: "policy_rejected", reason: auth.reason };
    }

    let retries = 0;
    while (true) {
      let reservation: SequenceReservation;
      try {
        reservation = await this.sequences.reserve(this.walletAddress);
      } catch (error) {
        this.exposure.release(reservationKey);
        return {
          claimId: opportunity.id,
          status: "sequence_error",
          message: error instanceof Error ? error.message : String(error),
        };
      }

      const result = await this.transport.submitStake(
        opportunity.id,
        this.walletAddress,
        reservation.sequence,
        opportunity.stakeUsdc,
      );

      if (result.status === "landed") {
        reservation.submit();
        this.exposure.commit(reservationKey);
        return {
          claimId: opportunity.id,
          status: "landed",
          sequence: reservation.sequence,
          stakeUsdc: opportunity.stakeUsdc,
          retries,
        };
      }

      reservation.release();

      if (result.status === "tx_bad_seq" && retries < this.maxBadSeqRetries) {
        retries += 1;
        await this.sequences.resync(this.walletAddress);
        continue;
      }

      this.exposure.release(reservationKey);
      return {
        claimId: opportunity.id,
        status: "submit_failed",
        reason: result.status,
        sequence: reservation.sequence,
        retries,
      };
    }
  }

  /** Launch multiple opportunities simultaneously via `Promise.all`. */
  async attemptSimultaneous(
    opportunities: readonly TraderOpportunity[],
    challengersById = new Map<number, { address: string }[]>(),
  ): Promise<OpportunityOutcome[]> {
    return Promise.all(
      opportunities.map((opportunity) =>
        this.attemptOpportunity(opportunity, challengersById),
      ),
    );
  }
}
