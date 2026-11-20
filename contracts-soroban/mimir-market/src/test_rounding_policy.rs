#![cfg(test)]
extern crate std;

use soroban_sdk::testutils::{Address as _, Events};
use soroban_sdk::{Address, String};

use crate::fees::{quote_fees_versioned, ROUNDING_POLICY_VERSION};
use crate::test_common::{Fixture, USDC};
use crate::types::{Error, FeeSnapshot, WinnerSide};

fn resolved_fixed_claim(f: &Fixture) -> (u64, Address) {
    let creator = f.user(100 * USDC);
    let agent = f.user(0);
    let mut params = f.params(10 * USDC);
    params.odds_mode = String::from_str(&f.env, "fixed");
    params.challenger_payout_bps = 10_001;
    params.agent_owner_recipient = Some(agent);
    let id = f.client().create_claim(&creator, &params);
    let stake = 20_130_000;
    let challenger = f.user(stake);
    f.client().challenge_claim(&challenger, &id, &stake, &None);
    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Challengers,
        &f.str("yes"),
        &90,
        &f.zero_hash(),
    );
    (id, challenger)
}

#[test]
fn rounding_policy_shared_client_vectors_match_contract_fee_math() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/payout-rounding/v1.json")).unwrap();
    assert_eq!(
        fixture["roundingPolicyVersion"].as_u64(),
        Some(ROUNDING_POLICY_VERSION as u64)
    );
    assert_eq!(
        fixture["usdcDecimals"].as_u64(),
        Some(crate::types::USDC_DECIMALS as u64)
    );
    let env = soroban_sdk::Env::default();
    let recipient = Address::generate(&env);
    for row in fixture["feeVectors"].as_array().unwrap() {
        let amount = |key: &str| row[key].as_str().unwrap().parse::<i128>().unwrap();
        let fees = FeeSnapshot {
            platform_fee_bps: row["platformBps"].as_u64().unwrap() as u32,
            agent_owner_fee_bps: row["ownerBps"].as_u64().unwrap() as u32,
            platform_recipient: Some(recipient.clone()),
            agent_owner_recipient: Some(recipient.clone()),
        };
        assert_eq!(
            quote_fees_versioned(
                amount("principal"),
                amount("gross"),
                &fees,
                ROUNDING_POLICY_VERSION
            )
            .unwrap(),
            (amount("net"), amount("fee")),
            "{}",
            row["name"]
        );
    }
}

#[test]
fn rounding_policy_versioned_quote_matches_legacy_and_actual_payout() {
    let f = Fixture::new(700, 300);
    let (id, who) = resolved_fixed_claim(&f);
    let client = f.client();
    let before = client.get_claim(&id);
    let events = f.env.events().all();
    let legacy = client.quote_challenger_payout(&id, &who);
    let versioned = client.quote_payout_versioned(&id, &who, &ROUNDING_POLICY_VERSION);
    assert_eq!(client.rounding_policy_version(), ROUNDING_POLICY_VERSION);
    assert_eq!(versioned.rounding_policy_version, ROUNDING_POLICY_VERSION);
    assert_eq!(versioned.quote, legacy);
    assert_eq!(client.get_claim(&id), before);
    assert_eq!(f.env.events().all(), events);
    let before_balance = f.token().balance(&who);
    assert_eq!(
        client.claim_payout_versioned(&who, &id, &ROUNDING_POLICY_VERSION),
        legacy.net
    );
    assert_eq!(f.token().balance(&who) - before_balance, legacy.net);
    assert_eq!(
        client
            .quote_payout_versioned(&id, &who, &ROUNDING_POLICY_VERSION)
            .quote
            .claimed,
        true
    );
    assert_eq!(
        client.try_claim_challenger_payout(&who, &id),
        Err(Ok(Error::AlreadyClaimedPayout))
    );
}

#[test]
fn rounding_policy_rejects_unknown_versions_before_state_or_money_changes() {
    let f = Fixture::new(700, 300);
    let (id, who) = resolved_fixed_claim(&f);
    let client = f.client();
    let claim = client.get_claim(&id);
    let roster = client.get_challenger_list(&id);
    let balances = (
        f.escrow_balance(),
        f.token().balance(&who),
        client.get_accrued_fees(&f.platform),
    );
    let events = f.env.events().all();
    for version in [0, ROUNDING_POLICY_VERSION + 1, u32::MAX] {
        assert_eq!(
            client.try_quote_payout_versioned(&id, &who, &version),
            Err(Ok(Error::UnsupportedRoundingPolicyVersion))
        );
        assert_eq!(
            client.try_claim_payout_versioned(&who, &id, &version),
            Err(Ok(Error::UnsupportedRoundingPolicyVersion))
        );
        // Even a missing claim is refused for its unknown policy first.
        assert_eq!(
            client.try_quote_payout_versioned(&u64::MAX, &who, &version),
            Err(Ok(Error::UnsupportedRoundingPolicyVersion))
        );
        assert_eq!(client.get_claim(&id), claim);
        assert_eq!(client.get_challenger_list(&id), roster);
        assert_eq!(
            (
                f.escrow_balance(),
                f.token().balance(&who),
                client.get_accrued_fees(&f.platform)
            ),
            balances
        );
        assert_eq!(f.env.events().all(), events);
    }
    assert_eq!(Error::UnsupportedRoundingPolicyVersion as u32, 48);
    let net = client.quote_challenger_payout(&id, &who).net;
    assert_eq!(
        client.claim_payout_versioned(&who, &id, &ROUNDING_POLICY_VERSION),
        net
    );
}

#[test]
fn rounding_policy_empty_preview_and_refund_do_not_bypass_version_gate() {
    let f = Fixture::new(700, 300);
    let creator = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    let who = f.user(3 * USDC);
    f.client().challenge_claim(&who, &id, &(3 * USDC), &None);
    let empty = f
        .client()
        .quote_payout_versioned(&id, &who, &ROUNDING_POLICY_VERSION);
    assert_eq!(
        (empty.quote.gross, empty.quote.fee, empty.quote.net),
        (0, 0, 0)
    );
    f.advance_by(3_600);
    f.client()
        .resolve_claim(&id, &WinnerSide::Draw, &f.str("draw"), &90, &f.zero_hash());
    assert_eq!(
        f.client().try_claim_payout_versioned(&who, &id, &0),
        Err(Ok(Error::UnsupportedRoundingPolicyVersion))
    );
    let quote = f
        .client()
        .quote_payout_versioned(&id, &who, &ROUNDING_POLICY_VERSION);
    assert_eq!((quote.quote.gross, quote.quote.fee), (3 * USDC, 0));
    assert_eq!(
        f.client()
            .claim_payout_versioned(&who, &id, &ROUNDING_POLICY_VERSION),
        3 * USDC
    );
}

#[test]
fn rounding_policy_last_pull_absorbs_exact_pool_dust_with_legacy_interoperability() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    let users = [f.user(3 * USDC), f.user(3 * USDC), f.user(3 * USDC)];
    for who in &users {
        f.client().challenge_claim(who, &id, &(3 * USDC), &None);
    }
    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Challengers,
        &f.str("yes"),
        &90,
        &f.zero_hash(),
    );
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/payout-rounding/v1.json")).unwrap();
    let pool = &fixture["poolVector"];
    let amount = |key: &str| pool[key].as_str().unwrap().parse::<i128>().unwrap();
    assert_eq!(
        f.client().claim_challenger_payout(&users[0], &id),
        amount("formulaGross")
    );
    assert_eq!(
        f.client()
            .claim_payout_versioned(&users[1], &id, &ROUNDING_POLICY_VERSION),
        amount("formulaGross")
    );
    let quote = f
        .client()
        .quote_payout_versioned(&id, &users[2], &ROUNDING_POLICY_VERSION);
    assert_eq!(quote.quote.gross, amount("finalGross"));
    assert_eq!(quote.quote.gross - amount("formulaGross"), amount("dust"));
    assert_eq!(
        f.client()
            .claim_payout_versioned(&users[2], &id, &ROUNDING_POLICY_VERSION),
        quote.quote.net
    );
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn rounding_policy_versioned_pull_still_requires_challenger_authorization() {
    let f = Fixture::new(700, 300);
    let (id, who) = resolved_fixed_claim(&f);
    let claim = f.client().get_claim(&id);
    let balance = f.escrow_balance();
    f.env.set_auths(&[]);
    assert!(f
        .client()
        .try_claim_payout_versioned(&who, &id, &ROUNDING_POLICY_VERSION)
        .is_err());
    assert_eq!(f.client().get_claim(&id), claim);
    assert_eq!(f.escrow_balance(), balance);
}

#[test]
fn rounding_policy_versioned_pull_parks_a_blocked_transfer_for_later_withdrawal() {
    let f = Fixture::with_stub_token(700, 300);
    let (id, who) = resolved_fixed_claim(&f);
    let quote = f
        .client()
        .quote_payout_versioned(&id, &who, &ROUNDING_POLICY_VERSION);
    f.stub().set_blocked(&who, &true);
    assert_eq!(
        f.client()
            .claim_payout_versioned(&who, &id, &ROUNDING_POLICY_VERSION),
        quote.quote.net
    );
    assert_eq!(f.client().get_withdrawable(&who), quote.quote.net);
    f.stub().set_blocked(&who, &false);
    assert_eq!(f.client().withdraw(&who), quote.quote.net);
    assert_eq!(f.client().get_withdrawable(&who), 0);
}
