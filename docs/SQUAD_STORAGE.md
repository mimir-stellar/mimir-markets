# Mimir Squad Storage Layout & TTL Policy

This document details the on-chain storage architecture, data keys, storage classes, TTL lifecycles, entry point interactions, and archival risk factors for the `mimir-squad` Soroban smart contract (`contracts-soroban/mimir-squad/src/storage.rs`).

---

## 1. Storage Parameters & Constants

Soroban state isolation distinguishes between **Instance** storage (tied to the contract instance lifetime) and **Persistent** storage (individual contract ledger entries with independent TTLs).

Defined in `storage.rs:28-29`:
- **`BUMP_THRESHOLD`**: `120_960` ledgers (~7 days assuming 5-second ledger close time). When an entry's remaining time-to-live drops below this threshold, it is eligible for TTL extension.
- **`BUMP_EXTEND`**: `518_400` ledgers (~30 days assuming 5-second ledger close time). The target lifetime to which the entry's TTL is extended upon a bump.

```rust
// contracts-soroban/mimir-squad/src/storage.rs:28-29
const BUMP_THRESHOLD: u32 = 120_960;
const BUMP_EXTEND: u32 = 518_400;
```

---

## 2. Storage Key Catalog

| Key (`DataKey`) | Storage Class | Value Type | TTL Policy | Touching Entry Points |
| :--- | :--- | :--- | :--- | :--- |
| `Init` | **Instance** | `bool` | Contract Instance Lifetime | `initialize` (`storage::mark_initialized`, `storage::is_initialized`) |
| `Usdc` | **Instance** | `Address` | Contract Instance Lifetime | `initialize` (`storage::set_config`), `get_usdc`, `get_escrow_balance` |
| `Oracle` | **Instance** | `Address` | Contract Instance Lifetime | `initialize`, `get_oracle`, `set_oracle`, `resolve` |
| `FeeRecipient` | **Instance** | `Address` | Contract Instance Lifetime | `initialize`, `get_fee_recipient`, `claim_fees` |
| `PendingOracle` | **Instance** | `PendingOracle` | Contract Instance Lifetime | `get_pending_oracle`, `set_pending_oracle`, `clear_pending_oracle` |
| `MarketCount` | **Instance** | `u64` | Contract Instance Lifetime | `create_market`, `get_market_count` |
| `AccruedFees` | **Instance** | `i128` | Contract Instance Lifetime | `resolve`, `claim_fees`, `get_accrued_fees` |
| `Market(u64)` | **Persistent** | `Market` | Bumped on read & write (`BUMP_THRESHOLD`, `BUMP_EXTEND`) | `create_market`, `deposit`, `withdraw_before_deadline`, `transition_deadline`, `resolve`, `cancel_market`, `claim`, `get_market`, `preview_claim` |
| `Deposit(u64, u32, Address)` | **Persistent** | `i128` | Bumped on write only (`BUMP_THRESHOLD`, `BUMP_EXTEND`); deleted on 0 | `deposit`, `withdraw_before_deadline`, `claim`, `get_deposit`, `preview_claim` |
| `Claimed(u64, u32, Address)` | **Persistent** | `bool` | Bumped on write only (`BUMP_THRESHOLD`, `BUMP_EXTEND`) | `claim`, `has_claimed`, `preview_claim` |
| `Payout(u64, u32, Address)` | **Persistent** | `i128` | Bumped on write only (`BUMP_THRESHOLD`, `BUMP_EXTEND`); deleted on 0 | `claim`, `claim_parked_payout`, `parked_payout` |

---

## 3. Storage Key Descriptions & Access Patterns

### 3.1 Instance Storage (Protocol Configuration & Global Counters)

1. **`DataKey::Init`**
   - **Accessor:** `storage::is_initialized`, `storage::mark_initialized` (`storage.rs:33-39`)
   - **Purpose:** Prevents re-initialization of core parameters once configured.

2. **`DataKey::Usdc`**
   - **Accessor:** `storage::usdc`, `storage::set_config` (`storage.rs:48-50, 60-66`)
   - **Purpose:** Holds the contract address of the accepted settlement token (Circle SAC USDC).

3. **`DataKey::Oracle`**
   - **Accessor:** `storage::oracle`, `storage::set_oracle` (`storage.rs:52-54, 68-70`)
   - **Purpose:** Stores the authorized oracle address permitted to invoke `resolve()`.

4. **`DataKey::FeeRecipient`**
   - **Accessor:** `storage::fee_recipient`, `storage::set_config` (`storage.rs:56-58, 60-66`)
   - **Purpose:** Protocol treasury address where accrued profit cuts are transferred upon `claim_fees()`.

5. **`DataKey::PendingOracle`**
   - **Accessor:** `storage::pending_oracle`, `storage::set_pending_oracle`, `storage::clear_pending_oracle` (`storage.rs:72-82`)
   - **Purpose:** Supports two-step timelocked oracle key rotation, holding `new_oracle: Address` and `effective_timestamp: u64`.

6. **`DataKey::MarketCount`**
   - **Accessor:** `storage::market_count`, `storage::set_market_count` (`storage.rs:86-95`)
   - **Purpose:** Monotonically increasing counter for sequential market ID assignment.

7. **`DataKey::AccruedFees`**
   - **Accessor:** `storage::accrued_fees`, `storage::set_accrued_fees` (`storage.rs:97-106`)
   - **Purpose:** Cumulative protocol fee balance retained in contract escrow until claimed by `fee_recipient`.

---

### 3.2 Persistent Storage (Market State, Ledger & Balances)

1. **`DataKey::Market(u64)`**
   - **Accessor:** `storage::get_market`, `storage::set_market` (`storage.rs:110-129`)
   - **Payload:** `Market` struct (`captain`, `question`, `deadline`, `fee_bps`, `total_deposits`, `deposits_0`, `deposits_1`, `resolved`, `result`, `claimed_count`, `winner_count`, `remaining_escrow`).
   - **TTL Behavior:** Both `get_market` and `set_market` proactively bump TTL via `extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND)`.

2. **`DataKey::Deposit(u64, u32, Address)`**
   - **Accessor:** `storage::deposit_of`, `storage::set_deposit` (`storage.rs:133-150`)
   - **Payload:** `i128` atomic units representing participant shares on market `id` and `side`.
   - **TTL Behavior:** Bumped when `set_deposit` is written. If updated amount is zero (e.g. full withdrawal), the entry is deleted via `persistent().remove(&key)`.

3. **`DataKey::Claimed(u64, u32, Address)`**
   - **Accessor:** `storage::has_claimed`, `storage::mark_claimed` (`storage.rs:152-164`)
   - **Payload:** `bool` (`true`) recording that a participant has claimed their winnings/refund.
   - **TTL Behavior:** Extended via `extend_ttl` when `mark_claimed` is written during `claim()`.

4. **`DataKey::Payout(u64, u32, Address)`**
   - **Accessor:** `storage::payout_of`, `storage::set_payout` (`storage.rs:170-187`)
   - **Payload:** `i128` parked settlement units when a token transfer trapped due to a frozen/deauthorized participant trustline.
   - **TTL Behavior:** Extended via `extend_ttl` when written in `set_payout`. Deleted via `persistent().remove(&key)` once claimed.

---

## 4. Archival & Operational Risk Analysis

### Risk 1: Unextended Read on `deposit_of` (`storage.rs:133-138`)
- **Code Reference:**
  ```rust
  // contracts-soroban/mimir-squad/src/storage.rs:133-138
  pub fn deposit_of(env: &Env, id: u64, side: u32, who: &Address) -> i128 {
      env.storage()
          .persistent()
          .get(&DataKey::Deposit(id, side, who.clone()))
          .unwrap_or(0)
  }
  ```
- **Risk Assessment:** `deposit_of` reads `DataKey::Deposit` without calling `extend_ttl`. In prediction markets spanning durations longer than `BUMP_EXTEND` (518,400 ledgers ~ 30 days), an early depositor who never re-deposits or modifies their position faces key archival. If the market resolves 45 days after their deposit, their `Deposit` record will be archived by the Stellar network. When `claim()` is called, reading the archived key will fail or return `0`, requiring an out-of-band state restoration before the payout can be claimed.
- **Mitigation Recommendation:** Proactively extend TTL in `deposit_of` or provide a public keeper function `bump_deposit_ttl(market_id, side, participant)`.

---

### Risk 2: Read-Only Polling on `has_claimed` (`storage.rs:152-156`)
- **Code Reference:**
  ```rust
  // contracts-soroban/mimir-squad/src/storage.rs:152-156
  pub fn has_claimed(env: &Env, id: u64, side: u32, who: &Address) -> bool {
      env.storage()
          .persistent()
          .has(&DataKey::Claimed(id, side, who.clone()))
  }
  ```
- **Risk Assessment:** `has_claimed` only checks membership (`persistent().has(...)`) without extending TTL. If external indexers or UI frontends query `has_claimed`, the record's TTL is not refreshed. If an old claimed entry archives, subsequent queries would return `false` (though `claim()` would be blocked if deposits are already zero or market balance is depleted).
- **Mitigation Recommendation:** Document for indexers that `Claimed` status should be cached off-chain from contract event logs rather than relying on perpetually alive on-chain entries.

---

### Risk 3: Parked Payout Archival Window (`storage.rs:170-175, 177-187`)
- **Code Reference:**
  ```rust
  // contracts-soroban/mimir-squad/src/storage.rs:170-175
  pub fn payout_of(env: &Env, id: u64, side: u32, who: &Address) -> i128 {
      env.storage()
          .persistent()
          .get(&DataKey::Payout(id, side, who.clone()))
          .unwrap_or(0)
  }
  ```
- **Risk Assessment:** Parked payouts are written when a winner's USDC transfer traps (`DEVIATION FROM SOLIDITY` fallback in `claim()`). `payout_of` does not bump TTL on read. If the participant's trustline remains deauthorized/frozen for longer than 30 days (`BUMP_EXTEND`), the parked entry will be archived. When the user attempts to call `claim_parked_payout()`, the transaction will revert with `0` or fail to locate the parked units until the ledger key is restored.
- **Mitigation Recommendation:** Bumping TTL in `payout_of` or during `preview_claim` ensures that any inquiry into an uncollected payout automatically extends its lifetime.

---

### Risk 4: Instance Inactivity & Contract Dormancy (`storage.rs:31-106`)
- **Code Reference:** `storage.rs:33-106` (Instance storage methods for config, oracle, fee recipient, and accrued fees).
- **Risk Assessment:** Instance storage entries do not possess independent TTLs; their lifetime is tied to the contract instance itself. In the event of prolonged market inactivity where no markets are created or resolved for months, the contract instance TTL may expire, rendering the contract inaccessible until restored.
- **Mitigation Recommendation:** The protocol operator should maintain a scheduled keeper (e.g. weekly health check) that extends contract instance TTL.
