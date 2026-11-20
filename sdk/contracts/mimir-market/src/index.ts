import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}





export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
  }
} as const

export interface Claim {
  category: string;
  /**
 * How many challengers have pulled their settlement. The last one absorbs
 * whatever `remaining_escrow` is left, so truncation dust is never stranded.
 */
challenger_claims: u32;
  challenger_count: u32;
  confidence: u32;
  context_hash: Buffer;
  counter_position: string;
  created_at: u64;
  creator: string;
  creator_position: string;
  creator_stake: i128;
  deadline: u64;
  evidence_hash: Option<Buffer>;
  fees: FeeSnapshot;
  market: MarketConfig;
  parent_id: u64;
  question: string;
  /**
 * Escrow still owed to challengers after resolution. Seeded by
 * `resolve_claim` and drawn down by each `claim_challenger_payout`, so the
 * contract can never pay out more than it took in.
 */
remaining_escrow: i128;
  reserved_creator_liability: i128;
  resolution_summary: string;
  resolution_url: string;
  state: ClaimState;
  total_challenger_stake: i128;
  winner_side: WinnerSide;
}

export const Errors = {
  1: {message:"AlreadyInitialized"},
  2: {message:"NotInitialized"},
  3: {message:"NotOwner"},
  4: {message:"NotOracle"},
  5: {message:"FeeCapExceeded"},
  6: {message:"FeeNeedsRecipient"},
  7: {message:"NothingQueued"},
  8: {message:"Timelocked"},
  9: {message:"StakeTooSmall"},
  10: {message:"DeadlineInPast"},
  11: {message:"EmptyQuestion"},
  12: {message:"ClaimNotFound"},
  13: {message:"ClaimNotOpen"},
  14: {message:"SelfChallenge"},
  15: {message:"AlreadyChallenged"},
  16: {message:"ClaimFull"},
  17: {message:"ChallengeWindowClosed"},
  18: {message:"InvalidInviteKey"},
  19: {message:"DuelNeedsEqualStake"},
  20: {message:"InsufficientCreatorLiquidity"},
  21: {message:"ClaimNotActive"},
  22: {message:"NotYetExpired"},
  23: {message:"InvalidVerdict"},
  24: {message:"NotCreator"},
  25: {message:"NothingToWithdraw"},
  26: {message:"NoFees"},
  27: {message:"PayoutExceedsEscrow"},
  28: {message:"UnsupportedToken"},
  29: {message:"Overflow"},
  30: {message:"InviteKeyTooLong"},
  31: {message:"ZeroStake"},
  32: {message:"ClaimNotResolved"},
  33: {message:"NotAChallenger"},
  34: {message:"AlreadyClaimedPayout"},
  35: {message:"ChallengersDidNotWin"},
  36: {message:"UnsupportedDecimals"},
  37: {message:"InvalidConfidence"},
  /**
   * `cancel_claim` refused because the claim still holds counterparty funds
   * or a reserved creator liability: challengers have funded this market, so
   * it belongs to settlement, not to a creator refund.
   */
  38: {message:"ClaimHasActiveClaims"},
  /**
   * Escrow could not back the cancellation refund at the moment of the call.
   * The refund is never minted; the claim stays untouched and the creator
   * can retry once the contract is solvent again.
   */
  39: {message:"RefundNotEscrowed"},
  /**
   * A verdict carried an encoding version this contract cannot decode. The
   * verdict is refused rather than reinterpreted, so resolution fails closed
   * and the claim is left untouched.
   */
  40: {message:"UnsupportedVerdictVersion"},
  /**
   * A single claim metadata string exceeded `MAX_METADATA_BYTES`. The
   * claim is refused rather than silently truncated, so what is stored is
   * always exactly what the caller supplied.
   */
  41: {message:"MetadataTooLong"},
  /**
   * The claim's combined metadata exceeded `MAX_CLAIM_METADATA_BYTES`. No
   * stake is pulled and no storage is written for a claim over the budget.
   */
  42: {message:"ClaimMetadataTooLong"},
  /**
   * The parent claim referenced by `parent_id` does not exist.
   */
  43: {message:"ParentClaimNotFound"},
  /**
   * The parent claim is not in a state that allows creating a rematch.
   */
  44: {message:"ParentClaimInvalidState"},
  /**
   * The parent claim has already been used for a rematch (no duplicate rematches).
   */
  45: {message:"ParentClaimAlreadyRematched"},
  /**
   * `get_claims_batch` was called with more than `MAX_BATCH_SIZE` ids. The
   * whole call is refused before any storage is read.
   */
  46: {message:"BatchTooLarge"},
  /**
   * A claim's escrow bookkeeping broke an accounting invariant (negative
   * escrow or stake, liability above stake, or more escrow than was taken
   * in). The write is refused so the contract never records an impossible
   * state.
   */
  47: {message:"ConservationViolation"},
  /**
   * The required payout rounding policy is unsupported. Use a supported
   * preview version before submitting a pull; no funds or state are changed.
   */
  48: {message:"UnsupportedRoundingPolicyVersion"},
  /**
   * Ownership transfer was blocked by the existing withdrawal pause guard.
   */
  49: {message:"Paused"}
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
  version: u32;
}


export interface FeePolicy {
  agent_owner_fee_bps: u32;
  platform_fee_bps: u32;
  platform_recipient: Option<string>;
}


export interface Challenger {
  address: string;
  /**
 * Set once this challenger has pulled their settlement. Held on the roster
 * entry rather than in a side map so `get_challenger_list` can report claim
 * status without an extra read per challenger.
 */
claimed: boolean;
  stake: i128;
}

export enum ClaimState {
  Open = 0,
  Active = 1,
  Resolved = 2,
  Cancelled = 3,
}

export enum WinnerSide {
  None = 0,
  Creator = 1,
  Challengers = 2,
  Draw = 3,
  Unresolvable = 4,
}


/**
 * Copied onto each claim at creation and never mutated afterwards.
 */
export interface FeeSnapshot {
  agent_owner_fee_bps: u32;
  agent_owner_recipient: Option<string>;
  platform_fee_bps: u32;
  platform_recipient: Option<string>;
}


/**
 * What a challenger would receive from `claim_challenger_payout`, without
 * performing it.
 */
export interface PayoutQuote {
  claimed: boolean;
  fee: i128;
  gross: i128;
  net: i128;
}


export interface ClaimFeeView {
  agent_owner_fee_bps: u32;
  agent_owner_recipient: Option<string>;
  context_hash: Buffer;
  platform_fee_bps: u32;
  platform_recipient: Option<string>;
}


/**
 * Mirrors `MimirV2.CreateParams`. Grouped into a struct for the same reason the
 * Solidity did: the argument list is otherwise unwieldy.
 */
export interface CreateParams {
  /**
 * `None` when the market is not attributed to an agent.
 */
agent_owner_recipient: Option<string>;
  category: string;
  challenger_payout_bps: u32;
  context_hash: Buffer;
  counter_position: string;
  creator_position: string;
  deadline: u64;
  handicap_line: string;
  invite_key: Option<string>;
  is_private: boolean;
  market_type: string;
  max_challengers: u32;
  odds_mode: string;
  parent_id: u64;
  question: string;
  resolution_url: string;
  settlement_rule: string;
  stake_amount: i128;
}


export interface MarketConfig {
  challenger_payout_bps: u32;
  handicap_line: string;
  invite_key_hash: Option<Buffer>;
  is_private: boolean;
  market_type: string;
  max_challengers: u32;
  odds_mode: string;
  settlement_rule: string;
}


export interface PendingOracle {
  executable_at: u64;
  next: string;
}


export interface PlatformStats {
  balance: i128;
  fees_accrued: i128;
  fees_claimed: i128;
  resolved: u64;
  total_claims: u64;
}

/**
 * Outcome of validating a rematch child's link to its parent claim, cached
 * under `DataKey::RematchParent(parent_id, child_id)`.
 */
export enum RematchStatus {
  Linked = 0,
  ParentNotFound = 1,
  ParentInvalidState = 2,
  ParentAlreadyRematched = 3,
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
offset: u32;
  /**
 * Total number of challengers in this claim (not just this page).
 */
total: u32;
}


export interface PendingFeePolicy {
  agent_owner_fee_bps: u32;
  executable_at: u64;
  platform_fee_bps: u32;
  platform_recipient: Option<string>;
}


/**
 * Versioned preview envelope. The legacy PayoutQuote encoding stays unchanged.
 */
export interface VersionedPayoutQuote {
  quote: PayoutQuote;
  rounding_policy_version: u32;
}



























export type DataKey = {tag: "Init", values: void} | {tag: "Paused", values: void} | {tag: "Owner", values: void} | {tag: "Oracle", values: void} | {tag: "Usdc", values: void} | {tag: "Policy", values: void} | {tag: "Pending", values: void} | {tag: "PendingOracle", values: void} | {tag: "ClaimCount", values: void} | {tag: "TotalResolved", values: void} | {tag: "FeesAccrued", values: void} | {tag: "FeesClaimed", values: void} | {tag: "Claim", values: readonly [u64]} | {tag: "Challengers", values: readonly [u64]} | {tag: "Verdict", values: readonly [u64]} | {tag: "Withdrawable", values: readonly [string]} | {tag: "Accrued", values: readonly [string]} | {tag: "RematchParent", values: readonly [u64, u64]} | {tag: "CreatorClaims", values: readonly [string, u32]} | {tag: "CreatorClaimCount", values: readonly [string]};

export interface Client {
  /**
   * Construct and simulate a get_usdc transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_usdc: (options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

  /**
   * Construct and simulate a withdraw transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Solidity used `msg.sender`; Soroban has no equivalent for a top-level
   * call, so the beneficiary is an explicit argument that must authorize.
   *
   * Withdrawals are intentionally NOT gated by the pause flag: pause
   * controls may halt new claims, challenges, and resolutions, but must
   * never block a funded user from pulling their own balance. This keeps
   * contract-first accounting intact — a paused market still owes its
   * users their escrowed funds, and the only safe way to honor that is to
   * let them withdraw.
   */
  withdraw: ({who}: {who: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a get_claim transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_claim: ({claim_id}: {claim_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Claim>>>

  /**
   * Construct and simulate a get_owner transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_owner: (options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

  /**
   * Construct and simulate a is_paused transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether the contract is currently paused. Pause halts new claims,
   * challenges, and resolutions, but never blocks `withdraw` or
   * `claim_fees` — see those entry points for the invariant.
   */
  is_paused: (options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a claim_fees transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  claim_fees: ({who}: {who: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a get_oracle transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_oracle: (options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

  /**
   * Construct and simulate a initialize transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Constructor equivalent, callable once.
   */
  initialize: ({owner, oracle, usdc_token, platform_fee_bps, agent_owner_fee_bps, platform_recipient}: {owner: string, oracle: string, usdc_token: string, platform_fee_bps: u32, agent_owner_fee_bps: u32, platform_recipient: Option<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_verdict transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The claim's verdict with its explicit encoding version.
   *
   * Refuses with `Error::UnsupportedVerdictVersion` if the stored verdict was
   * written by an encoding this contract does not understand, and with
   * `Error::ClaimNotResolved` if the claim has not been resolved.
   */
  get_verdict: ({claim_id}: {claim_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Verdict>>>

  /**
   * Construct and simulate a cancel_claim transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  cancel_claim: ({claim_id}: {claim_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a create_claim transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  create_claim: ({creator, params}: {creator: string, params: CreateParams}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a queue_oracle transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  queue_oracle: ({new_oracle}: {new_oracle: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_oracle transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  cancel_oracle: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a resolve_claim transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  resolve_claim: ({claim_id, winner_side, summary, confidence, evidence_hash}: {claim_id: u64, winner_side: WinnerSide, summary: string, confidence: u32, evidence_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a execute_oracle transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permissionless once the timelock has elapsed.
   */
  execute_oracle: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_claim_fees transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_claim_fees: ({claim_id}: {claim_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<ClaimFeeView>>>

  /**
   * Construct and simulate a get_fee_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_fee_policy: (options?: MethodOptions) => Promise<AssembledTransaction<Result<FeePolicy>>>

  /**
   * Construct and simulate a challenge_claim transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  challenge_claim: ({challenger, claim_id, stake_amount, invite_key}: {challenger: string, claim_id: u64, stake_amount: i128, invite_key: Option<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_accrued_fees transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_accrued_fees: ({who}: {who: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a get_claims_batch transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Batch-read up to [`MAX_BATCH_SIZE`] claims in one simulated call.
   *
   * Returns a `Vec<Option<Claim>>` whose length equals `ids.len()`. Each slot
   * holds `Some(claim)` when the id exists, or `None` when it does not. The
   * slot positions mirror the input positions exactly, so callers can zip the
   * result against their id list without any bookkeeping:
   *
   * ```text
   * ids    = [1, 999, 3]
   * result = [Some(claim_1), None, Some(claim_3)]
   * ```
   *
   * # Behavior guarantees
   *
   * - **Pure read.** No money, no auth, no state mutation. Safe to call from
   * any context, including unsigned simulation.
   * - **Position-stable.** The output length always equals the input length.
   * - **Non-panicking.** An unknown id yields `None`; it does not abort the
   * call or return an error for that slot.
   * - **Duplicate ids.** Each occurrence is resolved independently. Two slots
   * for the same id return the same `Claim` value, both `Some(…)`. This is
   * intentional: the function is idempotent and the on-chain state is the
   * same answer for both positions.
   * - **Challenger rosters exclud
   */
  get_claims_batch: ({ids}: {ids: Array<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Array<Option<Claim>>>>>

  /**
   * Construct and simulate a get_verdict_side transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Convenience view returning only the decoded verdict side.
   */
  get_verdict_side: ({claim_id}: {claim_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<WinnerSide>>>

  /**
   * Construct and simulate a get_withdrawable transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_withdrawable: ({who}: {who: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a queue_fee_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  queue_fee_policy: ({platform_fee_bps, agent_owner_fee_bps, platform_recipient}: {platform_fee_bps: u32, agent_owner_fee_bps: u32, platform_recipient: Option<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_fee_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  cancel_fee_policy: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a execute_fee_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permissionless once the timelock has elapsed.
   */
  execute_fee_policy: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_creator_claims transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Paginated list of claim ids created by `creator`, in creation order.
   *
   * Returns up to `limit` ids starting at `offset` (0-based) together with
   * the creator's total claim count, so callers can detect the last page
   * without an extra empty fetch. An `offset` beyond the end of the index
   * returns an empty `Vec` with `total` set correctly.
   *
   * The per-creator index is appended in `create_claim` and stored as
   * bounded pages of ids, so this read costs O(limit) rather than
   * O(total claims). TTL is extended on read like other persistent views.
   */
  get_creator_claims: ({creator, offset, limit}: {creator: string, offset: u32, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<readonly [Array<u64>, u32]>>>

  /**
   * Construct and simulate a get_pending_oracle transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_pending_oracle: (options?: MethodOptions) => Promise<AssembledTransaction<Option<PendingOracle>>>

  /**
   * Construct and simulate a get_platform_stats transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_platform_stats: (options?: MethodOptions) => Promise<AssembledTransaction<Result<PlatformStats>>>

  /**
   * Construct and simulate a transfer_ownership transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  transfer_ownership: ({new_owner}: {new_owner: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_challenger_list transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The roster, including each challenger's stake and whether they have
   * already pulled their settlement.
   */
  get_challenger_list: ({claim_id}: {claim_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Array<Challenger>>>

  /**
   * Construct and simulate a transition_deadline transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  transition_deadline: ({claim_id}: {claim_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_challengers_page transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * A paginated window into the challenger roster.
   *
   * Returns up to `limit` entries starting at `offset` (0-based).
   * `limit = 0` returns all entries from `offset` to the end of the roster —
   * identical to `get_challenger_list` when `offset = 0`.
   *
   * The `ChallengerPage` response always carries `total` (full roster length)
   * so callers can detect the last page without issuing an extra empty fetch.
   *
   * Neither `offset` nor `limit` can cause a panic: an `offset` beyond the
   * end of the roster returns an empty `items` slice with `total` set
   * correctly.
   */
  get_challengers_page: ({claim_id, offset, limit}: {claim_id: u64, offset: u32, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<ChallengerPage>>

  /**
   * Construct and simulate a claim_payout_versioned transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pull once using the same policy as a versioned preview. This retains the
   * legacy payout's authorization, fee accrual, dust and frozen-token fallback.
   */
  claim_payout_versioned: ({challenger, claim_id, required_version}: {challenger: string, claim_id: u64, required_version: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a get_pending_fee_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_pending_fee_policy: (options?: MethodOptions) => Promise<AssembledTransaction<Option<PendingFeePolicy>>>

  /**
   * Construct and simulate a quote_payout_versioned transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Preview a payout only under the caller's explicitly required policy.
   * Unsupported versions are refused before reading the claim or roster.
   */
  quote_payout_versioned: ({claim_id, challenger, required_version}: {claim_id: u64, challenger: string, required_version: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<VersionedPayoutQuote>>>

  /**
   * Construct and simulate a claim_challenger_payout transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Settle one challenger's winning or refunded position. Callable once per
   * challenger after resolution, and O(1) in the number of challengers, so a
   * market filled to MAX_CHALLENGERS can always be paid out in full.
   *
   * `resolve_claim` deliberately does NOT loop over challengers: a Stellar
   * transaction is capped on its ledger-entry footprint, and paying ~100
   * challengers at once does not fit. Returns the net amount credited.
   */
  claim_challenger_payout: ({challenger, claim_id}: {challenger: string, claim_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a get_claim_market_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_claim_market_config: ({claim_id}: {claim_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<MarketConfig>>>

  /**
   * Construct and simulate a quote_challenger_payout transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * What `claim_challenger_payout` would pay this challenger right now.
   */
  quote_challenger_payout: ({claim_id, challenger}: {claim_id: u64, challenger: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<PayoutQuote>>>

  /**
   * Construct and simulate a resolve_claim_versioned transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Versioned verdict entry point. Identical settlement semantics to
   * `resolve_claim`, but the oracle submits a `Verdict` carrying its explicit
   * encoding version. Unknown versions are refused with
   * `Error::UnsupportedVerdictVersion` and leave the claim untouched.
   */
  resolve_claim_versioned: ({claim_id, verdict, summary, confidence, evidence_hash}: {claim_id: u64, verdict: Verdict, summary: string, confidence: u32, evidence_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a rounding_policy_version transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read the current arithmetic policy without reading any claim or wallet.
   */
  rounding_policy_version: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(null, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAQAAAAAAAAAAAAAABUNsYWltAAAAAAAAFwAAAAAAAAAIY2F0ZWdvcnkAAAAQAAAAkkhvdyBtYW55IGNoYWxsZW5nZXJzIGhhdmUgcHVsbGVkIHRoZWlyIHNldHRsZW1lbnQuIFRoZSBsYXN0IG9uZSBhYnNvcmJzCndoYXRldmVyIGByZW1haW5pbmdfZXNjcm93YCBpcyBsZWZ0LCBzbyB0cnVuY2F0aW9uIGR1c3QgaXMgbmV2ZXIgc3RyYW5kZWQuAAAAAAARY2hhbGxlbmdlcl9jbGFpbXMAAAAAAAAEAAAAAAAAABBjaGFsbGVuZ2VyX2NvdW50AAAABAAAAAAAAAAKY29uZmlkZW5jZQAAAAAABAAAAAAAAAAMY29udGV4dF9oYXNoAAAD7gAAACAAAAAAAAAAEGNvdW50ZXJfcG9zaXRpb24AAAAQAAAAAAAAAApjcmVhdGVkX2F0AAAAAAAGAAAAAAAAAAdjcmVhdG9yAAAAABMAAAAAAAAAEGNyZWF0b3JfcG9zaXRpb24AAAAQAAAAAAAAAA1jcmVhdG9yX3N0YWtlAAAAAAAACwAAAAAAAAAIZGVhZGxpbmUAAAAGAAAAAAAAAA1ldmlkZW5jZV9oYXNoAAAAAAAD6AAAA+4AAAAgAAAAAAAAAARmZWVzAAAH0AAAAAtGZWVTbmFwc2hvdAAAAAAAAAAABm1hcmtldAAAAAAH0AAAAAxNYXJrZXRDb25maWcAAAAAAAAACXBhcmVudF9pZAAAAAAAAAYAAAAAAAAACHF1ZXN0aW9uAAAAEAAAALZFc2Nyb3cgc3RpbGwgb3dlZCB0byBjaGFsbGVuZ2VycyBhZnRlciByZXNvbHV0aW9uLiBTZWVkZWQgYnkKYHJlc29sdmVfY2xhaW1gIGFuZCBkcmF3biBkb3duIGJ5IGVhY2ggYGNsYWltX2NoYWxsZW5nZXJfcGF5b3V0YCwgc28gdGhlCmNvbnRyYWN0IGNhbiBuZXZlciBwYXkgb3V0IG1vcmUgdGhhbiBpdCB0b29rIGluLgAAAAAAEHJlbWFpbmluZ19lc2Nyb3cAAAALAAAAAAAAABpyZXNlcnZlZF9jcmVhdG9yX2xpYWJpbGl0eQAAAAAACwAAAAAAAAAScmVzb2x1dGlvbl9zdW1tYXJ5AAAAAAAQAAAAAAAAAA5yZXNvbHV0aW9uX3VybAAAAAAAEAAAAAAAAAAFc3RhdGUAAAAAAAfQAAAACkNsYWltU3RhdGUAAAAAAAAAAAAWdG90YWxfY2hhbGxlbmdlcl9zdGFrZQAAAAAACwAAAAAAAAALd2lubmVyX3NpZGUAAAAH0AAAAApXaW5uZXJTaWRlAAA=",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAMQAAAAAAAAASQWxyZWFkeUluaXRpYWxpemVkAAAAAAABAAAAAAAAAA5Ob3RJbml0aWFsaXplZAAAAAAAAgAAAAAAAAAITm90T3duZXIAAAADAAAAAAAAAAlOb3RPcmFjbGUAAAAAAAAEAAAAAAAAAA5GZWVDYXBFeGNlZWRlZAAAAAAABQAAAAAAAAARRmVlTmVlZHNSZWNpcGllbnQAAAAAAAAGAAAAAAAAAA1Ob3RoaW5nUXVldWVkAAAAAAAABwAAAAAAAAAKVGltZWxvY2tlZAAAAAAACAAAAAAAAAANU3Rha2VUb29TbWFsbAAAAAAAAAkAAAAAAAAADkRlYWRsaW5lSW5QYXN0AAAAAAAKAAAAAAAAAA1FbXB0eVF1ZXN0aW9uAAAAAAAACwAAAAAAAAANQ2xhaW1Ob3RGb3VuZAAAAAAAAAwAAAAAAAAADENsYWltTm90T3BlbgAAAA0AAAAAAAAADVNlbGZDaGFsbGVuZ2UAAAAAAAAOAAAAAAAAABFBbHJlYWR5Q2hhbGxlbmdlZAAAAAAAAA8AAAAAAAAACUNsYWltRnVsbAAAAAAAABAAAAAAAAAAFUNoYWxsZW5nZVdpbmRvd0Nsb3NlZAAAAAAAABEAAAAAAAAAEEludmFsaWRJbnZpdGVLZXkAAAASAAAAAAAAABNEdWVsTmVlZHNFcXVhbFN0YWtlAAAAABMAAAAAAAAAHEluc3VmZmljaWVudENyZWF0b3JMaXF1aWRpdHkAAAAUAAAAAAAAAA5DbGFpbU5vdEFjdGl2ZQAAAAAAFQAAAAAAAAANTm90WWV0RXhwaXJlZAAAAAAAABYAAAAAAAAADkludmFsaWRWZXJkaWN0AAAAAAAXAAAAAAAAAApOb3RDcmVhdG9yAAAAAAAYAAAAAAAAABFOb3RoaW5nVG9XaXRoZHJhdwAAAAAAABkAAAAAAAAABk5vRmVlcwAAAAAAGgAAAAAAAAATUGF5b3V0RXhjZWVkc0VzY3JvdwAAAAAbAAAAAAAAABBVbnN1cHBvcnRlZFRva2VuAAAAHAAAAAAAAAAIT3ZlcmZsb3cAAAAdAAAAAAAAABBJbnZpdGVLZXlUb29Mb25nAAAAHgAAAAAAAAAJWmVyb1N0YWtlAAAAAAAAHwAAAAAAAAAQQ2xhaW1Ob3RSZXNvbHZlZAAAACAAAAAAAAAADk5vdEFDaGFsbGVuZ2VyAAAAAAAhAAAAAAAAABRBbHJlYWR5Q2xhaW1lZFBheW91dAAAACIAAAAAAAAAFENoYWxsZW5nZXJzRGlkTm90V2luAAAAIwAAAAAAAAATVW5zdXBwb3J0ZWREZWNpbWFscwAAAAAkAAAAAAAAABFJbnZhbGlkQ29uZmlkZW5jZQAAAAAAACUAAADDYGNhbmNlbF9jbGFpbWAgcmVmdXNlZCBiZWNhdXNlIHRoZSBjbGFpbSBzdGlsbCBob2xkcyBjb3VudGVycGFydHkgZnVuZHMKb3IgYSByZXNlcnZlZCBjcmVhdG9yIGxpYWJpbGl0eTogY2hhbGxlbmdlcnMgaGF2ZSBmdW5kZWQgdGhpcyBtYXJrZXQsIHNvCml0IGJlbG9uZ3MgdG8gc2V0dGxlbWVudCwgbm90IHRvIGEgY3JlYXRvciByZWZ1bmQuAAAAABRDbGFpbUhhc0FjdGl2ZUNsYWltcwAAACYAAAC8RXNjcm93IGNvdWxkIG5vdCBiYWNrIHRoZSBjYW5jZWxsYXRpb24gcmVmdW5kIGF0IHRoZSBtb21lbnQgb2YgdGhlIGNhbGwuClRoZSByZWZ1bmQgaXMgbmV2ZXIgbWludGVkOyB0aGUgY2xhaW0gc3RheXMgdW50b3VjaGVkIGFuZCB0aGUgY3JlYXRvcgpjYW4gcmV0cnkgb25jZSB0aGUgY29udHJhY3QgaXMgc29sdmVudCBhZ2Fpbi4AAAARUmVmdW5kTm90RXNjcm93ZWQAAAAAAAAnAAAAsEEgdmVyZGljdCBjYXJyaWVkIGFuIGVuY29kaW5nIHZlcnNpb24gdGhpcyBjb250cmFjdCBjYW5ub3QgZGVjb2RlLiBUaGUKdmVyZGljdCBpcyByZWZ1c2VkIHJhdGhlciB0aGFuIHJlaW50ZXJwcmV0ZWQsIHNvIHJlc29sdXRpb24gZmFpbHMgY2xvc2VkCmFuZCB0aGUgY2xhaW0gaXMgbGVmdCB1bnRvdWNoZWQuAAAAGVVuc3VwcG9ydGVkVmVyZGljdFZlcnNpb24AAAAAAAAoAAAAsEEgc2luZ2xlIGNsYWltIG1ldGFkYXRhIHN0cmluZyBleGNlZWRlZCBgTUFYX01FVEFEQVRBX0JZVEVTYC4gVGhlCmNsYWltIGlzIHJlZnVzZWQgcmF0aGVyIHRoYW4gc2lsZW50bHkgdHJ1bmNhdGVkLCBzbyB3aGF0IGlzIHN0b3JlZCBpcwphbHdheXMgZXhhY3RseSB3aGF0IHRoZSBjYWxsZXIgc3VwcGxpZWQuAAAAD01ldGFkYXRhVG9vTG9uZwAAAAApAAAAjFRoZSBjbGFpbSdzIGNvbWJpbmVkIG1ldGFkYXRhIGV4Y2VlZGVkIGBNQVhfQ0xBSU1fTUVUQURBVEFfQllURVNgLiBObwpzdGFrZSBpcyBwdWxsZWQgYW5kIG5vIHN0b3JhZ2UgaXMgd3JpdHRlbiBmb3IgYSBjbGFpbSBvdmVyIHRoZSBidWRnZXQuAAAAFENsYWltTWV0YWRhdGFUb29Mb25nAAAAKgAAADpUaGUgcGFyZW50IGNsYWltIHJlZmVyZW5jZWQgYnkgYHBhcmVudF9pZGAgZG9lcyBub3QgZXhpc3QuAAAAAAATUGFyZW50Q2xhaW1Ob3RGb3VuZAAAAAArAAAAQlRoZSBwYXJlbnQgY2xhaW0gaXMgbm90IGluIGEgc3RhdGUgdGhhdCBhbGxvd3MgY3JlYXRpbmcgYSByZW1hdGNoLgAAAAAAF1BhcmVudENsYWltSW52YWxpZFN0YXRlAAAAACwAAABOVGhlIHBhcmVudCBjbGFpbSBoYXMgYWxyZWFkeSBiZWVuIHVzZWQgZm9yIGEgcmVtYXRjaCAobm8gZHVwbGljYXRlIHJlbWF0Y2hlcykuAAAAAAAbUGFyZW50Q2xhaW1BbHJlYWR5UmVtYXRjaGVkAAAAAC0AAAB4YGdldF9jbGFpbXNfYmF0Y2hgIHdhcyBjYWxsZWQgd2l0aCBtb3JlIHRoYW4gYE1BWF9CQVRDSF9TSVpFYCBpZHMuIFRoZQp3aG9sZSBjYWxsIGlzIHJlZnVzZWQgYmVmb3JlIGFueSBzdG9yYWdlIGlzIHJlYWQuAAAADUJhdGNoVG9vTGFyZ2UAAAAAAAAuAAAA10EgY2xhaW0ncyBlc2Nyb3cgYm9va2tlZXBpbmcgYnJva2UgYW4gYWNjb3VudGluZyBpbnZhcmlhbnQgKG5lZ2F0aXZlCmVzY3JvdyBvciBzdGFrZSwgbGlhYmlsaXR5IGFib3ZlIHN0YWtlLCBvciBtb3JlIGVzY3JvdyB0aGFuIHdhcyB0YWtlbgppbikuIFRoZSB3cml0ZSBpcyByZWZ1c2VkIHNvIHRoZSBjb250cmFjdCBuZXZlciByZWNvcmRzIGFuIGltcG9zc2libGUKc3RhdGUuAAAAABVDb25zZXJ2YXRpb25WaW9sYXRpb24AAAAAAAAvAAAAjFRoZSByZXF1aXJlZCBwYXlvdXQgcm91bmRpbmcgcG9saWN5IGlzIHVuc3VwcG9ydGVkLiBVc2UgYSBzdXBwb3J0ZWQKcHJldmlldyB2ZXJzaW9uIGJlZm9yZSBzdWJtaXR0aW5nIGEgcHVsbDsgbm8gZnVuZHMgb3Igc3RhdGUgYXJlIGNoYW5nZWQuAAAAIFVuc3VwcG9ydGVkUm91bmRpbmdQb2xpY3lWZXJzaW9uAAAAMAAAAEZPd25lcnNoaXAgdHJhbnNmZXIgd2FzIGJsb2NrZWQgYnkgdGhlIGV4aXN0aW5nIHdpdGhkcmF3YWwgcGF1c2UgZ3VhcmQuAAAAAAAGUGF1c2VkAAAAAAAx",
        "AAAAAQAAAW9BbiBvcmFjbGUgdmVyZGljdCBjYXJyeWluZyBpdHMgb3duIGVuY29kaW5nIHZlcnNpb24uCgpgdmVyc2lvbmAgaXMgYW4gZXhwbGljaXQgZGlzY3JpbWluYW50LCBub3QgYW4gaW5mZXJlbmNlOiBhIHJlYWRlciB0aGF0IGRvZXMKbm90IGtub3cgYSB2ZXJzaW9uIG11c3QgcmVmdXNlIHRoZSB2ZXJkaWN0IHJhdGhlciB0aGFuIHJlaW50ZXJwcmV0IGl0cwpmaWVsZHMuIGBzaWRlYCBpcyB0aGUgZGVjaXNpb24gYXMgZW5jb2RlZCB1bmRlciB0aGF0IHZlcnNpb24uIGBOb25lYCBpcwpuZXZlciBhIHNldHRsZWQgdmVyZGljdCwgc28gaXQgaXMgcmVqZWN0ZWQgYnkgW2BWZXJkaWN0OjpkZWNvZGVgXSBhdCBib3RoCndyaXRlIGFuZCByZWFkIHRpbWUuAAAAAAAAAAAHVmVyZGljdAAAAAACAAAAAAAAAARzaWRlAAAH0AAAAApXaW5uZXJTaWRlAAAAAAAAAAAAB3ZlcnNpb24AAAAABA==",
        "AAAAAQAAAAAAAAAAAAAACUZlZVBvbGljeQAAAAAAAAMAAAAAAAAAE2FnZW50X293bmVyX2ZlZV9icHMAAAAABAAAAAAAAAAQcGxhdGZvcm1fZmVlX2JwcwAAAAQAAAAAAAAAEnBsYXRmb3JtX3JlY2lwaWVudAAAAAAD6AAAABM=",
        "AAAAAQAAAAAAAAAAAAAACkNoYWxsZW5nZXIAAAAAAAMAAAAAAAAAB2FkZHJlc3MAAAAAEwAAAL9TZXQgb25jZSB0aGlzIGNoYWxsZW5nZXIgaGFzIHB1bGxlZCB0aGVpciBzZXR0bGVtZW50LiBIZWxkIG9uIHRoZSByb3N0ZXIKZW50cnkgcmF0aGVyIHRoYW4gaW4gYSBzaWRlIG1hcCBzbyBgZ2V0X2NoYWxsZW5nZXJfbGlzdGAgY2FuIHJlcG9ydCBjbGFpbQpzdGF0dXMgd2l0aG91dCBhbiBleHRyYSByZWFkIHBlciBjaGFsbGVuZ2VyLgAAAAAHY2xhaW1lZAAAAAABAAAAAAAAAAVzdGFrZQAAAAAAAAs=",
        "AAAAAwAAAAAAAAAAAAAACkNsYWltU3RhdGUAAAAAAAQAAAAAAAAABE9wZW4AAAAAAAAAAAAAAAZBY3RpdmUAAAAAAAEAAAAAAAAACFJlc29sdmVkAAAAAgAAAAAAAAAJQ2FuY2VsbGVkAAAAAAAAAw==",
        "AAAAAwAAAAAAAAAAAAAACldpbm5lclNpZGUAAAAAAAUAAAAAAAAABE5vbmUAAAAAAAAAAAAAAAdDcmVhdG9yAAAAAAEAAAAAAAAAC0NoYWxsZW5nZXJzAAAAAAIAAAAAAAAABERyYXcAAAADAAAAAAAAAAxVbnJlc29sdmFibGUAAAAE",
        "AAAAAQAAAEBDb3BpZWQgb250byBlYWNoIGNsYWltIGF0IGNyZWF0aW9uIGFuZCBuZXZlciBtdXRhdGVkIGFmdGVyd2FyZHMuAAAAAAAAAAtGZWVTbmFwc2hvdAAAAAAEAAAAAAAAABNhZ2VudF9vd25lcl9mZWVfYnBzAAAAAAQAAAAAAAAAFWFnZW50X293bmVyX3JlY2lwaWVudAAAAAAAA+gAAAATAAAAAAAAABBwbGF0Zm9ybV9mZWVfYnBzAAAABAAAAAAAAAAScGxhdGZvcm1fcmVjaXBpZW50AAAAAAPoAAAAEw==",
        "AAAAAQAAAFZXaGF0IGEgY2hhbGxlbmdlciB3b3VsZCByZWNlaXZlIGZyb20gYGNsYWltX2NoYWxsZW5nZXJfcGF5b3V0YCwgd2l0aG91dApwZXJmb3JtaW5nIGl0LgAAAAAAAAAAAAtQYXlvdXRRdW90ZQAAAAAEAAAAAAAAAAdjbGFpbWVkAAAAAAEAAAAAAAAAA2ZlZQAAAAALAAAAAAAAAAVncm9zcwAAAAAAAAsAAAAAAAAAA25ldAAAAAAL",
        "AAAAAQAAAAAAAAAAAAAADENsYWltRmVlVmlldwAAAAUAAAAAAAAAE2FnZW50X293bmVyX2ZlZV9icHMAAAAABAAAAAAAAAAVYWdlbnRfb3duZXJfcmVjaXBpZW50AAAAAAAD6AAAABMAAAAAAAAADGNvbnRleHRfaGFzaAAAA+4AAAAgAAAAAAAAABBwbGF0Zm9ybV9mZWVfYnBzAAAABAAAAAAAAAAScGxhdGZvcm1fcmVjaXBpZW50AAAAAAPoAAAAEw==",
        "AAAAAQAAAIRNaXJyb3JzIGBNaW1pclYyLkNyZWF0ZVBhcmFtc2AuIEdyb3VwZWQgaW50byBhIHN0cnVjdCBmb3IgdGhlIHNhbWUgcmVhc29uIHRoZQpTb2xpZGl0eSBkaWQ6IHRoZSBhcmd1bWVudCBsaXN0IGlzIG90aGVyd2lzZSB1bndpZWxkeS4AAAAAAAAADENyZWF0ZVBhcmFtcwAAABIAAAA1YE5vbmVgIHdoZW4gdGhlIG1hcmtldCBpcyBub3QgYXR0cmlidXRlZCB0byBhbiBhZ2VudC4AAAAAAAAVYWdlbnRfb3duZXJfcmVjaXBpZW50AAAAAAAD6AAAABMAAAAAAAAACGNhdGVnb3J5AAAAEAAAAAAAAAAVY2hhbGxlbmdlcl9wYXlvdXRfYnBzAAAAAAAABAAAAAAAAAAMY29udGV4dF9oYXNoAAAD7gAAACAAAAAAAAAAEGNvdW50ZXJfcG9zaXRpb24AAAAQAAAAAAAAABBjcmVhdG9yX3Bvc2l0aW9uAAAAEAAAAAAAAAAIZGVhZGxpbmUAAAAGAAAAAAAAAA1oYW5kaWNhcF9saW5lAAAAAAAAEAAAAAAAAAAKaW52aXRlX2tleQAAAAAD6AAAABAAAAAAAAAACmlzX3ByaXZhdGUAAAAAAAEAAAAAAAAAC21hcmtldF90eXBlAAAAABAAAAAAAAAAD21heF9jaGFsbGVuZ2VycwAAAAAEAAAAAAAAAAlvZGRzX21vZGUAAAAAAAAQAAAAAAAAAAlwYXJlbnRfaWQAAAAAAAAGAAAAAAAAAAhxdWVzdGlvbgAAABAAAAAAAAAADnJlc29sdXRpb25fdXJsAAAAAAAQAAAAAAAAAA9zZXR0bGVtZW50X3J1bGUAAAAAEAAAAAAAAAAMc3Rha2VfYW1vdW50AAAACw==",
        "AAAAAQAAAAAAAAAAAAAADE1hcmtldENvbmZpZwAAAAgAAAAAAAAAFWNoYWxsZW5nZXJfcGF5b3V0X2JwcwAAAAAAAAQAAAAAAAAADWhhbmRpY2FwX2xpbmUAAAAAAAAQAAAAAAAAAA9pbnZpdGVfa2V5X2hhc2gAAAAD6AAAA+4AAAAgAAAAAAAAAAppc19wcml2YXRlAAAAAAABAAAAAAAAAAttYXJrZXRfdHlwZQAAAAAQAAAAAAAAAA9tYXhfY2hhbGxlbmdlcnMAAAAABAAAAAAAAAAJb2Rkc19tb2RlAAAAAAAAEAAAAAAAAAAPc2V0dGxlbWVudF9ydWxlAAAAABA=",
        "AAAAAQAAAAAAAAAAAAAADVBlbmRpbmdPcmFjbGUAAAAAAAACAAAAAAAAAA1leGVjdXRhYmxlX2F0AAAAAAAABgAAAAAAAAAEbmV4dAAAABM=",
        "AAAAAQAAAAAAAAAAAAAADVBsYXRmb3JtU3RhdHMAAAAAAAAFAAAAAAAAAAdiYWxhbmNlAAAAAAsAAAAAAAAADGZlZXNfYWNjcnVlZAAAAAsAAAAAAAAADGZlZXNfY2xhaW1lZAAAAAsAAAAAAAAACHJlc29sdmVkAAAABgAAAAAAAAAMdG90YWxfY2xhaW1zAAAABg==",
        "AAAAAwAAAH1PdXRjb21lIG9mIHZhbGlkYXRpbmcgYSByZW1hdGNoIGNoaWxkJ3MgbGluayB0byBpdHMgcGFyZW50IGNsYWltLCBjYWNoZWQKdW5kZXIgYERhdGFLZXk6OlJlbWF0Y2hQYXJlbnQocGFyZW50X2lkLCBjaGlsZF9pZClgLgAAAAAAAAAAAAANUmVtYXRjaFN0YXR1cwAAAAAAAAQAAABKVGhlIHBhcmVudCBleGlzdHMsIHdhcyBpbiBhIHJlbWF0Y2hhYmxlIHN0YXRlIGFuZCBpcyBsaW5rZWQgdG8gdGhpcyBjaGlsZC4AAAAAAAZMaW5rZWQAAAAAAAAAAABKVGhlIHJlZmVyZW5jZWQgcGFyZW50IGNsYWltIGRvZXMgbm90IGV4aXN0IChgRXJyb3I6OlBhcmVudENsYWltTm90Rm91bmRgKS4AAAAAAA5QYXJlbnROb3RGb3VuZAAAAAAAAQAAAFZUaGUgcGFyZW50IGlzIG5vdCBpbiBhIHN0YXRlIHRoYXQgYWxsb3dzIGEgcmVtYXRjaCAoYEVycm9yOjpQYXJlbnRDbGFpbUludmFsaWRTdGF0ZWApLgAAAAAAElBhcmVudEludmFsaWRTdGF0ZQAAAAAAAgAAAE5UaGUgcGFyZW50IGFscmVhZHkgaGFzIGEgcmVtYXRjaCBjaGlsZCAoYEVycm9yOjpQYXJlbnRDbGFpbUFscmVhZHlSZW1hdGNoZWRgKS4AAAAAABZQYXJlbnRBbHJlYWR5UmVtYXRjaGVkAAAAAAAD",
        "AAAAAQAAAO1BIHBhZ2luYXRlZCB3aW5kb3cgaW50byBhIGNsYWltJ3MgY2hhbGxlbmdlciByb3N0ZXIuCgpgaXRlbXNgIGhvbGRzIHVwIHRvIGBsaW1pdGAgZW50cmllcyBzdGFydGluZyBhdCBgb2Zmc2V0YC4KYHRvdGFsYCBpcyB0aGUgdG90YWwgcm9zdGVyIGxlbmd0aCBzbyBjYWxsZXJzIGNhbiB0ZWxsIHdoZW4gdGhleSBoYXZlIHJlYWQKdGhlIGxhc3QgcGFnZSB3aXRob3V0IGZldGNoaW5nIGFuIGV4dHJhIGVtcHR5IG9uZS4AAAAAAAAAAAAADkNoYWxsZW5nZXJQYWdlAAAAAAADAAAAJ1RoZSBzbGljZSBvZiBjaGFsbGVuZ2VycyBmb3IgdGhpcyBwYWdlLgAAAAAFaXRlbXMAAAAAAAPqAAAH0AAAAApDaGFsbGVuZ2VyAAAAAABxUm9zdGVyIHBvc2l0aW9uIG9mIHRoZSBmaXJzdCBpdGVtIHJldHVybmVkIChtaXJyb3JzIHRoZSBjYWxsZXIncwpgb2Zmc2V0YCBhcmd1bWVudCBmb3Igc2FmZSBjdXJzb3IgYm9vay1rZWVwaW5nKS4AAAAAAAAGb2Zmc2V0AAAAAAAEAAAAP1RvdGFsIG51bWJlciBvZiBjaGFsbGVuZ2VycyBpbiB0aGlzIGNsYWltIChub3QganVzdCB0aGlzIHBhZ2UpLgAAAAAFdG90YWwAAAAAAAAE",
        "AAAAAQAAAAAAAAAAAAAAEFBlbmRpbmdGZWVQb2xpY3kAAAAEAAAAAAAAABNhZ2VudF9vd25lcl9mZWVfYnBzAAAAAAQAAAAAAAAADWV4ZWN1dGFibGVfYXQAAAAAAAAGAAAAAAAAABBwbGF0Zm9ybV9mZWVfYnBzAAAABAAAAAAAAAAScGxhdGZvcm1fcmVjaXBpZW50AAAAAAPoAAAAEw==",
        "AAAAAQAAAExWZXJzaW9uZWQgcHJldmlldyBlbnZlbG9wZS4gVGhlIGxlZ2FjeSBQYXlvdXRRdW90ZSBlbmNvZGluZyBzdGF5cyB1bmNoYW5nZWQuAAAAAAAAABRWZXJzaW9uZWRQYXlvdXRRdW90ZQAAAAIAAAAAAAAABXF1b3RlAAAAAAAH0AAAAAtQYXlvdXRRdW90ZQAAAAAAAAAAF3JvdW5kaW5nX3BvbGljeV92ZXJzaW9uAAAAAAQ=",
        "AAAABQAAAAAAAAAAAAAACkZlZUFjY3J1ZWQAAAAAAAEAAAALZmVlX2FjY3J1ZWQAAAAABAAAAAAAAAACaWQAAAAAAAYAAAABAAAAAAAAAAlyZWNpcGllbnQAAAAAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAAAAAASaXNfYWdlbnRfb3duZXJfZmVlAAAAAAABAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAACkZlZUNsYWltZWQAAAAAAAEAAAALZmVlX2NsYWltZWQAAAAAAgAAAAAAAAAJcmVjaXBpZW50AAAAAAAAEwAAAAEAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAACldpdGhkcmF3YWwAAAAAAAEAAAAKd2l0aGRyYXdhbAAAAAAAAgAAAAAAAAACdG8AAAAAABMAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADENsYWltQ3JlYXRlZAAAAAEAAAANY2xhaW1fY3JlYXRlZAAAAAAAAAMAAAAAAAAAAmlkAAAAAAAGAAAAAQAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAQAAAAAAAAAIY2F0ZWdvcnkAAAAQAAAAAAAAAAI=",
        "AAAABQAAAHhFbWl0dGVkIHdoZW4gaW5pdGlhbCBlc2Nyb3cgaXMgZXN0YWJsaXNoZWQgZm9yIGEgY2xhaW0uClJlY29yZHMgdGhlIGluaXRpYWwgZnVuZGluZyBzdGF0ZSBmb3IgYWNjb3VudGluZyByZWNvbmNpbGlhdGlvbi4AAAAAAAAADEVzY3Jvd1NlZWRlZAAAAAEAAAANZXNjcm93X3NlZWRlZAAAAAAAAAQAAAAAAAAAAmlkAAAAAAAGAAAAAQAAAAAAAAAGZnVuZGVyAAAAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAAAAAALZXNjcm93X3R5cGUAAAAAEAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADE9yYWNsZVF1ZXVlZAAAAAEAAAANb3JhY2xlX3F1ZXVlZAAAAAAAAAIAAAAAAAAABG5leHQAAAATAAAAAQAAAAAAAAANZXhlY3V0YWJsZV9hdAAAAAAAAAYAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADUNsYWltUmVzb2x2ZWQAAAAAAAABAAAADmNsYWltX3Jlc29sdmVkAAAAAAAFAAAAAAAAAAJpZAAAAAAABgAAAAEAAAAAAAAAC3dpbm5lcl9zaWRlAAAAB9AAAAAKV2lubmVyU2lkZQAAAAAAAAAAAAAAAAAHc3VtbWFyeQAAAAAQAAAAAAAAAAAAAAAKY29uZmlkZW5jZQAAAAAABAAAAAAAAAAAAAAADWV2aWRlbmNlX2hhc2gAAAAAAAPuAAAAIAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADU1hcmtldFNldHRsZWQAAAAAAAABAAAADm1hcmtldF9zZXR0bGVkAAAAAAAFAAAAAAAAAAJpZAAAAAAABgAAAAEAAAAAAAAACnRvdGFsX3BhaWQAAAAAAAsAAAAAAAAAAAAAAAp0b3RhbF9mZWVzAAAAAAALAAAAAAAAAEJFc2Nyb3cgbGVmdCBmb3IgY2hhbGxlbmdlcnMgdG8gcHVsbCB2aWEgYGNsYWltX2NoYWxsZW5nZXJfcGF5b3V0YC4AAAAAABNvd2VkX3RvX2NoYWxsZW5nZXJzAAAAAAsAAAAAAAAAAAAAAARkdXN0AAAACwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADU9yYWNsZUNoYW5nZWQAAAAAAAABAAAADm9yYWNsZV9jaGFuZ2VkAAAAAAACAAAAAAAAAARuZXh0AAAAEwAAAAEAAAAAAAAACHByZXZpb3VzAAAD6AAAABMAAAAAAAAAAg==",
        "AAAABQAAANJPbmUgY2hhbGxlbmdlcidzIHNldHRsZW1lbnQuIFRvZ2V0aGVyIHdpdGggYENsYWltQ2hhbGxlbmdlZGAgYW5kCmBDbGFpbVJlc29sdmVkYCB0aGlzIGdpdmVzIGFuIG9mZi1jaGFpbiBpbmRleGVyIGV2ZXJ5dGhpbmcgaXQgbmVlZHMgdG8gZGVyaXZlCnBlci1hZGRyZXNzIHdpbi9sb3NzIHJlY29yZHMsIHdoaWNoIGFyZSBubyBsb25nZXIgdHJhY2tlZCBvbiBjaGFpbi4AAAAAAAAAAAAOQ2hhbGxlbmdlclBhaWQAAAAAAAEAAAAPY2hhbGxlbmdlcl9wYWlkAAAAAAYAAAAAAAAAAmlkAAAAAAAGAAAAAQAAAAAAAAAKY2hhbGxlbmdlcgAAAAAAEwAAAAEAAAAAAAAABXN0YWtlAAAAAAAACwAAAAAAAAAAAAAABWdyb3NzAAAAAAAACwAAAAAAAAAAAAAAA2ZlZQAAAAALAAAAAAAAAAAAAAADbmV0AAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAR1UaGUgY3JlYXRvcidzIHJlZnVuZCBvZiBhbiB1bmNoYWxsZW5nZWQgY2xhaW0uIGByZWZ1bmRgIGxldHMgYW4gaW5kZXhlcgpyZWNvbmNpbGUgdGhlIHJlZnVuZCBhZ2FpbnN0IGBjcmVhdG9yX3N0YWtlYCBhbmQgZXNjcm93IHdpdGhvdXQgYSBzZWNvbmQKcmVhZDsgYHBhcmtlZGAgZGlzdGluZ3Vpc2hlcyBhIGRlbGl2ZXJlZCByZWZ1bmQgZnJvbSBvbmUgcGFya2VkIGFzIGEKd2l0aGRyYXdhYmxlIGJhbGFuY2Ugd2hlbiB0aGUgY3JlYXRvcidzIHRydXN0bGluZSByZWZ1c2VkIHRoZSB0cmFuc2Zlci4AAAAAAAAAAAAADkNsYWltQ2FuY2VsbGVkAAAAAAABAAAAD2NsYWltX2NhbmNlbGxlZAAAAAADAAAAAAAAAAJpZAAAAAAABgAAAAEAAAAAAAAABnJlZnVuZAAAAAAACwAAAAAAAAAAAAAABnBhcmtlZAAAAAAAAQAAAAAAAAAC",
        "AAAABQAAARZUaGUgdmVyc2lvbmVkIHZlcmRpY3Qgd3JpdHRlbiBhdCByZXNvbHV0aW9uLCBlbWl0dGVkIGFsb25nc2lkZQpgQ2xhaW1SZXNvbHZlZGAuCgpgQ2xhaW1SZXNvbHZlZGAga2VlcHMgaXRzIGV4aXN0aW5nIHNoYXBlIGZvciBjb21wYXRpYmxlIGluZGV4ZXJzOyB0aGlzIGV2ZW50CmNhcnJpZXMgdGhlIGV4cGxpY2l0IGVuY29kaW5nIHZlcnNpb24gc28gY29uc3VtZXJzIGNhbiBwaW4gdGhlIHZlcmRpY3QKZW5jb2Rpbmcgd2l0aG91dCBhIHNlY29uZCByZWFkIG9yIGEgc2NoZW1hIGd1ZXNzLgAAAAAAAAAAAA5WZXJkaWN0RW5jb2RlZAAAAAAAAQAAAA92ZXJkaWN0X2VuY29kZWQAAAAAAwAAAAAAAAACaWQAAAAAAAYAAAABAAAAAAAAAAd2ZXJzaW9uAAAAAAQAAAAAAAAAAAAAAAt3aW5uZXJfc2lkZQAAAAfQAAAACldpbm5lclNpZGUAAAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAD0FnZW50QXR0cmlidXRlZAAAAAABAAAAEGFnZW50X2F0dHJpYnV0ZWQAAAACAAAAAAAAAAJpZAAAAAAABgAAAAEAAAAAAAAAFWFnZW50X293bmVyX3JlY2lwaWVudAAAAAAAABMAAAABAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAD0NsYWltQ2hhbGxlbmdlZAAAAAABAAAAEGNsYWltX2NoYWxsZW5nZWQAAAADAAAAAAAAAAJpZAAAAAAABgAAAAEAAAAAAAAACmNoYWxsZW5nZXIAAAAAABMAAAABAAAAAAAAAAVzdGFrZQAAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAKVFbWl0dGVkIHdoZW4gYSBjbGFpbSdzIGRlYWRsaW5lIGlzIHJlYWNoZWQgYW5kIGl0IHRyYW5zaXRpb25zIHRvIHNldHRsZW1lbnQtZWxpZ2libGUuClVzZWZ1bCBmb3IgaW5kZXhlcnMgYW5kIHdvcmtlcnMgdG8gaWRlbnRpZnkgY2xhaW1zIHJlYWR5IGZvciBvcmFjbGUgcmVzb2x1dGlvbi4AAAAAAAAAAAAAD0RlYWRsaW5lUmVhY2hlZAAAAAABAAAAEGRlYWRsaW5lX3JlYWNoZWQAAAAEAAAAAAAAAAJpZAAAAAAABgAAAAEAAAAAAAAACGRlYWRsaW5lAAAABgAAAAAAAAAAAAAAEGNoYWxsZW5nZXJfY291bnQAAAAEAAAAAAAAAAAAAAAMdG90YWxfc3Rha2VkAAAACwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAD0ZlZVBvbGljeVF1ZXVlZAAAAAABAAAAEWZlZV9wb2xpY3lfcXVldWVkAAAAAAAABAAAAAAAAAAQcGxhdGZvcm1fZmVlX2JwcwAAAAQAAAAAAAAAAAAAABNhZ2VudF9vd25lcl9mZWVfYnBzAAAAAAQAAAAAAAAAAAAAABJwbGF0Zm9ybV9yZWNpcGllbnQAAAAAA+gAAAATAAAAAAAAAAAAAAANZXhlY3V0YWJsZV9hdAAAAAAAAAYAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAD09yYWNsZUNhbmNlbGxlZAAAAAABAAAAEG9yYWNsZV9jYW5jZWxsZWQAAAABAAAAAAAAAAljYW5jZWxsZWQAAAAAAAABAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAEEZlZVBvbGljeVVwZGF0ZWQAAAABAAAAEmZlZV9wb2xpY3lfdXBkYXRlZAAAAAAAAwAAAAAAAAAQcGxhdGZvcm1fZmVlX2JwcwAAAAQAAAAAAAAAAAAAABNhZ2VudF9vd25lcl9mZWVfYnBzAAAAAAQAAAAAAAAAAAAAABJwbGF0Zm9ybV9yZWNpcGllbnQAAAAAA+gAAAATAAAAAAAAAAI=",
        "AAAABQAAAHpFbWl0dGVkIG9uIGZpeGVkLW9kZHMgbGlxdWlkaXR5IHN0YXRlIGNoYW5nZXMgYmV5b25kIHJlc2VydmF0aW9ucy4KVHJhY2tzIGF2YWlsYWJsZSBjcmVhdG9yIGxpcXVpZGl0eSBmb3IgcmlzayBtYW5hZ2VtZW50LgAAAAAAAAAAABBMaXF1aWRpdHlVcGRhdGVkAAAAAQAAABFsaXF1aWRpdHlfdXBkYXRlZAAAAAAAAAQAAAAAAAAAAmlkAAAAAAAGAAAAAQAAAAAAAAAScmVzZXJ2ZWRfbGlhYmlsaXR5AAAAAAALAAAAAAAAAAAAAAATYXZhaWxhYmxlX2xpcXVpZGl0eQAAAAALAAAAAAAAAAAAAAATdG90YWxfY3JlYXRvcl9zdGFrZQAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAEVdpdGhkcmF3YWxQZW5kaW5nAAAAAAAAAQAAABJ3aXRoZHJhd2FsX3BlbmRpbmcAAAAAAAIAAAAAAAAAAnRvAAAAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAEkZlZVBvbGljeUNhbmNlbGxlZAAAAAAAAQAAABRmZWVfcG9saWN5X2NhbmNlbGxlZAAAAAEAAAAAAAAACWNhbmNlbGxlZAAAAAAAAAEAAAAAAAAAAg==",
        "AAAABQAAARJEZWZlbnNpdmUgaGFsdDogdGhlIGNsYWltJ3MgYWNjb3VudGluZyBzaG93cyBjb3VudGVycGFydHkgZnVuZHMgb3IgYQpyZXNlcnZlZCBjcmVhdG9yIGxpYWJpbGl0eSB3aGlsZSBpdHMgbGlmZWN5Y2xlIHN0YXRlIGNsYWltcyB0byBiZSBgT3BlbmAuClRoZSBjYW5jZWxsYXRpb24gd2FzIHJlZnVzZWQgYW5kIE5PVEhJTkcgY2hhbmdlZCDigJQgdGhpcyBldmVudCBpcyB0aGUKb24tY2hhaW4gcmVjb3JkIGZvciBrZWVwZXJzLCBpbmRleGVycyBhbmQgaW5jaWRlbnQgcmVzcG9uc2UuAAAAAAAAAAAAE0NhbmNlbGxhdGlvblJlZnVzZWQAAAAAAQAAABRjYW5jZWxsYXRpb25fcmVmdXNlZAAAAAUAAAAAAAAAAmlkAAAAAAAGAAAAAQAAAAAAAAAQY2hhbGxlbmdlcl9jb3VudAAAAAQAAAAAAAAAAAAAABZ0b3RhbF9jaGFsbGVuZ2VyX3N0YWtlAAAAAAALAAAAAAAAAAAAAAAacmVzZXJ2ZWRfY3JlYXRvcl9saWFiaWxpdHkAAAAAAAsAAAAAAAAAAAAAAAZyZWFzb24AAAAAAAQAAAAAAAAAAg==",
        "AAAABQAAAKtGcm96ZW4gZmVlIHRlcm1zIHdyaXR0ZW4gb250byBhIGNsYWltIGF0IGNyZWF0aW9uLiBJbmRleGVycyBjYW4gdHJlYXQgdGhpcyBhcwp0aGUgYXV0aG9yaXRhdGl2ZSBlY29ub21pY3MgZm9yIHRoZSBtYXJrZXQ7IGEgbGF0ZXIgYEZlZVBvbGljeVVwZGF0ZWRgIG11c3QKbm90IHJld3JpdGUgdGhlbS4AAAAAAAAAABRGZWVQb2xpY3lTbmFwc2hvdHRlZAAAAAEAAAAWZmVlX3BvbGljeV9zbmFwc2hvdHRlZAAAAAAABQAAAAAAAAACaWQAAAAAAAYAAAABAAAAAAAAABBwbGF0Zm9ybV9mZWVfYnBzAAAABAAAAAAAAAAAAAAAE2FnZW50X293bmVyX2ZlZV9icHMAAAAABAAAAAAAAAAAAAAAEnBsYXRmb3JtX3JlY2lwaWVudAAAAAAD6AAAABMAAAAAAAAAAAAAABVhZ2VudF9vd25lcl9yZWNpcGllbnQAAAAAAAPoAAAAEwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAFE93bmVyc2hpcFRyYW5zZmVycmVkAAAAAQAAABVvd25lcnNoaXBfdHJhbnNmZXJyZWQAAAAAAAACAAAAAAAAAARuZXh0AAAAEwAAAAEAAAAAAAAACHByZXZpb3VzAAAD6AAAABMAAAAAAAAAAg==",
        "AAAABQAAAH1MaWZlY3ljbGUgc3RhdGUgdHJhbnNpdGlvbiBldmVudCBmb3IgYXVkaXRpbmcgYW5kIG1vbml0b3JpbmcuCkVtaXR0ZWQgb24gZXZlcnkgc3RhdGUgY2hhbmdlIHdpdGggdGhlIHByZXZpb3VzIGFuZCBuZXcgc3RhdGVzLgAAAAAAAAAAAAAWQ2xhaW1TdGF0ZVRyYW5zaXRpb25lZAAAAAAAAQAAABhjbGFpbV9zdGF0ZV90cmFuc2l0aW9uZWQAAAAEAAAAAAAAAAJpZAAAAAAABgAAAAEAAAAAAAAACmZyb21fc3RhdGUAAAAAAAQAAAAAAAAAAAAAAAh0b19zdGF0ZQAAAAQAAAAAAAAAAAAAAAl0aW1lc3RhbXAAAAAAAAAGAAAAAAAAAAI=",
        "AAAABQAAARhBIGZpeGVkLW9kZHMgY2hhbGxlbmdlIGNvbnN1bWVkIHBhcnQgb2YgdGhlIGNyZWF0b3IncyBsaXF1aWRpdHkgZ3VhcmFudGVlLgpgcmVzZXJ2ZWRfY3JlYXRvcl9saWFiaWxpdHlgIGFuZCBgYXZhaWxhYmxlX2NyZWF0b3JfbGlxdWlkaXR5YCBhcmUgc25hcHNob3RzCmFmdGVyIHRoaXMgY2hhbGxlbmdlLCBzbyBhbiBpbmRleGVyIGNhbiBhdWRpdCB0aGUgbGltaXQgd2l0aG91dCByZXBsYXlpbmcKdGhlIHJvc3RlciBvciB0cnVzdGluZyBhIHN0YWxlIHJlYWQtaW5kZXggY2FsY3VsYXRpb24uAAAAAAAAABpGaXhlZE9kZHNMaXF1aWRpdHlSZXNlcnZlZAAAAAAAAQAAAB1maXhlZF9vZGRzX2xpcXVpZGl0eV9yZXNlcnZlZAAAAAAAAAcAAAAAAAAAAmlkAAAAAAAGAAAAAQAAAAAAAAAKY2hhbGxlbmdlcgAAAAAAEwAAAAEAAAAAAAAABXN0YWtlAAAAAAAACwAAAAAAAAAAAAAABWdyb3NzAAAAAAAACwAAAAAAAAAAAAAABnByb2ZpdAAAAAAACwAAAAAAAAAAAAAAGnJlc2VydmVkX2NyZWF0b3JfbGlhYmlsaXR5AAAAAAALAAAAAAAAAAAAAAAbYXZhaWxhYmxlX2NyZWF0b3JfbGlxdWlkaXR5AAAAAAsAAAAAAAAAAg==",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAAFAAAAAAAAAAeT25lLXRpbWUgaW5pdGlhbGlzYXRpb24gZ3VhcmQuAAAAAAAESW5pdAAAAAAAAACzR2xvYmFsIHBhdXNlIGZsYWcuIFdoZW4gc2V0LCBzdGF0ZS1jaGFuZ2luZyBtYXJrZXQgb3BlcmF0aW9ucyBhcmUKaGFsdGVkLCBidXQgd2l0aGRyYXdhbHMgYW5kIGZlZSBwdWxscyBNVVNUIHJlbWFpbiBhdmFpbGFibGUgc28gdXNlcgpmdW5kcyBhcmUgbmV2ZXIgdHJhcHBlZCBieSBhbiBvcGVyYXRvciBwYXVzZS4AAAAABlBhdXNlZAAAAAAAAAAAAAAAAAAFT3duZXIAAAAAAAAAAAAAAAAAAAZPcmFjbGUAAAAAAAAAAAAAAAAABFVzZGMAAAAAAAAAAAAAAAZQb2xpY3kAAAAAAAAAAAAAAAAAB1BlbmRpbmcAAAAAAAAAADpRdWV1ZWQgb3JhY2xlIHJvdGF0aW9uIChzZXBhcmF0ZSBmcm9tIGZlZS1wb2xpY3kgUGVuZGluZykuAAAAAAANUGVuZGluZ09yYWNsZQAAAAAAAAAAAAAAAAAACkNsYWltQ291bnQAAAAAAAAAAAAAAAAADVRvdGFsUmVzb2x2ZWQAAAAAAAAAAAAAAAAAAAtGZWVzQWNjcnVlZAAAAAAAAAAAAAAAAAtGZWVzQ2xhaW1lZAAAAAABAAAAAAAAAAVDbGFpbQAAAAAAAAEAAAAGAAAAAQAAAAAAAAALQ2hhbGxlbmdlcnMAAAAAAQAAAAYAAAABAAAAllZlcnNpb25lZCB2ZXJkaWN0IHdyaXR0ZW4gYXQgcmVzb2x1dGlvbi4gQWJzZW50IG9uIGNsYWltcyByZXNvbHZlZApiZWZvcmUgdmVyZGljdHMgd2VyZSB2ZXJzaW9uZWQ7IHJlYWRlcnMgZmFsbCBiYWNrIHRvIGBDbGFpbS53aW5uZXJfc2lkZWAKZm9yIHRob3NlLgAAAAAAB1ZlcmRpY3QAAAAAAQAAAAYAAAABAAAAL1B1bGwtcGF5bWVudCBmYWxsYmFjayBmb3IgZmFpbGVkIHBheW91dCBwdXNoZXMuAAAAAAxXaXRoZHJhd2FibGUAAAABAAAAEwAAAAEAAAA1QWNjcnVlZCwgdW5jbGFpbWVkIGZlZXMuIEFsd2F5cyBwdWxsZWQsIG5ldmVyIHB1c2hlZC4AAAAAAAAHQWNjcnVlZAAAAAABAAAAEwAAAAEAAABMUmVtYXRjaCBwYXJlbnQgbGluayB2YWxpZGF0aW9uIGNhY2hlOiAocGFyZW50X2lkLCBjaGlsZF9pZCkgLT4gUmVtYXRjaFN0YXR1cwAAAA1SZW1hdGNoUGFyZW50AAAAAAAAAgAAAAYAAAAGAAAAAQAAAE1QZXItY3JlYXRvciBjbGFpbSBpbmRleCBwYWdlOiAoY3JlYXRvciwgcGFnZV9pbmRleCkgLT4gVmVjPHU2ND4gb2YgY2xhaW0gaWRzLgAAAAAAAA1DcmVhdG9yQ2xhaW1zAAAAAAAAAgAAABMAAAAEAAAAAQAAAD5QZXItY3JlYXRvciB0b3RhbCBjbGFpbSBjb3VudCwgdXNlZCB0byBkZXJpdmUgdGhlIHBhZ2UgbGF5b3V0LgAAAAAAEUNyZWF0b3JDbGFpbUNvdW50AAAAAAAAAQAAABM=",
        "AAAAAAAAAAAAAAAIZ2V0X3VzZGMAAAAAAAAAAQAAA+kAAAATAAAAAw==",
        "AAAAAAAAAfNTb2xpZGl0eSB1c2VkIGBtc2cuc2VuZGVyYDsgU29yb2JhbiBoYXMgbm8gZXF1aXZhbGVudCBmb3IgYSB0b3AtbGV2ZWwKY2FsbCwgc28gdGhlIGJlbmVmaWNpYXJ5IGlzIGFuIGV4cGxpY2l0IGFyZ3VtZW50IHRoYXQgbXVzdCBhdXRob3JpemUuCgpXaXRoZHJhd2FscyBhcmUgaW50ZW50aW9uYWxseSBOT1QgZ2F0ZWQgYnkgdGhlIHBhdXNlIGZsYWc6IHBhdXNlCmNvbnRyb2xzIG1heSBoYWx0IG5ldyBjbGFpbXMsIGNoYWxsZW5nZXMsIGFuZCByZXNvbHV0aW9ucywgYnV0IG11c3QKbmV2ZXIgYmxvY2sgYSBmdW5kZWQgdXNlciBmcm9tIHB1bGxpbmcgdGhlaXIgb3duIGJhbGFuY2UuIFRoaXMga2VlcHMKY29udHJhY3QtZmlyc3QgYWNjb3VudGluZyBpbnRhY3Qg4oCUIGEgcGF1c2VkIG1hcmtldCBzdGlsbCBvd2VzIGl0cwp1c2VycyB0aGVpciBlc2Nyb3dlZCBmdW5kcywgYW5kIHRoZSBvbmx5IHNhZmUgd2F5IHRvIGhvbm9yIHRoYXQgaXMgdG8KbGV0IHRoZW0gd2l0aGRyYXcuAAAAAAh3aXRoZHJhdwAAAAEAAAAAAAAAA3dobwAAAAATAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAAAAAAAJZ2V0X2NsYWltAAAAAAAAAQAAAAAAAAAIY2xhaW1faWQAAAAGAAAAAQAAA+kAAAfQAAAABUNsYWltAAAAAAAAAw==",
        "AAAAAAAAAAAAAAAJZ2V0X293bmVyAAAAAAAAAAAAAAEAAAPpAAAAEwAAAAM=",
        "AAAAAAAAALhXaGV0aGVyIHRoZSBjb250cmFjdCBpcyBjdXJyZW50bHkgcGF1c2VkLiBQYXVzZSBoYWx0cyBuZXcgY2xhaW1zLApjaGFsbGVuZ2VzLCBhbmQgcmVzb2x1dGlvbnMsIGJ1dCBuZXZlciBibG9ja3MgYHdpdGhkcmF3YCBvcgpgY2xhaW1fZmVlc2Ag4oCUIHNlZSB0aG9zZSBlbnRyeSBwb2ludHMgZm9yIHRoZSBpbnZhcmlhbnQuAAAACWlzX3BhdXNlZAAAAAAAAAAAAAABAAAAAQ==",
        "AAAAAAAAAAAAAAAKY2xhaW1fZmVlcwAAAAAAAQAAAAAAAAADd2hvAAAAABMAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAAKZ2V0X29yYWNsZQAAAAAAAAAAAAEAAAPpAAAAEwAAAAM=",
        "AAAAAAAAACZDb25zdHJ1Y3RvciBlcXVpdmFsZW50LCBjYWxsYWJsZSBvbmNlLgAAAAAACmluaXRpYWxpemUAAAAAAAYAAAAAAAAABW93bmVyAAAAAAAAEwAAAAAAAAAGb3JhY2xlAAAAAAATAAAAAAAAAAp1c2RjX3Rva2VuAAAAAAATAAAAAAAAABBwbGF0Zm9ybV9mZWVfYnBzAAAABAAAAAAAAAATYWdlbnRfb3duZXJfZmVlX2JwcwAAAAAEAAAAAAAAABJwbGF0Zm9ybV9yZWNpcGllbnQAAAAAA+gAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAQNUaGUgY2xhaW0ncyB2ZXJkaWN0IHdpdGggaXRzIGV4cGxpY2l0IGVuY29kaW5nIHZlcnNpb24uCgpSZWZ1c2VzIHdpdGggYEVycm9yOjpVbnN1cHBvcnRlZFZlcmRpY3RWZXJzaW9uYCBpZiB0aGUgc3RvcmVkIHZlcmRpY3Qgd2FzCndyaXR0ZW4gYnkgYW4gZW5jb2RpbmcgdGhpcyBjb250cmFjdCBkb2VzIG5vdCB1bmRlcnN0YW5kLCBhbmQgd2l0aApgRXJyb3I6OkNsYWltTm90UmVzb2x2ZWRgIGlmIHRoZSBjbGFpbSBoYXMgbm90IGJlZW4gcmVzb2x2ZWQuAAAAAAtnZXRfdmVyZGljdAAAAAABAAAAAAAAAAhjbGFpbV9pZAAAAAYAAAABAAAD6QAAB9AAAAAHVmVyZGljdAAAAAAD",
        "AAAAAAAAAAAAAAAMY2FuY2VsX2NsYWltAAAAAQAAAAAAAAAIY2xhaW1faWQAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAMY3JlYXRlX2NsYWltAAAAAgAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAAZwYXJhbXMAAAAAB9AAAAAMQ3JlYXRlUGFyYW1zAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAAAAAAAMcXVldWVfb3JhY2xlAAAAAQAAAAAAAAAKbmV3X29yYWNsZQAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAANY2FuY2VsX29yYWNsZQAAAAAAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAANcmVzb2x2ZV9jbGFpbQAAAAAAAAUAAAAAAAAACGNsYWltX2lkAAAABgAAAAAAAAALd2lubmVyX3NpZGUAAAAH0AAAAApXaW5uZXJTaWRlAAAAAAAAAAAAB3N1bW1hcnkAAAAAEAAAAAAAAAAKY29uZmlkZW5jZQAAAAAABAAAAAAAAAANZXZpZGVuY2VfaGFzaAAAAAAAA+4AAAAgAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAC1QZXJtaXNzaW9ubGVzcyBvbmNlIHRoZSB0aW1lbG9jayBoYXMgZWxhcHNlZC4AAAAAAAAOZXhlY3V0ZV9vcmFjbGUAAAAAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAOZ2V0X2NsYWltX2ZlZXMAAAAAAAEAAAAAAAAACGNsYWltX2lkAAAABgAAAAEAAAPpAAAH0AAAAAxDbGFpbUZlZVZpZXcAAAAD",
        "AAAAAAAAAAAAAAAOZ2V0X2ZlZV9wb2xpY3kAAAAAAAAAAAABAAAD6QAAB9AAAAAJRmVlUG9saWN5AAAAAAAAAw==",
        "AAAAAAAAAAAAAAAPY2hhbGxlbmdlX2NsYWltAAAAAAQAAAAAAAAACmNoYWxsZW5nZXIAAAAAABMAAAAAAAAACGNsYWltX2lkAAAABgAAAAAAAAAMc3Rha2VfYW1vdW50AAAACwAAAAAAAAAKaW52aXRlX2tleQAAAAAD6AAAABAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAQZ2V0X2FjY3J1ZWRfZmVlcwAAAAEAAAAAAAAAA3dobwAAAAATAAAAAQAAAAs=",
        "AAAAAAAABABCYXRjaC1yZWFkIHVwIHRvIFtgTUFYX0JBVENIX1NJWkVgXSBjbGFpbXMgaW4gb25lIHNpbXVsYXRlZCBjYWxsLgoKUmV0dXJucyBhIGBWZWM8T3B0aW9uPENsYWltPj5gIHdob3NlIGxlbmd0aCBlcXVhbHMgYGlkcy5sZW4oKWAuIEVhY2ggc2xvdApob2xkcyBgU29tZShjbGFpbSlgIHdoZW4gdGhlIGlkIGV4aXN0cywgb3IgYE5vbmVgIHdoZW4gaXQgZG9lcyBub3QuIFRoZQpzbG90IHBvc2l0aW9ucyBtaXJyb3IgdGhlIGlucHV0IHBvc2l0aW9ucyBleGFjdGx5LCBzbyBjYWxsZXJzIGNhbiB6aXAgdGhlCnJlc3VsdCBhZ2FpbnN0IHRoZWlyIGlkIGxpc3Qgd2l0aG91dCBhbnkgYm9va2tlZXBpbmc6CgpgYGB0ZXh0CmlkcyAgICA9IFsxLCA5OTksIDNdCnJlc3VsdCA9IFtTb21lKGNsYWltXzEpLCBOb25lLCBTb21lKGNsYWltXzMpXQpgYGAKCiMgQmVoYXZpb3IgZ3VhcmFudGVlcwoKLSAqKlB1cmUgcmVhZC4qKiBObyBtb25leSwgbm8gYXV0aCwgbm8gc3RhdGUgbXV0YXRpb24uIFNhZmUgdG8gY2FsbCBmcm9tCmFueSBjb250ZXh0LCBpbmNsdWRpbmcgdW5zaWduZWQgc2ltdWxhdGlvbi4KLSAqKlBvc2l0aW9uLXN0YWJsZS4qKiBUaGUgb3V0cHV0IGxlbmd0aCBhbHdheXMgZXF1YWxzIHRoZSBpbnB1dCBsZW5ndGguCi0gKipOb24tcGFuaWNraW5nLioqIEFuIHVua25vd24gaWQgeWllbGRzIGBOb25lYDsgaXQgZG9lcyBub3QgYWJvcnQgdGhlCmNhbGwgb3IgcmV0dXJuIGFuIGVycm9yIGZvciB0aGF0IHNsb3QuCi0gKipEdXBsaWNhdGUgaWRzLioqIEVhY2ggb2NjdXJyZW5jZSBpcyByZXNvbHZlZCBpbmRlcGVuZGVudGx5LiBUd28gc2xvdHMKZm9yIHRoZSBzYW1lIGlkIHJldHVybiB0aGUgc2FtZSBgQ2xhaW1gIHZhbHVlLCBib3RoIGBTb21lKOKApilgLiBUaGlzIGlzCmludGVudGlvbmFsOiB0aGUgZnVuY3Rpb24gaXMgaWRlbXBvdGVudCBhbmQgdGhlIG9uLWNoYWluIHN0YXRlIGlzIHRoZQpzYW1lIGFuc3dlciBmb3IgYm90aCBwb3NpdGlvbnMuCi0gKipDaGFsbGVuZ2VyIHJvc3RlcnMgZXhjbHVkAAAAEGdldF9jbGFpbXNfYmF0Y2gAAAABAAAAAAAAAANpZHMAAAAD6gAAAAYAAAABAAAD6QAAA+oAAAPoAAAH0AAAAAVDbGFpbQAAAAAAAAM=",
        "AAAAAAAAADlDb252ZW5pZW5jZSB2aWV3IHJldHVybmluZyBvbmx5IHRoZSBkZWNvZGVkIHZlcmRpY3Qgc2lkZS4AAAAAAAAQZ2V0X3ZlcmRpY3Rfc2lkZQAAAAEAAAAAAAAACGNsYWltX2lkAAAABgAAAAEAAAPpAAAH0AAAAApXaW5uZXJTaWRlAAAAAAAD",
        "AAAAAAAAAAAAAAAQZ2V0X3dpdGhkcmF3YWJsZQAAAAEAAAAAAAAAA3dobwAAAAATAAAAAQAAAAs=",
        "AAAAAAAAAAAAAAAQcXVldWVfZmVlX3BvbGljeQAAAAMAAAAAAAAAEHBsYXRmb3JtX2ZlZV9icHMAAAAEAAAAAAAAABNhZ2VudF9vd25lcl9mZWVfYnBzAAAAAAQAAAAAAAAAEnBsYXRmb3JtX3JlY2lwaWVudAAAAAAD6AAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAARY2FuY2VsX2ZlZV9wb2xpY3kAAAAAAAAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAC1QZXJtaXNzaW9ubGVzcyBvbmNlIHRoZSB0aW1lbG9jayBoYXMgZWxhcHNlZC4AAAAAAAASZXhlY3V0ZV9mZWVfcG9saWN5AAAAAAAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAhFQYWdpbmF0ZWQgbGlzdCBvZiBjbGFpbSBpZHMgY3JlYXRlZCBieSBgY3JlYXRvcmAsIGluIGNyZWF0aW9uIG9yZGVyLgoKUmV0dXJucyB1cCB0byBgbGltaXRgIGlkcyBzdGFydGluZyBhdCBgb2Zmc2V0YCAoMC1iYXNlZCkgdG9nZXRoZXIgd2l0aAp0aGUgY3JlYXRvcidzIHRvdGFsIGNsYWltIGNvdW50LCBzbyBjYWxsZXJzIGNhbiBkZXRlY3QgdGhlIGxhc3QgcGFnZQp3aXRob3V0IGFuIGV4dHJhIGVtcHR5IGZldGNoLiBBbiBgb2Zmc2V0YCBiZXlvbmQgdGhlIGVuZCBvZiB0aGUgaW5kZXgKcmV0dXJucyBhbiBlbXB0eSBgVmVjYCB3aXRoIGB0b3RhbGAgc2V0IGNvcnJlY3RseS4KClRoZSBwZXItY3JlYXRvciBpbmRleCBpcyBhcHBlbmRlZCBpbiBgY3JlYXRlX2NsYWltYCBhbmQgc3RvcmVkIGFzCmJvdW5kZWQgcGFnZXMgb2YgaWRzLCBzbyB0aGlzIHJlYWQgY29zdHMgTyhsaW1pdCkgcmF0aGVyIHRoYW4KTyh0b3RhbCBjbGFpbXMpLiBUVEwgaXMgZXh0ZW5kZWQgb24gcmVhZCBsaWtlIG90aGVyIHBlcnNpc3RlbnQgdmlld3MuAAAAAAAAEmdldF9jcmVhdG9yX2NsYWltcwAAAAAAAwAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAAZvZmZzZXQAAAAAAAQAAAAAAAAABWxpbWl0AAAAAAAABAAAAAEAAAPpAAAD7QAAAAIAAAPqAAAABgAAAAQAAAAD",
        "AAAAAAAAAAAAAAASZ2V0X3BlbmRpbmdfb3JhY2xlAAAAAAAAAAAAAQAAA+gAAAfQAAAADVBlbmRpbmdPcmFjbGUAAAA=",
        "AAAAAAAAAAAAAAASZ2V0X3BsYXRmb3JtX3N0YXRzAAAAAAAAAAAAAQAAA+kAAAfQAAAADVBsYXRmb3JtU3RhdHMAAAAAAAAD",
        "AAAAAAAAAAAAAAASdHJhbnNmZXJfb3duZXJzaGlwAAAAAAABAAAAAAAAAAluZXdfb3duZXIAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAGRUaGUgcm9zdGVyLCBpbmNsdWRpbmcgZWFjaCBjaGFsbGVuZ2VyJ3Mgc3Rha2UgYW5kIHdoZXRoZXIgdGhleSBoYXZlCmFscmVhZHkgcHVsbGVkIHRoZWlyIHNldHRsZW1lbnQuAAAAE2dldF9jaGFsbGVuZ2VyX2xpc3QAAAAAAQAAAAAAAAAIY2xhaW1faWQAAAAGAAAAAQAAA+oAAAfQAAAACkNoYWxsZW5nZXIAAA==",
        "AAAAAAAAAAAAAAATdHJhbnNpdGlvbl9kZWFkbGluZQAAAAABAAAAAAAAAAhjbGFpbV9pZAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAhhBIHBhZ2luYXRlZCB3aW5kb3cgaW50byB0aGUgY2hhbGxlbmdlciByb3N0ZXIuCgpSZXR1cm5zIHVwIHRvIGBsaW1pdGAgZW50cmllcyBzdGFydGluZyBhdCBgb2Zmc2V0YCAoMC1iYXNlZCkuCmBsaW1pdCA9IDBgIHJldHVybnMgYWxsIGVudHJpZXMgZnJvbSBgb2Zmc2V0YCB0byB0aGUgZW5kIG9mIHRoZSByb3N0ZXIg4oCUCmlkZW50aWNhbCB0byBgZ2V0X2NoYWxsZW5nZXJfbGlzdGAgd2hlbiBgb2Zmc2V0ID0gMGAuCgpUaGUgYENoYWxsZW5nZXJQYWdlYCByZXNwb25zZSBhbHdheXMgY2FycmllcyBgdG90YWxgIChmdWxsIHJvc3RlciBsZW5ndGgpCnNvIGNhbGxlcnMgY2FuIGRldGVjdCB0aGUgbGFzdCBwYWdlIHdpdGhvdXQgaXNzdWluZyBhbiBleHRyYSBlbXB0eSBmZXRjaC4KCk5laXRoZXIgYG9mZnNldGAgbm9yIGBsaW1pdGAgY2FuIGNhdXNlIGEgcGFuaWM6IGFuIGBvZmZzZXRgIGJleW9uZCB0aGUKZW5kIG9mIHRoZSByb3N0ZXIgcmV0dXJucyBhbiBlbXB0eSBgaXRlbXNgIHNsaWNlIHdpdGggYHRvdGFsYCBzZXQKY29ycmVjdGx5LgAAABRnZXRfY2hhbGxlbmdlcnNfcGFnZQAAAAMAAAAAAAAACGNsYWltX2lkAAAABgAAAAAAAAAGb2Zmc2V0AAAAAAAEAAAAAAAAAAVsaW1pdAAAAAAAAAQAAAABAAAH0AAAAA5DaGFsbGVuZ2VyUGFnZQAA",
        "AAAAAAAAAJRQdWxsIG9uY2UgdXNpbmcgdGhlIHNhbWUgcG9saWN5IGFzIGEgdmVyc2lvbmVkIHByZXZpZXcuIFRoaXMgcmV0YWlucyB0aGUKbGVnYWN5IHBheW91dCdzIGF1dGhvcml6YXRpb24sIGZlZSBhY2NydWFsLCBkdXN0IGFuZCBmcm96ZW4tdG9rZW4gZmFsbGJhY2suAAAAFmNsYWltX3BheW91dF92ZXJzaW9uZWQAAAAAAAMAAAAAAAAACmNoYWxsZW5nZXIAAAAAABMAAAAAAAAACGNsYWltX2lkAAAABgAAAAAAAAAQcmVxdWlyZWRfdmVyc2lvbgAAAAQAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAAWZ2V0X3BlbmRpbmdfZmVlX3BvbGljeQAAAAAAAAAAAAEAAAPoAAAH0AAAABBQZW5kaW5nRmVlUG9saWN5",
        "AAAAAAAAAIlQcmV2aWV3IGEgcGF5b3V0IG9ubHkgdW5kZXIgdGhlIGNhbGxlcidzIGV4cGxpY2l0bHkgcmVxdWlyZWQgcG9saWN5LgpVbnN1cHBvcnRlZCB2ZXJzaW9ucyBhcmUgcmVmdXNlZCBiZWZvcmUgcmVhZGluZyB0aGUgY2xhaW0gb3Igcm9zdGVyLgAAAAAAABZxdW90ZV9wYXlvdXRfdmVyc2lvbmVkAAAAAAADAAAAAAAAAAhjbGFpbV9pZAAAAAYAAAAAAAAACmNoYWxsZW5nZXIAAAAAABMAAAAAAAAAEHJlcXVpcmVkX3ZlcnNpb24AAAAEAAAAAQAAA+kAAAfQAAAAFFZlcnNpb25lZFBheW91dFF1b3RlAAAAAw==",
        "AAAAAAAAAaFTZXR0bGUgb25lIGNoYWxsZW5nZXIncyB3aW5uaW5nIG9yIHJlZnVuZGVkIHBvc2l0aW9uLiBDYWxsYWJsZSBvbmNlIHBlcgpjaGFsbGVuZ2VyIGFmdGVyIHJlc29sdXRpb24sIGFuZCBPKDEpIGluIHRoZSBudW1iZXIgb2YgY2hhbGxlbmdlcnMsIHNvIGEKbWFya2V0IGZpbGxlZCB0byBNQVhfQ0hBTExFTkdFUlMgY2FuIGFsd2F5cyBiZSBwYWlkIG91dCBpbiBmdWxsLgoKYHJlc29sdmVfY2xhaW1gIGRlbGliZXJhdGVseSBkb2VzIE5PVCBsb29wIG92ZXIgY2hhbGxlbmdlcnM6IGEgU3RlbGxhcgp0cmFuc2FjdGlvbiBpcyBjYXBwZWQgb24gaXRzIGxlZGdlci1lbnRyeSBmb290cHJpbnQsIGFuZCBwYXlpbmcgfjEwMApjaGFsbGVuZ2VycyBhdCBvbmNlIGRvZXMgbm90IGZpdC4gUmV0dXJucyB0aGUgbmV0IGFtb3VudCBjcmVkaXRlZC4AAAAAAAAXY2xhaW1fY2hhbGxlbmdlcl9wYXlvdXQAAAAAAgAAAAAAAAAKY2hhbGxlbmdlcgAAAAAAEwAAAAAAAAAIY2xhaW1faWQAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAAAAAAAXZ2V0X2NsYWltX21hcmtldF9jb25maWcAAAAAAQAAAAAAAAAIY2xhaW1faWQAAAAGAAAAAQAAA+kAAAfQAAAADE1hcmtldENvbmZpZwAAAAM=",
        "AAAAAAAAAENXaGF0IGBjbGFpbV9jaGFsbGVuZ2VyX3BheW91dGAgd291bGQgcGF5IHRoaXMgY2hhbGxlbmdlciByaWdodCBub3cuAAAAABdxdW90ZV9jaGFsbGVuZ2VyX3BheW91dAAAAAACAAAAAAAAAAhjbGFpbV9pZAAAAAYAAAAAAAAACmNoYWxsZW5nZXIAAAAAABMAAAABAAAD6QAAB9AAAAALUGF5b3V0UXVvdGUAAAAAAw==",
        "AAAAAAAAAQBWZXJzaW9uZWQgdmVyZGljdCBlbnRyeSBwb2ludC4gSWRlbnRpY2FsIHNldHRsZW1lbnQgc2VtYW50aWNzIHRvCmByZXNvbHZlX2NsYWltYCwgYnV0IHRoZSBvcmFjbGUgc3VibWl0cyBhIGBWZXJkaWN0YCBjYXJyeWluZyBpdHMgZXhwbGljaXQKZW5jb2RpbmcgdmVyc2lvbi4gVW5rbm93biB2ZXJzaW9ucyBhcmUgcmVmdXNlZCB3aXRoCmBFcnJvcjo6VW5zdXBwb3J0ZWRWZXJkaWN0VmVyc2lvbmAgYW5kIGxlYXZlIHRoZSBjbGFpbSB1bnRvdWNoZWQuAAAAF3Jlc29sdmVfY2xhaW1fdmVyc2lvbmVkAAAAAAUAAAAAAAAACGNsYWltX2lkAAAABgAAAAAAAAAHdmVyZGljdAAAAAfQAAAAB1ZlcmRpY3QAAAAAAAAAAAdzdW1tYXJ5AAAAABAAAAAAAAAACmNvbmZpZGVuY2UAAAAAAAQAAAAAAAAADWV2aWRlbmNlX2hhc2gAAAAAAAPuAAAAIAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAEdSZWFkIHRoZSBjdXJyZW50IGFyaXRobWV0aWMgcG9saWN5IHdpdGhvdXQgcmVhZGluZyBhbnkgY2xhaW0gb3Igd2FsbGV0LgAAAAAXcm91bmRpbmdfcG9saWN5X3ZlcnNpb24AAAAAAAAAAAEAAAAE" ]),
      options
    )
  }
  public readonly fromJSON = {
    get_usdc: this.txFromJSON<Result<string>>,
        withdraw: this.txFromJSON<Result<i128>>,
        get_claim: this.txFromJSON<Result<Claim>>,
        get_owner: this.txFromJSON<Result<string>>,
        is_paused: this.txFromJSON<boolean>,
        claim_fees: this.txFromJSON<Result<i128>>,
        get_oracle: this.txFromJSON<Result<string>>,
        initialize: this.txFromJSON<Result<void>>,
        get_verdict: this.txFromJSON<Result<Verdict>>,
        cancel_claim: this.txFromJSON<Result<void>>,
        create_claim: this.txFromJSON<Result<u64>>,
        queue_oracle: this.txFromJSON<Result<void>>,
        cancel_oracle: this.txFromJSON<Result<void>>,
        resolve_claim: this.txFromJSON<Result<void>>,
        execute_oracle: this.txFromJSON<Result<void>>,
        get_claim_fees: this.txFromJSON<Result<ClaimFeeView>>,
        get_fee_policy: this.txFromJSON<Result<FeePolicy>>,
        challenge_claim: this.txFromJSON<Result<void>>,
        get_accrued_fees: this.txFromJSON<i128>,
        get_claims_batch: this.txFromJSON<Result<Array<Option<Claim>>>>,
        get_verdict_side: this.txFromJSON<Result<WinnerSide>>,
        get_withdrawable: this.txFromJSON<i128>,
        queue_fee_policy: this.txFromJSON<Result<void>>,
        cancel_fee_policy: this.txFromJSON<Result<void>>,
        execute_fee_policy: this.txFromJSON<Result<void>>,
        get_creator_claims: this.txFromJSON<Result<readonly [Array<u64>, u32]>>,
        get_pending_oracle: this.txFromJSON<Option<PendingOracle>>,
        get_platform_stats: this.txFromJSON<Result<PlatformStats>>,
        transfer_ownership: this.txFromJSON<Result<void>>,
        get_challenger_list: this.txFromJSON<Array<Challenger>>,
        transition_deadline: this.txFromJSON<Result<void>>,
        get_challengers_page: this.txFromJSON<ChallengerPage>,
        claim_payout_versioned: this.txFromJSON<Result<i128>>,
        get_pending_fee_policy: this.txFromJSON<Option<PendingFeePolicy>>,
        quote_payout_versioned: this.txFromJSON<Result<VersionedPayoutQuote>>,
        claim_challenger_payout: this.txFromJSON<Result<i128>>,
        get_claim_market_config: this.txFromJSON<Result<MarketConfig>>,
        quote_challenger_payout: this.txFromJSON<Result<PayoutQuote>>,
        resolve_claim_versioned: this.txFromJSON<Result<void>>,
        rounding_policy_version: this.txFromJSON<u32>
  }
}
