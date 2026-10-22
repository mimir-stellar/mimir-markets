import {Market, ClaimResult, PendingOracle, PendingFeeRecipient, ContractEvent} from './types.js';
import {Result, Spec, AssembledTransaction, Client as ContractClient, ClientOptions as ContractClientOptions, MethodOptions} from '@stellar/stellar-sdk/contract';
import {Address, xdr} from '@stellar/stellar-sdk';

export interface Client {
  /**
   * Pull-based payout. Solidity used `msg.sender`; Soroban has no equivalent
   * for a top-level call, so the claimant is an explicit argument that must
   * authorize. Returns the net amount transferred.
   */
  claim({ participant, market_id, side }: { participant: string | Address; market_id: bigint; side: number }, options?: MethodOptions): Promise<AssembledTransaction<Result<bigint, Error>>>;
  deposit({ participant, market_id, side, amount }: { participant: string | Address; market_id: bigint; side: number; amount: bigint }, options?: MethodOptions): Promise<AssembledTransaction<Result<null, Error>>>;
  resolve({ market_id, result }: { market_id: bigint; result: number }, options?: MethodOptions): Promise<AssembledTransaction<Result<null, Error>>>;
  get_usdc(options?: MethodOptions): Promise<AssembledTransaction<Result<string, Error>>>;
  claim_fees(options?: MethodOptions): Promise<AssembledTransaction<Result<bigint, Error>>>;
  get_market({ market_id }: { market_id: bigint }, options?: MethodOptions): Promise<AssembledTransaction<Result<Market, Error>>>;
  get_oracle(options?: MethodOptions): Promise<AssembledTransaction<Result<string, Error>>>;
  /**
   * Constructor equivalent, callable once.
   */
  initialize({ usdc, oracle, fee_recipient }: { usdc: string | Address; oracle: string | Address; fee_recipient: string | Address }, options?: MethodOptions): Promise<AssembledTransaction<Result<null, Error>>>;
  get_deposit({ market_id, side, who }: { market_id: bigint; side: number; who: string | Address }, options?: MethodOptions): Promise<AssembledTransaction<bigint>>;
  has_claimed({ market_id, side, who }: { market_id: bigint; side: number; who: string | Address }, options?: MethodOptions): Promise<AssembledTransaction<boolean>>;
  /**
   * Queue an oracle rotation; the current oracle must authorize.
   */
  queue_oracle({ new_oracle }: { new_oracle: string | Address }, options?: MethodOptions): Promise<AssembledTransaction<Result<null, Error>>>;
  /**
   * Captain-initiated market cancellation, only before the deadline. Sets the
   * market as resolved with result=RESULT_CANCELLED, allowing all depositors
   * to claim full refunds via claim(). No fees are charged on cancellation.
   */
  cancel_market({ market_id }: { market_id: bigint }, options?: MethodOptions): Promise<AssembledTransaction<Result<null, Error>>>;
  /**
   * Drop a queued oracle rotation; the current oracle must authorize.
   */
  cancel_oracle(options?: MethodOptions): Promise<AssembledTransaction<Result<null, Error>>>;
  create_market({ captain, question, deadline, fee_bps }: { captain: string | Address; question: string; deadline: bigint; fee_bps: number }, options?: MethodOptions): Promise<AssembledTransaction<Result<bigint, Error>>>;
  /**
   * Payout settled in the ledger but not delivered to one winner, because
   * the token transfer trapped. `claim_parked_payout` moves it.
   */
  parked_payout({ market_id, side, who }: { market_id: bigint; side: number; who: string | Address }, options?: MethodOptions): Promise<AssembledTransaction<bigint>>;
  preview_claim({ market_id, side, who }: { market_id: bigint; side: number; who: string | Address }, options?: MethodOptions): Promise<AssembledTransaction<Result<ClaimResult, Error>>>;
  /**
   * Apply a queued oracle rotation once its timelock has elapsed.
   */
  execute_oracle(options?: MethodOptions): Promise<AssembledTransaction<Result<null, Error>>>;
  get_accrued_fees(options?: MethodOptions): Promise<AssembledTransaction<bigint>>;
  get_market_count(options?: MethodOptions): Promise<AssembledTransaction<bigint>>;
  get_fee_recipient(options?: MethodOptions): Promise<AssembledTransaction<Result<string, Error>>>;
  get_markets_batch({ ids }: { ids: Array<bigint> }, options?: MethodOptions): Promise<AssembledTransaction<Result<Array<Market | null>, Error>>>;
  get_escrow_balance(options?: MethodOptions): Promise<AssembledTransaction<Result<bigint, Error>>>;
  get_pending_oracle(options?: MethodOptions): Promise<AssembledTransaction<PendingOracle | null>>;
  /**
   * Retry a payout that [`Self::claim`] parked because the transfer trapped
   * (frozen or deauthorized trustline). Returns the amount moved, or `0`
   * when nothing is parked.
   */
  claim_parked_payout({ participant, market_id, side }: { participant: string | Address; market_id: bigint; side: number }, options?: MethodOptions): Promise<AssembledTransaction<Result<bigint, Error>>>;
  /**
   * Queue a fee recipient rotation; the current fee recipient must authorize.
   */
  queue_fee_recipient({ new_recipient }: { new_recipient: string | Address }, options?: MethodOptions): Promise<AssembledTransaction<Result<null, Error>>>;
  transition_deadline({ market_id }: { market_id: bigint }, options?: MethodOptions): Promise<AssembledTransaction<Result<null, Error>>>;
  /**
   * Drop a queued fee recipient rotation; the current fee recipient must authorize.
   */
  cancel_fee_recipient(options?: MethodOptions): Promise<AssembledTransaction<Result<null, Error>>>;
  /**
   * Apply a queued fee recipient rotation once its timelock has elapsed.
   */
  execute_fee_recipient(options?: MethodOptions): Promise<AssembledTransaction<Result<null, Error>>>;
  withdraw_before_deadline({ participant, market_id, side, amount }: { participant: string | Address; market_id: bigint; side: number; amount: bigint }, options?: MethodOptions): Promise<AssembledTransaction<Result<null, Error>>>;
  get_pending_fee_recipient(options?: MethodOptions): Promise<AssembledTransaction<PendingFeeRecipient | null>>;
}

export class Client extends ContractClient {
  constructor(public readonly options: ContractClientOptions) {
    super(
      new Spec(["AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAIgAAAAAAAAASQWxyZWFkeUluaXRpYWxpemVkAAAAAAABAAAAAAAAAA5Ob3RJbml0aWFsaXplZAAAAAAAAgAAAAAAAAALWmVyb0FkZHJlc3MAAAAAAwAAAAAAAAANRW1wdHlRdWVzdGlvbgAAAAAAAAQAAAAAAAAAC0JhZERlYWRsaW5lAAAAAAUAAAAAAAAADkZlZUNhcEV4Y2VlZGVkAAAAAAAGAAAAAAAAAA5NYXJrZXROb3RGb3VuZAAAAAAABwAAAAAAAAAMTWFya2V0Q2xvc2VkAAAACAAAAAAAAAAHQmFkU2lkZQAAAAAJAAAAAAAAAApaZXJvQW1vdW50AAAAAAAKAAAAAAAAAAhTaWRlRnVsbAAAAAsAAAAAAAAABkxvY2tlZAAAAAAADAAAAAAAAAAJQmFkQW1vdW50AAAAAAAADQAAAAAAAAAJTm90T3JhY2xlAAAAAAAADgAAAAAAAAANTm90UmVzb2x2YWJsZQAAAAAAAA8AAAAAAAAACUJhZFJlc3VsdAAAAAAAABAAAAAAAAAAC0VtcHR5V2lubmVyAAAAABEAAAAAAAAADE5vdENsYWltYWJsZQAAABIAAAAAAAAACU5vdFdpbm5lcgAAAAAAABMAAAAAAAAADkFscmVhZHlDbGFpbWVkAAAAAAAUAAAAAAAAAA9Ob3RGZWVSZWNpcGllbnQAAAAAFQAAAAAAAAAGTm9GZWVzAAAAAAAWAAAAAAAAABBVbnN1cHBvcnRlZFRva2VuAAAAFwAAAAAAAAAIT3ZlcmZsb3cAAAAYAAAAAAAAABNVbnN1cHBvcnRlZERlY2ltYWxzAAAAABkAAAAAAAAAFUNvbnNlcnZhdGlvblZpb2xhdGlvbgAAAAAAABoAAABRVGhlIG1hcmtldCBxdWVzdGlvbiBleGNlZWRlZCBgTUFYX1FVRVNUSU9OX0JZVEVTYC4gUmVmdXNlZCByYXRoZXIgdGhhbgp0cnVuY2F0ZWQuAAAAAAAAD1F1ZXN0aW9uVG9vTG9uZwAAAAAbAAABLUFsbCBbYE1BWF9TUVVBRF9NRU1CRVJTYF0gc2xvdHMgYWNyb3NzIGJvdGggc2lkZXMgaGF2ZSBiZWVuIGZpbGxlZC4KRGlzdGluY3QgZnJvbSBbYEVycm9yOjpTaWRlRnVsbGBdLCB3aGljaCBmaXJlcyB3aGVuIGEgc2luZ2xlIHNpZGUgcmVhY2hlcwpbYE1BWF9QQVJUSUNJUEFOVFNfUEVSX1NJREVgXS4gIEEgbmV3IGRlcG9zaXRvciBpcyByZWplY3RlZCBvbmNlCmBwYXJ0aWNpcGFudHNfYSArIHBhcnRpY2lwYW50c19iID09IE1BWF9TUVVBRF9NRU1CRVJTYCBldmVuIGlmIHRoZSB0YXJnZXQKc2lkZSBzdGlsbCBoYXMgcm9vbS4AAAAAAAAJU3F1YWRGdWxsAAAAAAAAHAAAAMdBIHBheW91dCBjb3VsZCBub3QgYmUgZGVsaXZlcmVkIGJlY2F1c2UgdGhlIHRva2VuIHRyYW5zZmVyIHRyYXBwZWQKKGZyb3plbiBvciBkZWF1dGhvcml6ZWQgdHJ1c3RsaW5lKS4gVGhlIGFtb3VudCBpcyBwYXJrZWQsIG5vdCBsb3N0OgpgY2xhaW1gIHN1Y2NlZWRzIGFuZCBob2xkcyBpdCwgYGNsYWltX3BhcmtlZF9wYXlvdXRgIHJldHJpZXMgaXQuAAAAAAxQYXlvdXRQYXJrZWQAAAAdAAAATWBjYW5jZWxfbWFya2V0YCB3YXMgY2FsbGVkIG9uIGEgbWFya2V0IHRoYXQgaXMgYWxyZWFkeSByZXNvbHZlZCBvcgpjYW5jZWxsZWQuAAAAAAAAD0FscmVhZHlSZXNvbHZlZAAAAAAeAAAAQ2BjYW5jZWxfb3JhY2xlYCAvIGBleGVjdXRlX29yYWNsZWAgZm91bmQgbm8gcXVldWVkIG9yYWNsZSByb3RhdGlvbi4AAAAADU5vdGhpbmdRdWV1ZWQAAAAAAAAfAAAAQ2BleGVjdXRlX29yYWNsZWAgd2FzIGNhbGxlZCBiZWZvcmUgdGhlIHJvdGF0aW9uJ3MgdGltZWxvY2sgZWxhcHNlZC4AAAAAClRpbWVsb2NrZWQAAAAAACAAAABjYGdldF9tYXJrZXRzX2JhdGNoYCB3YXMgY2FsbGVkIHdpdGggbW9yZSB0aGFuIGBNQVhfQkFUQ0hfU0laRWAgaWRzLiBSZWZ1c2VkIGJlZm9yZSByZWFkaW5nIHN0b3JhZ2UuAAAAAA1CYXRjaFRvb0xhcmdlAAAAAAAAIQAAAFhgY2FuY2VsX2ZlZV9yZWNpcGllbnRgIC8gYGV4ZWN1dGVfZmVlX3JlY2lwaWVudGAgZm91bmQgbm8gcXVldWVkCmZlZS1yZWNpcGllbnQgcm90YXRpb24uAAAAFE5vRmVlUmVjaXBpZW50UXVldWVkAAAAIg==", "AAAAAQAAAAAAAAAAAAAABk1hcmtldAAAAAAACwAAAAAAAAAHY2FwdGFpbgAAAAATAAAAAAAAAAhkZWFkbGluZQAAAAYAAAAAAAAAB2ZlZV9icHMAAAAABAAAAAAAAAAOcGFydGljaXBhbnRzX2EAAAAAAAQAAAAAAAAADnBhcnRpY2lwYW50c19iAAAAAAAEAAAAAAAAAAZwb29sX2EAAAAAAAsAAAAAAAAABnBvb2xfYgAAAAAACwAAAAAAAAAQcmVtYWluaW5nX2VzY3JvdwAAAAsAAAAAAAAACHJlc29sdmVkAAAAAQAAADxgMGAgdW50aWwgcmVzb2x2ZWQsIHRoZW4gU0lERV9BIC8gU0lERV9CIC8gUkVTVUxUX0NBTkNFTExFRC4AAAAGcmVzdWx0AAAAAAAEAAAAAAAAAA13aW5uZXJfY2xhaW1zAAAAAAAABA==", "AAAAAQAAAAAAAAAAAAAAC0NsYWltUmVzdWx0AAAAAAMAAAAAAAAAA2ZlZQAAAAALAAAAAAAAAAVncm9zcwAAAAAAAAsAAAAAAAAAA25ldAAAAAAL", "AAAAAQAAAEVBIHF1ZXVlZCBvcmFjbGUgcm90YXRpb24sIGV4ZWN1dGFibGUgb25jZSBgZXhlY3V0YWJsZV9hdGAgaGFzIHBhc3NlZC4AAAAAAAAAAAAADVBlbmRpbmdPcmFjbGUAAAAAAAACAAAAAAAAAA1leGVjdXRhYmxlX2F0AAAAAAAABgAAAAAAAAAEbmV4dAAAABM=", "AAAAAQAAAExBIHF1ZXVlZCBmZWUtcmVjaXBpZW50IHJvdGF0aW9uLCBleGVjdXRhYmxlIG9uY2UgYGV4ZWN1dGFibGVfYXRgIGhhcyBwYXNzZWQuAAAAAAAAABNQZW5kaW5nRmVlUmVjaXBpZW50AAAAAAIAAAAAAAAADWV4ZWN1dGFibGVfYXQAAAAAAAAGAAAAAAAAAARuZXh0AAAAEw==", "AAAABQAAAAAAAAAAAAAAB0NsYWltZWQAAAAAAQAAAAdjbGFpbWVkAAAAAAUAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAtwYXJ0aWNpcGFudAAAAAATAAAAAQAAAAAAAAAFZ3Jvc3MAAAAAAAALAAAAAAAAAAAAAAADZmVlAAAAAAsAAAAAAAAAAAAAAANuZXQAAAAACwAAAAAAAAAC", "AAAABQAAAAAAAAAAAAAACFJlc29sdmVkAAAAAQAAAAhyZXNvbHZlZAAAAAQAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAZyZXN1bHQAAAAAAAQAAAAAAAAAAAAAAAZwb29sX2EAAAAAAAsAAAAAAAAAAAAAAAZwb29sX2IAAAAAAAsAAAAAAAAAAg==", "AAAABQAAAAAAAAAAAAAACURlcG9zaXRlZAAAAAAAAAEAAAAJZGVwb3NpdGVkAAAAAAAABQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAABHNpZGUAAAAEAAAAAQAAAAAAAAALcGFydGljaXBhbnQAAAAAEwAAAAEAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAAAAAABnNoYXJlcwAAAAAACwAAAAAAAAAC", "AAAABQAAAb5FbWl0dGVkIG9uIHRoZSBkZXBvc2l0IHRoYXQgZmlsbHMgdGhlIHNxdWFkIHRvIFtgY3JhdGU6OnR5cGVzOjpNQVhfU1FVQURfTUVNQkVSU2BdCnRvdGFsIHBhcnRpY2lwYW50cy4gU3Vic2VxdWVudCBkZXBvc2l0cyBmcm9tIG5ldyBhZGRyZXNzZXMgYXJlIHJlamVjdGVkCndpdGggW2BjcmF0ZTo6dHlwZXM6OkVycm9yOjpTcXVhZEZ1bGxgXSB1bnRpbCBleGlzdGluZyBtZW1iZXJzIHdpdGhkcmF3LgoKVGhpcyBldmVudCBmaXJlcyBvbiB0aGUgKmxhc3QgYWNjZXB0ZWQqIGRlcG9zaXQgcmF0aGVyIHRoYW4gb24gdGhlIHJlamVjdGVkCmF0dGVtcHQ6IFNvcm9iYW4gZGlzY2FyZHMgYWxsIGV2ZW50cyBlbWl0dGVkIGJ5IGEgZmFpbGVkIGludm9jYXRpb24sIHNvIGEKImNhcCBoaXQiIGV2ZW50IGNhbiBvbmx5IGJlIHJlbGlhYmx5IGluZGV4ZWQgZnJvbSBhIHN1Y2Nlc3NmdWwgb25lLgAAAAAAAAAAAAlTcXVhZEZ1bGwAAAAAAAABAAAACnNxdWFkX2Z1bGwAAAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAA10b3RhbF9tZW1iZXJzAAAAAAAABAAAAAAAAAAC", "AAAABQAAAAAAAAAAAAAACVdpdGhkcmF3bgAAAAAAAAEAAAAJd2l0aGRyYXduAAAAAAAABAAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAABHNpZGUAAAAEAAAAAQAAAAAAAAALcGFydGljaXBhbnQAAAAAEwAAAAEAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAC", "AAAABQAAAAAAAAAAAAAAC0ZlZXNDbGFpbWVkAAAAAAEAAAAMZmVlc19jbGFpbWVkAAAAAgAAAAAAAAAJcmVjaXBpZW50AAAAAAAAEwAAAAEAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAC", "AAAABQAAAGhBbiBvcmFjbGUgcm90YXRpb24gd2FzIHF1ZXVlZCBieSB0aGUgY3VycmVudCBvcmFjbGUuClRoZSByb3RhdGlvbiBiZWNvbWVzIGV4ZWN1dGFibGUgYXQgYGV4ZWN1dGFibGVfYXRgLgAAAAAAAAAMT3JhY2xlUXVldWVkAAAAAQAAAA1vcmFjbGVfcXVldWVkAAAAAAAAAgAAAAAAAAAEbmV4dAAAABMAAAABAAAAAAAAAA1leGVjdXRhYmxlX2F0AAAAAAAABgAAAAAAAAAC", "AAAABQAAAHRBIHBheW91dCBjb3VsZCBub3QgYmUgZGVsaXZlcmVkIChmcm96ZW4gb3IgZGVhdXRob3JpemVkIHRydXN0bGluZSkgYW5kIHdhcwpwYXJrZWQgZm9yIGEgbGF0ZXIgYGNsYWltX3BhcmtlZF9wYXlvdXRgLgAAAAAAAAAMUGF5b3V0UGFya2VkAAAAAQAAAA1wYXlvdXRfcGFya2VkAAAAAAAABAAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAABHNpZGUAAAAEAAAAAQAAAAAAAAALcGFydGljaXBhbnQAAAAAEwAAAAEAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAC", "AAAABQAAAAAAAAAAAAAADU1hcmtldENyZWF0ZWQAAAAAAAABAAAADm1hcmtldF9jcmVhdGVkAAAAAAAFAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAHY2FwdGFpbgAAAAATAAAAAQAAAAAAAAAIZGVhZGxpbmUAAAAGAAAAAAAAAAAAAAAHZmVlX2JwcwAAAAAEAAAAAAAAAAAAAAAIcXVlc3Rpb24AAAAQAAAAAAAAAAI=", "AAAABQAAAEFBIHF1ZXVlZCBvcmFjbGUgcm90YXRpb24gd2FzIGV4ZWN1dGVkIGFmdGVyIHRoZSB0aW1lbG9jayBlbGFwc2VkLgAAAAAAAAAAAAANT3JhY2xlQ2hhbmdlZAAAAAAAAAEAAAAOb3JhY2xlX2NoYW5nZWQAAAAAAAIAAAAAAAAABG5leHQAAAATAAAAAQAAAAAAAAAIcHJldmlvdXMAAAATAAAAAAAAAAI=", "AAAABQAAAG5FbWl0dGVkIHdoZW4gbGlxdWlkaXR5IGlzIGFkZGVkIHRvIGEgcG9vbCBtYXJrZXQuClRyYWNrcyBwb29sIGRlcHRoIGNoYW5nZXMgZm9yIGFuYWx5dGljcyBhbmQgcmlzayBtYW5hZ2VtZW50LgAAAAAAAAAAAA5MaXF1aWRpdHlBZGRlZAAAAAAAAQAAAA9saXF1aWRpdHlfYWRkZWQAAAAABQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAABHNpZGUAAAAEAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAAAAAAObmV3X3Bvb2xfdG90YWwAAAAAAAsAAAAAAAAAAAAAAA1zaGFyZXNfaXNzdWVkAAAAAAAACwAAAAAAAAAC", "AAAABQAAAI9BIGNhcHRhaW4gY2FuY2VsbGVkIGEgbWFya2V0IGJlZm9yZSBpdHMgZGVhZGxpbmUuIEV2ZXJ5IGRlcG9zaXRvciBjYW4gcHVsbAphIGZ1bGwgcmVmdW5kIHRocm91Z2ggYGNsYWltYDsgdGhlIHBvb2xzIGFyZSBrZXB0IGFzIGFuIGF1ZGl0IHRyYWlsLgAAAAAAAAAAD01hcmtldENhbmNlbGxlZAAAAAABAAAAEG1hcmtldF9jYW5jZWxsZWQAAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAHY2FwdGFpbgAAAAATAAAAAQAAAAAAAAAGcG9vbF9hAAAAAAALAAAAAAAAAAAAAAAGcG9vbF9iAAAAAAALAAAAAAAAAAI=", "AAAABQAAAD1BIHF1ZXVlZCBvcmFjbGUgcm90YXRpb24gd2FzIGNhbmNlbGxlZCBieSB0aGUgY3VycmVudCBvcmFjbGUuAAAAAAAAAAAAAA9PcmFjbGVDYW5jZWxsZWQAAAAAAQAAABBvcmFjbGVfY2FuY2VsbGVkAAAAAQAAAAAAAAAJY2FuY2VsbGVkAAAAAAAAAQAAAAAAAAAC", "AAAABQAAAJJFbWl0dGVkIHdoZW4gbGlxdWlkaXR5IGlzIHJlbW92ZWQgZnJvbSBhIHBvb2wgbWFya2V0IGJlZm9yZSByZXNvbHV0aW9uLgpEaXN0aW5ndWlzaGVzIGJldHdlZW4gcHJlLWRlYWRsaW5lIHdpdGhkcmF3YWxzIGFuZCBwb3N0LXJlc29sdXRpb24gY2xhaW1zLgAAAAAAAAAAABBMaXF1aWRpdHlSZW1vdmVkAAAAAQAAABFsaXF1aWRpdHlfcmVtb3ZlZAAAAAAAAAUAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAARzaWRlAAAABAAAAAEAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAAAAAADm5ld19wb29sX3RvdGFsAAAAAAALAAAAAAAAAAAAAAANc2hhcmVzX2J1cm5lZAAAAAAAAAsAAAAAAAAAAg==", "AAAABQAAAIxFbWl0dGVkIHdoZW4gdGhlIGN1cnJlbnQgZmVlIHJlY2lwaWVudCBxdWV1ZXMgYSByb3RhdGlvbiB0byBhIG5ldyBhZGRyZXNzLgpUaGUgcm90YXRpb24gYmVjb21lcyBleGVjdXRhYmxlIG9ubHkgYXQgb3IgYWZ0ZXIgYGV4ZWN1dGFibGVfYXRgLgAAAAAAAAASRmVlUmVjaXBpZW50UXVldWVkAAAAAAABAAAAFGZlZV9yZWNpcGllbnRfcXVldWVkAAAAAgAAAAAAAAAEbmV4dAAAABMAAAABAAAAAAAAAA1leGVjdXRhYmxlX2F0AAAAAAAABgAAAAAAAAAC", "AAAABQAAAJVFbWl0dGVkIHdoZW4gYSBxdWV1ZWQgZmVlIHJlY2lwaWVyIHJvdGF0aW9uIGlzIGV4ZWN1dGVkIGFmdGVyIHRoZSB0aW1lbG9jay4KQW55IGZlZXMgYWNjcnVlZCBidXQgdW5jbGFpbWVkIGF0IGV4ZWN1dGlvbiB0aW1lIGFyZSBwYXlhYmxlIHRvIGBgbmV4dGBgLgAAAAAAAAAAAAATRmVlUmVjaXBpZW50Q2hhbmdlZAAAAAABAAAAFWZlZV9yZWNpcGllbnRfY2hhbmdlZAAAAAAAAAIAAAAAAAAABG5leHQAAAATAAAAAQAAAAAAAAAIcHJldmlvdXMAAAATAAAAAAAAAAI=", "AAAABQAAAFNFbWl0dGVkIHdoZW4gYSBxdWV1ZWQgZmVlIHJlY2lwaWVudCByb3RhdGlvbiBpcyBjYW5jZWxsZWQgYnkgdGhlIGN1cnJlbnQgcmVjaXBpZW50LgAAAAAAAAAAFUZlZVJlY2lwaWVudENhbmNlbGxlZAAAAAAAAAEAAAAXZmVlX3JlY2lwaWVudF9jYW5jZWxsZWQAAAAAAQAAAAAAAAAJY2FuY2VsbGVkAAAAAAAAAQAAAAAAAAAC", "AAAABQAAAFRFbWl0dGVkIHdoZW4gYSBwb29sIG1hcmtldCdzIGRlYWRsaW5lIHBhc3NlcyBhbmQgaXQgYmVjb21lcyBlbGlnaWJsZSBmb3IgcmVzb2x1dGlvbi4AAAAAAAAAFU1hcmtldERlYWRsaW5lUmVhY2hlZAAAAAAAAAEAAAAXbWFya2V0X2RlYWRsaW5lX3JlYWNoZWQAAAAABAAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAACGRlYWRsaW5lAAAABgAAAAAAAAAAAAAADHBvb2xfYV90b3RhbAAAAAsAAAAAAAAAAAAAAAxwb29sX2JfdG90YWwAAAALAAAAAAAAAAI=", "AAAABQAAAHZQb29sIG1hcmtldCBzdGF0ZSB0cmFuc2l0aW9uIGV2ZW50IGZvciBsaWZlY3ljbGUgYXVkaXRpbmcuCkVtaXR0ZWQgb24gZXZlcnkgc3RhdGUgY2hhbmdlIHdpdGggcHJldmlvdXMgYW5kIG5ldyBzdGF0ZXMuAAAAAAAAAAAAF01hcmtldFN0YXRlVHJhbnNpdGlvbmVkAAAAAAEAAAAZbWFya2V0X3N0YXRlX3RyYW5zaXRpb25lZAAAAAAAAAQAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAApmcm9tX3N0YXRlAAAAAAAEAAAAAAAAAAAAAAAIdG9fc3RhdGUAAAAEAAAAAAAAAAAAAAAJdGltZXN0YW1wAAAAAAAABgAAAAAAAAAC", "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAADAAAAAAAAAAAAAAABEluaXQAAAAAAAAAAAAAAARVc2RjAAAAAAAAAAAAAAAGT3JhY2xlAAAAAAAAAAAAAAAAAAxGZWVSZWNpcGllbnQAAAAAAAAAAAAAAA1QZW5kaW5nT3JhY2xlAAAAAAAAAAAAAAAAAAATUGVuZGluZ0ZlZVJlY2lwaWVudAAAAAAAAAAAAAAAAAtNYXJrZXRDb3VudAAAAAAAAAAAAAAAAAtBY2NydWVkRmVlcwAAAAABAAAAAAAAAAZNYXJrZXQAAAAAAAEAAAAGAAAAAQAAAEMobWFya2V0LCBzaWRlLCBwYXJ0aWNpcGFudCkgLT4gZGVwb3NpdGVkIHVuaXRzLiBTaGFyZXMgZXF1YWwgdW5pdHMuAAAAAAdEZXBvc2l0AAAAAAMAAAAGAAAABAAAABMAAAABAAAALyhtYXJrZXQsIHNpZGUsIHBhcnRpY2lwYW50KSAtPiBhbHJlYWR5IGNsYWltZWQuAAAAAAdDbGFpbWVkAAAAAAMAAAAGAAAABAAAABMAAAABAAAAxShtYXJrZXQsIHNpZGUsIHBhcnRpY2lwYW50KSAtPiBwYXlvdXQgc2V0dGxlZCBpbiB0aGUgbGVkZ2VyIGJ1dCBub3QKZGVsaXZlcmVkLCBiZWNhdXNlIHRoZSB0b2tlbiB0cmFuc2ZlciB0cmFwcGVkIChmcm96ZW4gb3IgZGVhdXRob3JpemVkCnRydXN0bGluZSkuIFBhcmtlZCB1bnRpbCBgY2xhaW1fcGFya2VkX3BheW91dGAgY2FuIG1vdmUgaXQuAAAAAAAABlBheW91dAAAAAAAAwAAAAYAAAAEAAAAEw==", "AAAAAAAAAL9QdWxsLWJhc2VkIHBheW91dC4gU29saWRpdHkgdXNlZCBgbXNnLnNlbmRlcmA7IFNvcm9iYW4gaGFzIG5vIGVxdWl2YWxlbnQKZm9yIGEgdG9wLWxldmVsIGNhbGwsIHNvIHRoZSBjbGFpbWFudCBpcyBhbiBleHBsaWNpdCBhcmd1bWVudCB0aGF0IG11c3QKYXV0aG9yaXplLiBSZXR1cm5zIHRoZSBuZXQgYW1vdW50IHRyYW5zZmVycmVkLgAAAAAFY2xhaW0AAAAAAAADAAAAAAAAAAtwYXJ0aWNpcGFudAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAARzaWRlAAAABAAAAAEAAAPpAAAACwAAAAM=", "AAAAAAAAAAAAAAAHZGVwb3NpdAAAAAAEAAAAAAAAAAtwYXJ0aWNpcGFudAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAARzaWRlAAAABAAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAACAAAAAw==", "AAAAAAAAAAAAAAAHcmVzb2x2ZQAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAZyZXN1bHQAAAAAAAQAAAABAAAD6QAAAAIAAAAD", "AAAAAAAAAAAAAAAIZ2V0X3VzZGMAAAAAAAAAAQAAA+kAAAATAAAAAw==", "AAAAAAAAAAAAAAAKY2xhaW1fZmVlcwAAAAAAAAAAAAEAAAPpAAAACwAAAAM=", "AAAAAAAAAAAAAAAKZ2V0X21hcmtldAAAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAAZNYXJrZXQAAAAAAAM=", "AAAAAAAAAAAAAAAKZ2V0X29yYWNsZQAAAAAAAAAAAAEAAAPpAAAAEwAAAAM=", "AAAAAAAAACZDb25zdHJ1Y3RvciBlcXVpdmFsZW50LCBjYWxsYWJsZSBvbmNlLgAAAAAACmluaXRpYWxpemUAAAAAAAMAAAAAAAAABHVzZGMAAAATAAAAAAAAAAZvcmFjbGUAAAAAABMAAAAAAAAADWZlZV9yZWNpcGllbnQAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==", "AAAAAAAAAAAAAAALZ2V0X2RlcG9zaXQAAAAAAwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAEc2lkZQAAAAQAAAAAAAAAA3dobwAAAAATAAAAAQAAAAs=", "AAAAAAAAAAAAAAALaGFzX2NsYWltZWQAAAAAAwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAEc2lkZQAAAAQAAAAAAAAAA3dobwAAAAATAAAAAQAAAAE=", "AAAAAAAAADxRdWV1ZSBhbiBvcmFjbGUgcm90YXRpb247IHRoZSBjdXJyZW50IG9yYWNsZSBtdXN0IGF1dGhvcml6ZS4AAAAMcXVldWVfb3JhY2xlAAAAAQAAAAAAAAAKbmV3X29yYWNsZQAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=", "AAAAAAAAANpDYXB0YWluLWluaXRpYXRlZCBtYXJrZXQgY2FuY2VsbGF0aW9uLCBvbmx5IGJlZm9yZSB0aGUgZGVhZGxpbmUuIFNldHMgdGhlCm1hcmtldCBhcyByZXNvbHZlZCB3aXRoIHJlc3VsdD1SRVNVTFRfQ0FOQ0VMTEVELCBhbGxvd2luZyBhbGwgZGVwb3NpdG9ycwp0byBjbGFpbSBmdWxsIHJlZnVuZHMgdmlhIGNsYWltKCkuIE5vIGZlZXMgYXJlIGNoYXJnZWQgb24gY2FuY2VsbGF0aW9uLgAAAAAADWNhbmNlbF9tYXJrZXQAAAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAACAAAAAw==", "AAAAAAAAAEFEcm9wIGEgcXVldWVkIG9yYWNsZSByb3RhdGlvbjsgdGhlIGN1cnJlbnQgb3JhY2xlIG11c3QgYXV0aG9yaXplLgAAAAAAAA1jYW5jZWxfb3JhY2xlAAAAAAAAAAAAAAEAAAPpAAAAAgAAAAM=", "AAAAAAAAAAAAAAANY3JlYXRlX21hcmtldAAAAAAAAAQAAAAAAAAAB2NhcHRhaW4AAAAAEwAAAAAAAAAIcXVlc3Rpb24AAAAQAAAAAAAAAAhkZWFkbGluZQAAAAYAAAAAAAAAB2ZlZV9icHMAAAAABAAAAAEAAAPpAAAABgAAAAM=", "AAAAAAAAAIFQYXlvdXQgc2V0dGxlZCBpbiB0aGUgbGVkZ2VyIGJ1dCBub3QgZGVsaXZlcmVkIHRvIG9uZSB3aW5uZXIsIGJlY2F1c2UKdGhlIHRva2VuIHRyYW5zZmVyIHRyYXBwZWQuIGBjbGFpbV9wYXJrZWRfcGF5b3V0YCBtb3ZlcyBpdC4AAAAAAAANcGFya2VkX3BheW91dAAAAAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAABHNpZGUAAAAEAAAAAAAAAAN3aG8AAAAAEwAAAAEAAAAL", "AAAAAAAAAAAAAAANcHJldmlld19jbGFpbQAAAAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAABHNpZGUAAAAEAAAAAAAAAAN3aG8AAAAAEwAAAAEAAAPpAAAH0AAAAAtDbGFpbVJlc3VsdAAAAAAD", "AAAAAAAAAD1BcHBseSBhIHF1ZXVlZCBvcmFjbGUgcm90YXRpb24gb25jZSBpdHMgdGltZWxvY2sgaGFzIGVsYXBzZWQuAAAAAAAADmV4ZWN1dGVfb3JhY2xlAAAAAAAAAAAAAQAAA+kAAAACAAAAAw==", "AAAAAAAAAAAAAAAQZ2V0X2FjY3J1ZWRfZmVlcwAAAAAAAAABAAAACw==", "AAAAAAAAAAAAAAAQZ2V0X21hcmtldF9jb3VudAAAAAAAAAABAAAABg==", "AAAAAAAAAAAAAAARZ2V0X2ZlZV9yZWNpcGllbnQAAAAAAAAAAAAAAQAAA+kAAAATAAAAAw==", "AAAAAAAAAAAAAAARZ2V0X21hcmtldHNfYmF0Y2gAAAAAAAABAAAAAAAAAANpZHMAAAAD6gAAAAYAAAABAAAD6QAAA+oAAAPoAAAH0AAAAAZNYXJrZXQAAAAAAAM=", "AAAAAAAAAAAAAAASZ2V0X2VzY3Jvd19iYWxhbmNlAAAAAAAAAAAAAQAAA+kAAAALAAAAAw==", "AAAAAAAAAAAAAAASZ2V0X3BlbmRpbmdfb3JhY2xlAAAAAAAAAAAAAQAAA+gAAAfQAAAADVBlbmRpbmdPcmFjbGUAAAA=", "AAAAAAAAAKRSZXRyeSBhIHBheW91dCB0aGF0IFtgU2VsZjo6Y2xhaW1gXSBwYXJrZWQgYmVjYXVzZSB0aGUgdHJhbnNmZXIgdHJhcHBlZAooZnJvemVuIG9yIGRlYXV0aG9yaXplZCB0cnVzdGxpbmUpLiBSZXR1cm5zIHRoZSBhbW91bnQgbW92ZWQsIG9yIGAwYAp3aGVuIG5vdGhpbmcgaXMgcGFya2VkLgAAABNjbGFpbV9wYXJrZWRfcGF5b3V0AAAAAAMAAAAAAAAAC3BhcnRpY2lwYW50AAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAABHNpZGUAAAAEAAAAAQAAA+kAAAALAAAAAw==", "AAAAAAAAAElRdWV1ZSBhIGZlZSByZWNpcGllbnQgcm90YXRpb247IHRoZSBjdXJyZW50IGZlZSByZWNpcGllbnQgbXVzdCBhdXRob3JpemUuAAAAAAAAE3F1ZXVlX2ZlZV9yZWNpcGllbnQAAAAAAQAAAAAAAAANbmV3X3JlY2lwaWVudAAAAAAAABMAAAABAAAD6QAAAAIAAAAD", "AAAAAAAAAAAAAAATdHJhbnNpdGlvbl9kZWFkbGluZQAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAACAAAAAw==", "AAAAAAAAAE9Ecm9wIGEgcXVldWVkIGZlZSByZWNpcGllbnQgcm90YXRpb247IHRoZSBjdXJyZW50IGZlZSByZWNpcGllbnQgbXVzdCBhdXRob3JpemUuAAAAABRjYW5jZWxfZmVlX3JlY2lwaWVudAAAAAAAAAABAAAD6QAAAAIAAAAD", "AAAAAAAAAERBcHBseSBhIHF1ZXVlZCBmZWUgcmVjaXBpZW50IHJvdGF0aW9uIG9uY2UgaXRzIHRpbWVsb2NrIGhhcyBlbGFwc2VkLgAAABVleGVjdXRlX2ZlZV9yZWNpcGllbnQAAAAAAAAAAAAAAQAAA+kAAAACAAAAAw==", "AAAAAAAAAAAAAAAYd2l0aGRyYXdfYmVmb3JlX2RlYWRsaW5lAAAABAAAAAAAAAALcGFydGljaXBhbnQAAAAAEwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAEc2lkZQAAAAQAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAAAgAAAAM=", "AAAAAAAAAAAAAAAZZ2V0X3BlbmRpbmdfZmVlX3JlY2lwaWVudAAAAAAAAAAAAAABAAAD6AAAB9AAAAATUGVuZGluZ0ZlZVJlY2lwaWVudAA="]),
      options
    );
  }

   static deploy<T = Client>(options: MethodOptions & Omit<ContractClientOptions, 'contractId'> & { wasmHash: Buffer | string; salt?: Buffer | Uint8Array; format?: "hex" | "base64"; address?: string; }): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(null, options);
  }
  public readonly fromJSON = {
    claim : this.txFromJSON<Result<bigint, Error>>,  deposit : this.txFromJSON<Result<null, Error>>,  resolve : this.txFromJSON<Result<null, Error>>,  get_usdc : this.txFromJSON<Result<string, Error>>,  claim_fees : this.txFromJSON<Result<bigint, Error>>,  get_market : this.txFromJSON<Result<Market, Error>>,  get_oracle : this.txFromJSON<Result<string, Error>>,  initialize : this.txFromJSON<Result<null, Error>>,  get_deposit : this.txFromJSON<bigint>,  has_claimed : this.txFromJSON<boolean>,  queue_oracle : this.txFromJSON<Result<null, Error>>,  cancel_market : this.txFromJSON<Result<null, Error>>,  cancel_oracle : this.txFromJSON<Result<null, Error>>,  create_market : this.txFromJSON<Result<bigint, Error>>,  parked_payout : this.txFromJSON<bigint>,  preview_claim : this.txFromJSON<Result<ClaimResult, Error>>,  execute_oracle : this.txFromJSON<Result<null, Error>>,  get_accrued_fees : this.txFromJSON<bigint>,  get_market_count : this.txFromJSON<bigint>,  get_fee_recipient : this.txFromJSON<Result<string, Error>>,  get_markets_batch : this.txFromJSON<Result<Array<Market | null>, Error>>,  get_escrow_balance : this.txFromJSON<Result<bigint, Error>>,  get_pending_oracle : this.txFromJSON<PendingOracle | null>,  claim_parked_payout : this.txFromJSON<Result<bigint, Error>>,  queue_fee_recipient : this.txFromJSON<Result<null, Error>>,  transition_deadline : this.txFromJSON<Result<null, Error>>,  cancel_fee_recipient : this.txFromJSON<Result<null, Error>>,  execute_fee_recipient : this.txFromJSON<Result<null, Error>>,  withdraw_before_deadline : this.txFromJSON<Result<null, Error>>,  get_pending_fee_recipient : this.txFromJSON<PendingFeeRecipient | null>
  };

  /**
   * Parse a raw contract event (topics + data) into a typed {@link ContractEvent}.
   */
  parseEvent(topics: xdr.ScVal[] | string[], data: xdr.ScVal | string): ContractEvent | undefined {
    return this.spec.parseEvent(topics, data) as ContractEvent | undefined;
  }
  /**
   * Build a topics filter row for the "Claimed" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  claimedEventFilter(topicValues?: { market_id?: bigint; participant?: string | Address }): string[] {
    return this.spec.eventTopicFilter("Claimed", topicValues);
  }
  /**
   * Build a topics filter row for the "Resolved" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  resolvedEventFilter(topicValues?: { market_id?: bigint }): string[] {
    return this.spec.eventTopicFilter("Resolved", topicValues);
  }
  /**
   * Build a topics filter row for the "Deposited" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  depositedEventFilter(topicValues?: { market_id?: bigint; side?: number; participant?: string | Address }): string[] {
    return this.spec.eventTopicFilter("Deposited", topicValues);
  }
  /**
   * Build a topics filter row for the "SquadFull" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  squadFullEventFilter(topicValues?: { market_id?: bigint }): string[] {
    return this.spec.eventTopicFilter("SquadFull", topicValues);
  }
  /**
   * Build a topics filter row for the "Withdrawn" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  withdrawnEventFilter(topicValues?: { market_id?: bigint; side?: number; participant?: string | Address }): string[] {
    return this.spec.eventTopicFilter("Withdrawn", topicValues);
  }
  /**
   * Build a topics filter row for the "FeesClaimed" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  feesClaimedEventFilter(topicValues?: { recipient?: string | Address }): string[] {
    return this.spec.eventTopicFilter("FeesClaimed", topicValues);
  }
  /**
   * Build a topics filter row for the "OracleQueued" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  oracleQueuedEventFilter(topicValues?: { next?: string | Address }): string[] {
    return this.spec.eventTopicFilter("OracleQueued", topicValues);
  }
  /**
   * Build a topics filter row for the "PayoutParked" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  payoutParkedEventFilter(topicValues?: { market_id?: bigint; side?: number; participant?: string | Address }): string[] {
    return this.spec.eventTopicFilter("PayoutParked", topicValues);
  }
  /**
   * Build a topics filter row for the "MarketCreated" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  marketCreatedEventFilter(topicValues?: { market_id?: bigint; captain?: string | Address }): string[] {
    return this.spec.eventTopicFilter("MarketCreated", topicValues);
  }
  /**
   * Build a topics filter row for the "OracleChanged" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  oracleChangedEventFilter(topicValues?: { next?: string | Address }): string[] {
    return this.spec.eventTopicFilter("OracleChanged", topicValues);
  }
  /**
   * Build a topics filter row for the "LiquidityAdded" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  liquidityAddedEventFilter(topicValues?: { market_id?: bigint; side?: number }): string[] {
    return this.spec.eventTopicFilter("LiquidityAdded", topicValues);
  }
  /**
   * Build a topics filter row for the "MarketCancelled" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  marketCancelledEventFilter(topicValues?: { market_id?: bigint; captain?: string | Address }): string[] {
    return this.spec.eventTopicFilter("MarketCancelled", topicValues);
  }
  /**
   * Build a topics filter row for the "OracleCancelled" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  oracleCancelledEventFilter(): string[] {
    return this.spec.eventTopicFilter("OracleCancelled");
  }
  /**
   * Build a topics filter row for the "LiquidityRemoved" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  liquidityRemovedEventFilter(topicValues?: { market_id?: bigint; side?: number }): string[] {
    return this.spec.eventTopicFilter("LiquidityRemoved", topicValues);
  }
  /**
   * Build a topics filter row for the "FeeRecipientQueued" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  feeRecipientQueuedEventFilter(topicValues?: { next?: string | Address }): string[] {
    return this.spec.eventTopicFilter("FeeRecipientQueued", topicValues);
  }
  /**
   * Build a topics filter row for the "FeeRecipientChanged" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  feeRecipientChangedEventFilter(topicValues?: { next?: string | Address }): string[] {
    return this.spec.eventTopicFilter("FeeRecipientChanged", topicValues);
  }
  /**
   * Build a topics filter row for the "FeeRecipientCancelled" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  feeRecipientCancelledEventFilter(): string[] {
    return this.spec.eventTopicFilter("FeeRecipientCancelled");
  }
  /**
   * Build a topics filter row for the "MarketDeadlineReached" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  marketDeadlineReachedEventFilter(topicValues?: { market_id?: bigint }): string[] {
    return this.spec.eventTopicFilter("MarketDeadlineReached", topicValues);
  }
  /**
   * Build a topics filter row for the "MarketStateTransitioned" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  marketStateTransitionedEventFilter(topicValues?: { market_id?: bigint }): string[] {
    return this.spec.eventTopicFilter("MarketStateTransitioned", topicValues);
  }
}