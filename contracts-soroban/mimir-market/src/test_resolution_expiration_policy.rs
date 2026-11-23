#![cfg(test)]
//! Focused coverage for the oracle resolution expiration policy descriptor
//! (`get_resolution_expiration_policy`) and its enforced lifecycle boundaries.

use crate::test_common::{Fixture, USDC};
use crate::types::{
    ClaimState, Error, ResolutionExpirationPolicy, WinnerSide, CHALLENGE_LOCK_SECONDS,
    MAX_CONFIDENCE, ORACLE_TIMELOCK_SECONDS, RESOLUTION_EXPIRY_SECONDS, VERDICT_VERSION_V1,
};

#[test]
fn descriptor_exposes_approved_resolution_and_expiry_rules() {
    let f = Fixture::new(0, 0);
    let policy = f.client().get_resolution_expiration_policy();

    assert_eq!(
        policy,
        ResolutionExpirationPolicy {
            oracle_only_resolution: true,
            challenge_lock_seconds: CHALLENGE_LOCK_SECONDS,
            oracle_timelock_seconds: ORACLE_TIMELOCK_SECONDS,
            resolution_expiry_seconds: RESOLUTION_EXPIRY_SECONDS,
            open_claim_expiry_cancels: true,
            active_claim_auto_expires: false,
            verdict_version: VERDICT_VERSION_V1,
            max_confidence: MAX_CONFIDENCE,
        }
    );
    assert_eq!(policy.resolution_expiry_seconds, 0);
    assert_eq!(policy.max_confidence, 100);
}

#[test]
fn open_claim_expiry_boundary_cancels_and_refunds_creator() {
    let f = Fixture::new(0, 0);
    let creator = f.user(20 * USDC);
    let params = f.params(10 * USDC);
    let deadline = params.deadline;
    let id = f.client().create_claim(&creator, &params);

    // One second before deadline: expiry transition is refused.
    f.advance_to(deadline - 1);
    assert_eq!(
        f.client().try_transition_deadline(&id),
        Err(Ok(Error::Timelocked))
    );
    assert_eq!(f.client().get_claim(&id).state, ClaimState::Open);

    // At exact deadline: unchallenged Open claim transitions to Cancelled and
    // refunds the creator's full stake (no fee).
    f.advance_to(deadline);
    f.client().transition_deadline(&id);
    assert_eq!(f.client().get_claim(&id).state, ClaimState::Cancelled);
    assert_eq!(f.token().balance(&creator), 20 * USDC);
}

#[test]
fn challenge_lock_boundary_matches_policy_descriptor() {
    let f = Fixture::new(0, 0);
    let policy = f.client().get_resolution_expiration_policy();
    let creator = f.user(20 * USDC);
    let alice = f.user(20 * USDC);
    let bob = f.user(20 * USDC);

    let params = f.params(10 * USDC);
    let deadline = params.deadline;
    let id = f.client().create_claim(&creator, &params);

    // At `deadline - challenge_lock_seconds`, challenging is still allowed.
    f.advance_to(deadline - policy.challenge_lock_seconds);
    f.client()
        .challenge_claim(&alice, &id, &(5 * USDC), &None);

    // One second closer to the deadline, the challenge window is closed.
    f.advance_to(deadline - policy.challenge_lock_seconds + 1);
    assert_eq!(
        f.client()
            .try_challenge_claim(&bob, &id, &(5 * USDC), &None),
        Err(Ok(Error::ChallengeWindowClosed))
    );
}

#[test]
fn active_claim_preserves_oracle_only_resolution_and_withdrawal_rights_past_deadline() {
    let f = Fixture::new(0, 0);
    let policy = f.client().get_resolution_expiration_policy();
    let creator = f.user(20 * USDC);
    let challenger = f.user(20 * USDC);

    let params = f.params(10 * USDC);
    let deadline = params.deadline;
    let id = f.client().create_claim(&creator, &params);
    f.client()
        .challenge_claim(&challenger, &id, &(10 * USDC), &None);

    // Before deadline: oracle cannot resolve yet.
    f.advance_to(deadline - 1);
    assert_eq!(
        f.client().try_resolve_claim(
            &id,
            &WinnerSide::Challengers,
            &f.str("early"),
            &90,
            &f.zero_hash(),
        ),
        Err(Ok(Error::NotYetExpired))
    );

    // Far past deadline (30 days): because `active_claim_auto_expires == false`
    // and `resolution_expiry_seconds == 0`, the claim stays Active and cannot
    // be cancelled by `transition_deadline` or `cancel_claim`.
    f.advance_to(deadline + 30 * 86_400);
    f.client().transition_deadline(&id);
    assert_eq!(f.client().get_claim(&id).state, ClaimState::Active);
    assert_eq!(
        f.client().try_cancel_claim(&id),
        Err(Ok(Error::ClaimNotOpen))
    );

    // Confidence above `policy.max_confidence` is rejected.
    assert_eq!(
        f.client().try_resolve_claim(
            &id,
            &WinnerSide::Challengers,
            &f.str("bad confidence"),
            &(policy.max_confidence + 1),
            &f.zero_hash(),
        ),
        Err(Ok(Error::InvalidConfidence))
    );
    assert_eq!(f.client().get_claim(&id).state, ClaimState::Active);

    // Oracle resolves with valid confidence; challenger retains pull-based
    // withdrawal rights.
    f.client().resolve_claim(
        &id,
        &WinnerSide::Challengers,
        &f.str("oracle verdict"),
        &policy.max_confidence,
        &f.zero_hash(),
    );
    assert_eq!(f.client().get_claim(&id).state, ClaimState::Resolved);

    let payout = f.client().claim_challenger_payout(&challenger, &id);
    assert_eq!(payout, 20 * USDC);
    assert_eq!(f.token().balance(&challenger), 30 * USDC);
}
