import {Address} from '@stellar/stellar-sdk';

    /**
 * Error Enum: Error
 */
export const Error = {
  1 : { message: "AlreadyInitialized" },
  2 : { message: "NotInitialized" },
  3 : { message: "ZeroAddress" },
  4 : { message: "EmptyQuestion" },
  5 : { message: "BadDeadline" },
  6 : { message: "FeeCapExceeded" },
  7 : { message: "MarketNotFound" },
  8 : { message: "MarketClosed" },
  9 : { message: "BadSide" },
  10 : { message: "ZeroAmount" },
  11 : { message: "SideFull" },
  12 : { message: "Locked" },
  13 : { message: "BadAmount" },
  14 : { message: "NotOracle" },
  15 : { message: "NotResolvable" },
  16 : { message: "BadResult" },
  17 : { message: "EmptyWinner" },
  18 : { message: "NotClaimable" },
  19 : { message: "NotWinner" },
  20 : { message: "AlreadyClaimed" },
  21 : { message: "NotFeeRecipient" },
  22 : { message: "NoFees" },
  23 : { message: "UnsupportedToken" },
  24 : { message: "Overflow" },
  25 : { message: "UnsupportedDecimals" },
  26 : { message: "ConservationViolation" },
  /**
   * The market question exceeded `MAX_QUESTION_BYTES`. Refused rather than
   * truncated.
   */
  27 : { message: "QuestionTooLong" },
  /**
   * All [`MAX_SQUAD_MEMBERS`] slots across both sides have been filled.
   * Distinct from [`Error::SideFull`], which fires when a single side reaches
   * [`MAX_PARTICIPANTS_PER_SIDE`].  A new depositor is rejected once
   * `participants_a + participants_b == MAX_SQUAD_MEMBERS` even if the target
   * side still has room.
   */
  28 : { message: "SquadFull" },
  /**
   * A payout could not be delivered because the token transfer trapped
   * (frozen or deauthorized trustline). The amount is parked, not lost:
   * `claim` succeeds and holds it, `claim_parked_payout` retries it.
   */
  29 : { message: "PayoutParked" },
  /**
   * `cancel_market` was called on a market that is already resolved or
   * cancelled.
   */
  30 : { message: "AlreadyResolved" },
  /**
   * `cancel_oracle` / `execute_oracle` found no queued oracle rotation.
   */
  31 : { message: "NothingQueued" },
  /**
   * `execute_oracle` was called before the rotation's timelock elapsed.
   */
  32 : { message: "Timelocked" },
  /**
   * `get_markets_batch` was called with more than `MAX_BATCH_SIZE` ids. Refused before reading storage.
   */
  33 : { message: "BatchTooLarge" },
  /**
   * `cancel_fee_recipient` / `execute_fee_recipient` found no queued
   * fee-recipient rotation.
   */
  34 : { message: "NoFeeRecipientQueued" }
}

/**
 * Struct: Market
 */
export interface Market {
  captain: string;
  deadline: bigint;
  fee_bps: number;
  participants_a: number;
  participants_b: number;
  pool_a: bigint;
  pool_b: bigint;
  remaining_escrow: bigint;
  resolved: boolean;
  /**
   * `0` until resolved, then SIDE_A / SIDE_B / RESULT_CANCELLED.
   */
  result: number;
  winner_claims: number;
}

/**
 * Struct: ClaimResult
 */
export interface ClaimResult {
  fee: bigint;
  gross: bigint;
  net: bigint;
}

/**
 * A queued oracle rotation, executable once `executable_at` has passed.
 */
export interface PendingOracle {
  executable_at: bigint;
  next: string;
}

/**
 * A queued fee-recipient rotation, executable once `executable_at` has passed.
 */
export interface PendingFeeRecipient {
  executable_at: bigint;
  next: string;
}

/**
 * Event: Claimed
 */
export interface ClaimedEvent {
  name: "Claimed";
  data: {
    market_id: bigint;
    participant: string;
    gross?: bigint;
    fee?: bigint;
    net?: bigint;
  };
}

/**
 * Event: Resolved
 */
export interface ResolvedEvent {
  name: "Resolved";
  data: {
    market_id: bigint;
    result?: number;
    pool_a?: bigint;
    pool_b?: bigint;
  };
}

/**
 * Event: Deposited
 */
export interface DepositedEvent {
  name: "Deposited";
  data: {
    market_id: bigint;
    side: number;
    participant: string;
    amount?: bigint;
    shares?: bigint;
  };
}

/**
 * Emitted on the deposit that fills the squad to [`crate::types::MAX_SQUAD_MEMBERS`]
 * total participants. Subsequent deposits from new addresses are rejected
 * with [`crate::types::Error::SquadFull`] until existing members withdraw.
 *
 * This event fires on the *last accepted* deposit rather than on the rejected
 * attempt: Soroban discards all events emitted by a failed invocation, so a
 * "cap hit" event can only be reliably indexed from a successful one.
 */
export interface SquadFullEvent {
  name: "SquadFull";
  data: {
    market_id: bigint;
    total_members?: number;
  };
}

/**
 * Event: Withdrawn
 */
export interface WithdrawnEvent {
  name: "Withdrawn";
  data: {
    market_id: bigint;
    side: number;
    participant: string;
    amount?: bigint;
  };
}

/**
 * Event: FeesClaimed
 */
export interface FeesClaimedEvent {
  name: "FeesClaimed";
  data: {
    recipient: string;
    amount?: bigint;
  };
}

/**
 * An oracle rotation was queued by the current oracle.
 * The rotation becomes executable at `executable_at`.
 */
export interface OracleQueuedEvent {
  name: "OracleQueued";
  data: {
    next: string;
    executable_at?: bigint;
  };
}

/**
 * A payout could not be delivered (frozen or deauthorized trustline) and was
 * parked for a later `claim_parked_payout`.
 */
export interface PayoutParkedEvent {
  name: "PayoutParked";
  data: {
    market_id: bigint;
    side: number;
    participant: string;
    amount?: bigint;
  };
}

/**
 * Event: MarketCreated
 */
export interface MarketCreatedEvent {
  name: "MarketCreated";
  data: {
    market_id: bigint;
    captain: string;
    deadline?: bigint;
    fee_bps?: number;
    question?: string;
  };
}

/**
 * A queued oracle rotation was executed after the timelock elapsed.
 */
export interface OracleChangedEvent {
  name: "OracleChanged";
  data: {
    next: string;
    previous?: string;
  };
}

/**
 * Emitted when liquidity is added to a pool market.
 * Tracks pool depth changes for analytics and risk management.
 */
export interface LiquidityAddedEvent {
  name: "LiquidityAdded";
  data: {
    market_id: bigint;
    side: number;
    amount?: bigint;
    new_pool_total?: bigint;
    shares_issued?: bigint;
  };
}

/**
 * A captain cancelled a market before its deadline. Every depositor can pull
 * a full refund through `claim`; the pools are kept as an audit trail.
 */
export interface MarketCancelledEvent {
  name: "MarketCancelled";
  data: {
    market_id: bigint;
    captain: string;
    pool_a?: bigint;
    pool_b?: bigint;
  };
}

/**
 * A queued oracle rotation was cancelled by the current oracle.
 */
export interface OracleCancelledEvent {
  name: "OracleCancelled";
  data: {
    cancelled?: boolean;
  };
}

/**
 * Emitted when liquidity is removed from a pool market before resolution.
 * Distinguishes between pre-deadline withdrawals and post-resolution claims.
 */
export interface LiquidityRemovedEvent {
  name: "LiquidityRemoved";
  data: {
    market_id: bigint;
    side: number;
    amount?: bigint;
    new_pool_total?: bigint;
    shares_burned?: bigint;
  };
}

/**
 * Emitted when the current fee recipient queues a rotation to a new address.
 * The rotation becomes executable only at or after `executable_at`.
 */
export interface FeeRecipientQueuedEvent {
  name: "FeeRecipientQueued";
  data: {
    next: string;
    executable_at?: bigint;
  };
}

/**
 * Emitted when a queued fee recipier rotation is executed after the timelock.
 * Any fees accrued but unclaimed at execution time are payable to ``next``.
 */
export interface FeeRecipientChangedEvent {
  name: "FeeRecipientChanged";
  data: {
    next: string;
    previous?: string;
  };
}

/**
 * Emitted when a queued fee recipient rotation is cancelled by the current recipient.
 */
export interface FeeRecipientCancelledEvent {
  name: "FeeRecipientCancelled";
  data: {
    cancelled?: boolean;
  };
}

/**
 * Emitted when a pool market's deadline passes and it becomes eligible for resolution.
 */
export interface MarketDeadlineReachedEvent {
  name: "MarketDeadlineReached";
  data: {
    market_id: bigint;
    deadline?: bigint;
    pool_a_total?: bigint;
    pool_b_total?: bigint;
  };
}

/**
 * Pool market state transition event for lifecycle auditing.
 * Emitted on every state change with previous and new states.
 */
export interface MarketStateTransitionedEvent {
  name: "MarketStateTransitioned";
  data: {
    market_id: bigint;
    from_state?: number;
    to_state?: number;
    timestamp?: bigint;
  };
}

/**
 * Union: DataKey
 */
 export type DataKey =
  { tag: "Init"; values: void } |
  { tag: "Usdc"; values: void } |
  { tag: "Oracle"; values: void } |
  { tag: "FeeRecipient"; values: void } |
  { tag: "PendingOracle"; values: void } |
  { tag: "PendingFeeRecipient"; values: void } |
  { tag: "MarketCount"; values: void } |
  { tag: "AccruedFees"; values: void } |
  { tag: "Market"; values: readonly [bigint] } |
  /**
   * (market, side, participant) -> deposited units. Shares equal units.
   */
  { tag: "Deposit"; values: readonly [bigint, number, string] } |
  /**
   * (market, side, participant) -> already claimed.
   */
  { tag: "Claimed"; values: readonly [bigint, number, string] } |
  /**
   * (market, side, participant) -> payout settled in the ledger but not
   * delivered, because the token transfer trapped (frozen or deauthorized
   * trustline). Parked until `claim_parked_payout` can move it.
   */
  { tag: "Payout"; values: readonly [bigint, number, string] };
    export type ContractEvent = ClaimedEvent | ResolvedEvent | DepositedEvent | SquadFullEvent | WithdrawnEvent | FeesClaimedEvent | OracleQueuedEvent | PayoutParkedEvent | MarketCreatedEvent | OracleChangedEvent | LiquidityAddedEvent | MarketCancelledEvent | OracleCancelledEvent | LiquidityRemovedEvent | FeeRecipientQueuedEvent | FeeRecipientChangedEvent | FeeRecipientCancelledEvent | MarketDeadlineReachedEvent | MarketStateTransitionedEvent;
    