//! Offline settlement conservation verifier (#805).
//!
//! Every fixture under `fixtures/settlement/` is a canonical synthetic manifest
//! that conserves exactly. Each failure case starts from one of them and moves a
//! single amount, so the test names the one rule it breaks.

extern crate std;

use std::string::String;

use crate::settlement_verifier::{verify_manifest, Field, Leg, Mismatch, Report};

const POOL_DUST: &str = include_str!("../fixtures/settlement/pool-challengers-dust.manifest");
const FIXED: &str = include_str!("../fixtures/settlement/fixed-challengers.manifest");
const CREATOR: &str = include_str!("../fixtures/settlement/creator-wins.manifest");
const DRAW: &str = include_str!("../fixtures/settlement/draw-refund.manifest");
const PARTIAL: &str = include_str!("../fixtures/settlement/partial-claims.manifest");

/// Replace exactly one occurrence of `from`, so a test cannot silently mutate
/// nothing (or more than it meant to).
fn mutate(base: &str, from: &str, to: &str) -> String {
    assert_eq!(
        base.matches(from).count(),
        1,
        "fixture must contain `{from}` once"
    );
    base.replacen(from, to, 1)
}

// ── Canonical manifests conserve ─────────────────────────────────────────────

#[test]
fn pool_mode_last_claimant_absorbs_truncation_dust() {
    assert_eq!(
        verify_manifest(POOL_DUST),
        Ok(Report {
            claim_id: 101,
            inflow: 130_000_001,
            paid: 127_000_004,
            fees: 2_999_997,
            remaining: 0,
            challengers: 3,
            claimed: 3,
        })
    );
}

#[test]
fn fixed_odds_refunds_unspent_liability_without_a_fee() {
    let report = verify_manifest(FIXED).unwrap();
    assert_eq!(report.inflow, 135_000_000);
    assert_eq!(report.paid + report.fees + report.remaining, report.inflow);
    assert_eq!(report.fees, 1_050_000);
}

#[test]
fn creator_win_charges_only_fees_that_have_a_recipient() {
    let report = verify_manifest(CREATOR).unwrap();
    assert_eq!(report.inflow, 100_000_000);
    // 2% platform fee on 50,000,000 profit; the agent-owner leg has no recipient.
    assert_eq!(report.fees, 1_000_000);
    assert_eq!(report.paid, 99_000_000);
    assert_eq!(report.claimed, 0);
}

#[test]
fn draw_returns_every_principal_with_no_fee() {
    let report = verify_manifest(DRAW).unwrap();
    assert_eq!(report.paid, report.inflow);
    assert_eq!(report.fees, 0);
}

#[test]
fn unclaimed_challengers_leave_exactly_what_they_are_owed() {
    let report = verify_manifest(PARTIAL).unwrap();
    assert_eq!(report.claimed, 1);
    assert_eq!(report.remaining, 120_000_000);
    assert_eq!(report.paid + report.fees + report.remaining, report.inflow);
}

#[test]
fn comments_and_blank_lines_do_not_change_the_result() {
    let spaced = POOL_DUST.replace('\n', "\n\n# note\n");
    assert_eq!(verify_manifest(&spaced), verify_manifest(POOL_DUST));
}

// ── Principal ────────────────────────────────────────────────────────────────

#[test]
fn a_principal_shortfall_is_reported_on_its_leg() {
    // First challenger paid one stroop less than the pool formula.
    let bad = mutate(
        POOL_DUST,
        "challenger 10000000 43333332 999999 42333333\nchallenger 10000000",
        "challenger 10000000 43333331 999999 42333332\nchallenger 10000000",
    );
    assert_eq!(
        verify_manifest(&bad),
        Err(Mismatch::Leg {
            leg: Leg::Challenger(0),
            field: Field::Principal,
            expected: 43_333_332,
            found: 43_333_331,
        })
    );
}

#[test]
fn a_draw_cannot_pay_more_than_principal() {
    let bad = mutate(
        DRAW,
        "challenger 25000000 25000000 0 25000000",
        "challenger 25000000 25000001 0 25000001",
    );
    assert!(matches!(
        verify_manifest(&bad),
        Err(Mismatch::Leg {
            leg: Leg::Challenger(0),
            field: Field::Principal,
            ..
        })
    ));
}

#[test]
fn a_creator_refund_that_ignores_reserved_liability_is_caught() {
    // Fixed odds: the creator gets back creator_stake - reserved liability.
    let bad = mutate(FIXED, "creator_paid 65000000", "creator_paid 100000000");
    assert_eq!(
        verify_manifest(&bad),
        Err(Mismatch::Leg {
            leg: Leg::Creator,
            field: Field::Net,
            expected: 65_000_000,
            found: 100_000_000,
        })
    );
}

// ── Fees ─────────────────────────────────────────────────────────────────────

#[test]
fn an_overcharged_fee_is_reported() {
    let bad = mutate(
        POOL_DUST,
        "challenger 10000001 43333337 999999 42333338",
        "challenger 10000001 43333337 1000000 42333337",
    );
    assert_eq!(
        verify_manifest(&bad),
        Err(Mismatch::Leg {
            leg: Leg::Challenger(2),
            field: Field::Fee,
            expected: 999_999,
            found: 1_000_000,
        })
    );
}

#[test]
fn a_fee_without_a_recipient_is_not_charged() {
    // Charging the 1% agent-owner leg as well on a creator win is a mismatch,
    // because that leg has no recipient.
    let bad = mutate(CREATOR, "creator_fee 1000000", "creator_fee 1500000");
    assert_eq!(
        verify_manifest(&bad),
        Err(Mismatch::Leg {
            leg: Leg::Creator,
            field: Field::Fee,
            expected: 1_000_000,
            found: 1_500_000,
        })
    );
}

#[test]
fn a_fee_on_a_returned_stake_is_refused() {
    let bad = mutate(
        DRAW,
        "challenger 15000000 15000000 0 15000000",
        "challenger 15000000 15000000 1 14999999",
    );
    assert!(matches!(
        verify_manifest(&bad),
        Err(Mismatch::Leg {
            field: Field::Fee,
            expected: 0,
            found: 1,
            ..
        })
    ));
}

#[test]
fn net_must_equal_gross_minus_fee() {
    let bad = mutate(
        FIXED,
        "challenger 20000000 40000000 600000 39400000",
        "challenger 20000000 40000000 600000 39400001",
    );
    assert!(matches!(
        verify_manifest(&bad),
        Err(Mismatch::Leg {
            field: Field::Net,
            expected: 39_400_000,
            found: 39_400_001,
            ..
        })
    ));
}

// ── Remainder ────────────────────────────────────────────────────────────────

#[test]
fn dust_stranded_by_the_last_claimant_is_caught() {
    // The last claimant took the formula amount instead of the remainder,
    // leaving five stroops in escrow.
    let bad = mutate(
        POOL_DUST,
        "challenger 10000001 43333337 999999 42333338\nremaining 0",
        "challenger 10000001 43333332 999999 42333333\nremaining 5",
    );
    assert_eq!(
        verify_manifest(&bad),
        Err(Mismatch::Leg {
            leg: Leg::Challenger(2),
            field: Field::Principal,
            expected: 43_333_337,
            found: 43_333_332,
        })
    );
}

#[test]
fn a_wrong_remaining_balance_is_reported() {
    let bad = mutate(PARTIAL, "remaining 120000000", "remaining 119999999");
    assert_eq!(
        verify_manifest(&bad),
        Err(Mismatch::Remainder {
            expected: 120_000_000,
            found: 119_999_999,
        })
    );
}

#[test]
fn a_fully_settled_market_must_leave_nothing() {
    let bad = mutate(DRAW, "remaining 0", "remaining 1");
    assert_eq!(
        verify_manifest(&bad),
        Err(Mismatch::Remainder {
            expected: 0,
            found: 1,
        })
    );
}

// ── Manifest shape (boundaries) ──────────────────────────────────────────────

#[test]
fn an_unknown_manifest_version_is_refused() {
    let bad = mutate(
        POOL_DUST,
        "mimir-settlement-manifest v1",
        "mimir-settlement-manifest v2",
    );
    assert_eq!(verify_manifest(&bad), Err(Mismatch::UnsupportedVersion));
    assert_eq!(verify_manifest(""), Err(Mismatch::UnsupportedVersion));
}

#[test]
fn a_missing_record_is_named() {
    let bad = mutate(POOL_DUST, "creator_fee 0\n", "");
    assert_eq!(
        verify_manifest(&bad),
        Err(Mismatch::Missing {
            record: "creator_fee"
        })
    );
}

#[test]
fn fixed_odds_needs_its_payout_rate() {
    let bad = mutate(FIXED, "payout_bps 20000\n", "");
    assert_eq!(
        verify_manifest(&bad),
        Err(Mismatch::Missing {
            record: "payout_bps"
        })
    );
}

#[test]
fn a_repeated_record_is_ambiguous_and_refused() {
    let bad = mutate(POOL_DUST, "remaining 0", "remaining 0\nremaining 0");
    assert!(matches!(
        verify_manifest(&bad),
        Err(Mismatch::Malformed { .. })
    ));
}

#[test]
fn amounts_must_be_atomic_integers() {
    for amount in ["-1", "1.5", "1_000", "0x10", ""] {
        let bad = mutate(
            DRAW,
            "creator_paid 40000000",
            &std::format!("creator_paid {amount}"),
        );
        assert!(
            matches!(
                verify_manifest(&bad),
                Err(Mismatch::Malformed { .. }) | Err(Mismatch::Missing { .. })
            ),
            "`{amount}` must be refused"
        );
    }
}

#[test]
fn a_claim_listed_after_an_unclaimed_challenger_is_out_of_order() {
    let bad = mutate(
        PARTIAL,
        "challenger 30000000 - - -\nremaining",
        "challenger 30000000 60000000 750000 59250000\nremaining",
    );
    assert!(matches!(
        verify_manifest(&bad),
        Err(Mismatch::Malformed { .. })
    ));
}

#[test]
fn amounts_that_cannot_fit_report_overflow() {
    let huge = "170141183460469231731687303715884105727"; // i128::MAX
    let bad = mutate(
        DRAW,
        "creator_stake 40000000",
        &std::format!("creator_stake {huge}"),
    );
    assert_eq!(verify_manifest(&bad), Err(Mismatch::Overflow));
}
