#![cfg(test)]
//! Focused tests for bounded fee liability summaries and separation of collectible
//! fees from user principal.
//!
//! Acceptance criteria:
//! - Return bounded aggregate liabilities by known recipient class (Platform and AgentOwner).
//! - Keep collectible fees separate from user principal.
//! - Bounded O(1) query without iterating markets.
//! - Error handling for uninitialized state.
//! - Strict conservation: total escrow balance = user_principal + total_collectible_fees.

extern crate std;

use crate::test_common::{Fixture, USDC};
use crate::types::{Error, FeeRecipientClass, WinnerSide};

#[test]
fn initial_fee_liabilities_zero_after_initialization() {
    let f = Fixture::new(200, 300);

    let summary = f.client().get_fee_liability_summary();
    assert_eq!(summary.platform_accrued, 0);
    assert_eq!(summary.platform_claimed, 0);
    assert_eq!(summary.platform_collectible, 0);
    assert_eq!(summary.agent_owner_accrued, 0);
    assert_eq!(summary.agent_owner_claimed, 0);
    assert_eq!(summary.agent_owner_collectible, 0);
    assert_eq!(summary.total_collectible_fees, 0);
    assert_eq!(summary.user_principal, 0);
    assert_eq!(summary.total_withdrawable, 0);

    // Alias matches
    assert_eq!(f.client().get_fee_liabilities(), summary);

    // Class views match
    let plat = f
        .client()
        .get_fee_liability_by_class(&FeeRecipientClass::Platform);
    assert_eq!(plat.recipient_class, FeeRecipientClass::Platform);
    assert_eq!(plat.accrued, 0);
    assert_eq!(plat.claimed, 0);
    assert_eq!(plat.collectible, 0);

    let owner = f
        .client()
        .get_fee_liability_by_class(&FeeRecipientClass::AgentOwner);
    assert_eq!(owner.recipient_class, FeeRecipientClass::AgentOwner);
    assert_eq!(owner.accrued, 0);
    assert_eq!(owner.claimed, 0);
    assert_eq!(owner.collectible, 0);
}

#[test]
fn fee_liabilities_before_initialization_fails() {
    let env = soroban_sdk::Env::default();
    env.mock_all_auths();
    let contract_id = env.register(crate::contract::MimirMarket, ());
    let client = crate::contract::MimirMarketClient::new(&env, &contract_id);

    let err_summary = client.try_get_fee_liability_summary().unwrap_err().unwrap();
    assert_eq!(err_summary, Error::NotInitialized);

    let err_alias = client.try_get_fee_liabilities().unwrap_err().unwrap();
    assert_eq!(err_alias, Error::NotInitialized);

    let err_class = client
        .try_get_fee_liability_by_class(&FeeRecipientClass::Platform)
        .unwrap_err()
        .unwrap();
    assert_eq!(err_class, Error::NotInitialized);
}

#[test]
fn platform_fee_accrual_and_separation_from_user_principal() {
    // 500 bps (5%) platform fee, 0 agent fee
    let f = Fixture::new(500, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);

    // 1. Create claim: 10 USDC creator stake
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));

    let before_challenge = f.client().get_fee_liability_summary();
    assert_eq!(before_challenge.total_collectible_fees, 0);
    assert_eq!(before_challenge.user_principal, 10 * USDC);
    assert_eq!(
        f.escrow_balance(),
        before_challenge.user_principal + before_challenge.total_collectible_fees
    );

    // 2. Challenge claim: 10 USDC challenger stake
    f.client().challenge_claim(&c1, &id, &(10 * USDC), &None);

    let after_challenge = f.client().get_fee_liability_summary();
    assert_eq!(after_challenge.total_collectible_fees, 0);
    assert_eq!(after_challenge.user_principal, 20 * USDC);
    assert_eq!(
        f.escrow_balance(),
        after_challenge.user_principal + after_challenge.total_collectible_fees
    );

    // 3. Resolve claim: Creator wins. Profit = 10 USDC. Fee = 5% of 10 USDC = 0.5 USDC.
    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Creator,
        &f.str("creator"),
        &90,
        &f.zero_hash(),
    );

    let fee = 5 * USDC / 10; // 0.5 USDC
    let after_resolve = f.client().get_fee_liability_summary();
    assert_eq!(after_resolve.platform_accrued, fee);
    assert_eq!(after_resolve.platform_claimed, 0);
    assert_eq!(after_resolve.platform_collectible, fee);
    assert_eq!(after_resolve.agent_owner_accrued, 0);
    assert_eq!(after_resolve.agent_owner_claimed, 0);
    assert_eq!(after_resolve.agent_owner_collectible, 0);
    assert_eq!(after_resolve.total_collectible_fees, fee);
    assert_eq!(after_resolve.user_principal, 0);
    assert_eq!(
        f.escrow_balance(),
        after_resolve.user_principal + after_resolve.total_collectible_fees
    );
    assert_eq!(f.escrow_balance(), fee);

    // 4. Platform claims fees
    let claimed = f.client().claim_fees(&f.platform);
    assert_eq!(claimed, fee);

    let after_claim = f.client().get_fee_liability_summary();
    assert_eq!(after_claim.platform_accrued, fee);
    assert_eq!(after_claim.platform_claimed, fee);
    assert_eq!(after_claim.platform_collectible, 0);
    assert_eq!(after_claim.total_collectible_fees, 0);
    assert_eq!(after_claim.user_principal, 0);
    assert_eq!(
        f.escrow_balance(),
        after_claim.user_principal + after_claim.total_collectible_fees
    );
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn dual_recipient_class_liabilities_track_independently() {
    // 200 bps (2%) platform fee, 300 bps (3%) agent owner fee
    let f = Fixture::new(200, 300);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let agent_wallet = f.user(10 * USDC);

    let mut params = f.params(10 * USDC);
    params.agent_owner_recipient = Some(agent_wallet.clone());

    let id = f.client().create_claim(&creator, &params);
    f.client().challenge_claim(&c1, &id, &(10 * USDC), &None);
    f.advance_by(3_600);

    f.client().resolve_claim(
        &id,
        &WinnerSide::Creator,
        &f.str("creator"),
        &90,
        &f.zero_hash(),
    );

    // Profit = 10 USDC
    // platform_fee = floor(10 * 200 / 10000) = 0.2 USDC
    // agent_fee = floor(10 * 300 / 10000) = 0.3 USDC
    let plat_fee = 2 * USDC / 10;
    let agent_fee = 3 * USDC / 10;
    let total_fees = plat_fee + agent_fee;

    let s1 = f.client().get_fee_liability_summary();
    assert_eq!(s1.platform_accrued, plat_fee);
    assert_eq!(s1.platform_claimed, 0);
    assert_eq!(s1.platform_collectible, plat_fee);
    assert_eq!(s1.agent_owner_accrued, agent_fee);
    assert_eq!(s1.agent_owner_claimed, 0);
    assert_eq!(s1.agent_owner_collectible, agent_fee);
    assert_eq!(s1.total_collectible_fees, total_fees);

    // Query by class matches
    let plat_class = f
        .client()
        .get_fee_liability_by_class(&FeeRecipientClass::Platform);
    assert_eq!(plat_class.accrued, plat_fee);
    assert_eq!(plat_class.claimed, 0);
    assert_eq!(plat_class.collectible, plat_fee);

    let agent_class = f
        .client()
        .get_fee_liability_by_class(&FeeRecipientClass::AgentOwner);
    assert_eq!(agent_class.accrued, agent_fee);
    assert_eq!(agent_class.claimed, 0);
    assert_eq!(agent_class.collectible, agent_fee);

    // Conservation check: total escrow = user_principal + total_collectible_fees
    assert_eq!(
        f.escrow_balance(),
        s1.user_principal + s1.total_collectible_fees
    );

    // Partial claim: Platform claims, AgentOwner does not
    let plat_claimed = f.client().claim_fees(&f.platform);
    assert_eq!(plat_claimed, plat_fee);

    let s2 = f.client().get_fee_liability_summary();
    assert_eq!(s2.platform_claimed, plat_fee);
    assert_eq!(s2.platform_collectible, 0);
    // Agent owner liabilities completely untouched
    assert_eq!(s2.agent_owner_claimed, 0);
    assert_eq!(s2.agent_owner_collectible, agent_fee);
    assert_eq!(s2.total_collectible_fees, agent_fee);
    assert_eq!(
        f.escrow_balance(),
        s2.user_principal + s2.total_collectible_fees
    );

    // Agent owner claims
    let agent_claimed = f.client().claim_fees(&agent_wallet);
    assert_eq!(agent_claimed, agent_fee);

    let s3 = f.client().get_fee_liability_summary();
    assert_eq!(s3.agent_owner_claimed, agent_fee);
    assert_eq!(s3.agent_owner_collectible, 0);
    assert_eq!(s3.total_collectible_fees, 0);
    assert_eq!(
        f.escrow_balance(),
        s3.user_principal + s3.total_collectible_fees
    );
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn non_profit_verdicts_and_cancellations_keep_fees_zero_and_preserve_principal() {
    let f = Fixture::new(500, 500);
    let creator1 = f.user(100 * USDC);
    let creator2 = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);

    // Claim 1: Draw verdict -> refund in full, no fee
    let id1 = f.client().create_claim(&creator1, &f.params(10 * USDC));
    f.client().challenge_claim(&c1, &id1, &(10 * USDC), &None);
    f.advance_by(3_600);
    f.client().resolve_claim(
        &id1,
        &WinnerSide::Draw,
        &f.str("draw"),
        &50,
        &f.zero_hash(),
    );

    let s_draw = f.client().get_fee_liability_summary();
    assert_eq!(s_draw.total_collectible_fees, 0);
    assert_eq!(s_draw.platform_accrued, 0);
    assert_eq!(s_draw.agent_owner_accrued, 0);

    // Challenger pulls their refund
    let pulled = f.client().claim_challenger_payout(&c1, &id1);
    assert_eq!(pulled, 10 * USDC);
    assert_eq!(f.client().get_fee_liability_summary().user_principal, 0);

    // Claim 2: Cancelled market -> refund creator in full, no fee
    let id2 = f.client().create_claim(&creator2, &f.params(10 * USDC));
    let s_open = f.client().get_fee_liability_summary();
    assert_eq!(s_open.user_principal, 10 * USDC);
    assert_eq!(s_open.total_collectible_fees, 0);

    f.client().cancel_claim(&id2);
    let s_cancelled = f.client().get_fee_liability_summary();
    assert_eq!(s_cancelled.user_principal, 0);
    assert_eq!(s_cancelled.total_collectible_fees, 0);
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn total_withdrawable_tracks_parked_balances_correctly() {
    let f = Fixture::new(0, 0);
    let u1 = f.user(10 * USDC);
    let u2 = f.user(10 * USDC);

    assert_eq!(f.client().get_total_withdrawable(), 0);

    // Fund the contract escrow so withdrawals can be pushed
    f.mint(&f.contract_id, 20 * USDC);

    f.client().add_withdrawable(&u1, &(3 * USDC));
    assert_eq!(f.client().get_total_withdrawable(), 3 * USDC);

    f.client().add_withdrawable(&u2, &(5 * USDC));
    assert_eq!(f.client().get_total_withdrawable(), 8 * USDC);

    let summary = f.client().get_fee_liability_summary();
    assert_eq!(summary.total_withdrawable, 8 * USDC);

    // Clear one withdrawable
    f.env.mock_all_auths();
    f.client().withdraw(&u1);
    assert_eq!(f.client().get_total_withdrawable(), 5 * USDC);

    f.client().withdraw(&u2);
    assert_eq!(f.client().get_total_withdrawable(), 0);
}
