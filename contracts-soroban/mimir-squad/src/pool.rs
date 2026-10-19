//! Market lifecycle: create, deposit, withdraw, resolve, claim.

use soroban_sdk::{Address, Env, String};

use crate::escrow;
use crate::events;
use crate::storage;
use crate::types::{
    ClaimResult, Error, Market, PendingOracle, BPS_DIVISOR, MAX_DURATION, MAX_FEE_BPS,
    MAX_PARTICIPANTS_PER_SIDE, MAX_QUESTION_BYTES, MAX_SQUAD_MEMBERS, MIN_DURATION,
    ORACLE_TIMELOCK_SECONDS, RESULT_CANCELLED, SIDE_A, SIDE_B,
};

/// The fee on one winning claim: `floor(profit * fee_bps / BPS_DIVISOR)`.
///
/// Fees apply to PROFIT only, so a winner never receives less than their
/// principal. The division truncates, so the fee rounds DOWN and the fractional
/// remainder stays with the participant: `net = gross - fee`, so fee rounding
/// never leaves anything behind in escrow. `claim` and `preview_claim` both use
/// this one function, so a preview cannot round differently from the payout.
pubcrate fn profit_fee(principal: i128, gross: i128, fee_bps: u32) -> Result<i128, Error> {
    let profit = if gross > principal {
        gross - principal
    } else {
        0
    };
    profit
        .checked_mul(fee_bps as i128)
        .map(|p| p / BPS_DIVISOR)
        .ok_or(Error::Overflow)
}

fn require_side(side: u32) -> Result<(), Error> {
    if side != SIDE_A && side != SIDE_B {
        return Err(Error::BadSide);
    }
    Ok(()
}

/// Invariant: escrow accounting must conserve funds.
///
/// After resolve, `remaining_escrow == pool_a + pool_b`.
/// After each claim, `remaining_escrow` never goes negative and never exceeds
/// the original pools. Fees are accrued separately and are not part of
/// `remaining_escrow`.
fn assert_market_conservation(market: &Market) -> Result<(), Error> {
    if market.remaining_escrow < 0 {
        return Err(Error::ConservationViolation);
    }
    if market.pool_a < 0 || market.pool_b < 0 {
        return Err(Error::ConservationViolation);
    }
    if market.resolved {
        let total = market
            .pool_a
            .checked_add(market.pool_b)
            .ok_or(Error::Overflow)?;
        // Remaining escrow must never exceed the resolved pool total.
        if market.remaining_escrow > total {
            return Err(Error::ConservationViolation);
        }
    }
    Ok(()
}

/// The gross payout for one winning claim, before fees.
///
/// Every winner but the final one receives their pro-rata share,
/// `floor((pool_a + pool_b) * principal / winner_pool)`, which truncates. The
/// last winner to claim receives whatever `remaining_escrow` is left, so the
/// pool-share truncation dust is distributed rather than stranded in escrow.
///
/// `claim` and `preview_claim` both call this one function, so the dust branch
/// cannot be computed two different ways: a preview of the final winner cannot
/// round differently from the payout it is previewing.
fn winner_gross(market: &Market, principal: i128) -> Result<i128, Error> {
    let winner_pool = if market.result == SIDE_A {
        market.pool_a
    } else {
        market.pool_b
    };
    let winner_count = if market.result == SIDE_A {
        market.participants_a
    } else {
        market.participants_b
    };

    // `winner_claims` counts winners that have already pulled. This call is the
    // next one, so it closes the escrow when it is the final winner.
    if market.winner_claims + 1 == winner_count {
        return Ok(market.remaining_escrow);
    }

    (market.pool_a + market.pool_b)
        .checked_mul(principal)
        .map(|p| p / winner_pool)
        .ok_or(Error::Overflow)
}

pub fn initialize(
    env: &Env,
    usdc: Address,
    oracle: Address,
    fee_recipient: Address,
) -> Result<(), Error> {
    if storage::is_initialized(env) {
        return Err(Error::AlreadyInitialized);
    }
    escrow::require_usdc_decimals(env, &usdc)?;
    storage::mark_initialized(env);
    storage::set_config(env, &usdc, &oracle, &fee_recipient);
    Ok(()
}

pub fn create_market(
    env: &Env,
    captain: Address,
    question: String,
    deadline: u64,
    fee_bps: u32,
) -> Result<u64, Error> {
    captain.require_auth();

    if question.is_empty() {
        return Err(Error::EmptyQuestion);
    }
    if question.len() > MAX_QUESTION_BYTES {
        return Err(Error::QuestionTooLong);
    }
    let now = env.ledger().timestamp();
    let earliest = now.checked_add(MIN_DURATION).ok_or(Error::Overflow)?;
    let latest = now.checked_add(MAX_DURATION).ok_or(Error::Overflow)?;
    if deadline < earliest || deadline > latest {
        return Err(Error::BadDeadline);
    }
    if fee_bps > MAX_FEE_BPS {
        return Err(Error::FeeCapExceeded);
    }

    let id = storage::market_count(env) + 1;
    storage::set_market_count(env, id);
    storage::set_market(
        env,
        id,
        &Market {
            captain: captain.clone(),
            deadline,
            fee_bps,
            result: 0,
            resolved: false,
            pool_a: 0,
            pool_b: 0,
            remaining_escrow: 0,
            participants_a: 0,
            participants_b: 0,
            winner_claims: 0,
        },
    );

    events::MarketCreated {
        market_id: id,
        captain,
        deadline,
        fee_bps,
        question,
    }
    .publish(env);
    Ok(id)
}

pub fn deposit(
    env: &Env,
    participant: Address,
    market_id: u64,
    side: u32,
    amount: i128,
) -> Result<(), Error> {
    participant.require_auth();

    let mut market = storage::get_market(env, market_id)?;
    if market.resolved || env.ledger().timestamp() >= market.deadline {
        return Err(Error::MarketClosed);
    }
    require_side(side)?;
    if amount <= 0 {
        return Err(Error::ZeroAmount);
    }

    // The participant count only moves on a NEW depositor to that side, so
    // topping up an existing position never consumes a slot.
    let previous = storage::deposit_of(env, market_id, side, &participant);
    if previous == 0 {
        // ── Total-membership cap (across both sides) ──────────────────────
        // This fires before the per-side check so callers get a clear signal
        // that the squad itself is full, not just the target side.
        let total = market
            .participants_a
            .checked_add(market.participants_b)
            .ok_or(Error::Overflow)?;
        if total >= MAX_SQUAD_MEMBERS {
            return Err(Error::SquadFull);
        }

        // ── Per-side cap ───────────────────────────────────────────────────────────────────
        let count = if side == SIDE_A {
            market.participants_a
        } else {
            market.participants_b
        };
        if count >= MAX_PARTICIPANTS_PER_SIDE {
            return Err(Error::SideFull);
        }
        if side == SIDE_A {
            market.participants_a += 1;
        } else {
            market.participants_b += 1;
        }
    }

    let usdc = storage::usdc(env)?;
    escrow::pull(env, &usdc, &participant, amount)?;

    storage::set_deposit(env, market_id, side, &participant, previous + amount);
    if side == SIDE_A {
        market.pool_a += amount;
    } else {
        market.pool_b += amount;
    }
    storage::set_market(env, market_id, &market);

    let new_pool_total = if side == SIDE_A {
        market.pool_a
    } else {
        market.pool_b
    };

    if previous == 0 {
        let total_now = market
            .participants_a
            .checked_add(market.participants_b)
            .ok_or(Error::Overflow)?;
        if total_now == MAX_SQUAD_MEMBERS {
            events::SquadFull {
                market_id,
                total_members: total_now,
            }
            .publish(env);
        }
    }

    events::LiquidityAdded {
        market_id,
        side,
        amount,
        new_pool_total,
        shares_issued: amount,
    }
    .publish(env);

    events::Deposited {
        market_id,
        side,
        participant,
        amount,
        shares: amount, // shares equal deposited units
    }
    .publish(env);
    Ok(())
}

pub fn withdraw_before_deadline(
    env: &Env,
    participant: Address,
    market_id: u64,
    side: u32,
    amount: i128,
) -> Result<(), Error> {
    participant.require_auth();
    require_side(side)?;

    let mut market = storage::get_market(env, market_id)?;
    if market.resolved || env.ledger().timestamp() >= market.deadline {
        return Err(Error::Locked);
    }

    let balance = storage::deposit_of(env, market_id, side, &participant);
    if balance == 0 {
        return Ok(());
    }
    if amount <= 0 || amount > balance {
        return Err(Error::BadAmount);
    }

    let next = balance - amount;
    storage::set_deposit(env, market_id, side, &participant, next);
    if side == SIDE_A {
        market.pool_a -= amount;
        if next == 0 {
            market.participants_a -= 1;
        }
    } else {
        market.pool_b -= amount;
        if next == 0 {
            market.participants_b -= 1;
        }
    }
    storage::set_market(env, market_id, &market);

    let usdc = storage::usdc(env)?;
    escrow::push(env, &usdc, &participant, amount);

    let new_pool_total = if side == SIDE_A {
        market.pool_a
    } else {
        market.pool_b
    };

    events::LiquidityRemoved {
        market_id,
        side,
        amount,
        new_pool_total,
        shares_burned: amount,
    }
    .publish(env);

    events::Withdrawn {
        market_id,
        side,
        participant,
        amount,
    }
    .publish(env);
    Ok(()
}


pub fn transition_deadline(env: &Env, market_id: u64) -> Result<(), Error> {
    let mut market = storage::get_market(env, market_id)?;
    if market.resolved {
        return Err(Error::Locked);
    }
    if market.pool_a > 0 && market.pool_b > 0 {
        return Ok(());
    }
    if env.ledger().timestamp() < market.deadline {
        return Err(Error::Locked);
    }

    events::MarketDeadlineReached {
        market_id,
        deadline: market.deadline,
        pool_a_total: market.pool_a,
        pool_b_total: market.pool_b,
    }
    .publish(env);

    market.resolved = true;
    market.result = RESULT_CANCELLED;
    market.remaining_escrow = market
        .pool_a
        .checked_add(market.pool_b)
        .ok_or(Error::Overflow)?;
    assert_market_conservation(&market)?;
    
    events::MarketStateTransitioned {
        market_id,
        from_state: 0, // Active
        to_state: 2,   // Resolved
        timestamp: env.ledger().timestamp(),
    }
    .publish(env);
    
    storage::set_market(env, market_id, &market);

    events::Resolved {
        market_id,
        result: RESULT_CANCELLED,
        pool_a: market.pool_a,
        pool_b: market.pool_b,
    }
    .publish(env);
    Ok(()
}

pub fn resolve(env: &Env, market_id: u64, result: u32) -> Result<(), Error> {
    storage::oracle(env)?.require_auth();

    let mut market = storage::get_market(env, market_id)?;
    if market.resolved {
        if market.result == result {
            return Ok(());
        } else {
            return Err(Error::NotResolvable);
        }
    }
    if env.ledger().timestamp() < market.deadline {
        return Err(Error::NotResolvable);
    }
    if result != SIDE_A && result != SIDE_B && result != RESULT_CANCELLED {
        return Err(Error::BadResult);
    }
    if result != RESULT_CANCELLED {
        let winner_pool = if result == SIDE_A {
            market.pool_a
        } else {
            market.pool_b
        };
        if winner_pool <= 0 {
            return Err(Error::EmptyWinner);
        }
    }

    events::MarketDeadlineReached {
        market_id,
        deadline: market.deadline,
        pool_a_total: market.pool_a,
        pool_b_total: market.pool_b,
    }
    .publish(env);

    market.resolved = true;
    market.result = result;
    market.remaining_escrow = market
        .pool_a
        .checked_add(market.pool_b)
        .ok_or(Error::Overflow)?;
    assert_market_conservation(&market)?;
    
    events::Ma
}
