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
    contractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
  }
} as const

export const Errors = {
  1: {message:"AlreadyInitialized"},
  2: {message:"NotInitialized"},
  3: {message:"ZeroAddress"},
  4: {message:"EmptyQuestion"},
  5: {message:"BadDeadline"},
  6: {message:"FeeCapExceeded"},
  7: {message:"MarketNotFound"},
  8: {message:"MarketClosed"},
  9: {message:"BadSide"},
  10: {message:"ZeroAmount"},
  11: {message:"SideFull"},
  12: {message:"Locked"},
  13: {message:"BadAmount"},
  14: {message:"NotOracle"},
  15: {message:"NotResolvable"},
  16: {message:"BadResult"},
  17: {message:"EmptyWinner"},
  18: {message:"NotClaimable"},
  19: {message:"NotWinner"},
  20: {message:"AlreadyClaimed"},
  21: {message:"NotFeeRecipient"},
  22: {message:"NoFees"},
  23: {message:"UnsupportedToken"},
  24: {message:"Overflow"}
}


export interface Market {
  captain: string;
  deadline: u64;
  fee_bps: u32;
  participants_a: u32;
  participants_b: u32;
  pool_a: i128;
  pool_b: i128;
  remaining_escrow: i128;
  resolved: boolean;
  /**
 * `0` until resolved, then SIDE_A / SIDE_B / RESULT_CANCELLED.
 */
result: u32;
  winner_claims: u32;
}


export interface ClaimResult {
  fee: i128;
  gross: i128;
  net: i128;
}


/**
 * Bounded compatibility descriptor exposed for indexers. `schema_version`
 * identifies the storage layout; `min_supported` and `max_supported` bound
 * the schema interpretations this contract build can serve. Indexers must
 * reject any required schema outside this range.
 */
export interface SchemaDescriptor {
  max_supported: u32;
  min_supported: u32;
  schema_version: u32;
}


export type DataKey = {tag: "Init", values: void} | {tag: "Usdc", values: void} | {tag: "Oracle", values: void} | {tag: "FeeRecipient", values: void} | {tag: "MarketCount", values: void} | {tag: "AccruedFees", values: void} | {tag: "Market", values: readonly [u64]} | {tag: "Deposit", values: readonly [u64, u32, string]} | {tag: "Claimed", values: readonly [u64, u32, string]};

export interface Client {
  /**
   * Construct and simulate a claim transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pull-based payout. Solidity used `msg.sender`; Soroban has no equivalent
   * for a top-level call, so the claimant is an explicit argument that must
   * authorize. Returns the net amount transferred.
   */
  claim: ({participant, market_id, side}: {participant: string, market_id: u64, side: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a deposit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  deposit: ({participant, market_id, side, amount}: {participant: string, market_id: u64, side: u32, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a resolve transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  resolve: ({market_id, result}: {market_id: u64, result: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_usdc transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_usdc: (options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

  /**
   * Construct and simulate a claim_fees transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  claim_fees: (options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a get_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_market: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Market>>>

  /**
   * Construct and simulate a get_oracle transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_oracle: (options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

  /**
   * Construct and simulate a initialize transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Constructor equivalent, callable once.
   */
  initialize: ({usdc, oracle, fee_recipient}: {usdc: string, oracle: string, fee_recipient: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_deposit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_deposit: ({market_id, side, who}: {market_id: u64, side: u32, who: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a has_claimed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  has_claimed: ({market_id, side, who}: {market_id: u64, side: u32, who: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a create_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  create_market: ({captain, question, deadline, fee_bps}: {captain: string, question: string, deadline: u64, fee_bps: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a preview_claim transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  preview_claim: ({market_id, side, who}: {market_id: u64, side: u32, who: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<ClaimResult>>>

  /**
   * Construct and simulate a get_accrued_fees transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_accrued_fees: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a get_market_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_market_count: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a get_fee_recipient transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_fee_recipient: (options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

  /**
   * Construct and simulate a get_escrow_balance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_escrow_balance: (options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a get_schema_descriptor transaction. Returns the bounded storage schema compatibility descriptor for indexers. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_schema_descriptor: (options?: MethodOptions) => Promise<AssembledTransaction<SchemaDescriptor>>

  /**
   * Construct and simulate a withdraw_before_deadline transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  withdraw_before_deadline: ({participant, market_id, side, amount}: {participant: string, market_id: u64, side: u32, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAGAAAAAAAAAASQWxyZWFkeUluaXRpYWxpemVkAAAAAAABAAAAAAAAAA5Ob3RJbml0aWFsaXplZAAAAAAAAgAAAAAAAAALWmVyb0FkZHJlc3MAAAAAAwAAAAAAAAANRW1wdHlRdWVzdGlvbgAAAAAAAAQAAAAAAAAAC0JhZERlYWRsaW5lAAAAAAUAAAAAAAAADkZlZUNhcEV4Y2VlZGVkAAAAAAAGAAAAAAAAAA5NYXJrZXROb3RGb3VuZAAAAAAABwAAAAAAAAAMTWFya2V0Q2xvc2VkAAAACAAAAAAAAAAHQmFkU2lkZQAAAAAJAAAAAAAAAApaZXJvQW1vdW50AAAAAAAKAAAAAAAAAAhTaWRlRnVsbAAAAAsAAAAAAAAABkxvY2tlZAAAAAAADAAAAAAAAAAJQmFkQW1vdW50AAAAAAAADQAAAAAAAAAJTm90T3JhY2xlAAAAAAAADgAAAAAAAAANTm90UmVzb2x2YWJsZQAAAAAAAA8AAAAAAAAACUJhZFJlc3VsdAAAAAAAABAAAAAAAAAAC0VtcHR5V2lubmVyAAAAABEAAAAAAAAADE5vdENsYWltYWJsZQAAABIAAAAAAAAACU5vdFdpbm5lcgAAAAAAABMAAAAAAAAADkFscmVhZHlDbGFpbWVkAAAAAAAUAAAAAAAAAA9Ob3RGZWVSZWNpcGllbnQAAAAAFQAAAAAAAAAGTm9GZWVzAAAAAAAWAAAAAAAAABBVbnN1cHBvcnRlZFRva2VuAAAAFwAAAAAAAAAIT3ZlcmZsb3cAAAAY",
        "AAAAAQAAAAAAAAAAAAAAU2NoZW1hRGVzY3JpcHRvcgAAAAAAAAMAAAAAAAAAD21heF9zdXBwb3J0ZWQAAAAABAAAAAAAAAAPbWluX3N1cHBvcnRlZAAAAAAEAAAAAAAAAA5zY2hlbWFfdmVyc2lvbgAAAAAABA"]),
      options
    )
  }
}
