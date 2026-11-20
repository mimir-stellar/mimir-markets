# Payout rounding policy

Mimir market policy **1** identifies the existing atomic USDC arithmetic. It
changes no fee rate, escrow allocation, withdrawal authority or stored claim.

| Calculation | Policy 1 |
| --- | --- |
| Fixed-odds gross | Truncate `stake * payout_bps / 10000` |
| Pool profit share | Truncate `stake * creator_stake / total_challenger_stake` |
| Profit fees | Truncate each recipient's `profit * fee_bps / 10000` separately |
| Fee remainders | Retained in the participant's net payout |
| Pool dust | Paid to the final challenger to claim |
| Refund | Return principal without a profit fee |

All calculations use integer atomic USDC (seven decimals). XLM remains for
ledger fees and reserve.

## Contract interface

The existing `quote_challenger_payout` and `claim_challenger_payout` methods keep
their signatures and response encodings. New integrations can require a policy:

- `rounding_policy_version()` returns `1` without reading a claim or wallet.
- `quote_payout_versioned(claim_id, challenger, required_version)` returns
  `{ rounding_policy_version: 1, quote: { gross, fee, net, claimed } }`.
- `claim_payout_versioned(challenger, claim_id, required_version)` returns the
  net credited with the existing payout authorization and duplicate protection.

The required version must be exactly `1`. Other values fail with
`UnsupportedRoundingPolicyVersion` (**contract error 48**) before reading the
claim/roster, accruing fees or transferring funds. The remedy is to read a
supported preview and update the client policy. Repeating the same unsupported
request cannot succeed.

The wrapper reports its version even for zero quotes: unresolved claims,
nonparticipants, creator wins and already claimed positions retain their existing
zero-quote behavior. Unknown versions are also rejected on refund paths.

This version is a compatibility requirement. It does not reserve an amount,
authorize a signature or lock a quote: another claimant can collect the pool dust
before this wallet does. Soroban state at execution remains authoritative.
Payouts remain pull-based, and a failed token transfer uses the existing parked
withdrawal fallback. No signing-key or deployment change is included.

## Client interface and fixtures

`previewChallengerPayoutSafe()` adds `roundingPolicyVersion: 1` and accepts an
optional `requiredRoundingPolicyVersion`. Omission preserves the current policy;
unsupported values throw `UnsupportedRoundingPolicyVersion`, with code
`unsupported_rounding_policy_version`. `splitFees()` and `settleMarket()` check
the same optional requirement, including refund and zero-fee paths.

`quoteChallengerPayoutVersioned()` and `claimChallengerPayoutVersioned()` in
`lib/contract.ts` call the new contract methods. They reject unsupported versions
before simulation or asking for a signer. They require a deployment exposing the
new methods and never silently fall back to an unversioned quote. Existing
adapters remain available for current deployments.

Rust and Node tests consume `fixtures/payout-rounding/v1.json`, a shared synthetic
fixture pinning the version, decimals, independent fee rounding, one-unit profit,
refunds and pool dust. Atomic amounts are decimal strings to preserve integers
above JavaScript's safe number limit.

## Before and after

For a 20,130,000-unit stake at 10,001 payout bps and 700 + 300 profit-fee bps,
the legacy quote is unchanged:

```json
{"gross":"20132013","fee":"200","net":"20131813","claimed":false}
```

The versioned quote wraps those amounts:

```json
{"rounding_policy_version":1,"quote":{"gross":"20132013","fee":"200","net":"20131813","claimed":false}}
```

An interface can render: **Rounding policy 1 · Net payout 2.0131813 USDC**.
These JSON examples show atomic amounts as strings for independent clients.

## Verification and rollback

```sh
cd contracts-soroban
cargo test --locked -p mimir-market rounding_policy
cargo test --locked
cargo build --locked --target wasm32v1-none --release
```

From the repository root:

```sh
node --import tsx --test tests/node/rounding-policy.test.ts tests/node/rounding-policy-adapters.test.ts tests/node/payout-preview.test.ts tests/node/fees.test.ts tests/node/pool-payout.test.ts
```

The market SDK is regenerated from the local SDK 25 Wasm with Stellar CLI
25.2.0; the older CLI 22 cannot read its XDR 25 event specifications:

```sh
stellar contract bindings typescript --wasm contracts-soroban/target/wasm32v1-none/release/mimir_market.wasm --output-dir sdk/contracts/mimir-market --overwrite
```

Retain the existing SDK package manifest and Testnet `networks` metadata when
refreshing the generated source. No deployment is performed by this command.

Revert the added methods, client support, generated bindings and fixtures together
to roll back. Stored claim/fee encodings and legacy methods are unchanged, so no
data migration is required. Any future policy change needs an explicit design
for existing funded claims; changing the constant alone is insufficient.
