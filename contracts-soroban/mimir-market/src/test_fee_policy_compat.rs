#![cfg(test)]
//! Bounded fee-policy compatibility query for generated clients.

extern crate std;

use soroban_sdk::{Env, Symbol};

use crate::contract::{MimirMarket, MimirMarketClient};
use crate::test_common::Fixture;
use crate::types::{
    Error, FeeRoundingMode, BPS_DIVISOR, FEE_POLICY_COMPAT_MAX_FIELDS, FEE_POLICY_COMPAT_VERSION,
    FEE_TIMELOCK_SECONDS, MAX_TOTAL_FEE_BPS, MIN_STAKE, USDC_DECIMALS,
};

#[test]
fn uninitialized_contract_refuses_compatibility_query() {
    let env = Env::default();
    let contract_id = env.register(MimirMarket, ());
    let client = MimirMarketClient::new(&env, &contract_id);

    let err = client
        .try_get_fee_policy_compatibility()
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::NotInitialized);
}

#[test]
fn compatibility_query_reports_bounded_fields_caps_and_rounding_semantics() {
    let f = Fixture::new(250, 150);
    let compat = f.client().get_fee_policy_compatibility();

    assert_eq!(compat.schema_version, FEE_POLICY_COMPAT_VERSION);
    assert_eq!(compat.supported_fields.len(), FEE_POLICY_COMPAT_MAX_FIELDS);
    assert_eq!(
        compat.supported_fields.get(0).unwrap(),
        Symbol::new(&f.env, "platform_fee_bps")
    );
    assert_eq!(
        compat.supported_fields.get(1).unwrap(),
        Symbol::new(&f.env, "agent_owner_fee_bps")
    );
    assert_eq!(
        compat.supported_fields.get(2).unwrap(),
        Symbol::new(&f.env, "platform_recipient")
    );
    assert_eq!(
        compat.supported_fields.get(3).unwrap(),
        Symbol::new(&f.env, "agent_owner_recipient")
    );
    assert_eq!(
        compat.supported_fields.get(4).unwrap(),
        Symbol::new(&f.env, "revision")
    );

    assert_eq!(compat.max_total_fee_bps, MAX_TOTAL_FEE_BPS);
    assert_eq!(compat.bps_divisor, BPS_DIVISOR);
    assert_eq!(compat.fee_timelock_seconds, FEE_TIMELOCK_SECONDS);
    assert_eq!(compat.usdc_decimals, USDC_DECIMALS);
    assert_eq!(compat.min_stake, MIN_STAKE);
    assert_eq!(
        compat.rounding_mode,
        FeeRoundingMode::FloorPerLegParticipantRemainder
    );
    assert!(compat.profit_only);
    assert!(compat.pull_based_payouts);
    assert!(compat.exact_usdc_escrow);
    assert_eq!(compat.current_revision, 1);
    assert_eq!(compat.current_total_fee_bps, 400);
    assert!(!compat.has_pending_policy);
}

#[test]
fn compatibility_query_tracks_cap_boundary_and_pending_policy_lifecycle() {
    let f = Fixture::new(500, 500);
    let initial = f.client().get_fee_policy_compatibility();
    assert_eq!(initial.current_total_fee_bps, MAX_TOTAL_FEE_BPS);
    assert_eq!(initial.current_revision, 1);
    assert!(!initial.has_pending_policy);

    // Queue a valid policy change via the existing setter.
    f.client()
        .queue_fee_policy(&300, &200, &Some(f.platform.clone()));
    let queued = f.client().get_fee_policy_compatibility();
    assert!(queued.has_pending_policy);
    assert_eq!(queued.current_revision, 1);
    assert_eq!(queued.current_total_fee_bps, MAX_TOTAL_FEE_BPS);

    // Execute after timelock elapses.
    f.advance_by(FEE_TIMELOCK_SECONDS);
    f.client().execute_fee_policy();
    let executed = f.client().get_fee_policy_compatibility();
    assert!(!executed.has_pending_policy);
    assert_eq!(executed.current_revision, 2);
    assert_eq!(executed.current_total_fee_bps, 500);
}

#[test]
fn compatibility_query_is_read_only_and_preserves_existing_policy_state() {
    let f = Fixture::new(100, 50);
    let policy_before = f.client().get_fee_policy();
    let pending_before = f.client().get_pending_fee_policy();
    let stats_before = f.client().get_platform_stats();

    let first = f.client().get_fee_policy_compatibility();
    let second = f.client().get_fee_policy_compatibility();

    assert_eq!(first, second);
    assert_eq!(f.client().get_fee_policy(), policy_before);
    assert_eq!(f.client().get_pending_fee_policy(), pending_before);
    assert_eq!(f.client().get_platform_stats(), stats_before);
}
