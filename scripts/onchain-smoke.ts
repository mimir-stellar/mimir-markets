/**
 * Live end-to-end smoke against the deployed Soroban contracts on Stellar
 * Testnet. Replaces the previous EVM smoke, which did:
 *   read config → createClaim (2 USDC) → challengeClaim (2 USDC) → read state.
 *
 * The Soroban flow is the same shape, with real Circle testnet USDC pulled into
 * contract escrow through the USDC Stellar Asset Contract:
 *   [1] read oracle / usdc / fee policy / claim count
 *   [2] deployer create_claim  (2 USDC, ClaimState::Open)
 *   [3] oracle   challenge_claim (2 USDC, ClaimState::Active)
 *   [4] read the claim + roster + escrow balance back
 *   [5] (--resolve only) wait out the real deadline, then oracle resolve_claim
 *       and the challenger's claim_challenger_payout
 *
 * Every call goes through the generated bindings in `sdk/contracts/*`, so this
 * doubles as bindings verification.
 *
 * On resolve/payout: a live network has no ledger fast-forward, so
 * `resolve_claim`'s `NotYetExpired` guard can only be satisfied by real elapsed
 * time. `challenge_claim` additionally requires `now + CHALLENGE_LOCK_SECONDS
 * (60) <= deadline`, so the shortest deadline that still admits a challenge is
 * ~60s out. The default run therefore stops after the challenge and asserts the
 * state transitions up to that point; `--resolve` opts into the real wait.
 *
 *   npx tsx scripts/onchain-smoke.ts
 *   npx tsx scripts/onchain-smoke.ts --resolve      # ~3 min of real waiting
 *   npx tsx scripts/onchain-smoke.ts --squad        # also exercise mimir-squad
 */
import { createHash, randomUUID } from "node:crypto";

import { Asset, Horizon } from "@stellar/stellar-sdk";

import {
  CHALLENGE_LOCK_SECONDS,
  ENV_KEYS,
  HORIZON_URL,
  MIN_STAKE_ATOMIC,
  USDC_CODE,
  USDC_ISSUER,
  explorerContractUrl,
  formatAtomicUsdc,
  requireEnv,
} from "./lib/stellar-env";
import {
  keypairFor,
  marketClient,
  marketContractId,
  sendAndUnwrap,
  squadClient,
  squadContractId,
  unwrapResult,
  usdcSacId,
} from "./lib/stellar-clients";
import { ClaimState, WinnerSide, type Claim, type CreateParams } from "../sdk/contracts/mimir-market/src/index";

const args = new Set(process.argv.slice(2));
const DO_RESOLVE = args.has("--resolve");
const DO_SQUAD = args.has("--squad");

const STAKE = MIN_STAKE_ATOMIC; // 2 USDC @ 7 decimals
/** Comfortably past `CHALLENGE_LOCK_SECONDS` so the challenge cannot race it. */
const DEADLINE_OFFSET_SECONDS = 150;

const horizon = new Horizon.Server(HORIZON_URL);
const USDC = new Asset(USDC_CODE, USDC_ISSUER);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

async function classicUsdcBalance(publicKey: string): Promise<bigint> {
  const account = await horizon.loadAccount(publicKey);
  const line = account.balances.find(
    (b) =>
      "asset_code" in b && b.asset_code === USDC.code && "asset_issuer" in b && b.asset_issuer === USDC.issuer,
  );
  if (!line) throw new Error(`${publicKey} has no USDC trustline — run scripts/stellar-keys.ts`);
  return BigInt(line.balance.replace(".", ""));
}

async function requireStakeableUsdc(role: string, publicKey: string): Promise<void> {
  const balance = await classicUsdcBalance(publicKey);
  console.log(`  ${role} USDC: ${formatAtomicUsdc(balance)}`);
  if (balance < STAKE) {
    throw new Error(
      `${role} (${publicKey}) holds ${formatAtomicUsdc(balance)} USDC but needs at least ` +
        `${formatAtomicUsdc(STAKE)} — run: npx tsx scripts/stellar-usdc-faucet.ts`,
    );
  }
}

function smokeCreateParams(deadline: number): CreateParams {
  const nonce = randomUUID();
  return {
    question: `Onchain smoke ${nonce.slice(0, 8)} — is this claim challengeable on testnet?`,
    creator_position: "Yes",
    counter_position: "No",
    resolution_url: "https://example.com/smoke",
    deadline: BigInt(deadline),
    stake_amount: STAKE,
    category: "custom",
    parent_id: 0n,
    market_type: "binary",
    odds_mode: "pool",
    challenger_payout_bps: 0,
    handicap_line: "",
    settlement_rule: "Smoke test only — not for real settlement",
    max_challengers: 100,
    is_private: false,
    invite_key: null,
    // A real context pack is hashed here in production; a deterministic digest of
    // the nonce keeps each smoke claim distinguishable on chain.
    context_hash: createHash("sha256").update(nonce).digest(),
    agent_owner_recipient: null,
  };
}

function assertEqual(label: string, actual: unknown, expected: unknown): void {
  if (String(actual) !== String(expected)) {
    throw new Error(`${label}: got ${actual}, expected ${expected}`);
  }
  console.log(`  ✓ ${label} = ${actual}`);
}

/** The RPC can lag one ledger behind a successful submission. */
async function readClaimWhen(
  claimId: bigint,
  predicate: (claim: Claim) => boolean,
  what: string,
): Promise<Claim> {
  const market = marketClient();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const claim = unwrapResult<Claim>("get_claim", (await market.get_claim({ claim_id: claimId })).result);
    if (predicate(claim)) return claim;
    await sleep(1_500);
  }
  throw new Error(`claim #${claimId} never reached the expected state (${what})`);
}

async function smokeMarket(): Promise<void> {
  const marketId = marketContractId();
  const usdcSac = usdcSacId();
  const deployer = keypairFor("deployer").publicKey();
  const oracle = keypairFor("oracle").publicKey();

  console.log("── Soroban on-chain smoke: mimir-market ──");
  console.log(`  contract : ${marketId}`);
  console.log(`  usdc SAC : ${usdcSac}`);
  console.log(`  creator  : ${deployer} (deployer)`);
  console.log(`  challengr: ${oracle} (oracle)`);
  console.log(`  ${explorerContractUrl(marketId)}\n`);

  console.log("[0] preflight — real USDC balances");
  await requireStakeableUsdc("creator", deployer);
  await requireStakeableUsdc("challenger", oracle);

  console.log("\n[1] read config");
  const readOnly = marketClient();
  const onOracle = unwrapResult<string>("get_oracle", (await readOnly.get_oracle()).result);
  const onUsdc = unwrapResult<string>("get_usdc", (await readOnly.get_usdc()).result);
  const statsBefore = unwrapResult<{ total_claims: bigint; balance: bigint; fees_accrued: bigint }>(
    "get_platform_stats",
    (await readOnly.get_platform_stats()).result,
  );
  assertEqual("get_oracle", onOracle, oracle);
  assertEqual("get_usdc", onUsdc, usdcSac);
  console.log(`  · total_claims before  = ${statsBefore.total_claims}`);
  console.log(`  · escrow balance before = ${formatAtomicUsdc(statsBefore.balance)} USDC`);

  const deadline = nowSeconds() + DEADLINE_OFFSET_SECONDS;
  console.log(
    `\n[2] create_claim — ${formatAtomicUsdc(STAKE)} USDC, deadline in ${DEADLINE_OFFSET_SECONDS}s ` +
      `(challenge lock is ${CHALLENGE_LOCK_SECONDS}s)`,
  );
  const creatorClient = marketClient("deployer");
  const createTx = await creatorClient.create_claim({
    creator: deployer,
    params: smokeCreateParams(deadline),
  });
  const claimId = await sendAndUnwrap<bigint>("create_claim", createTx);
  console.log(`  ✓ claim #${claimId} created`);

  const opened = await readClaimWhen(claimId, (claim) => claim.creator_stake === STAKE, "Open with stake");
  assertEqual("state", ClaimState[opened.state], ClaimState[ClaimState.Open]);
  assertEqual("creator", opened.creator, deployer);
  assertEqual("creator_stake", formatAtomicUsdc(opened.creator_stake), formatAtomicUsdc(STAKE));
  assertEqual("challenger_count", opened.challenger_count, 0);
  assertEqual("fees.platform_fee_bps snapshot", opened.fees.platform_fee_bps, 200);

  console.log(`\n[3] challenge_claim — ${formatAtomicUsdc(STAKE)} USDC from the oracle account`);
  const challengerClient = marketClient("oracle");
  const challengeTx = await challengerClient.challenge_claim({
    challenger: oracle,
    claim_id: claimId,
    stake_amount: STAKE,
    invite_key: null,
  });
  await sendAndUnwrap<void>("challenge_claim", challengeTx);
  console.log("  ✓ challenge accepted");

  console.log("\n[4] read back");
  const active = await readClaimWhen(claimId, (claim) => claim.challenger_count >= 1, "Active with 1 challenger");
  assertEqual("state", ClaimState[active.state], ClaimState[ClaimState.Active]);
  assertEqual("challenger_count", active.challenger_count, 1);
  assertEqual(
    "total_challenger_stake",
    formatAtomicUsdc(active.total_challenger_stake),
    formatAtomicUsdc(STAKE),
  );

  const roster = (await readOnly.get_challenger_list({ claim_id: claimId })).result;
  assertEqual("roster length", roster.length, 1);
  assertEqual("roster[0].address", roster[0].address, oracle);
  assertEqual("roster[0].stake", formatAtomicUsdc(roster[0].stake), formatAtomicUsdc(STAKE));
  assertEqual("roster[0].claimed", roster[0].claimed, false);

  const statsAfter = unwrapResult<{ total_claims: bigint; balance: bigint }>(
    "get_platform_stats",
    (await readOnly.get_platform_stats()).result,
  );
  assertEqual("total_claims", statsAfter.total_claims, statsBefore.total_claims + 1n);
  assertEqual(
    "escrow balance delta",
    formatAtomicUsdc(statsAfter.balance - statsBefore.balance),
    formatAtomicUsdc(STAKE * 2n),
  );

  if (!DO_RESOLVE) {
    console.log(
      `\n  ⓘ Stopping after the challenge. resolve_claim enforces` +
        `\n    "env.ledger().timestamp() >= claim.deadline" (Error::NotYetExpired) and a live` +
        `\n    network cannot be fast-forwarded, so full resolve + payout needs a real wait.` +
        `\n    Claim #${claimId} is now Active with a deadline at ${new Date(deadline * 1_000).toISOString()};` +
        `\n    re-run with --resolve to exercise settlement end to end.`,
    );
    return;
  }

  console.log("\n[5] resolve + payout (waiting out the real deadline)");
  const waitMs = Math.max(0, (deadline - nowSeconds() + 10) * 1_000);
  console.log(`  waiting ${Math.round(waitMs / 1_000)}s for the deadline to pass…`);
  await sleep(waitMs);

  const oracleClient = marketClient("oracle");
  const resolveTx = await oracleClient.resolve_claim({
    claim_id: claimId,
    winner_side: WinnerSide.Challengers,
    summary: "Onchain smoke — challengers awarded so the payout pull can be exercised",
    confidence: 100,
    evidence_hash: createHash("sha256").update(`smoke-evidence-${claimId}`).digest(),
  });
  await sendAndUnwrap<void>("resolve_claim", resolveTx);
  console.log("  ✓ resolve_claim accepted");

  const resolved = await readClaimWhen(
    claimId,
    (claim) => ClaimState[claim.state] === ClaimState[ClaimState.Resolved],
    "Resolved",
  );
  assertEqual("state", ClaimState[resolved.state], ClaimState[ClaimState.Resolved]);
  assertEqual("winner_side", WinnerSide[resolved.winner_side], WinnerSide[WinnerSide.Challengers]);
  console.log(`  · remaining_escrow = ${formatAtomicUsdc(resolved.remaining_escrow)} USDC`);

  const quote = unwrapResult<{ gross: bigint; fee: bigint; net: bigint; claimed: boolean }>(
    "quote_challenger_payout",
    (await readOnly.quote_challenger_payout({ claim_id: claimId, challenger: oracle })).result,
  );
  console.log(
    `  · quote: gross ${formatAtomicUsdc(quote.gross)}, fee ${formatAtomicUsdc(quote.fee)}, ` +
      `net ${formatAtomicUsdc(quote.net)} USDC`,
  );
  assertEqual("quote.claimed", quote.claimed, false);

  const oracleBefore = await classicUsdcBalance(oracle);
  const payoutTx = await oracleClient.claim_challenger_payout({ challenger: oracle, claim_id: claimId });
  const net = await sendAndUnwrap<bigint>("claim_challenger_payout", payoutTx);
  console.log(`  ✓ claim_challenger_payout paid ${formatAtomicUsdc(net)} USDC`);
  assertEqual("payout matches quote.net", formatAtomicUsdc(net), formatAtomicUsdc(quote.net));

  const oracleAfter = await classicUsdcBalance(oracle);
  assertEqual(
    "challenger classic USDC delta",
    formatAtomicUsdc(oracleAfter - oracleBefore),
    formatAtomicUsdc(net),
  );

  const settled = await readClaimWhen(claimId, (claim) => claim.challenger_claims >= 1, "payout recorded");
  assertEqual("challenger_claims", settled.challenger_claims, 1);

  const accrued = (await readOnly.get_accrued_fees({ who: keypairFor("deployer").publicKey() })).result;
  console.log(`  · platform fees accrued to the recipient = ${formatAtomicUsdc(accrued)} USDC`);
}

async function smokeSquad(): Promise<void> {
  const squadId = squadContractId();
  const deployer = keypairFor("deployer").publicKey();
  const oracle = keypairFor("oracle").publicKey();

  console.log("\n── Soroban on-chain smoke: mimir-squad ──");
  console.log(`  contract: ${squadId}`);
  console.log(`  ${explorerContractUrl(squadId)}`);

  // MIN_DURATION in mimir-squad/src/types.rs is 600s, so the deadline must be at
  // least 10 minutes out. The flow below stays entirely inside the open window.
  const deadline = nowSeconds() + 900;
  const captain = squadClient("deployer");
  const createTx = await captain.create_market({
    captain: deployer,
    question: `Onchain smoke ${randomUUID().slice(0, 8)} — squad pool round trip`,
    deadline: BigInt(deadline),
    fee_bps: 200,
  });
  const marketId = await sendAndUnwrap<bigint>("create_market", createTx);
  console.log(`  ✓ market #${marketId} created (deadline ${new Date(deadline * 1_000).toISOString()})`);

  await sendAndUnwrap<void>(
    "deposit(side A)",
    await captain.deposit({ participant: deployer, market_id: marketId, side: 1, amount: STAKE }),
  );
  console.log(`  ✓ side A deposit ${formatAtomicUsdc(STAKE)} USDC`);

  const challenger = squadClient("oracle");
  await sendAndUnwrap<void>(
    "deposit(side B)",
    await challenger.deposit({ participant: oracle, market_id: marketId, side: 2, amount: STAKE }),
  );
  console.log(`  ✓ side B deposit ${formatAtomicUsdc(STAKE)} USDC`);

  const readOnly = squadClient();
  const market = unwrapResult<{ pool_a: bigint; pool_b: bigint; participants_a: number; participants_b: number }>(
    "get_market",
    (await readOnly.get_market({ market_id: marketId })).result,
  );
  assertEqual("pool_a", formatAtomicUsdc(market.pool_a), formatAtomicUsdc(STAKE));
  assertEqual("pool_b", formatAtomicUsdc(market.pool_b), formatAtomicUsdc(STAKE));
  assertEqual("participants_a", market.participants_a, 1);
  assertEqual("participants_b", market.participants_b, 1);

  // Return side B before the deadline: a real state transition that needs no wait.
  await sendAndUnwrap<void>(
    "withdraw_before_deadline",
    await challenger.withdraw_before_deadline({
      participant: oracle,
      market_id: marketId,
      side: 2,
      amount: STAKE,
    }),
  );
  const afterWithdraw = unwrapResult<{ pool_b: bigint }>(
    "get_market",
    (await readOnly.get_market({ market_id: marketId })).result,
  );
  assertEqual("pool_b after withdraw", formatAtomicUsdc(afterWithdraw.pool_b), "0");
  console.log(
    `  ⓘ resolve() needs "timestamp >= deadline" too, so squad settlement also requires a real wait.`,
  );
}

async function main(): Promise<void> {
  // Fail fast with a useful message rather than deep inside a contract call.
  requireEnv(ENV_KEYS.deployerSecret, "run: npx tsx scripts/stellar-keys.ts");
  requireEnv(ENV_KEYS.oracleSecret, "run: npx tsx scripts/stellar-keys.ts");

  await smokeMarket();
  if (DO_SQUAD) await smokeSquad();

  console.log("\n✓ ON-CHAIN SMOKE PASSED");
}

main().catch((error) => {
  console.error("onchain-smoke FAILED:", error instanceof Error ? error.message : error);
  const extras = (error as { response?: { data?: unknown } })?.response?.data;
  if (extras) console.error(JSON.stringify(extras, null, 2));
  process.exit(1);
});
