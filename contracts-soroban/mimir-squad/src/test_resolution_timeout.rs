#![cfg(test)]
//! Permissionless refunds when the oracle does not resolve before timeout.

extern crate std;

use soroban_sdk::testutils::Events as _;
use soroban_sdk::Event;

use crate::test_common::{Fixture, DEFAULT_DURATION, USDC};
use crate::types::{Error, RESOLUTION_GRACE_SECONDS, RESULT_CANCELLED, SIDE_A, SIDE_B};

#[test]
fn expiry_is_rejected_before_grace_and_succeeds_at_the_boundary() {
    let f = Fixture::new();
    let captain = f.user(0);
    let id = f.market(&captain, 0);
    let expires_at = f.now() + DEFAULT_DURATION + RESOLUTION_GRACE_SECONDS;

    f.advance_to(expires_at - 1);
    assert_eq!(
        f.client()
            .try_expire_unresolved(&id)
            .unwrap_err()
            .unwrap(),
        Error::GracePeriodNotElapsed
    );
    assert!(!f.client().get_market(&id).resolved);

    f.advance_to(expires_at);
    f.env.set_auths(&[]);
    f.client().expire_unresolved(&id);
    let market = f.client().get_market(&id);
    assert!(market.resolved);
    assert_eq!(market.result, RESULT_CANCELLED);
    assert_eq!(market.remaining_escrow, 0);

    let expected = crate::events::MarketResolutionExpired {
        market_id: id,
        deadline: f.now() - RESOLUTION_GRACE_SECONDS,
        expired_at: expires_at,
        pool_a: 0,
        pool_b: 0,
    }
    .to_xdr(&f.env, &f.contract_id);
    assert!(f
        .env
        .events()
        .all()
        .events()
        .iter()
        .any(|event| event == &expected));
}

#[test]
fn expiry_refunds_every_participant_without_fees() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let a2 = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let both = f.user(100 * USDC);
    let id = f.market(&captain, 1_000);

    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.client().deposit(&a2, &id, &SIDE_A, &(15 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(20 * USDC));
    f.client().deposit(&both, &id, &SIDE_A, &(5 * USDC));
    f.client().deposit(&both, &id, &SIDE_B, &(7 * USDC));

    f.advance_to(f.now() + DEFAULT_DURATION + RESOLUTION_GRACE_SECONDS);
    f.client().expire_unresolved(&id);

    assert_eq!(f.client().claim(&a1, &id, &SIDE_A), 10 * USDC);
    assert_eq!(f.client().claim(&a2, &id, &SIDE_A), 15 * USDC);
    assert_eq!(f.client().claim(&b1, &id, &SIDE_B), 20 * USDC);
    assert_eq!(f.client().claim(&both, &id, &SIDE_A), 5 * USDC);
    assert_eq!(f.client().claim(&both, &id, &SIDE_B), 7 * USDC);

    for participant in [&a1, &a2, &b1, &both] {
        assert_eq!(f.token().balance(participant), 100 * USDC);
    }
    assert_eq!(f.client().get_accrued_fees(), 0);
    assert_eq!(f.client().get_market(&id).remaining_escrow, 0);
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn expiry_is_one_shot_and_oracle_cannot_resolve_after_the_cutoff() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);
    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(10 * USDC));

    f.advance_to(f.now() + DEFAULT_DURATION + RESOLUTION_GRACE_SECONDS);
    assert_eq!(
        f.client().try_resolve(&id, &SIDE_A).unwrap_err().unwrap(),
        Error::NotResolvable
    );
    f.client().expire_unresolved(&id);
    assert_eq!(
        f.client()
            .try_expire_unresolved(&id)
            .unwrap_err()
            .unwrap(),
        Error::AlreadyResolved
    );
    assert_eq!(
        f.client().try_resolve(&id, &RESULT_CANCELLED).unwrap_err().unwrap(),
        Error::NotResolvable
    );
}

#[test]
fn oracle_resolution_wins_inside_grace_and_prevents_expiry() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);
    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(10 * USDC));

    f.advance_to(f.now() + DEFAULT_DURATION + RESOLUTION_GRACE_SECONDS - 1);
    f.client().resolve(&id, &SIDE_A);
    assert_eq!(
        f.client()
            .try_expire_unresolved(&id)
            .unwrap_err()
            .unwrap(),
        Error::AlreadyResolved
    );
    assert_eq!(f.client().get_market(&id).result, SIDE_A);
}