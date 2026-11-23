# Mimir Contract Errors Reference

This document provides a comprehensive reference of all error codes returned by the Mimir Soroban smart contracts (`mimir-market` and `mimir-squad`). Stale approved fee-policy changes are rejected with the typed `StaleFeePolicyRevision` error (`mimir-market`), preserving the active policy and all balances.

## Overview

Soroban smart contracts define errors with `#[contracterror]` and numeric `#[repr(u32)]` discriminants. When a transaction reverts on-chain or during RPC simulation, the Soroban host returns a `ContractError(u32)` code.

Client SDKs and UI applications can map these numeric error codes or their variant names to user-friendly error messages, diagnose transaction failures, and provide actionable remediation guidance.

### Source Files

- **`mimir-market`**: [`contracts-soroban/mimir-market/src/types.rs`](../contracts-soroban/mimir-market/src/types.rs)
- **`mimir-squad`**: [`contracts-soroban/mimir-squad/src/types.rs`](../contracts-soroban/mimir-squad/src/types.rs)

---

## Contract Errors Table

| Code | Name | Contract | Entry Points | Cause | Remediation |
| ---: | :--- | :--- | :--- | :--- | :--- |
| 1 | `AlreadyInitialized` | `mimir-market` | `initialize` | Contract initialization was called when the contract was already initialized. | No action needed; initialization is a one-time operation. Do not re-initialize an existing market contract. |
| 2 | `NotInitialized` | `mimir-market` | `get_claim`, `get_claims_batch`, `get_claim_market_config`, `get_claim_fees`, `get_verdict`, `get_verdict_side`, `get_fee_policy`, `get_owner`, `get_oracle`, `get_usdc`, `get_platform_stats` | Contract entry point was called before `initialize` has been executed. | Call `initialize` with valid configuration addresses and parameters before invoking other methods. |
| 3 | `NotOwner` | `mimir-market` | `transfer_ownership`, `queue_fee_policy`, `cancel_fee_policy` | Transaction caller is not the contract owner (admin actions require owner authorization). | Sign and submit the transaction with the contract owner account. |
| 4 | `NotOracle` | `mimir-market` | `resolve_claim`, `resolve_claim_versioned`, `queue_oracle`, `cancel_oracle` | Transaction caller is not the configured oracle address. | Ensure the call is authorized by the oracle address configured in `get_oracle()`. |
| 5 | `FeeCapExceeded` | `mimir-market` | `initialize`, `queue_fee_policy` | Combined platform and agent owner fee bps exceeds `MAX_TOTAL_FEE_BPS` (1,000 bps = 10%). | Set fee parameters such that `platform_fee_bps + agent_owner_fee_bps <= 1000`. |
| 6 | `FeeNeedsRecipient` | `mimir-market` | `initialize`, `queue_fee_policy` | Non-zero `platform_fee_bps` was configured without providing a `platform_recipient` address. | Supply a valid `platform_recipient` address whenever `platform_fee_bps > 0`. |
| 7 | `NothingQueued` | `mimir-market` | `cancel_oracle`, `execute_oracle`, `cancel_fee_policy`, `execute_fee_policy` | Attempted to cancel or execute an oracle or fee policy update when no change was queued. | Call `queue_oracle` or `queue_fee_policy` before attempting to cancel or execute the change. |
| 8 | `Timelocked` | `mimir-market` | `execute_oracle`, `execute_fee_policy`, `transition_deadline` | For governance: the 2-day timelock has not yet elapsed. For `transition_deadline`: the claim deadline plus 60-second challenge lock window has not yet passed. | Wait until the required timelock or challenge lock window has fully elapsed before calling. |
| 9 | `StakeTooSmall` | `mimir-market` | `create_claim`, `challenge_claim` | Stake amount is below the required `MIN_STAKE` (2 USDC = 20,000,000 atomic units). | Increase stake to at least 2 USDC (20,000,000 stroops/units). |
| 10 | `DeadlineInPast` | `mimir-market` | `create_claim` | Market deadline timestamp is less than or equal to current ledger timestamp. | Provide a future unix timestamp for the market resolution deadline. |
| 11 | `EmptyQuestion` | `mimir-market` | `create_claim` | The claim question string is empty. | Provide a non-empty question string describing the market proposition. |
| 12 | `ClaimNotFound` | `mimir-market` | `get_claim`, `get_claim_market_config`, `get_claim_fees`, `get_verdict`, `get_verdict_side`, `quote_challenger_payout`, `challenge_claim`, `resolve_claim`, `resolve_claim_versioned`, `transition_deadline`, `cancel_claim`, `claim_challenger_payout` | No market claim exists for the given `claim_id`. | Check the claim ID and verify the claim was created successfully. |
| 13 | `ClaimNotOpen` | `mimir-market` | `challenge_claim`, `transition_deadline`, `cancel_claim` | Operation requires `ClaimState::Open`, but the claim is in a different state (Active, Resolved, or Cancelled). | Check `get_claim(claim_id).state`; challenges and creator cancellations are only allowed while open. |
| 14 | `SelfChallenge` | `mimir-market` | `challenge_claim` | The creator attempted to challenge their own claim. | A challenge must come from a different wallet address than the creator address. |
| 15 | `AlreadyChallenged` | `mimir-market` | `challenge_claim` | The account has already submitted a challenge for this claim when duplicate challenges are restricted. | Use another account or wait for new challenge opportunities on other claims. |
| 16 | `ClaimFull` | `mimir-market` | `challenge_claim` | Maximum number of challengers for this market has been reached (`challenger_count >= max_challengers` or 100). | Market roster is full; join a different open market or wait for a rematch. |
| 17 | `ChallengeWindowClosed` | `mimir-market` | `challenge_claim` | Challenge submitted within the 60-second lock window prior to the deadline (`now > deadline - 60s`). | Submit challenges before the 60-second final pre-deadline lock period begins. |
| 18 | `InvalidInviteKey` | `mimir-market` | `challenge_claim` | Private market challenge provided a missing, incorrect, or mismatched invite key. | Provide the correct invite key secret associated with this private market. |
| 19 | `DuelNeedsEqualStake` | `mimir-market` | `challenge_claim` | In 1v1 duel mode, the challenger stake must exactly match the creator stake. | Set the challenger stake amount equal to `claim.creator_stake`. |
| 20 | `InsufficientCreatorLiquidity` | `mimir-market` | `challenge_claim`, `resolve_claim`, `resolve_claim_versioned` | Creator available stake cannot cover the payout liability for this challenge or settlement. | Reduce the challenger stake or adjust the payout ratio to fit within remaining creator stake. |
| 21 | `ClaimNotActive` | `mimir-market` | `resolve_claim`, `resolve_claim_versioned` | Oracle attempted to resolve a claim that is not in `ClaimState::Active` (e.g. Open, Resolved, or Cancelled). | Only challenged active claims can be resolved. If unchallenged and expired, call `transition_deadline`. |
| 22 | `NotYetExpired` | `mimir-market` | `resolve_claim`, `resolve_claim_versioned` | Oracle attempted to resolve a claim before its deadline timestamp has passed (`now < deadline`). | Wait until the claim deadline timestamp has passed before submitting the resolution verdict. |
| 23 | `InvalidVerdict` | `mimir-market` | `resolve_claim`, `resolve_claim_versioned`, `get_verdict_side` | Resolution verdict side was `WinnerSide::None`. | Specify a conclusive resolution outcome: `Creator`, `Challengers`, `Draw`, or `Unresolvable`. |
| 24 | `NotCreator` | `mimir-market` | `cancel_claim` | Transaction caller is not the creator of the claim. | Sign the cancellation call with the address that created the claim. |
| 25 | `NothingToWithdraw` | `mimir-market` | `withdraw` | The account has no withdrawable funds stored under `withdrawable`. | Check `get_withdrawable(account)` before attempting to withdraw; no funds are pending. |
| 26 | `NoFees` | `mimir-market` | `claim_fees` | No accrued fees are available for the caller to claim. | Check `get_accrued_fees(account)` before claiming; only accumulated fee recipients can claim. |
| 27 | `PayoutExceedsEscrow` | `mimir-market` | `resolve_claim`, `resolve_claim_versioned`, `claim_challenger_payout` | Computed settlement payout exceeds available claim escrow balance. | Contract accounting integrity failure; do not retry without auditing contract balance. |
| 28 | `UnsupportedToken` | `mimir-market` | `initialize`, `create_claim`, `challenge_claim`, `claim_challenger_payout`, `withdraw`, `claim_fees` | Token contract call failed or address is not a valid token contract. | Verify that the USDC token contract address is deployed and has the expected token interface. |
| 29 | `Overflow` | `mimir-market` | `initialize`, `queue_oracle`, `queue_fee_policy`, `create_claim`, `challenge_claim`, `resolve_claim`, `resolve_claim_versioned`, `claim_challenger_payout` | Arithmetic calculation exceeded integer bounds during stake or fee aggregation. | Verify amounts and timestamps are within standard bounds and do not cause numeric overflow. |
| 30 | `InviteKeyTooLong` | `mimir-market` | `create_claim`, `challenge_claim` | Private invite key string exceeds `MAX_INVITE_KEY_BYTES` (128 bytes). | Use an invite key string of 128 bytes or fewer. |
| 31 | `ZeroStake` | `mimir-market` | `create_claim`, `challenge_claim` | Escrow deposit amount is zero or negative. | Specify a positive stake amount equal to or above `MIN_STAKE`. |
| 32 | `ClaimNotResolved` | `mimir-market` | `claim_challenger_payout`, `quote_challenger_payout`, `get_verdict`, `get_verdict_side` | Operation attempted on a claim that has not yet reached `ClaimState::Resolved`. | Wait for oracle resolution before querying verdicts or claiming challenger payouts. |
| 33 | `NotAChallenger` | `mimir-market` | `claim_challenger_payout`, `quote_challenger_payout` | Caller address is not listed in the claim challenger roster. | Only addresses that placed a challenge can claim payouts; verify participant address. |
| 34 | `AlreadyClaimedPayout` | `mimir-market` | `claim_challenger_payout` | Challenger has already claimed their payout for this market claim. | Payout has already been collected; verify payout history on-chain. |
| 35 | `ChallengersDidNotWin` | `mimir-market` | `claim_challenger_payout`, `quote_challenger_payout` | Claim resolved with `WinnerSide::Creator`; challengers are not owed winnings. | No challenger payout is available when the creator wins the claim. |
| 36 | `UnsupportedDecimals` | `mimir-market` | `initialize` | Token contract reported decimals other than `USDC_DECIMALS` (7). | Initialize contract with Stellar Asset Contract USDC, which uses exactly 7 decimals. |
| 37 | `InvalidConfidence` | `mimir-market` | `resolve_claim`, `resolve_claim_versioned` | Oracle confidence score exceeds 10,000 (100% in bps). | Oracle must submit confidence between 0 and 10,000 bps inclusive. |
| 38 | `ClaimHasActiveClaims` | `mimir-market` | `cancel_claim` | Creator attempted to cancel a claim that has accepted counterparty challenger stake or liability. | Challenged markets cannot be cancelled by the creator; market must proceed to oracle resolution. |
| 39 | `RefundNotEscrowed` | `mimir-market` | `cancel_claim` | Contract token balance cannot cover creator stake refund at the time of cancellation. | Retry when contract escrow balance is restored to satisfy refund. |
| 40 | `UnsupportedVerdictVersion` | `mimir-market` | `resolve_claim_versioned`, `get_verdict`, `get_verdict_side` | Verdict version does not match `VERDICT_VERSION_V1` (1). | Submit verdicts formatted with version 1 encoding. |
| 41 | `MetadataTooLong` | `mimir-market` | `create_claim`, `resolve_claim`, `resolve_claim_versioned` | A single claim metadata field exceeds `MAX_METADATA_BYTES` (512 bytes). | Ensure each text field (question, positions, URL, category, rules, summary) is at most 512 bytes. |
| 42 | `ClaimMetadataTooLong` | `mimir-market` | `create_claim`, `resolve_claim`, `resolve_claim_versioned` | Combined byte length of all claim metadata fields exceeds `MAX_CLAIM_METADATA_BYTES` (2,048 bytes). | Shorten the total textual content so aggregate metadata is 2,048 bytes or fewer. |
| 43 | `ParentClaimNotFound` | `mimir-market` | `create_claim` | Specified `parent_id` does not reference an existing claim. | Provide the ID of an existing parent claim or omit `parent_id`. |
