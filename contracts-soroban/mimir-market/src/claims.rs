//! Claim lifecycle: create, challenge, cancel.

use soroban_sdk::{Address, Env, String, Vec};

use crate::escrow;
use crate::events;
use crate::fees;
use crate::storage;
use crate::types::{
    Challenger, Claim, ClaimState, CreateParams, Error, FeeSnapshot, MarketConfig, WinnerSide,
    BPS_DIVISOR, CHALLENGE_LOCK_SECONDS, DEFAULT_PAYOUT_BPS, MAX_CHALLENGERS, MIN_STAKE,
};
use crate::util;

pub fn create_claim(env: &Env, creator: Address, params: CreateParams) -> Result<u64, Error> {
    creator.require_auth();

    if params.stake_amount < MIN_STAKE {
        return Err(Error::StakeTooSmall);
    }
    if params.deadline <= env.ledger().timestamp() {
        return Err(Error::DeadlineInPast);
    }
    if params.question.is_empty() {
        return Err(Error::EmptyQuestion);
    }

    let usdc = storage::usdc(env)?;
    escrow::pull(env, &usdc, &creator, params.stake_amount)?;

    let is_fixed = util::is_fixed_odds(env, &params.odds_mode);
    let payout_bps = if is_fixed {
        if params.challenger_payout_bps as i128 >= BPS_DIVISOR {
            params.challenger_payout_bps
        } else {
            DEFAULT_PAYOUT_BPS
        }
    } else {
        0
    };

    let max_challengers = if params.max_challengers == 0 || params.max_challengers > MAX_CHALLENGERS
    {
        MAX_CHALLENGERS
    } else {
        params.max_challengers
    };

    let invite_key_hash = match &params.invite_key {
        Some(key) if !key.is_empty() => Some(util::hash_string(env, key)?),
        _ => None,
    };

    let id = storage::claim_count(env) + 1;
    storage::set_claim_count(env, id);

    // The policy in force NOW is frozen onto the claim. A later change cannot
    // reach a market whose participants have already committed money.
    let current = storage::fee_policy(env)?;
    let snapshot = FeeSnapshot {
        platform_fee_bps: current.platform_fee_bps,
        agent_owner_fee_bps: current.agent_owner_fee_bps,
        platform_recipient: current.platform_recipient,
        agent_owner_recipient: params.agent_owner_recipient.clone(),
    };

    let claim = Claim {
        creator: creator.clone(),
        question: params.question,
        creator_position: params.creator_position,
        counter_position: params.counter_position,
        resolution_url: params.resolution_url,
        creator_stake: params.stake_amount,
        total_challenger_stake: 0,
        reserved_creator_liability: 0,
        deadline: params.deadline,
        state: ClaimState::Open,
        winner_side: WinnerSide::None,
        resolution_summary: String::from_str(env, ""),
        confidence: 0,
        category: util::or_default(env, &params.category, "custom"),
        parent_id: params.parent_id,
        challenger_count: 0,
        remaining_escrow: 0,
        challenger_claims: 0,
        created_at: env.ledger().timestamp(),
        evidence_hash: None,
        context_hash: params.context_hash,
        market: MarketConfig {
            market_type: util::or_default(env, &params.market_type, "binary"),
            odds_mode: String::from_str(env, if is_fixed { "fixed" } else { "pool" }),
            challenger_payout_bps: payout_bps,
            handicap_line: params.handicap_line,
            settlement_rule: params.settlement_rule,
            max_challengers,
            is_private: params.is_private,
            invite_key_hash,
        },
        fees: snapshot,
    };

    let category = claim.category.clone();
    storage::set_claim(env, id, &claim);
    storage::set_challengers(env, id, &Vec::new(env));

    events::ClaimCreated {
        id,
        creator,
        category,
    }
    .publish(env);
    events::FeePolicySnapshotted {
        id,
        platform_fee_bps: snapshot.platform_fee_bps,
        agent_owner_fee_bps: snapshot.agent_owner_fee_bps,
        platform_recipient: snapshot.platform_recipient.clone(),
        agent_owner_recipient: snapshot.agent_owner_recipient.clone(),
    }
    .publish(env);
    if let Some(agent) = params.agent_owner_recipient {
        events::AgentAttributed {
            id,
            agent_owner_recipient: agent,
        }
        .publish(env);
    }
    Ok(id)
}

pub fn challenge_claim(
    env: &Env,
    challenger: Address,
    claim_id: u64,
    stake_amount: i128,
    invite_key: Option<String>,
) -> Result<(), Error> {
    challenger.require_auth();

    let mut claim = storage::get_claim(env, claim_id)?;
    if claim.state != ClaimState::Open && claim.state != ClaimState::Active {
        return Err(Error::ClaimNotOpen);
    }
    if challenger == claim.creator {
        return Err(Error::SelfChallenge);
    }

    let mut list = storage::challengers(env, claim_id);
    for existing in list.iter() {
        if existing.address == challenger {
            return Err(Error::AlreadyChallenged);
        }
    }
    if claim.challenger_count >= claim.market.max_challengers {
        return Err(Error::ClaimFull);
    }
    if stake_amount < MIN_STAKE {
        return Err(Error::StakeTooSmall);
    }
    // Anti-sniping: a challenge must land at least CHALLENGE_LOCK_SECONDS before
    // the deadline.
    let earliest_close = env
        .ledger()
        .timestamp()
        .checked_add(CHALLENGE_LOCK_SECONDS)
        .ok_or(Error::Overflow)?;
    if earliest_close > claim.deadline {
        return Err(Error::ChallengeWindowClosed);
    }

    if claim.market.is_private {
        if let Some(expected) = claim.market.invite_key_hash.clone() {
            let supplied = match &invite_key {
                Some(key) => util::hash_string(env, key)?,
                None => return Err(Error::InvalidInviteKey),
            };
            if supplied != expected {
                return Err(Error::InvalidInviteKey);
            }
        }
    }

    // A one-slot market is a duel, so the stakes must match. v1 could not enforce
    // this on chain and relied on an off-chain guard; v2 can.
    if claim.market.max_challengers == 1 && stake_amount != claim.creator_stake {
        return Err(Error::DuelNeedsEqualStake);
    }

    if util::is_fixed_odds(env, &claim.market.odds_mode) {
        let gross = fees::gross_payout(stake_amount, claim.market.challenger_payout_bps)?;
        let profit = if gross > stake_amount {
            gross - stake_amount
        } else {
            0
        };
        let available = claim.creator_stake - claim.reserved_creator_liability;
        if available < profit {
            return Err(Error::InsufficientCreatorLiquidity);
        }
        claim.reserved_creator_liability += profit;
    }

    let usdc = storage::usdc(env)?;
    escrow::pull(env, &usdc, &challenger, stake_amount)?;

    list.push_back(Challenger {
        address: challenger.clone(),
        stake: stake_amount,
        claimed: false,
    });
    storage::set_challengers(env, claim_id, &list);

    claim.total_challenger_stake += stake_amount;
    claim.challenger_count += 1;
    claim.state = ClaimState::Active;
    storage::set_claim(env, claim_id, &claim);

    events::ClaimChallenged {
        id: claim_id,
        challenger,
        stake: stake_amount,
    }
    .publish(env);
    Ok(())
}

pub fn cancel_claim(env: &Env, claim_id: u64) -> Result<(), Error> {
    let mut claim = storage::get_claim(env, claim_id)?;
    claim.creator.require_auth();
    if claim.state != ClaimState::Open {
        return Err(Error::ClaimNotOpen);
    }

    claim.state = ClaimState::Cancelled;
    let creator = claim.creator.clone();
    let refund = claim.creator_stake;
    storage::set_claim(env, claim_id, &claim);

    // Cancellation is a refund: no fee.
    let usdc = storage::usdc(env)?;
    escrow::push_or_park(env, &usdc, &creator, refund);

    events::ClaimCancelled { id: claim_id }.publish(env);
    Ok(())
}
