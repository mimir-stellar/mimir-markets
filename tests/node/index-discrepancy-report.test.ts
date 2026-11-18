/**
 * Chain-to-index discrepancy report tests.
 *
 * Synthetic capture + synthetic index rows only: no RPC, no live database, no
 * credentials. The DB-backed path runs against an in-memory fake pool.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import type { ChainEvent } from "../../lib/ops/projection";
import {
  buildDiscrepancyReport,
  DISCREPANCY_REPORT_MAX_CLAIMS,
  normalizeClaimSelection,
  parseDiscrepancyCapture,
  runIndexDiscrepancyReport,
  type CapturedSettlement,
  type DiscrepancyReportInput,
  type IndexedClaim,
  type IndexedSettlement,
} from "../../lib/server/index-discrepancy";

const CREATOR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const CHALLENGER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWGI";
const OTHER = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

function created(claimId: number, ledger: number, creator = CREATOR): ChainEvent {
  return { name: "ClaimCreated", claimId, creator, category: "crypto", blockNumber: ledger, logIndex: 0 };
}
function challenged(claimId: number, ledger: number): ChainEvent {
  return { name: "ClaimChallenged", claimId, challenger: CHALLENGER, stakeUnits: 25_000_000n, blockNumber: ledger, logIndex: 0 };
}
function resolved(claimId: number, ledger: number, winnerSide: 1 | 2 = 2): ChainEvent {
  return { name: "ClaimResolved", claimId, winnerSide, confidence: 91, blockNumber: ledger, logIndex: 0 };
}

function claimRow(id: number, overrides: Partial<IndexedClaim> = {}): IndexedClaim {
  return { id, creator: CREATOR, category: "crypto", state: "resolved", winner_side: "challengers", challenger_count: 1, ...overrides };
}

const SETTLEMENT: CapturedSettlement = {
  claimId: 1,
  transactionHash: "tx-resolve-1",
  ledger: 1005,
  totalPaidAtomic: 0n,
  totalFeesAtomic: 500_000n,
  owedToChallengersAtomic: 49_000_000n,
  dustAtomic: 1n,
  pulledNetAtomic: 24_000_000n,
};

function settlementRow(overrides: Partial<IndexedSettlement> = {}): IndexedSettlement {
  return {
    claim_id: 1,
    gross_volume_atomic: 49_500_001n,
    payout_atomic: 24_000_000n,
    dust_atomic: 1n,
    transaction_hash: "TX-RESOLVE-1",
    ...overrides,
  };
}

function input(overrides: Partial<DiscrepancyReportInput> = {}): DiscrepancyReportInput {
  return {
    claimIds: [1],
    capture: {
      capturedThroughLedger: 1010,
      events: [created(1, 1000), challenged(1, 1001), resolved(1, 1005)],
      settlements: [SETTLEMENT],
    },
    indexed: { claims: [claimRow(1)], settlements: [settlementRow()] },
    ...overrides,
  };
}

// ── Clean baseline ────────────────────────────────────────────────────────────

test("an index that matches the capture reports nothing", () => {
  const report = buildDiscrepancyReport(input());
  assert.deepEqual(report.summary, { missing: 0, stale: 0, conflicting: 0, unverified: 0 });
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.checked, { claims: 1, settlements: 1 });
  assert.equal(report.truncated, false);
});

// ── Classification ────────────────────────────────────────────────────────────

test("missing: the chain has the claim and settlement, the index has neither", () => {
  const report = buildDiscrepancyReport(input({ indexed: { claims: [], settlements: [] } }));
  assert.equal(report.summary.missing, 2);
  assert.deepEqual(
    report.findings.map((f) => [f.record, f.classification, f.field]),
    [["claim", "missing", "row"], ["settlement", "missing", "row"]],
  );
});

test("stale: the index is behind on state, challengers and pulled payout", () => {
  const report = buildDiscrepancyReport(
    input({
      indexed: {
        claims: [claimRow(1, { state: "open", winner_side: "", challenger_count: 0 })],
        settlements: [settlementRow({ payout_atomic: 0n })],
      },
    }),
  );
  assert.equal(report.summary.stale, 3);
  assert.equal(report.summary.conflicting, 0);
  const byField = Object.fromEntries(report.findings.map((f) => [`${f.record}.${f.field}`, f]));
  assert.equal(byField["claim.state"].classification, "stale");
  assert.equal(byField["claim.state"].chain, "resolved");
  assert.equal(byField["claim.state"].chainLedger, 1005);
  assert.equal(byField["claim.challenger_count"].classification, "stale");
  assert.equal(byField["settlement.payout_atomic"].classification, "stale");
  assert.equal(byField["settlement.payout_atomic"].chain, "24000000");
});

test("conflicting: values the chain contradicts are never reported as stale", () => {
  const report = buildDiscrepancyReport(
    input({
      indexed: {
        claims: [claimRow(1, { creator: OTHER, winner_side: "creator", challenger_count: 2 })],
        settlements: [settlementRow({ transaction_hash: "tx-other", dust_atomic: 0n, gross_volume_atomic: 1n, payout_atomic: 99_000_000n })],
      },
    }),
  );
  assert.equal(report.summary.stale, 0);
  assert.equal(report.summary.missing, 0);
  assert.deepEqual(
    report.findings.map((f) => `${f.record}.${f.field}:${f.classification}`),
    [
      "claim.challenger_count:conflicting",
      "claim.creator:conflicting",
      "claim.winner_side:conflicting",
      "settlement.dust_atomic:conflicting",
      "settlement.gross_volume_atomic:conflicting",
      "settlement.payout_atomic:conflicting",
      "settlement.transaction_hash:conflicting",
    ],
  );
});

test("an index state ahead of the chain is conflicting, not stale", () => {
  const report = buildDiscrepancyReport(
    input({
      capture: { capturedThroughLedger: 1010, events: [created(1, 1000), challenged(1, 1001)] },
      indexed: { claims: [claimRow(1, { state: "cancelled", winner_side: "" })], settlements: [] },
    }),
  );
  assert.deepEqual(report.findings.map((f) => [f.field, f.classification]), [["state", "conflicting"]]);
});

test("a settlement row for a claim the capture shows unresolved is conflicting", () => {
  const report = buildDiscrepancyReport(
    input({
      capture: { capturedThroughLedger: 1010, events: [created(1, 1000), challenged(1, 1001)] },
      indexed: { claims: [claimRow(1, { state: "active", winner_side: "" })], settlements: [settlementRow()] },
    }),
  );
  assert.deepEqual(report.findings.map((f) => [f.record, f.field, f.classification]), [["settlement", "row", "conflicting"]]);
});

test("ids the capture says nothing about are unverified, not discrepancies", () => {
  const report = buildDiscrepancyReport(
    input({ claimIds: [1, 7], indexed: { claims: [claimRow(1), claimRow(7)], settlements: [settlementRow()] } }),
  );
  assert.deepEqual(report.unverifiedClaimIds, [7]);
  assert.equal(report.summary.unverified, 1);
  assert.deepEqual(report.findings, []);
});

test("reorged-out events do not count as chain truth", () => {
  const report = buildDiscrepancyReport(
    input({
      capture: {
        capturedThroughLedger: 1010,
        events: [created(1, 1000), { ...challenged(1, 1001), blockHash: "orphaned" }],
        reorgedOut: ["orphaned"],
      },
      indexed: { claims: [claimRow(1, { state: "active", winner_side: "", challenger_count: 1 })], settlements: [] },
    }),
  );
  assert.deepEqual(
    report.findings.map((f) => [f.field, f.classification]),
    [["challenger_count", "conflicting"], ["state", "conflicting"]],
  );
});

// ── Bounds ────────────────────────────────────────────────────────────────────

test("only selected claims are compared; the rest of the capture and index is ignored", () => {
  const report = buildDiscrepancyReport(
    input({
      claimIds: [1],
      capture: {
        capturedThroughLedger: 1010,
        events: [created(1, 1000), challenged(1, 1001), resolved(1, 1005), created(2, 1002)],
        settlements: [SETTLEMENT],
      },
      indexed: { claims: [claimRow(1), claimRow(2, { creator: OTHER })], settlements: [settlementRow()] },
    }),
  );
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.selectedClaimIds, [1]);
});

test("selection fails closed: empty, oversized, duplicated or malformed", () => {
  assert.throws(() => normalizeClaimSelection([]), /at least one/);
  const tooMany = Array.from({ length: DISCREPANCY_REPORT_MAX_CLAIMS + 1 }, (_, i) => i + 1);
  assert.throws(() => normalizeClaimSelection(tooMany), /at most 200/);
  assert.throws(() => normalizeClaimSelection([1, 2, 3], 2), /at most 2/);
  assert.throws(() => normalizeClaimSelection([1, 1]), /twice/);
  for (const bad of [0, -1, 1.5, Number.NaN, "1"]) {
    assert.throws(() => normalizeClaimSelection([bad]), /positive safe integers/);
  }
  // A caller cannot raise the ceiling.
  assert.throws(() => normalizeClaimSelection(tooMany, 10_000), /at most 200/);
  assert.deepEqual(normalizeClaimSelection([3, 1, 2]), [1, 2, 3]);
});

test("findings are capped but every finding is counted", () => {
  const ids = [1, 2, 3, 4, 5];
  const report = buildDiscrepancyReport({
    claimIds: ids,
    capture: { capturedThroughLedger: 1010, events: ids.map((id) => created(id, 1000 + id)) },
    indexed: { claims: [], settlements: [] },
    maxFindings: 2,
  });
  assert.equal(report.summary.missing, 5);
  assert.equal(report.findings.length, 2);
  assert.equal(report.truncated, true);
});

test("the report is deterministic regardless of input order", () => {
  const a = buildDiscrepancyReport(input({ claimIds: [1, 2], indexed: { claims: [], settlements: [] } }));
  const b = buildDiscrepancyReport(
    input({
      claimIds: [2, 1],
      capture: { capturedThroughLedger: 1010, events: [resolved(1, 1005), challenged(1, 1001), created(1, 1000)], settlements: [SETTLEMENT] },
      indexed: { claims: [], settlements: [] },
    }),
  );
  assert.deepEqual(a, b);
});

test("two different market_settled events for one claim refuse the report", () => {
  assert.throws(
    () => buildDiscrepancyReport(input({ capture: { capturedThroughLedger: 1010, events: [created(1, 1000)], settlements: [SETTLEMENT, { ...SETTLEMENT, transactionHash: "tx-x" }] } })),
    /two different market_settled/,
  );
});

// ── Capture parsing ───────────────────────────────────────────────────────────

const fixture = JSON.parse(readFileSync(resolve("fixtures/ledger/funded-market-v1.json"), "utf8"));

test("a saved ledger fixture is a valid capture, with settlements optional", () => {
  const capture = parseDiscrepancyCapture(fixture);
  assert.equal(capture.events.length, 3);
  assert.deepEqual(capture.settlements, []);

  const withSettlement = parseDiscrepancyCapture({
    ...fixture,
    settlements: [{ claimId: 1, transactionHash: "tx-resolve-1", ledger: 1005, totalPaidAtomic: "0", totalFeesAtomic: "0", owedToChallengersAtomic: "25000000", dustAtomic: "0" }],
  });
  assert.equal(withSettlement.settlements?.[0].owedToChallengersAtomic, 25_000_000n);
  assert.equal(withSettlement.settlements?.[0].pulledNetAtomic, 0n);
});

test("capture parsing rejects number amounts and out-of-range ledgers", () => {
  const base = { claimId: 1, transactionHash: "tx", ledger: 1005, totalPaidAtomic: "0", totalFeesAtomic: "0", owedToChallengersAtomic: "0", dustAtomic: "0" };
  assert.throws(() => parseDiscrepancyCapture({ ...fixture, settlements: [{ ...base, dustAtomic: 0 }] }), /base-10 string/);
  assert.throws(() => parseDiscrepancyCapture({ ...fixture, settlements: [{ ...base, ledger: 99_999 }] }), /capture range/);
  assert.throws(() => parseDiscrepancyCapture({ ...fixture, settlements: {} }), /must be an array/);
});

// ── Against the (fake) read index ─────────────────────────────────────────────

const issued: Array<{ sql: string; args: unknown[] }> = [];

function installFakePool(): void {
  const query = async (sql: string, args: unknown[] = []) => {
    issued.push({ sql, args });
    if (/FROM claims/.test(sql)) {
      return {
        rows: [{ id: 1, creator: CREATOR, category: "crypto", state: "active", winner_side: "", challenger_count: 1 }],
        rowCount: 1,
      };
    }
    if (/FROM market_settlements/.test(sql)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => {} }) };
  process.env.DATABASE_URL = "postgres://fake/mimir";
  const g = globalThis as unknown as Record<string, unknown>;
  g.__mimirDbPool = pool;
  g.__mimirDbReady = Promise.resolve(pool);
}

test("runIndexDiscrepancyReport reads only the selected rows and never writes", async () => {
  installFakePool();
  issued.length = 0;
  const capture = parseDiscrepancyCapture({
    ...fixture,
    settlements: [{ claimId: 1, transactionHash: "tx-resolve-1", ledger: 1005, totalPaidAtomic: "0", totalFeesAtomic: "0", owedToChallengersAtomic: "25000000", dustAtomic: "0" }],
  });
  const report = await runIndexDiscrepancyReport(capture, [1]);

  assert.deepEqual(
    report.findings.map((f) => `${f.record}.${f.field}:${f.classification}`),
    ["claim.state:stale", "settlement.row:missing"],
  );
  assert.equal(issued.length, 2);
  for (const { sql, args } of issued) {
    assert.match(sql, /^\s*SELECT/);
    assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE/);
    assert.ok(args.includes(1));
  }
});
