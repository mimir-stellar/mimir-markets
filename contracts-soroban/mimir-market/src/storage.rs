//! Storage keys and typed accessors.
//!
//! Globals live in instance storage (small, always loaded with the contract).
//! Per-claim and per-address rows live in persistent storage.

use soroban_sdk::{contracttype, Address, Env, Vec};

use crate::types::{
    Challenger, ChallengerPage, Claim, Error, FeePolicy, PendingFeePolicy, PendingOracle,
    PendingOwner, RematchStatus, Verdict,
};

/// Maximum number of addresses accepted by [`get_withdrawable_batch`].
///
/// Keeps the ledger-entry footprint of a single read bounded.
pub const MAX_BATCH_SIZE: u32 = 50;

/// Number of claim ids packed into a single per-creator index page.
///
/// Keeps each persistent entry small while amortising the per-entry overhead.
pub const CREATOR_PAGE_SIZE: u32 = 100;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// One-time initialisation guard.
    Init,
    /// Global pause flag. When set, state-changing market operations are
    /// halted, but withdrawals and fee pulls MUST remain available so user
    /// funds are never trapped by an operator pause.
    Paused,
    Owner,
    Oracle,
    Usdc,
    Policy,
    Pending,
    /// Queued oracle rotation (separate from fee-policy Pending).
    PendingOracle,
    /// Proposed new owner awaiting acceptance.
    PendingOwner,
    ClaimCount,
    TotalResolved,
    FeesAccrued,
    FeesClaimed,
    Claim(u64),
    Challengers(u64),
    /// Versioned verdict written at resolution. Absent on claims resolved
    /// before verdicts were versioned; readers fall back to `Claim.winner_side`
    /// for those.
    Verdict(u64),
    /// Pull-payment fallback for failed payout pushes.
    Withdrawable(Address),
    /// Accrued, unclaimed fees. Always pulled, never pushed.
    Accrued(Address),
    /// Rematch parent link validation cache: (parent_id, child_id) -> RematchStatus
    RematchParent(u64, u64),
    /// Per-creator claim index page: (creator, page_index) -> Vec<u64> of claim ids.
    CreatorClaims(Address, u32),
    /// Per-creator total claim count, used to derive the page layout.
    CreatorClaimCount(Address),
}

/// Persistent entries are bumped to roughly 30 days of ledgers on touch so an
/// open market cannot be archived out from under its participants.
const BUMP_THRESHOLD: u32 = 120_960;
const BUMP_EXTEND: u32 = 518_400;

// ── Globals ──────────────────────────────────────────────────────────────────

pub fn is_initialized(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Init)
}

pub fn mark_initialized(env: &Env) {
    env.storage().instance().set(&DataKey::Init, &true);
}

/// Whether the market is currently paused.
///
/// Pause is a *state-changing* gate only: it must never be consulted on the
/// withdrawal or fee-pull paths. See [`require_not_paused`] for the guard used
/// by mutating entry points.
pub fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

pub fn set_paused(env: &Env, paused: bool) {
    env.storage().instance().set(&DataKey::Paused, &paused);
}

pub fn owner(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Owner)
        .ok_or(Error::NotInitialized)
}

pub fn set_owner(env: &Env, who: &Address) {
    env.storage().instance().set(&DataKey::Owner, who);
}

pub fn pending_owner(env: &Env) -> Option<PendingOwner> {
    env.storage().instance().get(&DataKey::PendingOwner)
}

pub fn set_pending_owner(env: &Env, pending: &PendingOwner) {
    env.storage().instance().set(&DataKey::PendingOwner, pending);
}

pub fn clear_pending_owner(env: &Env) {
    env.storage().instance().remove(&DataKey::PendingOwner);
}

pub fn oracle(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Oracle)
        .ok_or(Error::NotInitialized)
}

pub fn set_oracle(env: &Env, who: &Address) {
    env.storage().instance().set(&DataKey::Oracle, who);
}

pub fn usdc(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Usdc)
        .ok_or(Error::NotInitialized)
}

pub fn set_usdc(env: &Env, who: &Address) {
    env.storage().instance().set(&DataKey::Usdc, who);
}

pub fn fee_policy(env: &Env) -> Result<FeePolicy, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Policy)
        .ok_or(Error::NotInitialized)
}

pub fn set_fee_policy(env: &Env, policy: &FeePolicy) {
    env.storage().instance().set(&DataKey::Policy, policy);
}

pub fn pending_fee_policy(env: &Env) -> Option<PendingFeePolicy> {
    env.storage().instance().get(&DataKey::Pending)
}

pub fn set_pending_fee_policy(env: &Env, pending: &PendingFeePolicy) {
    env.storage().instance().set(&DataKey::Pending, pending);
}

pub fn clear_pending_fee_policy(env: &Env) {
    env.storage().instance().remove(&DataKey::Pending);
}

pub fn pending_oracle(env: &Env) -> Option<PendingOracle> {
    env.storage().instance().get(&DataKey::PendingOracle)
}

pub fn set_pending_oracle(env: &Env, pending: &PendingOracle) {
    env.storage().instance().set(&DataKey::PendingOracle, pending);
}

pub fn clear_pending_oracle(env: &Env) {
    env.storage().instance().remove(&DataKey::PendingOracle);
}

fn counter(env: &Env, key: DataKey) -> u64 {
    env.storage().instance().get(&key).unwrap_or(0)
}

fn set_counter(env: &Env, key: DataKey, value: u64) {
    env.storage().instance().set(&key, &value);
}

pub fn claim_count(env: &Env) -> u64 {
    counter(env, DataKey::ClaimCount)
}

pub fn set_claim_count(env: &Env, value: u64) {
    set_counter(env, DataKey::ClaimCount, value);
}

pub fn total_resolved(env: &Env) -> u64 {
    counter(env, DataKey::TotalResolved)
}

pub fn bump_total_resolved(env: &Env) {
    let next = total_resolved(env) + 1;
    set_counter(env, DataKey::TotalResolved, next);
}

fn amount(env: &Env, key: DataKey) -> i128 {
    env.storage().instance().get(&key).unwrap_or(0)
}

pub fn lifetime_fees_accrued(env: &Env) -> i128 {
    amount(env, DataKey::FeesAccrued)
}

pub fn add_lifetime_fees_accrued(env: &Env, delta: i128) {
    let next = lifetime_fees_accrued(env) + delta;
    env.storage().instance().set(&DataKey::FeesAccrued, &next);
}

pub fn lifetime_fees_claimed(env: &Env) -> i128 {
    amount(env, DataKey::FeesClaimed)
}

pub fn add_lifetime_fees_claimed(env: &Env, delta: i128) {
    let next = lifetime_fees_claimed(env) + delta;
    env.storage().instance().set(&DataKey::FeesClaimed, &next);
}

// ── Claims ───────────────────────────────────────────────────────────────────

pub fn get_claim(env: &Env, id: u64) -> Result<Claim, Error> {
    let key = DataKey::Claim(id);
    let claim: Claim = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::ClaimNotFound)?;
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
    Ok(claim)
}

/// Return `Some(claim)` if the entry exists, `None` if it does not.
///
/// Unlike [`get_claim`], a miss does NOT bump the TTL (there is nothing to
/// extend) and does NOT return an error, so it is the right primitive for
/// batch reads where a missing id is a normal, non-fatal answer.
///
/// A present entry still receives its usual TTL extension so an open market
/// cannot expire while a batch is being constructed.
pub fn get_claim_opt(env: &Env, id: u64) -> Option<Claim> {
    let key = DataKey::Claim(id);
    match env.storage().persistent().get::<_, Claim>(&key) {
        Some(claim) => {
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
            Some(claim)
        }
        None => None,
    }
}

pub fn set_claim(env: &Env, id: u64, claim: &Claim) {
    let key = DataKey::Claim(id);
    env.storage().persistent().set(&key, claim);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
}

pub fn challengers(env: &Env, id: u64) -> Vec<Challenger> {
    let key = DataKey::Challengers(id);
    match env.storage().persistent().get::<_, Vec<Challenger>>(&key) {
        Some(list) => {
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
            list
        }
        None => Vec::new(env),
    }
}

/// Return a page of the challenger roster starting at `offset`, up to `limit`
/// entries. `limit = 0` is treated as "return all remaining entries from
/// `offset`". Callers should use a non-zero limit in production to bound
/// ledger-entry footprint.
///
/// Never panics: if `offset` is beyond the end of the roster the returned
/// `items` slice is empty and `total` carries the actual roster length.
pub fn challengers_page(env: &Env, id: u64, offset: u32, limit: u32) -> ChallengerPage {
    let list = challengers(env, id);
    let total = list.len();
    let start = offset.min(total);
    let remaining = total - start;
    let take = if limit == 0 {
        remaining
    } else {
        limit.min(remaining)
    };

    let mut items = Vec::new(env);
    for i in start..start + take {
        items.push_back(list.get(i).unwrap());
    }

    ChallengerPage {
        items,
        offset: start,
        total,
    }
}

pub fn set_challengers(env: &Env, id: u64, list: &Vec<Challenger>) {
    let key = DataKey::Challengers(id);
    env.storage().persistent().set(&key, list);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
}

// ── Per-creator claim index ──────────────────────────────────────────────────

/// Total number of claims ever created by `creator`.
///
/// This is the authoritative length of the creator's index; pages are derived
/// from it on read, so a partially-written tail page is never observed.
pub fn creator_claim_count(env: &Env, creator: &Address) -> u64 {
    let key = DataKey::CreatorClaimCount(creator.clone());
    match env.storage().persistent().get::<_, u64>(&key) {
        Some(count) => {
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
            count
        }
        None => 0,
    }
}

fn creator_page(env: &Env, creator: &Address, page: u32) -> Vec<u64> {
    let key = DataKey::CreatorClaims(creator.clone(), page);
    match env.storage().persistent().get::<_, Vec<u64>>(&key) {
        Some(list) => {
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
            list
        }
        None => Vec::new(env),
    }
}

fn set_creator_page(env: &Env, creator: &Address, page: u32, list: &Vec<u64>) {
    let key = DataKey::CreatorClaims(creator.clone(), page);
    env.storage().persistent().set(&key, list);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
}

/// Append `id` to the creator's index, writing at most one page entry.
///
/// The page is only rewritten when the current tail page is full and a new
/// page must be started; otherwise the existing tail page is read, extended,
/// and written back, so `create_claim` grows its footprint by at most one
/// persistent entry.
pub fn append_creator_claim(env: &Env, creator: &Address, id: u64) {
    let count = creator_claim_count(env, creator);
    let page = (count / CREATOR_PAGE_SIZE as u64) as u32;
    let mut list = creator_page(env, creator, page);
    list.push_back(id);
    set_creator_page(env, creator, page, &list);

    let count_key = DataKey::CreatorClaimCount(creator.clone());
    env.storage().persistent().set(&count_key, &(count + 1));
    env.storage()
        .persistent()
        .extend_ttl(&count_key, BUMP_THRESHOLD, BUMP_EXTEND);
}
