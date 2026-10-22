import {Address} from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

    /**
 * Struct: Claim
 */
export interface Claim {
  category: string;
  /**
   * How many challengers have pulled their settlement. The last one absorbs
   * whatever `remaining_escrow` is left, so truncation dust is never stranded.
   */
  challenger_claims: number;
  challenger_count: number;
  confidence: number;
  context_hash: Buffer;
  counter_position: string;
  created_at: bigint;
  creator: string;
  creator_position: string;
  creator_stake: bigint;
  deadline: bigint;
  evidence_hash: Buffer | null;
  fees: FeeSnapshot;
  market: MarketConfig;
  parent_id: bigint;
  question: string;
  /**
   * Escrow still owed to challengers after resolution. Seeded by
   * `resolve_claim` and drawn down by each `claim_challenger_payout`, so the
   * contract can never pay out more than it took in.
   */
  remaining_escrow: bigint;
  reserved_creator_liability: bigint;
  resolution_summary: string;
  resolution_url: string;
  state: ClaimState;
  total_challenger_stake: bigint;
  winner_side: WinnerSide;
}

/**
 * Error Enum: Error
 */
export const Error = {
  1 : { message: "AlreadyInitialized" },
  2 : { message: "NotInitialized" },
  3 : { message: "NotOwner" },
  4 : { message: "NotOracle" },
  5 : { message: "FeeCapExceeded" },
  6 : { message: "FeeNeedsRecipient" },
  7 : { message: "NothingQueued" },
  8 : { message: "Timelocked" },
  9 : { message: "StakeTooSmall" },
  10 : { message: "DeadlineInPast" },
  11 : { message: "EmptyQuestion" },
  12 : { message: "ClaimNotFound" },
  13 : { message: "ClaimNotOpen" },
  14 : { message: "SelfChallenge" },
  15 : { message: "AlreadyChallenged" },
  16 : { message: "ClaimFull" },
  17 : { message: "ChallengeWindowClosed" },
  18 : { message: "InvalidInviteKey" },
  19 : { message: "DuelNeedsEqualStake" },
  20 : { message: "InsufficientCreatorLiquidity" },
  21 : { message: "ClaimNotActive" },
  22 : { message: "NotYetExpired" },
  23 : { message: "InvalidVerdict" },
  24 : { message: "NotCreator" },
  25 : { message: "NothingToWithdraw" },
  26 : { message: "NoFees" },
  27 : { message: "PayoutExceedsEscrow" },
  28 : { message: "UnsupportedToken" },
  29 : { message: "Overflow" },
  30 : { message: "InviteKeyTooLong" },
  31 : { message: "ZeroStake" },
  32 : { message: "ClaimNotResolved" },
  33 : { message: "NotAChallenger" },
  34 : { message: "AlreadyClaimedPayout" },
  35 : { message: "ChallengersDidNotWin" },
  36 : { message: "UnsupportedDecimals" },
  37 : { message: "InvalidConfidence" },
  /**
   * `cancel_claim` refused because the claim still holds counterparty funds
   * or a reserved creator liability: challengers have funded this market, so
   * it belongs to settlement, not to a creator refund.
   */
  38 : { message: "ClaimHasActiveClaims" },
  /**
   * Escrow could not back the cancellation refund at the moment of the call.
   * The refund is never minted; the claim stays untouched and the creator
   * can retry once the contract is solvent again.
   */
  39 : { message: "RefundNotEscrowed" },
  /**
   * A verdict carried an encoding version this contract cannot decode. The
   * verdict is refused rather than reinterpreted, so resolution fails closed
   * and the claim is left untouched.
   */
  40 : { message: "UnsupportedVerdictVersion" },
  /**
   * A single claim metadata string exceeded `MAX_METADATA_BYTES`. The
   * claim is refused rather than silently truncated, so what is stored is
   * always exactly what the caller supplied.
   */
  41 : { message: "MetadataTooLong" },
  /**
   * The claim's combined metadata exceeded `MAX_CLAIM_METADATA_BYTES`. No
   * stake is pulled and no storage is written for a claim over the budget.
   */
  42 : { message: "ClaimMetadataTooLong" },
  /**
   * The parent claim referenced by `parent_id` does not exist.
   */
  43 : { message: "ParentClaimNotFound" },
  /**
   * The parent claim is not in a state that allows creating a rematch.
   */
  44 : { message: "ParentClaimInvalidState" },
  /**
   * The parent claim has already been used for a rematch (no duplicate rematches).
   */
  45 : { message: "ParentClaimAlreadyRematched" },
  /**
   * `get_claims_batch` was called with more than `MAX_BATCH_SIZE` ids. The
   * whole call is refused before any storage is read.
   */
  46 : { message: "BatchTooLarge" },
  /**
   * A claim's escrow bookkeeping broke an accounting invariant (negative
   * escrow or stake, liability above stake, or more escrow than was taken
   * in). The write is refused so the contract never records an impossible
   * state.
   */
  47 : { message: "ConservationViolation" }
}

/**
 * An oracle verdict carrying its own encoding version.
 *
 * `version` is an explicit discriminant, not an inference: a reader that does
 * not know a version must refuse the verdict rather than reinterpret its
 * fields. `side` is the decision as encoded under that version. `None` is
 * never a settled verdict, so it is rejected by [`Verdict::decode`] at both
 * write and read time.
 */
export interface Verdict {
  side: WinnerSide;
  version: number;
}

/**
 * Struct: FeePolicy
 */
export interface FeePolicy {
  agent_owner_fee_bps: number;
  platform_fee_bps: number;
  platform_recipient: string | null;
}

/**
 * Struct: Challenger
 */
export interface Challenger {
  address: string;
  /**
   * Set once this challenger has pulled their settlement. Held on the roster
   * entry rather than in a side map so `get_challenger_list` can report claim
   * status without an extra read per challenger.
   */
  claimed: boolean;
  stake: bigint;
}

/**
 * Enum: ClaimState
 */
export enum ClaimState {
  /**
   * Enum Case: Open
   */
  Open = 0,
  /**
   * Enum Case: Active
   */
  Active = 1,
  /**
   * Enum Case: Resolved
   */
  Resolved = 2,
  /**
   * Enum Case: Cancelled
   */
  Cancelled = 3
}

/**
 * Enum: WinnerSide
 */
export enum WinnerSide {
  /**
   * Enum Case: None
   */
  None = 0,
  /**
   * Enum Case: Creator
   */
  Creator = 1,
  /**
   * Enum Case: Challengers
   */
  Challengers = 2,
  /**
   * Enum Case: Draw
   */
  Draw = 3,
  /**
   * Enum Case: Unresolvable
   */
  Unresolvable = 4
}

/**
 * Copied onto each claim at creation and never mutated afterwards.
 */
export interface FeeSnapshot {
  agent_owner_fee_bps: number;
  agent_owner_recipient: string | null;
  platform_fee_bps: number;
  platform_recipient: string | null;
}

/**
 * What a challenger would receive from `claim_challenger_payout`, without
 * performing it.
 */
export interface PayoutQuote {
  claimed: boolean;
  fee: bigint;
  gross: bigint;
  net: bigint;
}

/**
 * Struct: ClaimFeeView
 */
export interface ClaimFeeView {
  agent_owner_fee_bps: number;
  agent_owner_recipient: string | null;
  context_hash: Buffer;
  platform_fee_bps: number;
  platform_recipient: string | null;
}

/**
 * Mirrors `MimirV2.CreateParams`. Grouped into a struct for the same reason the
 * Solidity did: the argument list is otherwise unwieldy.
 */
export interface CreateParams {
  /**
   * `None` when the market is not attributed to an agent.
   */
  agent_owner_recipient: string | null;
  category: string;
  challenger_payout_bps: number;
  context_hash: Buffer;
  counter_position: string;
  creator_position: string;
  deadline: bigint;
  handicap_line: string;
  invite_key: string | null;
  is_private: boolean;
  market_type: string;
  max_challengers: number;
  odds_mode: string;
  parent_id: bigint;
  question: string;
  resolution_url: string;
  settlement_rule: string;
  stake_amount: bigint;
}

/**
 * Struct: MarketConfig
 */
export interface MarketConfig {
  challenger_payout_bps: number;
  handicap_line: string;
  invite_key_hash: Buffer | null;
  is_private: boolean;
  market_type: string;
  max_challengers: number;
  odds_mode: string;
  settlement_rule: string;
}

/**
 * Struct: PendingOracle
 */
export interface PendingOracle {
  executable_at: bigint;
  next: string;
}

/**
 * Struct: PlatformStats
 */
export interface PlatformStats {
  balance: bigint;
  fees_accrued: bigint;
  fees_claimed: bigint;
  resolved: bigint;
  total_claims: bigint;
}

/**
 * Outcome of validating a rematch child's link to its parent claim, cached
 * under `DataKey::RematchParent(parent_id, child_id)`.
 */
export enum RematchStatus {
  /**
   * The parent exists, was in a rematchable state and is linked to this child.
   */
  Linked = 0,
  /**
   * The referenced parent claim does not exist (`Error::ParentClaimNotFound`).
   */
  ParentNotFound = 1,
  /**
   * The parent is not in a state that allows a rematch (`Error::ParentClaimInvalidState`).
   */
  ParentInvalidState = 2,
  /**
   * The parent already has a rematch child (`Error::ParentClaimAlreadyRematched`).
   */
  ParentAlreadyRematched = 3
}

/**
 * A paginated window into a claim's challenger roster.
 *
 * `items` holds up to `limit` entries starting at `offset`.
 * `total` is the total roster length so callers can tell when they have read
 * the last page without fetching an extra empty one.
 */
export interface ChallengerPage {
  /**
   * The slice of challengers for this page.
   */
  items: Array<Challenger>;
  /**
   * Roster position of the first item returned (mirrors the caller's
   * `offset` argument for safe cursor book-keeping).
   */
  offset: number;
  /**
   * Total number of challengers in this claim (not just this page).
   */
  total: number;
}

/**
 * Struct: PendingFeePolicy
 */
export interface PendingFeePolicy {
  agent_owner_fee_bps: number;
  executable_at: bigint;
  platform_fee_bps: number;
  platform_recipient: string | null;
}

/**
 * Event: FeeAccrued
 */
export interface FeeAccruedEvent {
  name: "FeeAccrued";
  data: {
    id: bigint;
    recipient: string;
    amount?: bigint;
    is_agent_owner_fee?: boolean;
  };
}

/**
 * Event: FeeClaimed
 */
export interface FeeClaimedEvent {
  name: "FeeClaimed";
  data: {
    recipient: string;
    amount?: bigint;
  };
}

/**
 * Event: Withdrawal
 */
export interface WithdrawalEvent {
  name: "Withdrawal";
  data: {
    to: string;
    amount?: bigint;
  };
}

/**
 * Event: ClaimCreated
 */
export interface ClaimCreatedEvent {
  name: "ClaimCreated";
  data: {
    id: bigint;
    creator: string;
    category?: string;
  };
}

/**
 * Emitted when initial escrow is established for a claim.
 * Records the initial funding state for accounting reconciliation.
 */
export interface EscrowSeededEvent {
  name: "EscrowSeeded";
  data: {
    id: bigint;
    funder: string;
    amount?: bigint;
    escrow_type?: string;
  };
}

/**
 * Event: OracleQueued
 */
export interface OracleQueuedEvent {
  name: "OracleQueued";
  data: {
    next: string;
    executable_at?: bigint;
  };
}

/**
 * Event: ClaimResolved
 */
export interface ClaimResolvedEvent {
  name: "ClaimResolved";
  data: {
    id: bigint;
    winner_side?: WinnerSide;
    summary?: string;
    confidence?: number;
    evidence_hash?: Buffer;
  };
}

/**
 * Event: MarketSettled
 */
export interface MarketSettledEvent {
  name: "MarketSettled";
  data: {
    id: bigint;
    total_paid?: bigint;
    total_fees?: bigint;
    /**
     * Escrow left for challengers to pull via `claim_challenger_payout`.
     */
    owed_to_challengers?: bigint;
    dust?: bigint;
  };
}

/**
 * Event: OracleChanged
 */
export interface OracleChangedEvent {
  name: "OracleChanged";
  data: {
    next: string;
    previous?: string | null;
  };
}

/**
 * One challenger's settlement. Together with `ClaimChallenged` and
 * `ClaimResolved` this gives an off-chain indexer everything it needs to derive
 * per-address win/loss records, which are no longer tracked on chain.
 */
export interface ChallengerPaidEvent {
  name: "ChallengerPaid";
  data: {
    id: bigint;
    challenger: string;
    stake?: bigint;
    gross?: bigint;
    fee?: bigint;
    net?: bigint;
  };
}

/**
 * The creator's refund of an unchallenged claim. `refund` lets an indexer
 * reconcile the refund against `creator_stake` and escrow without a second
 * read; `parked` distinguishes a delivered refund from one parked as a
 * withdrawable balance when the creator's trustline refused the transfer.
 */
export interface ClaimCancelledEvent {
  name: "ClaimCancelled";
  data: {
    id: bigint;
    refund?: bigint;
    parked?: boolean;
  };
}

/**
 * The versioned verdict written at resolution, emitted alongside
 * `ClaimResolved`.
 *
 * `ClaimResolved` keeps its existing shape for compatible indexers; this event
 * carries the explicit encoding version so consumers can pin the verdict
 * encoding without a second read or a schema guess.
 */
export interface VerdictEncodedEvent {
  name: "VerdictEncoded";
  data: {
    id: bigint;
    version?: number;
    winner_side?: WinnerSide;
  };
}

/**
 * Event: AgentAttributed
 */
export interface AgentAttributedEvent {
  name: "AgentAttributed";
  data: {
    id: bigint;
    agent_owner_recipient: string;
  };
}

/**
 * Event: ClaimChallenged
 */
export interface ClaimChallengedEvent {
  name: "ClaimChallenged";
  data: {
    id: bigint;
    challenger: string;
    stake?: bigint;
  };
}

/**
 * Emitted when a claim's deadline is reached and it transitions to settlement-eligible.
 * Useful for indexers and workers to identify claims ready for oracle resolution.
 */
export interface DeadlineReachedEvent {
  name: "DeadlineReached";
  data: {
    id: bigint;
    deadline?: bigint;
    challenger_count?: number;
    total_staked?: bigint;
  };
}

/**
 * Event: FeePolicyQueued
 */
export interface FeePolicyQueuedEvent {
  name: "FeePolicyQueued";
  data: {
    platform_fee_bps?: number;
    agent_owner_fee_bps?: number;
    platform_recipient?: string | null;
    executable_at?: bigint;
  };
}

/**
 * Event: OracleCancelled
 */
export interface OracleCancelledEvent {
  name: "OracleCancelled";
  data: {
    cancelled?: boolean;
  };
}

/**
 * Event: FeePolicyUpdated
 */
export interface FeePolicyUpdatedEvent {
  name: "FeePolicyUpdated";
  data: {
    platform_fee_bps?: number;
    agent_owner_fee_bps?: number;
    platform_recipient?: string | null;
  };
}

/**
 * Emitted on fixed-odds liquidity state changes beyond reservations.
 * Tracks available creator liquidity for risk management.
 */
export interface LiquidityUpdatedEvent {
  name: "LiquidityUpdated";
  data: {
    id: bigint;
    reserved_liability?: bigint;
    available_liquidity?: bigint;
    total_creator_stake?: bigint;
  };
}

/**
 * Event: WithdrawalPending
 */
export interface WithdrawalPendingEvent {
  name: "WithdrawalPending";
  data: {
    to: string;
    amount?: bigint;
  };
}

/**
 * Event: FeePolicyCancelled
 */
export interface FeePolicyCancelledEvent {
  name: "FeePolicyCancelled";
  data: {
    cancelled?: boolean;
  };
}

/**
 * Defensive halt: the claim's accounting shows counterparty funds or a
 * reserved creator liability while its lifecycle state claims to be `Open`.
 * The cancellation was refused and NOTHING changed — this event is the
 * on-chain record for keepers, indexers and incident response.
 */
export interface CancellationRefusedEvent {
  name: "CancellationRefused";
  data: {
    id: bigint;
    challenger_count?: number;
    total_challenger_stake?: bigint;
    reserved_creator_liability?: bigint;
    reason?: number;
  };
}

/**
 * Frozen fee terms written onto a claim at creation. Indexers can treat this as
 * the authoritative economics for the market; a later `FeePolicyUpdated` must
 * not rewrite them.
 */
export interface FeePolicySnapshottedEvent {
  name: "FeePolicySnapshotted";
  data: {
    id: bigint;
    platform_fee_bps?: number;
    agent_owner_fee_bps?: number;
    platform_recipient?: string | null;
    agent_owner_recipient?: string | null;
  };
}

/**
 * Event: OwnershipTransferred
 */
export interface OwnershipTransferredEvent {
  name: "OwnershipTransferred";
  data: {
    next: string;
    previous?: string | null;
  };
}

/**
 * Lifecycle state transition event for auditing and monitoring.
 * Emitted on every state change with the previous and new states.
 */
export interface ClaimStateTransitionedEvent {
  name: "ClaimStateTransitioned";
  data: {
    id: bigint;
    from_state?: number;
    to_state?: number;
    timestamp?: bigint;
  };
}

/**
 * A fixed-odds challenge consumed part of the creator's liquidity guarantee.
 * `reserved_creator_liability` and `available_creator_liquidity` are snapshots
 * after this challenge, so an indexer can audit the limit without replaying
 * the roster or trusting a stale read-index calculation.
 */
export interface FixedOddsLiquidityReservedEvent {
  name: "FixedOddsLiquidityReserved";
  data: {
    id: bigint;
    challenger: string;
    stake?: bigint;
    gross?: bigint;
    profit?: bigint;
    reserved_creator_liability?: bigint;
    available_creator_liquidity?: bigint;
  };
}

/**
 * Union: DataKey
 */
 export type DataKey =
  /**
   * One-time initialisation guard.
   */
  { tag: "Init"; values: void } |
  { tag: "Owner"; values: void } |
  { tag: "Oracle"; values: void } |
  { tag: "Usdc"; values: void } |
  { tag: "Policy"; values: void } |
  { tag: "Pending"; values: void } |
  /**
   * Queued oracle rotation (separate from fee-policy Pending).
   */
  { tag: "PendingOracle"; values: void } |
  { tag: "ClaimCount"; values: void } |
  { tag: "TotalResolved"; values: void } |
  { tag: "FeesAccrued"; values: void } |
  { tag: "FeesClaimed"; values: void } |
  { tag: "Claim"; values: readonly [bigint] } |
  { tag: "Challengers"; values: readonly [bigint] } |
  /**
   * Versioned verdict written at resolution. Absent on claims resolved
   * before verdicts were versioned; readers fall back to `Claim.winner_side`
   * for those.
   */
  { tag: "Verdict"; values: readonly [bigint] } |
  /**
   * Pull-payment fallback for failed payout pushes.
   */
  { tag: "Withdrawable"; values: readonly [string] } |
  /**
   * Accrued, unclaimed fees. Always pulled, never pushed.
   */
  { tag: "Accrued"; values: readonly [string] } |
  /**
   * Rematch parent link validation cache: (parent_id, child_id) -> RematchStatus
   */
  { tag: "RematchParent"; values: readonly [bigint, bigint] };
    export type ContractEvent = FeeAccruedEvent | FeeClaimedEvent | WithdrawalEvent | ClaimCreatedEvent | EscrowSeededEvent | OracleQueuedEvent | ClaimResolvedEvent | MarketSettledEvent | OracleChangedEvent | ChallengerPaidEvent | ClaimCancelledEvent | VerdictEncodedEvent | AgentAttributedEvent | ClaimChallengedEvent | DeadlineReachedEvent | FeePolicyQueuedEvent | OracleCancelledEvent | FeePolicyUpdatedEvent | LiquidityUpdatedEvent | WithdrawalPendingEvent | FeePolicyCancelledEvent | CancellationRefusedEvent | FeePolicySnapshottedEvent | OwnershipTransferredEvent | ClaimStateTransitionedEvent | FixedOddsLiquidityReservedEvent;
    