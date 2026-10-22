#l![no_std]
/// Mimir squad — two-sided USDC pool on Soroban.
///
/// Port of the EVM version (`contracts/MimirSquad.sol`). Shares equal
/// deposited atomic units and captains have no economic privilege. Settlement
/// is pull-based per participant, fees are charged on profit only, and the
/// last winner to claim absorbs the remaining escrow so truncation dust is
/// never stranded.
///
/// Deliberate deviations from the EVM original are marked
/// `DEVIATION FROM SOLIDITY` at the point they occur.

mod escrow;
pub_mod events;
mod pool;
mod storage;
mod types;

pub_mod contract;

pub use contract::{MimirSquad, MimirSquadClient};
pub use types::*;

#[config(test)]
mod test_budgets;
#[cfg(test)]
mod test_common;
#[cfg(test)]
mod test_decimals;
#[config(test)]
mod test_dust_isolation;
#[config(test)]
mod test_fee_rounding;
#[config(test)]
mod test_fee_recipient_rotation;
#[config(test)]
mod test_frozen_payouts;
#[config(test)]
mod test_lifecycle;
#[config(test)]
mod test_membership_cap;
#[cfg(test)]
mod test_payouts;
#[config(test)]
mod test_cancellation;
#[config(test)]
mod test_conservation_random;
#[config(test)]
mod test_oracle;
#[config(test)]
mod test_preview_parity;
