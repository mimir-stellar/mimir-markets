#![cfg(test)]
//! Fee recipient rotation: queue, cancel, execute, auth gating, and the
//! timelock boundary.

extern crate std;

use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, InvokeError};

use crate::test_common::{Fixture, DEFAULT_DURATION, USDC};
use crate::types::{Error, FEE_RECIPIENT_TIMELOCK_SECONDS, MAX_FEE_BPS, SIDE_A, SIDE_B};

#[test]
fn fee_recipient_rotation_is_recipient_gated_and_timelocked() {
    let f = Fixture::new();
    let new_recipient = Address::generate(&f.env);
    let previous = f.client().get_fee_recipient();

    f.env.set_auths(&[]);
    assert_eq!(
        f.client().try_queue_fee_recipient(&new_recipient),
        Err(Err(InvokeError::Abort))
    );

    f.env.mock_all_auths();
    f.client().queue_fee_recipient(&new_recipient);
    let queued = f.client().get_pending_fee_recipient().unwrap();
    assert_eq!(queued.next, new_recipient);
    assert_eq!(
        queued.executable_at,
        f.now() + FEE_RECIPIENT_TIMELOCK_SECONDS
    );
    assert_eq!(f.client().get_fee_recipient(), previous);

    assert_eq!(
        f.client().try_execute_fee_recipient(),
        Err(Ok(Error::Timelocked))
    );

    f.advance_to(queued.executable_at - 1);
    assert_eq!(
        f.client().try_execute_fee_recipient(),
        Err(Ok(Error::Timelocked))
    );
    assert_eq!(f.client().get_fee_recipient(), previous);
    assert_eq!(f.client().get_pending_fee_recipient(), Some(queued));

    f.advance_by(1);
    f.client().execute_fee_recipient();
    assert_eq!(f.client().get_fee_recipient(), new_recipient);
    assert!(f.client().get_pending_fee_recipient().is_none());
    assert_eq!(
        f.client().try_execute_fee_recipient(),
        Err(Ok(Error::NoFeeRecipientQueued))
    );
    assert_eq!(
        f.client().try_cancel_fee_recipient(),
        Err(Ok(Error::NoFeeRecipientQueued))
    );
}

#[test]
fn cancelling_a_queued_fee_recipient_keeps_the_current_one() {
    let f = Fixture::new();
    let new_recipient = Address::generate(&f.env);
    let previous = f.client().get_fee_recipient();

    f.client().queue_fee_recipient(&new_recipient);
    f.client().cancel_fee_recipient();

    assert!(f.client().get_pending_fee_recipient().is_none());
    assert_eq!(f.client().get_fee_recipient(), previous);
}

#[test]
fn executing_or_cancelling_without_a_queued_recipient_is_rejected() {
    let f = Fixture::new();

    assert!(f.client().get_pending_fee_recipient().is_none());
    assert_eq!(
        f.client().try_execute_fee_recipient(),
        Err(Ok(Error::NoFeeRecipientQueued))
    );
    assert_eq!(
        f.client().try_cancel_fee_recipient(),
        Err(Ok(Error::NoFeeRecipientQueued))
    );
}

#[test]
fn fee_recipient_execution_is_permissionless_after_timelock() {
    let f = Fixture::new();
    let new_recipient = Address::generate(&f.env);

    f.client().queue_fee_recipient(&new_recipient);
    f.advance_by(FEE_RECIPIENT_TIMELOCK_SECONDS);

    f.env.set_auths(&[]);
    f.client().execute_fee_recipient();
    assert_eq!(f.client().get_fee_recipient(), new_recipient);
    assert!(f.client().get_pending_fee_recipient().is_none());
}

/// Re-queueing before the first rotation executes moves the destination without
/// ever shortening the wait: the new queue is timed from the new request.
#[test]
fn requeuing_resets_the_timelock_and_never_skips_it() {
    let f = Fixture::new();
    let first = Address::generate(&f.env);
    let second = Address::generate(&f.env);

    f.client().queue_fee_recipient(&first);
    f.advance_by(FEE_RECIPIENT_TIMELOCK_SECONDS / 2);
    f.client().queue_fee_recipient(&second);

    let queued = f.client().get_pending_fee_recipient().unwrap();
    assert_eq!(queued.next, second);
    assert_eq!(
        queued.executable_at,
        f.now() + FEE_RECIPIENT_TIMELOCK_SECONDS
    );

    // The first rotation's window has passed, but the re-queue restarted it.
    f.advance_by(FEE_RECIPIENT_TIMELOCK_SECONDS / 2);
    assert_eq!(
        f.client().try_execute_fee_recipient(),
        Err(Ok(Error::Timelocked))
    );
}

/// Fees accrued under the old recipient are paid to whoever holds the role when
/// they are claimed — a rotation does not strand them.
#[test]
fn accrued_fees_are_paid_to_the_recipient_at_claim_time() {
    let f = Fixture::new();
    let captain = f.user(0);
    let id = f.market(&captain, MAX_FEE_BPS);

    let winner = f.user(100 * USDC);
    f.client().deposit(&winner, &id, &SIDE_A, &(10 * USDC));
    let loser = f.user(100 * USDC);
    f.client().deposit(&loser, &id, &SIDE_B, &(10 * USDC));

    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &SIDE_A);
    f.client().claim(&winner, &id, &SIDE_A);

    let accrued = f.client().get_accrued_fees();
    assert!(accrued > 0, "a winning claim at max fee must accrue fees");

    let new_recipient = Address::generate(&f.env);
    f.client().queue_fee_recipient(&new_recipient);
    f.advance_by(FEE_RECIPIENT_TIMELOCK_SECONDS);
    f.client().execute_fee_recipient();

    let paid = f.client().claim_fees();
    assert_eq!(paid, accrued);
    assert_eq!(f.token().balance(&new_recipient), accrued);
    assert_eq!(f.client().get_accrued_fees(), 0);
}
