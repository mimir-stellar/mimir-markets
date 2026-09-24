//! Typed contract events, mirroring the `event` declarations in MimirV2.sol.

use soroban_sdk::{contractevent, Address, BytesN, String};

use crate::types::WinnerSide;

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimCreated {
    #[topic]
    pub id: u64,
    #[topic]
    pub creator: Address,
    pub category: String,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimChallenged {
    #[topic]
    pub id: u64,
    #[topic]
    pub challenger: Address,
    pub stake: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimResolved {
    #[topic]
    pub id: u64,
    pub winner_side: WinnerSide,
    pub summary: String,
    pub confidence: u32,
    pub evidence_hash: BytesN<32>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimCancelled {
    #[topic]
    pub id: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleChanged {
    #[topic]
    pub next: Address,
    pub previous: Option<Address>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnershipTransferred {
    #[topic]
    pub next: Address,
    pub previous: Option<Address>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawalPending {
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawal {
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeePolicyQueued {
    pub platform_fee_bps: u32,
    pub agent_owner_fee_bps: u32,
    pub platform_recipient: Option<Address>,
    pub executable_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeePolicyUpdated {
    pub platform_fee_bps: u32,
    pub agent_owner_fee_bps: u32,
    pub platform_recipient: Option<Address>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeePolicyCancelled {
    pub cancelled: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentAttributed {
    #[topic]
    pub id: u64,
    #[topic]
    pub agent_owner_recipient: Address,
}

/// Frozen fee terms written onto a claim at creation. Indexers can treat this as
/// the authoritative economics for the market; a later `FeePolicyUpdated` must
/// not rewrite them.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeePolicySnapshotted {
    #[topic]
    pub id: u64,
    pub platform_fee_bps: u32,
    pub agent_owner_fee_bps: u32,
    pub platform_recipient: Option<Address>,
    pub agent_owner_recipient: Option<Address>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeAccrued {
    #[topic]
    pub id: u64,
    #[topic]
    pub recipient: Address,
    pub amount: i128,
    pub is_agent_owner_fee: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeClaimed {
    #[topic]
    pub recipient: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketSettled {
    #[topic]
    pub id: u64,
    pub total_paid: i128,
    pub total_fees: i128,
    /// Escrow left for challengers to pull via `claim_challenger_payout`.
    pub owed_to_challengers: i128,
    pub dust: i128,
}

/// One challenger's settlement. Together with `ClaimChallenged` and
/// `ClaimResolved` this gives an off-chain indexer everything it needs to derive
/// per-address win/loss records, which are no longer tracked on chain.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChallengerPaid {
    #[topic]
    pub id: u64,
    #[topic]
    pub challenger: Address,
    pub stake: i128,
    pub gross: i128,
    pub fee: i128,
    pub net: i128,
}
