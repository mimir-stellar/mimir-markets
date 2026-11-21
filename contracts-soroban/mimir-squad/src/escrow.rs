//! USDC custody for the squad pool.

use soroban_sdk::{token, Address, Env};

use crate::types::{Error, USDC_DECIMALS};

/// Refuse an escrow token whose scale is not [`USDC_DECIMALS`]. A token that
/// cannot answer `decimals()` is not a SEP-41 token, so it is rejected as
/// unsupported rather than trapping.
pub fn require_usdc_decimals(env: &Env, usdc: &Address) -> Result<(), Error> {
    match token::TokenClient::new(env, usdc).try_decimals() {
        Ok(Ok(decimals)) if decimals == USDC_DECIMALS => Ok(()),
        Ok(Ok(_)) => Err(Error::UnsupportedDecimals),
        _ => Err(Error::UnsupportedToken),
    }
}

/// Move `amount` from `from` into contract escrow, asserting the escrow balance
/// moved by exactly that much. Fee-on-transfer and rebasing assets would break
/// pool accounting, so they are rejected at the door.
pub fn pull(env: &Env, usdc: &Address, from: &Address, amount: i128) -> Result<(), Error> {
    let client = token::TokenClient::new(env, usdc);
    let here = env.current_contract_address();
    let before = client.balance(&here);
    client.transfer(from, &here, &amount);
    if client.balance(&here) != before + amount {
        return Err(Error::UnsupportedToken);
    }
    Ok(())
}

/// Why a squad withdrawal could not be satisfied. Kept stable so callers and
/// indexers can branch on the reason rather than parse messages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WithdrawalUnavailable {
    /// The account has no position in the pool at all.
    NoPosition,
    /// The account has a position, but less than the requested amount is unlocked.
    InsufficientUnlocked,
    /// The pool is in a state that does not permit withdrawals.
    IncompatibleState,
}

/// Classify why a withdrawal of `requested` cannot proceed, or `None` when it
/// can. Authorization is checked by the caller before this is consulted, so the
/// existing checks are preserved unchanged.
pub fn classify_withdrawal(
    has_position: bool,
    unlocked: i128,
    requested: i128,
    state_allows_withdrawal: bool,
) -> Option<WithdrawalUnavailable> {
    if !state_allows_withdrawal {
        return Some(WithdrawalUnavailable::IncompatibleState);
    }
    if !has_position {
        return Some(WithdrawalUnavailable::NoPosition);
    }
    if unlocked < requested {
        return Some(WithdrawalUnavailable::InsufficientUnlocked);
    }
    None
}

/// Push a payout. Squad settlement is already pull-based per participant, so a
/// failure here affects only the caller and is allowed to propagate — matching
/// `require(usdc.transfer(...))` in the Solidity.
pub fn push(env: &Env, usdc: &Address, to: &Address, amount: i128) {
    token::TokenClient::new(env, usdc).transfer(&env.current_contract_address(), to, &amount);
}

/// Push a payout without letting the token abort the caller.
///
/// A deauthorized (frozen) trustline makes the token trap, which under
/// [`push`] reverts the whole invocation — a winner with a frozen trustline
/// could not settle at all. This variant surfaces the same failure as `false`,
/// so the caller can keep the accounting it has already applied and park the
/// amount instead of unwinding it. The failed sub-call changes nothing: the
/// funds stay in escrow.
pub fn try_push(env: &Env, usdc: &Address, to: &Address, amount: i128) -> bool {
    let client = token::TokenClient::new(env, usdc);
    // `try_*` returns the sub-call's own error shape wrapped in an invocation
    // result; only `Ok(Ok(()))` means the transfer completed. A SEP-41 token
    // that reports failure through its error type and a Stellar Asset Contract
    // that traps both land outside it.
    matches!(
        client.try_transfer(&env.current_contract_address(), to, &amount),
        Ok(Ok(()))
    )
}

#[cfg(test)]
mod withdrawal_reason_tests {
    use super::*;

    #[test]
    fn no_position_is_distinct() {
        assert_eq!(
            classify_withdrawal(false, 0, 10, true),
            Some(WithdrawalUnavailable::NoPosition)
        );
    }

    #[test]
    fn insufficient_unlocked_boundary() {
        assert_eq!(
            classify_withdrawal(true, 9, 10, true),
            Some(WithdrawalUnavailable::InsufficientUnlocked)
        );
        assert_eq!(classify_withdrawal(true, 10, 10, true), None);
    }

    #[test]
    fn incompatible_state_takes_precedence() {
        assert_eq!(
            classify_withdrawal(false, 0, 10, false),
            Some(WithdrawalUnavailable::IncompatibleState)
        );
    }
}

pub fn balance(env: &Env, usdc: &Address) -> i128 {
    token::TokenClient::new(env, usdc).balance(&env.current_contract_address())
}

/// Read-only escrow view for settlement readiness: returns the escrow balance
/// without any state mutation, so callers can report withdrawal availability
/// independently of resolution.
pub fn readable_balance(env: &Env, usdc: &Address) -> i128 {
    balance(env, usdc)
}
