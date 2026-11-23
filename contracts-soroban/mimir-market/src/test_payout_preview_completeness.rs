#![cfg(test)]
//! Payout preview completeness tests under complete and truncated claim histories.
//!
//! Acceptance criteria:
//! - Mark missing observations explicitly (`missing_observations > 0`).
//! - Never present an incomplete aggregate as a verified total liability (`verified_total_liability == None`).
//! - Verify complete history produces `is_complete: true` and `verified_total_liability: Some(amount)`.
//! - Boundary coverage: 0 claims, limit == total, limit < total, offset > 0, sparse/missing IDs, over-sized batch.

extern crate std;

use soroban_sdk::Vec;

use crate::test_common::{Fixture, USDC};
use crate::types::Error;

#[test]
fn complete_creator_history_yields_verified_total_liability() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);

    let _id1 = f.client().create_claim(&creator, &f.params(10 * USDC));
    let _id2 = f.client().create_claim(&creator, &f.params(20 * USDC));

    // Limit = 0 means read all remaining entries from offset 0 (full history).
    let preview = f.client().preview_creator_payouts(&creator, &0, &0);

    assert_eq!(preview.total_claims, 2);
    assert_eq!(preview.observed_count, 2);
    assert_eq!(preview.missing_observations, 0);
    assert!(!preview.is_truncated);
    assert!(preview.is_complete);
    assert_eq!(preview.aggregate_liability, 30 * USDC);
    assert_eq!(preview.verified_total_liability, Some(30 * USDC));
    assert_eq!(preview.aggregate_gross, 30 * USDC);
    assert_eq!(preview.aggregate_net, 30 * USDC);
}

#[test]
fn truncated_creator_history_never_presents_incomplete_aggregate_as_verified_liability() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);

    let _id1 = f.client().create_claim(&creator, &f.params(10 * USDC));
    let _id2 = f.client().create_claim(&creator, &f.params(20 * USDC));
    let _id3 = f.client().create_claim(&creator, &f.params(30 * USDC));

    // Creator has 3 claims, but limit is 2 (truncated history).
    let preview = f.client().preview_creator_payouts(&creator, &0, &2);

    assert_eq!(preview.total_claims, 3);
    assert_eq!(preview.observed_count, 2);
    // Explicitly marks the 1 missing observation beyond the page boundary.
    assert_eq!(preview.missing_observations, 1);
    assert!(preview.is_truncated);
    assert!(!preview.is_complete);

    // Aggregate liability contains only the observed slice (10 + 20 = 30 USDC).
    assert_eq!(preview.aggregate_liability, 30 * USDC);
    // CRITICAL: verified_total_liability is None — an incomplete aggregate
    // is NEVER presented as a verified total liability!
    assert_eq!(preview.verified_total_liability, None);
}

#[test]
fn non_zero_offset_truncation_marks_missing_observations_and_nulls_verified_liability() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);

    let _id1 = f.client().create_claim(&creator, &f.params(10 * USDC));
    let _id2 = f.client().create_claim(&creator, &f.params(20 * USDC));
    let _id3 = f.client().create_claim(&creator, &f.params(30 * USDC));

    // Reading page starting at offset 1 with limit 2 (skips first claim).
    let preview = f.client().preview_creator_payouts(&creator, &1, &2);

    assert_eq!(preview.total_claims, 3);
    assert_eq!(preview.observed_count, 2);
    assert_eq!(preview.missing_observations, 1);
    assert!(preview.is_truncated);
    assert!(!preview.is_complete);

    // Slice covers claim 2 and 3 (20 + 30 = 50 USDC).
    assert_eq!(preview.aggregate_liability, 50 * USDC);
    assert_eq!(preview.verified_total_liability, None);
}

#[test]
fn empty_creator_history_is_complete_with_zero_verified_liability() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);

    let preview = f.client().preview_creator_payouts(&creator, &0, &10);

    assert_eq!(preview.total_claims, 0);
    assert_eq!(preview.observed_count, 0);
    assert_eq!(preview.missing_observations, 0);
    assert!(!preview.is_truncated);
    assert!(preview.is_complete);
    assert_eq!(preview.aggregate_liability, 0);
    assert_eq!(preview.verified_total_liability, Some(0));
}

#[test]
fn exact_boundary_limit_equals_total_claims_is_complete() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);

    let _id1 = f.client().create_claim(&creator, &f.params(10 * USDC));
    let _id2 = f.client().create_claim(&creator, &f.params(15 * USDC));

    // limit == total (2)
    let preview = f.client().preview_creator_payouts(&creator, &0, &2);
    assert_eq!(preview.total_claims, 2);
    assert_eq!(preview.observed_count, 2);
    assert_eq!(preview.missing_observations, 0);
    assert!(!preview.is_truncated);
    assert!(preview.is_complete);
    assert_eq!(preview.verified_total_liability, Some(25 * USDC));

    // limit > total (5 > 2)
    let preview_over = f.client().preview_creator_payouts(&creator, &0, &5);
    assert_eq!(preview_over.total_claims, 2);
    assert_eq!(preview_over.observed_count, 2);
    assert_eq!(preview_over.missing_observations, 0);
    assert!(!preview_over.is_truncated);
    assert!(preview_over.is_complete);
    assert_eq!(preview_over.verified_total_liability, Some(25 * USDC));
}

#[test]
fn claims_batch_preview_marks_missing_observations_and_withholds_verified_liability() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);

    let id1 = f.client().create_claim(&creator, &f.params(10 * USDC));
    let id2 = f.client().create_claim(&creator, &f.params(20 * USDC));
    let missing_id = 999_999u64;

    let mut ids = Vec::new(&f.env);
    ids.push_back(id1);
    ids.push_back(missing_id);
    ids.push_back(id2);

    let preview = f.client().preview_claims_batch(&ids);

    assert_eq!(preview.total_claims, 3);
    assert_eq!(preview.observed_count, 2);
    assert_eq!(preview.missing_observations, 1);
    assert!(!preview.is_complete);
    assert_eq!(preview.aggregate_liability, 30 * USDC);
    // Unverified because of the missing ID!
    assert_eq!(preview.verified_total_liability, None);

    // When all IDs exist:
    let mut valid_ids = Vec::new(&f.env);
    valid_ids.push_back(id1);
    valid_ids.push_back(id2);
    let complete_preview = f.client().preview_claims_batch(&valid_ids);
    assert_eq!(complete_preview.total_claims, 2);
    assert_eq!(complete_preview.observed_count, 2);
    assert_eq!(complete_preview.missing_observations, 0);
    assert!(complete_preview.is_complete);
    assert_eq!(complete_preview.verified_total_liability, Some(30 * USDC));
}

#[test]
fn batch_too_large_is_rejected_prior_to_storage_access() {
    let f = Fixture::new(0, 0);
    let mut ids = Vec::new(&f.env);
    for i in 0..51 {
        ids.push_back(i);
    }

    let err = f.client().try_preview_claims_batch(&ids).unwrap_err().unwrap();
    assert_eq!(err, Error::BatchTooLarge);
}

#[test]
fn preview_reflects_fixed_odds_reserved_liability_and_fees() {
    let f = Fixture::new(500, 500); // 5% platform, 5% owner fee
    let creator = f.user(100 * USDC);
    let challenger = f.user(100 * USDC);

    let mut params = f.params(20 * USDC);
    params.odds_mode = f.str("fixed");
    params.challenger_payout_bps = 20_000; // 2x payout = 1x profit
    let id = f.client().create_claim(&creator, &params);

    // Before challenge: 0 reserved liability
    let pre_challenge = f.client().preview_creator_payouts(&creator, &0, &0);
    assert_eq!(pre_challenge.aggregate_liability, 0);
    assert_eq!(pre_challenge.verified_total_liability, Some(0));

    // Challenger puts 5 USDC -> reserves 5 USDC creator liability
    f.client().challenge_claim(&challenger, &id, &(5 * USDC), &None);

    let post_challenge = f.client().preview_creator_payouts(&creator, &0, &0);
    assert_eq!(post_challenge.aggregate_liability, 5 * USDC);
    assert_eq!(post_challenge.verified_total_liability, Some(5 * USDC));
    // Gross payout = 5 USDC challenger stake + 5 USDC profit = 10 USDC
    assert_eq!(post_challenge.aggregate_gross, 10 * USDC);
    // Profit = 5 USDC. Platform fee is 5% = 0.25 USDC = 2_500_000 stroops (agent owner has no recipient so uncharged).
    assert_eq!(post_challenge.aggregate_fees, 2_500_000);
    assert_eq!(post_challenge.aggregate_net, 10 * USDC - 2_500_000);
}
