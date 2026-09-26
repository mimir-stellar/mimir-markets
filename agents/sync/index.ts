/**
 * Mimir Read-Index Sync Worker
 *
 * Reconciles the Neon read index against on-chain state. Contract state is the
 * source of truth; this keeps /explorer, /dashboard and the VS APIs from serving
 * stale claims, and it is the `sync` worker /api/health monitors.
 *
 * Lives in the worker fleet rather than behind a platform cron: Railway already
 * runs this fleet as a long-lived process, so an in-process interval needs no
 * scheduler, no HTTP hop and no shared secret to go wrong.
 *
 * Read-only: this worker signs nothing. Everything it needs comes from Soroban RPC
 * through `lib/contract.ts` (claims) and `lib/stellar.ts` (`getEvents`, for the
 * settlement projection), so it needs no keypair and holds no secret.
 *
 * Run: npx tsx agents/sync/index.ts
 * Env: DATABASE_URL, NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID,
 *      NEXT_PUBLIC_STELLAR_RPC_URL
 *      SYNC_POLL_INTERVAL_MS=300000 (poll cadence in ms, default 5m)
 */

import { getMarketContractId, getStellarRpcUrl } from "../../lib/stellar";
import { reportingPoll } from "../../lib/ops/heartbeat";
import { reconcileSettlements } from "../../lib/server/settlement-index";
import { reconcileVsIndex } from "../../lib/server/vs-index";
import { makeLogger } from "../../lib/logger";

const log = makeLogger("sync");

// Default 5m: the health probe warns when the index is over 300s stale, so a
// slower cadence would report a working sync as degraded.
const POLL_INTERVAL_MS = Number(process.env.SYNC_POLL_INTERVAL_MS ?? "300000");

async function poll(): Promise<void> {
  const summary = await reconcileVsIndex();
  log.info("VS index reconciled", {
    synced: summary.synced,
    new: summary.new,
    stateChanges: summary.stateChanges,
  });

  const fees = await reconcileSettlements();
  log.info("Settlements reconciled", {
    settlements: fees.settlements,
    accruals: fees.accruals,
    payouts: fees.payouts,
    claims: fees.claims,
    fromLedger: fees.fromLedger,
    toLedger: fees.toLedger,
    truncated: fees.truncated,
  });
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required — the read index has nowhere to live");
  }

  log.banner([
    "═══════════════════════════════════════════════",
    "  Mimir Read-Index Sync Worker",
    `  Contract   : ${getMarketContractId() || "(unset)"}`,
    `  Soroban RPC: ${getStellarRpcUrl()}`,
    `  Poll every : ${POLL_INTERVAL_MS / 1000}s`,
    "═══════════════════════════════════════════════",
  ].join("\n"));

  // Reports a heartbeat either way, so a crash-looping sync shows as alive and
  // failing on /api/health rather than merely stale.
  const safePoll = () => reportingPoll("sync", "sync", POLL_INTERVAL_MS / 1000, poll);

  await safePoll();
  setInterval(safePoll, POLL_INTERVAL_MS);
}

main().catch((err) => {
  log.error("Fatal error", { err });
  process.exit(1);
});
