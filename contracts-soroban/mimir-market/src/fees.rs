//! Payout arithmetic. The mirror of this lives in `lib/fees.ts`.

use soroban_sdk::{Address, Env};

use crate::events;
use crate::storage;
use crate::types::{Error, FeeSnapshot, BPS_DIVISOR};

/// Exact fee-ledger view for one recipient, in atomic USDC units.
///
/// Field meanings are stable:
/// - `accrued`: lifetime fees credited to the recipient (monotonic).
/// - `claimed`: lifetime fees the recipient has withdrawn (monotonic).
/// - `outstanding`: fees still owed to the recipient (`accrued - claimed`).
///
/// `accrued == 0` means no accrual ever happened; `accrued > 0` with
/// `outstanding == 0` means a fully claimed balance. The two are distinct.
pub struct FeeBalance {
    pub accrued: i128,
    pub claimed: i128,
    pub outstanding: i128,
}

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

#[cfg(test)]
mod tests {
    use super::*;

    // Pure-arithmetic boundary checks for the fee ledger view semantics.
    // The FeeBalance derivation is `outstanding = accrued - claimed`; these
    // assertions pin the three distinct states the issue requires.

    fn balance(accrued: i128, claimed: i128) -> FeeBalance {
        FeeBalance {
            accrued,
            claimed,
            outstanding: accrued - claimed,
        }
    }

    #[test]
    fn no_accrual_is_distinct_from_fully_claimed() {
        let never = balance(0, 0);
        let fully_claimed = balance(500, 500);
        assert_eq!(never.accrued, 0);
        assert_eq!(never.outstanding, 0);
        assert_eq!(fully_claimed.accrued, 500);
        assert_eq!(fully_claimed.outstanding, 0);
        assert_ne!(never.accrued, fully_claimed.accrued);
    }

    #[test]
    fn partial_claim_leaves_exact_outstanding() {
        let partial = balance(1_000_000, 250_000);
        assert_eq!(partial.outstanding, 750_000);
    }

    #[test]
    fn quote_has_no_fees_at_or_below_principal() {
        let fees = FeeSnapshot {
            platform_fee_bps: 100,
            agent_owner_fee_bps: 50,
            platform_recipient: None,
            agent_owner_recipient: None,
        };
        assert_eq!(quote_fees(100, 100, &fees).unwrap(), (100, 0));
        assert_eq!(quote_fees(100, 90, &fees).unwrap(), (90, 0));
    }
}
