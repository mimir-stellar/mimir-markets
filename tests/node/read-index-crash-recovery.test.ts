import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";

import {
  READ_INDEX_TABLES,
  type ReadIndexTableName,
  type BackupRow,
  type ReadIndexBackup,
} from "../../lib/ops/cache-backup";
import {
  restoreReadIndexFromBackup,
  type ReadIndexRestoreResult,
} from "../../lib/server/read-index-backup";
import { reconcileSettlements } from "../../lib/server/settlement-index";
import { reconcileVsIndex } from "../../lib/server/vs-index";
import * as stellar from "../../lib/stellar";
import * as contract from "../../lib/contract";

const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures", "cache-backup");
const CRASH_FIXTURE_PATH = join(FIXTURE_DIR, "crash-recovery.json");

function readCrashFixture(): string {
  return readFileSync(CRASH_FIXTURE_PATH, "utf8");
}

// ── In-memory transactional fake database pool ────────────────────────────────

interface TableStore {
  rows: Map<string, BackupRow>;
  keyFn: (row: BackupRow) => string;
}

const TABLE_KEYS: Record<ReadIndexTableName, (row: BackupRow) => string> = {
  claims: (r) => String(r.id),
  challengers: (r) => `${r.claim_id}:${r.address}`,
  sync_meta: (r) => String(r.key),
  market_settlements: (r) => String(r.claim_id),
  fee_accruals: (r) => String(r.accrual_id ?? `${r.transaction_hash}:${r.log_index}`),
  fee_claims: (r) => String(r.claim_event_id ?? `${r.transaction_hash}:${r.log_index}`),
  fee_policies: (r) => String(r.policy_id),
  agent_revenue_attribution: (r) => String(r.claim_id),
};

class FakeMemoryDb {
  tables = new Map<ReadIndexTableName, Map<string, BackupRow>>();

  constructor() {
    this.reset();
  }

  reset() {
    this.tables.clear();
    for (const name of READ_INDEX_TABLES) {
      this.tables.set(name, new Map());
    }
  }

  cloneState(): Map<ReadIndexTableName, Map<string, BackupRow>> {
    const copy = new Map<ReadIndexTableName, Map<string, BackupRow>>();
    for (const [name, map] of this.tables.entries()) {
      const rowMap = new Map<string, BackupRow>();
      for (const [k, v] of map.entries()) {
        rowMap.set(k, { ...v });
      }
      copy.set(name, rowMap);
    }
    return copy;
  }

  restoreState(state: Map<ReadIndexTableName, Map<string, BackupRow>>) {
    this.tables = state;
  }

  getTableRows(name: ReadIndexTableName): BackupRow[] {
    const map = this.tables.get(name);
    if (!map) return [];
    return Array.from(map.values());
  }

  upsert(name: ReadIndexTableName, row: BackupRow, doNothing = false) {
    const map = this.tables.get(name);
    if (!map) return;
    const key = TABLE_KEYS[name](row);
    if (doNothing && map.has(key)) {
      return;
    }
    map.set(key, { ...map.get(key), ...row });
  }

  executeSql(sql: string, args: unknown[]): { rows: BackupRow[] } {
    const trimmed = sql.trim();

    // SELECT columns FROM table ...
    const selectMatch = trimmed.match(/^SELECT\s+([\s\S]+?)\s+FROM\s+([a-zA-Z0-9_]+)/i);
    if (selectMatch) {
      const tableName = selectMatch[2] as ReadIndexTableName;
      if (this.tables.has(tableName)) {
        let rows = this.getTableRows(tableName);

        // Simple WHERE key = $1 or WHERE recipient = $1
        const whereMatch = trimmed.match(/WHERE\s+([a-zA-Z0-9_]+)\s*=\s*\$1/i);
        if (whereMatch) {
          const col = whereMatch[1];
          const val = String(args[0]);
          rows = rows.filter((r) => String(r[col]) === val);
        }

        // Simple aggregation queries
        if (trimmed.includes("SUM(")) {
          let sumGross = 0n;
          let sumPayouts = 0n;
          let sumPlatform = 0n;
          let sumOwner = 0n;
          let sumDust = 0n;
          let sumAmount = 0n;
          for (const r of rows) {
            if (r.gross_volume_atomic) sumGross += BigInt(String(r.gross_volume_atomic));
            if (r.payout_atomic) sumPayouts += BigInt(String(r.payout_atomic));
            if (r.platform_fee_atomic) sumPlatform += BigInt(String(r.platform_fee_atomic));
            if (r.agent_owner_fee_atomic) sumOwner += BigInt(String(r.agent_owner_fee_atomic));
            if (r.dust_atomic) sumDust += BigInt(String(r.dust_atomic));
            if (r.amount_atomic) sumAmount += BigInt(String(r.amount_atomic));
          }
          return {
            rows: [
              {
                markets: rows.length,
                gross: sumGross.toString(),
                payouts: sumPayouts.toString(),
                platform: sumPlatform.toString(),
                owner: sumOwner.toString(),
                dust: sumDust.toString(),
                amount: sumAmount.toString(),
              },
            ],
          };
        }

        return { rows };
      }
    }

    // INSERT INTO <table> (<columns>) VALUES (<placeholders>) ...
    const insertMatch = trimmed.match(/^INSERT\s+INTO\s+([a-zA-Z0-9_]+)\s*\(([\s\S]+?)\)\s*VALUES/i);
    if (insertMatch) {
      const tableName = insertMatch[1] as ReadIndexTableName;
      const columns = insertMatch[2].split(",").map((c) => c.trim());
      const row: BackupRow = {};
      columns.forEach((col, idx) => {
        row[col] = args[idx];
      });
      const doNothing = /DO\s+NOTHING/i.test(trimmed);
      this.upsert(tableName, row, doNothing);
      return { rows: [] };
    }

    return { rows: [] };
  }
}

const memoryDb = new FakeMemoryDb();

function installFakePool() {
  process.env.DATABASE_URL = "postgres://fake/mimir";

  const pool = {
    query: async (sql: string, args: unknown[] = []) => {
      return memoryDb.executeSql(sql, args);
    },
    connect: async () => {
      let inTx = false;
      let txSnapshot: Map<ReadIndexTableName, Map<string, BackupRow>> | null = null;

      return {
        query: async (sql: string, args: unknown[] = []) => {
          const trimmed = sql.trim();
          if (trimmed === "BEGIN") {
            inTx = true;
            txSnapshot = memoryDb.cloneState();
            return { rows: [] };
          }
          if (trimmed === "COMMIT") {
            inTx = false;
            txSnapshot = null;
            return { rows: [] };
          }
          if (trimmed === "ROLLBACK") {
            if (txSnapshot) {
              memoryDb.restoreState(txSnapshot);
            }
            inTx = false;
            txSnapshot = null;
            return { rows: [] };
          }
          return memoryDb.executeSql(sql, args);
        },
        release: () => {
          if (inTx && txSnapshot) {
            memoryDb.restoreState(txSnapshot);
            inTx = false;
            txSnapshot = null;
          }
        },
      };
    },
  };

  process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://fake:fake@localhost:5432/fake";
  const g = globalThis as unknown as Record<string, unknown>;
  g.__mimirDbPool = pool;
  g.__mimirDbReady = Promise.resolve(pool);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test("fixture: committed crash-recovery.json is valid and self-verifying", () => {
  const json = readCrashFixture();
  const backup = JSON.parse(json) as ReadIndexBackup;
  assert.equal(backup.kind, "mimir-read-index-backup");
  assert.equal(backup.tables.claims.length, 3);
  assert.equal(backup.tables.market_settlements.length, 2);
  assert.equal(backup.tables.fee_accruals.length, 4);
  assert.equal(backup.tables.fee_claims.length, 2);
});

test("positive: full batched restore succeeds and matches checksum", async () => {
  installFakePool();
  memoryDb.reset();

  const archive = readCrashFixture();
  const result = await restoreReadIndexFromBackup(archive, { batchSize: 5 });

  assert.equal(result.applied, true);
  assert.equal(result.verify.ok, true);
  assert.equal(memoryDb.getTableRows("claims").length, 3);
  assert.equal(memoryDb.getTableRows("market_settlements").length, 2);
  assert.equal(memoryDb.getTableRows("fee_accruals").length, 4);
  assert.equal(memoryDb.getTableRows("fee_claims").length, 2);
});

test("crash recovery: interrupt BEFORE checkpoint commit rolls back current batch and replay succeeds", async () => {
  installFakePool();
  memoryDb.reset();

  const archive = readCrashFixture();

  // Run restore with interrupt BEFORE checkpoint commit on batch 1 (zero-indexed: 2nd batch)
  await assert.rejects(
    () =>
      restoreReadIndexFromBackup(archive, {
        batchSize: 5,
        interrupt: { beforeCheckpoint: 1 },
      }),
    /Crash interrupted before checkpoint commit \(batch 1\)/,
  );

  // Batch 0 was committed (first 5 statements), batch 1 was aborted before commit
  const initialClaims = memoryDb.getTableRows("claims");
  assert.ok(initialClaims.length > 0, "batch 0 changes should be committed");
  const initialSettlements = memoryDb.getTableRows("market_settlements");
  assert.equal(initialSettlements.length, 0, "batch 1 settlements should not be committed yet");

  // REPLAY: Re-run the full restore to completion
  const replayed = await restoreReadIndexFromBackup(archive, { batchSize: 5 });
  assert.equal(replayed.applied, true);
  assert.equal(replayed.verify.ok, true);

  // Assert replay did not double-apply settlement or fee events
  const settlements = memoryDb.getTableRows("market_settlements");
  const accruals = memoryDb.getTableRows("fee_accruals");
  const feeClaims = memoryDb.getTableRows("fee_claims");

  assert.equal(settlements.length, 2);
  assert.equal(accruals.length, 4);
  assert.equal(feeClaims.length, 2);

  // Settlement amounts are not doubled
  const s301 = settlements.find((s) => s.claim_id === 301);
  assert.ok(s301);
  assert.equal(s301.gross_volume_atomic, "30000000");
  assert.equal(s301.payout_atomic, "28500000");
  assert.equal(s301.platform_fee_atomic, "1000000");
  assert.equal(s301.agent_owner_fee_atomic, "400000");

  // Total accruals sum to exactly 2_400_000 (1_000_000 + 400_000 + 700_000 + 300_000)
  const totalAccrued = accruals.reduce((sum, r) => sum + BigInt(String(r.amount_atomic)), 0n);
  assert.equal(totalAccrued, 2_400_000n);
});

test("crash recovery: interrupt AFTER checkpoint commit commits batch and replay succeeds", async () => {
  installFakePool();
  memoryDb.reset();

  const archive = readCrashFixture();

  // Run restore with interrupt AFTER checkpoint commit on batch 0
  await assert.rejects(
    () =>
      restoreReadIndexFromBackup(archive, {
        batchSize: 5,
        interrupt: { afterCheckpoint: 0 },
      }),
    /Crash interrupted after checkpoint commit \(batch 0\)/,
  );

  // Batch 0 was committed
  assert.ok(memoryDb.getTableRows("claims").length > 0);

  // REPLAY: Full restore re-applies all batches idempotently
  const replayed = await restoreReadIndexFromBackup(archive, { batchSize: 5 });
  assert.equal(replayed.applied, true);
  assert.equal(replayed.verify.ok, true);

  // Verify settlement and fee amounts are exact and not doubled
  const settlements = memoryDb.getTableRows("market_settlements");
  assert.equal(settlements.length, 2);
  const totalVolume = settlements.reduce((sum, s) => sum + BigInt(String(s.gross_volume_atomic)), 0n);
  assert.equal(totalVolume, 60_000_000n);
});

test("idempotent replay: consecutive complete replays never double amounts or rows", async () => {
  installFakePool();
  memoryDb.reset();

  const archive = readCrashFixture();

  // Run 1
  await restoreReadIndexFromBackup(archive, { batchSize: 4 });
  // Run 2 (replay)
  await restoreReadIndexFromBackup(archive, { batchSize: 4 });
  // Run 3 (replay again)
  const res3 = await restoreReadIndexFromBackup(archive, { batchSize: 4 });

  assert.equal(res3.verify.ok, true);
  assert.equal(memoryDb.getTableRows("market_settlements").length, 2);
  assert.equal(memoryDb.getTableRows("fee_accruals").length, 4);

  const accruals = memoryDb.getTableRows("fee_accruals");
  const totalAccrued = accruals.reduce((sum, r) => sum + BigInt(String(r.amount_atomic)), 0n);
  assert.equal(totalAccrued, 2_400_000n);
});

test("boundary: interrupt on batch 0 before checkpoint commit rolls back completely", async () => {
  installFakePool();
  memoryDb.reset();

  const archive = readCrashFixture();

  await assert.rejects(
    () =>
      restoreReadIndexFromBackup(archive, {
        batchSize: 5,
        interrupt: { beforeCheckpoint: 0 },
      }),
    /Crash interrupted before checkpoint commit \(batch 0\)/,
  );

  // Nothing was committed
  for (const name of READ_INDEX_TABLES) {
    assert.equal(memoryDb.getTableRows(name).length, 0, `${name} should have 0 rows`);
  }
});

test("settlement-index: replay after interrupt before checkpoint does not double fee or settlement events", async () => {
  installFakePool();
  memoryDb.reset();

  // Set fake sync meta cursor
  memoryDb.upsert("sync_meta", { key: "settlement_cursor_ledger", value: "1000" });

  const events = [
    {
      topic: [
        xdr.ScVal.scvSymbol("fee_accrued"),
        nativeToScVal(101n, { type: "u64" }),
        new Address("GBO43ZBS4RBC2QFDKB23U6TBFEEK47ZLGSXDJSRV2H3PNQK5ZDEYXVLE").toScVal(),
      ],
      value: nativeToScVal({ amount: 50_000n, is_agent_owner_fee: false }),
      txHash: "tx-fee-1",
      ledger: 1005,
      ledgerClosedAt: "2026-01-01T00:00:00Z",
      id: "1005-0",
    },
    {
      topic: [
        xdr.ScVal.scvSymbol("fee_accrued"),
        nativeToScVal(101n, { type: "u64" }),
        new Address("GD2SI5PUEFKC7TONNX7OR72WMYUO7WZDSCDSIVWWXPDIDYW5OP3ETM5D").toScVal(),
      ],
      value: nativeToScVal({ amount: 20_000n, is_agent_owner_fee: true }),
      txHash: "tx-fee-1",
      ledger: 1005,
      ledgerClosedAt: "2026-01-01T00:00:00Z",
      id: "1005-1",
    },
    {
      topic: [
        xdr.ScVal.scvSymbol("challenger_paid"),
        nativeToScVal(101n, { type: "u64" }),
        new Address("GD2SI5PUEFKC7TONNX7OR72WMYUO7WZDSCDSIVWWXPDIDYW5OP3ETM5D").toScVal(),
      ],
      value: nativeToScVal({ net: 100_000n, fee: 20_000n, gross: 120_000n, stake: 50_000n }),
      txHash: "tx-pull-1",
      ledger: 1006,
      ledgerClosedAt: "2026-01-01T00:01:00Z",
      id: "1006-0",
    },
    {
      topic: [
        xdr.ScVal.scvSymbol("market_settled"),
        nativeToScVal(101n, { type: "u64" }),
      ],
      value: nativeToScVal({
        total_paid: 200_000n,
        total_fees: 70_000n,
        owed_to_challengers: 0n,
        dust: 500n,
      }),
      txHash: "tx-settle-1",
      ledger: 1006,
      ledgerClosedAt: "2026-01-01T00:01:00Z",
      id: "1006-1",
    },
  ];

  const origMarketId = process.env.NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID;
  process.env.NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";

  const eventsFetcher = async () => ({
    events: events as unknown as import("@stellar/stellar-sdk").rpc.Api.EventResponse[],
    latestLedger: 1010,
    truncated: false,
  });

  try {
    // Run 1: interrupted BEFORE checkpoint commit
    await assert.rejects(
      () =>
        reconcileSettlements({
          interrupt: { beforeCheckpoint: true },
          eventsFetcher,
        }),
      /Crash interrupted before checkpoint commit/,
    );

    // Cursor was NOT advanced because of interrupt
    const cursorAfterCrash = memoryDb.getTableRows("sync_meta").find((r) => r.key === "settlement_cursor_ledger");
    assert.equal(cursorAfterCrash?.value, "1000");

    // Events were written
    const accrualsRun1 = memoryDb.getTableRows("fee_accruals");
    assert.equal(accrualsRun1.length, 2);

    // Run 2: REPLAY from the same unadvanced cursor
    const result2 = await reconcileSettlements({ eventsFetcher });
    assert.equal(result2.settlements, 1);

    // Verify replay did not duplicate fee accruals or double settlement amounts
    const accrualsReplay = memoryDb.getTableRows("fee_accruals");
    assert.equal(accrualsReplay.length, 2, "fee_accruals should not duplicate on replay");

    const settlements = memoryDb.getTableRows("market_settlements");
    assert.equal(settlements.length, 1);
    const s = settlements[0];
    assert.equal(s.payout_atomic, "300000"); // 200_000 + 100_000 (pulled) - NOT doubled to 600_000
    assert.equal(s.platform_fee_atomic, "50000");
    assert.equal(s.agent_owner_fee_atomic, "20000");

    // Cursor is now safely advanced
    const cursorFinal = memoryDb.getTableRows("sync_meta").find((r) => r.key === "settlement_cursor_ledger");
    assert.equal(cursorFinal?.value, "1010");
  } finally {
    if (origMarketId === undefined) {
      delete process.env.NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID;
    } else {
      process.env.NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID = origMarketId;
    }
  }
});

test("vs-index: claim batch reconcile survives interrupt and replay resumes safely", async () => {
  installFakePool();
  memoryDb.reset();

  memoryDb.upsert("sync_meta", { key: "last_claim_count", value: "0" });

  const mockClaims: contract.ClaimData[] = [
    {
      id: 1,
      creator: "GBO43ZBS4RBC2QFDKB23U6TBFEEK47ZLGSXDJSRV2H3PNQK5ZDEYXVLE",
      question: "Claim 1",
      creator_position: "Yes",
      counter_position: "No",
      resolution_url: "https://example.com/1",
      creator_stake: 10,
      total_challenger_stake: 5,
      reserved_creator_liability: 0,
      available_creator_liability: 0,
      deadline: 1800000000,
      state: "open",
      winner_side: "",
      resolution_summary: null,
      confidence: 0,
      category: "crypto",
      parent_id: 0,
      market_type: "binary",
      odds_mode: "pool",
      challenger_payout_bps: 0,
      handicap_line: null,
      settlement_rule: null,
      max_challengers: 5,
      created_at: 0,
      visibility: "public",
      challenger_count: 1,
      challengers: [
        {
          address: "GD2SI5PUEFKC7TONNX7OR72WMYUO7WZDSCDSIVWWXPDIDYW5OP3ETM5D",
          stake: 5,
          potential_payout: 10,
        },
      ],
      first_challenger: "GD2SI5PUEFKC7TONNX7OR72WMYUO7WZDSCDSIVWWXPDIDYW5OP3ETM5D",
      challenger_addresses: ["GD2SI5PUEFKC7TONNX7OR72WMYUO7WZDSCDSIVWWXPDIDYW5OP3ETM5D"],
      total_pot: 15,
    },
  ];

  const getClaimCount = async () => 1;
  const getClaimSummaries = async () => mockClaims;

  // Run 1: interrupted BEFORE checkpoint commit
  await assert.rejects(
    () =>
      reconcileVsIndex({
        interrupt: { beforeCheckpoint: true },
        skipEventSync: true,
        getClaimCount,
        getClaimSummaries,
      }),
    /Crash interrupted before checkpoint commit/,
  );

  // Cursor was not committed
  const cursor1 = memoryDb.getTableRows("sync_meta").find((r) => r.key === "last_claim_count");
  assert.equal(cursor1?.value, "0");

  // Claims were persisted in DB
  assert.equal(memoryDb.getTableRows("claims").length, 1);

  // Run 2: REPLAY completes and advances checkpoint
  const res = await reconcileVsIndex({
    skipEventSync: true,
    getClaimCount,
    getClaimSummaries,
  });
  assert.equal(res.synced, 1);

  // Verify claims and challengers were not duplicated on replay
  assert.equal(memoryDb.getTableRows("claims").length, 1);
  assert.equal(memoryDb.getTableRows("challengers").length, 1);

  // Cursor is now checkpointed
  const cursorFinal = memoryDb.getTableRows("sync_meta").find((r) => r.key === "last_claim_count");
  assert.equal(cursorFinal?.value, "1");
});
