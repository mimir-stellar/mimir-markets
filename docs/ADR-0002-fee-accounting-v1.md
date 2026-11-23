# ADR-0002: Fee accounting v1

Status: Accepted

## Context

Fee policy and escrow modules allocate exact USDC amounts while retaining
pull-based user funds. Integrators need to read fee state without inferring
it from events or from the off-chain index.

## Decision

Fee recipients expose three exact atomic-integer values in USDC base units:

- `accrued`: lifetime fees credited to the recipient. Monotonic non-decreasing.
- `claimed`: lifetime fees the recipient has withdrawn. Monotonic non-decreasing.
- `outstanding`: fees still claimable, defined as `accrued - claimed`.

Field meaning is stable across versions. `accrued == 0` means no accrual has
happened. `accrued > 0` with `outstanding == 0` means a fully claimed balance.
These two states are intentionally distinct.

## Consequences

- Soroban contract state remains the authoritative source. The Postgres index
  is a read cache and must not be used to derive these values for payouts.
- Values are integer USDC only. XLM is used only for fees and reserve.
- Payouts remain pull-based. Reading these values does not move funds.
- Existing payout and fee-split behaviour is unchanged.
