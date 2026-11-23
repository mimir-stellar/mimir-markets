//! Payout arithmetic. The mirror of this lives in `lib/fees.ts`.

use soroban_sdk::{Env, Symbol, Vec};

use crate::events;
use crate::storage;
use crate::types::{
    Claim, ClaimState, Error, FeeSnapshot, PayoutPreview, WinnerSide, BPS_DIVISOR,
};

/// `stake * bps / BPS_DIVISOR`, truncating. Checked multiplication so an
/// absurd stake errors instead of wrapping, matching Solidity 0.8 revert-on-
/// overflow semantics.
/// Returns `Error::StaleFeePolicyRevision` when an approved administrative
/// change is stale relative to the active fee-policy revision.
/// Callers must reject such changes and leave the active policy and balances untouched.
pub fn check_policy_revision(expected: u64, active: u64) -> Result<(), Error> {
    if expected != active {
        return Err(Error::StaleFeePolicyRevision);
    }
    Ok(())
}

pub fn gross_payout(stake: i128, bps: u32) -> Result<i128, Error> {
    stake
        .checked_mul(bps as i128)
        .map(|p| p / BPS_DIVISOR)
        .ok_or(Error::Overflow)
}

/// Pool-mode share of the creator's stake owed to one challenger:
/// `challenger_stake * creator_stake / total_challenger_stake`, truncating.
pub fn pool_share(
    challenger_stake: i128,
    creator_stake: i128,
    total_challenger_stake: i128,
) -> Result<i128, Error> {
    if total_challenger_stake == 0 {
        return Ok(0);
    }
    challenger_stake
        .checked_mul(creator_stake)
        .map(|p| p / total_challenger_stake)
        .ok_or(Error::Overflow)
}

/// Read the accrued / claimed / outstanding fee values for `recipient`.
///
/// Values are exact atomic integers read from contract state, which remains
/// authoritative. `outstanding` is derived as `accrued - claimed` and is never
/// negative under the invariant that claims never exceed accruals.
pub fn fee_balance(env: &Env, recipient: &Address) -> FeeBalance {
    let accrued = storage::get_accrued_fees(env, recipient);
    let claimed = storage::get_claimed_fees(env, recipient);
    FeeBalance {
        accrued,
        claimed,
        outstanding: accrued - claimed,
    }
}

/// The fee split for a gross payout, without accruing anything. Returns
/// `(owed, fees_taken)`.
///
/// A fee with no recipient is not charged. The init/queue guards already make
/// this unreachable for the platform fee; keeping it here means a malformed
/// snapshot can never mint an unclaimable balance.
pub fn quote_fees(principal: i128, gross: i128, fees: &FeeSnapshot) -> Result<(i128, i128), Error> {
    if gross <= principal {
        return Ok((gross, 0));
    }
    let profit = gross - principal;

    let platform_fee = match &fees.platform_recipient {
        Some(_) => bps_of(profit, fees.platform_fee_bps)?,
        None => 0,
    };
    let owner_fee = match &fees.agent_owner_recipient {
        Some(_) => bps_of(profit, fees.agent_owner_fee_bps)?,
        None => 0,
    };

    let fees_taken = platform_fee + owner_fee;
    Ok((gross - fees_taken, fees_taken))
}

fn bps_of(amount: i128, bps: u32) -> Result<i128, Error> {
    amount
        .checked_mul(bps as i128)
        .map(|p| p / BPS_DIVISOR)
        .ok_or(Error::Overflow)
}

#[cfg(test)]
mod settlement_vector_tests {
    //! Independently derived expected values for tiny atomic USDC stakes.
    //! Expectations are computed by hand (integer floor division), not by
    //! calling the contract's own helpers, so they cross-check the logic.
    use super::*;

    #[test]
    fn pool_share_splits_with_indivisible_remainder() {
        // Three challengers stake 1, 1, 1 (total 3) against a creator stake of 2.
        // Each owes floor(1 * 2 / 3) = 0, so the whole pool remains as dust.
        assert_eq!(pool_share(1, 2, 3).unwrap(), 0);
        assert_eq!(pool_share(1, 2, 3).unwrap() + pool_share(1, 2, 3).unwrap() + pool_share(1, 2, 3).unwrap(), 0);
        // Stakes 2, 3, 5 (total 10) against creator stake 7:
        // floor(2*7/10)=1, floor(3*7/10)=2, floor(5*7/10)=3 -> sum 6, dust 1.
        assert_eq!(pool_share(2, 7, 10).unwrap(), 1);
        assert_eq!(pool_share(3, 7, 10).unwrap(), 2);
        assert_eq!(pool_share(5, 7, 10).unwrap(), 3);
    }

    #[test]
    fn pool_share_zero_total_is_zero() {
        assert_eq!(pool_share(0, 5, 0).unwrap(), 0);
    }

    #[test]
    fn pool_share_overflow_errors() {
        assert_eq!(pool_share(i128::MAX, 2, 1), Err(Error::Overflow));
    }

    #[test]
    fn gross_payout_tiny_stakes_round_down() {
        // 1 atomic unit at 3333 bps: floor(3333 / 10000) = 0.
        assert_eq!(gross_payout(1, 3333).unwrap(), 0);
        // 3 atomic units at 5000 bps: floor(15000 / 10000) = 1.
        assert_eq!(gross_payout(3, 5000).unwrap(), 1);
    }

    #[test]
    fn quote_fees_no_profit_takes_nothing() {
        let fees = FeeSnapshot {
            platform_fee_bps: 1000,
            agent_owner_fee_bps: 500,
            platform_recipient: None,
            agent_owner_recipient: None,
        };
        assert_eq!(quote_fees(10, 10, &fees).unwrap(), (10, 0));
        assert_eq!(quote_fees(10, 7, &fees).unwrap(), (7, 0));
    }
}

/// Split a gross payout into fees and the amount owed.
///
/// Fees apply to PROFIT only, so `owed` can never fall below `principal` for a
/// winner. Each leg is `floor(profit * bps / BPS_DIVISOR)`, computed separately,
/// so every leg rounds DOWN and two legs together never take more than one leg
/// at their combined rate would. The fractional remainder stays with the
/// participant (`owed = gross - fees_taken`), so fee rounding leaves nothing in
/// escrow. Escrow dust comes only from pool-share truncation, and the last
/// claimant absorbs it.
///
/// Returns `(owed, fees_taken)` and accrues the fee balances as a side effect.
pub fn apply_fees(
    env: &Env,
    claim_id: u64,
    principal: i128,
    gross: i128,
    fees: &FeeSnapshot,
) -> Result<(i128, i128), Error> {
    let (owed, fees_taken) = quote_fees(principal, gross, fees)?;
    if fees_taken == 0 {
        return Ok((owed, 0));
    }

    let profit = gross - principal;
    let platform_fee = match &fees.platform_recipient {
        Some(_) => bps_of(profit, fees.platform_fee_bps)?,
        None => 0,
    };
    let owner_fee = fees_taken - platform_fee;

    if platform_fee > 0 {
        let to = fees.platform_recipient.clone().unwrap();
        storage::add_accrued_fees(env, &to, platform_fee);
        storage::add_lifetime_fees_accrued(env, platform_fee);
        events::FeeAccrued {
            id: claim_id,
            recipient: to,
            amount: platform_fee,
            is_agent_owner_fee: false,
        }
        .publish(env);
    }
    if owner_fee > 0 {
        let to = fees.agent_owner_recipient.clone().unwrap();
        storage::add_accrued_fees(env, &to, owner_fee);
        storage::add_lifetime_fees_accrued(env, owner_fee);
        events::FeeAccrued {
            id: claim_id,
            recipient: to,
            amount: owner_fee,
            is_agent_owner_fee: true,
        }
        .publish(env);
    }

    Ok((owed, fees_taken))
}

/// What a single claim's liability and payout preview are: `(liability, gross, fee, net)`.
///
/// For Open / Active claims:
/// - Fixed-odds: liability backed by creator is `reserved_creator_liability`.
///   Gross payout to winning challengers is `total_challenger_stake + reserved_creator_liability`.
///   Profit is `reserved_creator_liability`. Fee is computed on profit using `quote_fees`.
/// - Pool mode: liability backed by creator is `creator_stake`.
///   Gross payout to winning challengers is `total_challenger_stake + creator_stake`.
///
/// For Resolved claims:
/// - Challengers won: liability is `remaining_escrow`.
/// - Creator won: liability to challengers is 0.
/// - Cancelled / Draw / Unresolvable: refund of stakes with 0 fee.
pub fn claim_payout_preview(env: &Env, claim: &Claim) -> Result<(i128, i128, i128, i128), Error> {
    match claim.state {
        ClaimState::Open | ClaimState::Active => {
            if crate::util::is_fixed_odds(env, &claim.market.odds_mode) {
                let liability = claim.reserved_creator_liability;
                let gross = claim
                    .total_challenger_stake
                    .checked_add(claim.reserved_creator_liability)
                    .ok_or(Error::Overflow)?;
                let (net, fee) = quote_fees(claim.total_challenger_stake, gross, &claim.fees)?;
                Ok((liability, gross, fee, net))
            } else {
                let liability = claim.creator_stake;
                let gross = claim
                    .total_challenger_stake
                    .checked_add(claim.creator_stake)
                    .ok_or(Error::Overflow)?;
                let (net, fee) = quote_fees(claim.total_challenger_stake, gross, &claim.fees)?;
                Ok((liability, gross, fee, net))
            }
        }
        ClaimState::Resolved => {
            match claim.winner_side {
                WinnerSide::Challengers => {
                    let gross = claim.remaining_escrow;
                    let (net, fee) = quote_fees(claim.total_challenger_stake, gross, &claim.fees)?;
                    Ok((gross, gross, fee, net))
                }
                WinnerSide::Creator => {
                    Ok((0, 0, 0, 0))
                }
                WinnerSide::Draw | WinnerSide::Unresolvable | WinnerSide::None => {
                    let refund = claim
                        .creator_stake
                        .checked_add(claim.total_challenger_stake)
                        .ok_or(Error::Overflow)?;
                    Ok((refund, refund, 0, refund))
                }
            }
        }
        ClaimState::Cancelled => {
            let refund = claim
                .creator_stake
                .checked_add(claim.total_challenger_stake)
                .ok_or(Error::Overflow)?;
            Ok((refund, refund, 0, refund))
        }
    }
}

/// Aggregate payout preview across a slice of claims, tracking completeness.
///
/// Invariants:
/// - Missing observations are marked explicitly (`missing_observations > 0`).
/// - When history is truncated or claims are missing, `is_complete` is `false`.
/// - An incomplete aggregate is NEVER presented as a verified total liability
///   (`verified_total_liability` is `None`).
/// - Only when all claims in history are observed without omission is
///   `verified_total_liability` set to `Some(aggregate_liability)`.
pub fn aggregate_payout_preview(
    env: &Env,
    claims: &soroban_sdk::Vec<Option<Claim>>,
    total_claims: u32,
    is_truncated: bool,
) -> Result<PayoutPreview, Error> {
    let mut aggregate_liability: i128 = 0;
    let mut aggregate_gross: i128 = 0;
    let mut aggregate_fees: i128 = 0;
    let mut aggregate_net: i128 = 0;
    let mut observed_count: u32 = 0;
    let mut missing_in_slice: u32 = 0;

    for opt_claim in claims.iter() {
        match opt_claim {
            Some(claim) => {
                let (liability, gross, fee, net) = claim_payout_preview(env, &claim)?;
                aggregate_liability = aggregate_liability
                    .checked_add(liability)
                    .ok_or(Error::Overflow)?;
                aggregate_gross = aggregate_gross
                    .checked_add(gross)
                    .ok_or(Error::Overflow)?;
                aggregate_fees = aggregate_fees
                    .checked_add(fee)
                    .ok_or(Error::Overflow)?;
                aggregate_net = aggregate_net
                    .checked_add(net)
                    .ok_or(Error::Overflow)?;
                observed_count = observed_count.saturating_add(1);
            }
            None => {
                missing_in_slice = missing_in_slice.saturating_add(1);
            }
        }
    }

    let unobserved_due_to_truncation = total_claims.saturating_sub(observed_count + missing_in_slice);
    let missing_observations = missing_in_slice.saturating_add(unobserved_due_to_truncation);

    let is_complete = !is_truncated && missing_observations == 0 && observed_count == total_claims;

    let verified_total_liability = if is_complete {
        Some(aggregate_liability)
    } else {
        None
    };

    Ok(PayoutPreview {
        aggregate_liability,
        verified_total_liability,
        aggregate_gross,
        aggregate_fees,
        aggregate_net,
        observed_count,
        total_claims,
        missing_observations,
        is_truncated,
        is_complete,
    })
}
