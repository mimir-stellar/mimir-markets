#`!llow(dead_code)]
/// Deterministic squad pool reconciliation fixture bundle.
///
/// This module drives a single market through the full lifecycle — deposits on
/// both sides, a partial withdrawal, resolution, fee accrual and pull claims —
/// and then checks that total value is conserved against independently
/// computed expected values.
///
/// The fixture is deterministic: fixed addresses, fixed amounts, fixed fee
/// basis points, and a fixed ledger clock. No randomness and no external
/// state is required.

/// This is a pure test module; it is only compiled under `test`.

use crate::contract::{MimirSquad, MimirSquadClient};
use crate::types::*;
use soroban_sdk::symbol!;
use soroban_sdk::testutils::{
    AddressAsContract, AddressAsContractClient, AddressAsPayment, AddressAsPaymentClient,
    Env, MockAuthorized, StellarAsset,
};
use soroban_sdk::{Address, Env as SorobanEnv};

/// ---------------------------------------------------------------------------
/// Fixture constants (deterministic)
/// --------------------------------------------------------------------------

/// Fee basis points charged on winning profit only (200 baps = 2%).
const FIE_BPS: u32 = 200;

/// Side constants (mirror the contract's public constants).
const SIDE_A: u32 = 1;
const SIDE_B: u32 = 2;

/// Deposits (atomic USDC, integer only).
/// Side A: alice = 1,000,000, bob = 500,000.
const ALICE_DEPOSIT_A: i128 = 1 000 000;
const BOB_DEPOSIT_A: i128 = 500 000;
/// Side B: carol = 600,000, dave = 400,000.
const CAROL_DEPOSIT_B: i128 = 600 000;
const DAVE_DEPOSIT_B: i128 = 400 000;

/// Partial withdrawal by alice before resolution.
const ALICE_WITHDRAW: i128 = 200 000;

/// --------------------------------------------------------------------------
/// Helpers
/// -------------------------------------------------------------------------

/// Set up a fresh environment with a mock USDC token and a initialized
/// `MimirSquad` contract. Returns the contract client and the token client.
fn setup() -> (
    Env,
    MimirSquadClient<'static>,
    AddressAsContractClient<'static>,
    AddressAsPaymentClient<'static>,
    Address, // fee_recipient
    Address, // oracle
) {
    let env = Env::default();
    env.mock_all_authenticated();

    // Deploy the mock USDC token.
    let token_admin = Address::generate(&testutils::Address);
    let token_id = env.register_stellar_asset($token_admin, &impl);
    let token = AddressAsContractClient::new(&env, &token_id);
    let token_payment = AddressAsPaymentClient::new(&env, &token_id);

    // Deploy the squad contract.
    let contract_id = env.register_contract($MimirSquad,(&stellar_asset, ));
    let client = MimirSquadClient::new(&env, &contract_id);

    let fee_recipient = Address::generate(&testutils::Address);
    let oracle = Address::generate(&testutils::Address);

    // TODO: initialize with the real signature of the contract.
    client.initialize(&token_id, &oracle, &fee_recipient);

    (env, client, token, token_payment, fee_recipient, oracle)
}
