//! Small helpers: string hashing and string equality.

use soroban_sdk::{Bytes, BytesN, Env, String};

use crate::types::{Error, MAX_INVITE_KEY_BYTES, Claim, ClaimState};

/// keccak256 of a `String`'s UTF-8 bytes.
///
/// Soroban's `env.crypto()` exposes `keccak256`, so the invite-key hash is
/// byte-for-byte identical to the Solidity `keccak256(bytes(inviteKey))`. The
/// only difference is the length bound: marshalling a host `String` into guest
/// memory needs a fixed buffer, hence [`MAX_INVITE_KEY_BYTES`].
pub fn hash_string(env: &Env, s: &String) -> Result<BytesN<32>, Error> {
    let len = s.len();
    if len > MAX_INVITE_KEY_BYTES {
        return Err(Error::InviteKeyTooLong);
    }
    let mut buf = [0u8; MAX_INVITE_KEY_BYTES as usize];
    let slice = &mut buf[..len as usize];
    s.copy_into_slice(slice);
    let bytes = Bytes::from_slice(env, slice);
    Ok(env.crypto().keccak256(&bytes).to_bytes())
}

pub fn is_fixed_odds(env: &Env, odds_mode: &String) -> bool {
    *odds_mode == String::from_str(env, "fixed")
}

/// `value` when non-empty, otherwise `fallback`.
pub fn or_default(env: &Env, value: &String, fallback: &str) -> String {
    if value.is_empty() {
        String::from_str(env, fallback)
    } else {
        value.clone()
    }
}


pub fn assert_claim_conservation(claim: &Claim) -> Result<(), Error> {
    if claim.remaining_escrow < 0 {
        return Err(Error::ConservationViolation);
    }
    if claim.total_challenger_stake < 0 || claim.creator_stake < 0 {
        return Err(Error::ConservationViolation);
    }
    if claim.reserved_creator_liability < 0 {
        return Err(Error::ConservationViolation);
    }
    if claim.reserved_creator_liability > claim.creator_stake {
        return Err(Error::ConservationViolation);
    }
    if claim.state == ClaimState::Resolved {
        let total = claim
            .creator_stake
            .checked_add(claim.total_challenger_stake)
            .ok_or(Error::Overflow)?;
        if claim.remaining_escrow > total {
            return Err(Error::ConservationViolation);
        }
    }
    Ok(())
}
