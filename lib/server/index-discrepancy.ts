/**
 * Bounded chain-to-index discrepancy report.
 *
 * Compares a SELECTED set of claims (and their settlement projections) in the
 * Postgres read index with a capture of the authoritative chain events, and
 * classifies every difference as one of:
 *
 *   missing      the chain capture proves a record exists, the index has no row
 *   stale        the index is behind the chain: a value the chain has since moved
 *                past (an earlier lifecycle state, fewer challengers, a payout
 *                that has not yet absorbed later pulls). A resync fixes it.
 *   conflicting  the index says something the chain contradicts and lag cannot
 *                explain (a different creator or winner, a state the chain never
 *                reached, a settlement transaction or amount that disagrees).
 *                A resync may not fix it; it needs a look.
 *
 * Selected ids the capture says nothing about are reported as `unverified`, not
 * as discrepancies: their history may sit outside the captured ledger range.
 *
 * The report is read-only and bounded: at most `DISCREPANCY_REPORT_MAX_CLAIMS`
 * ids per run, at most `DISCREPANCY_REPORT_MAX_FINDINGS` findings listed (the
 * summary still counts every finding and `truncated` says when the list was cut).
 * It never writes to Postgres, never advances a cursor and never calls the RPC —
 * the chain side is a capture, so the comparison is reproducible offline.
 *
 * Soroban contract state stays authoritative: findings describe the index, never
 * the chain. Money is compared in integer atomic USDC (bigint), never floats.
 */

import { getClaimsByFilter, getMarketSettlementsByClaimIds } from "@/lib/db";
import { parseLedgerFixture } from "@/lib/ops/ledger-fixture";
import { project, type ChainEvent, type ProjectedClaim } from "@/lib/ops/projection";
import { grossVolume } from "@/lib/server/settlement-index";

/** Hard ceiling on claim ids per report. Callers may ask for fewer, never more. */
export const DISCREPANCY_REPORT_MAX_CLAIMS = 200;
/** Hard ceiling on findings listed in one report. */
export const DISCREPANCY_REPORT_MAX_FINDINGS = 1_000;

export type DiscrepancyClass = "missing" | "stale" | "conflicting";
export type DiscrepancyRecord = "claim" | "settlement";

/** A `market_settled` event as captured, with the challenger pulls seen after it. */
export interface CapturedSettlement {
  claimId: number;
  transactionHash: string;
  ledger: number;
  totalPaidAtomic: bigint;
  totalFeesAtomic: bigint;
  owedToChallengersAtomic: bigint;
  dustAtomic: bigint;
  /** Sum of `challenger_paid.net` captured for this claim. */
  pulledNetAtomic: bigint;
}

/** The read-index claim columns the report compares. */
export interface IndexedClaim {
  id: number;
  creator: string;
  category: string;
  state: string;
  winner_side: string;
  challenger_count: number;
}

/** The read-index settlement columns the report compares. */
export interface IndexedSettlement {
  claim_id: number;
  gross_volume_atomic: bigint;
  payout_atomic: bigint;
  dust_atomic: bigint;
  transaction_hash: string;
}

export interface DiscrepancyFinding {
  classification: DiscrepancyClass;
  record: DiscrepancyRecord;
  claimId: number;
  field: string;
  indexed: string | null;
  chain: string | null;
  /** Ledger of the newest captured event the chain value comes from. */
  chainLedger: number;
}

export interface DiscrepancyReport {
  reportVersion: 1;
  capturedThroughLedger: number;
  selectedClaimIds: number[];
  checked: { claims: number; settlements: number };
  summary: { missing: number; stale: number; conflicting: number; unverified: number };
  /** Selected ids the capture has no events for; nothing could be compared. */
  unverifiedClaimIds: number[];
  findings: DiscrepancyFinding[];
  /** True when more findings existed than `maxFindings`; the summary counts all of them. */
  truncated: boolean;
}

export interface DiscrepancyReportInput {
  claimIds: readonly number[];
  capture: {
    capturedThroughLedger: number;
    events: readonly ChainEvent[];
    reorgedOut?: readonly string[];
    settlements?: readonly CapturedSettlement[];
  };
  indexed: {
    claims: readonly IndexedClaim[];
    settlements: readonly IndexedSettlement[];
  };
  maxClaims?: number;
  maxFindings?: number;
}

/** Contract `WinnerSide` discriminants, as the read index stores them. */
const WINNER_SIDES: Record<number, string> = {
  0: "",
  1: "creator",
  2: "challengers",
  3: "draw",
  4: "unresolvable",
};

const STATE_RANK: Record<string, number> = { open: 0, active: 1, resolved: 2, cancelled: 2 };

/**
 * Validate and bound the selection. Fails closed: an empty, oversized,
 * duplicated or malformed selection throws rather than silently narrowing.
 */
export function normalizeClaimSelection(
  claimIds: readonly unknown[],
  maxClaims = DISCREPANCY_REPORT_MAX_CLAIMS,
): number[] {
  const cap = Math.min(Math.max(1, Math.trunc(maxClaims)), DISCREPANCY_REPORT_MAX_CLAIMS);
  if (!Array.isArray(claimIds) || claimIds.length === 0) {
    throw new RangeError("select at least one claim id");
  }
  if (claimIds.length > cap) {
    throw new RangeError(`select at most ${cap} claim ids per report (got ${claimIds.length})`);
  }
  const seen = new Set<number>();
  for (const raw of claimIds) {
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) {
      throw new RangeError(`claim ids must be positive safe integers (got ${String(raw)})`);
    }
    if (seen.has(raw)) throw new RangeError(`claim id ${raw} is selected twice`);
    seen.add(raw);
  }
  return [...seen].sort((a, b) => a - b);
}

function compareClaim(chain: ProjectedClaim, indexed: IndexedClaim, push: (f: Omit<DiscrepancyFinding, "record" | "claimId" | "chainLedger">) => void): void {
  if (indexed.creator !== chain.creator) {
    push({ classification: "conflicting", field: "creator", indexed: indexed.creator, chain: chain.creator });
  }
  if (indexed.category !== chain.category) {
    push({ classification: "conflicting", field: "category", indexed: indexed.category, chain: chain.category });
  }

  const indexedRank = STATE_RANK[indexed.state];
  const chainRank = STATE_RANK[chain.state];
  if (indexed.state !== chain.state) {
    // Behind on the lifecycle is lag. Ahead of it, a terminal state the chain
    // never reached, or an unknown value is a contradiction.
    const stale = indexedRank !== undefined && indexedRank < chainRank;
    push({ classification: stale ? "stale" : "conflicting", field: "state", indexed: indexed.state, chain: chain.state });
  }

  if (indexed.state === "resolved" && chain.state === "resolved") {
    const chainWinner = WINNER_SIDES[chain.winnerSide] ?? String(chain.winnerSide);
    if (indexed.winner_side !== chainWinner) {
      push({ classification: "conflicting", field: "winner_side", indexed: indexed.winner_side, chain: chainWinner });
    }
  }

  const chainCount = chain.challengers.length;
  if (indexed.challenger_count !== chainCount) {
    push({
      classification: indexed.challenger_count < chainCount ? "stale" : "conflicting",
      field: "challenger_count",
      indexed: String(indexed.challenger_count),
      chain: String(chainCount),
    });
  }
}

function compareSettlement(chain: CapturedSettlement, indexed: IndexedSettlement, push: (f: Omit<DiscrepancyFinding, "record" | "claimId" | "chainLedger">) => void): void {
  if (indexed.transaction_hash.toLowerCase() !== chain.transactionHash.toLowerCase()) {
    push({ classification: "conflicting", field: "transaction_hash", indexed: indexed.transaction_hash, chain: chain.transactionHash });
  }
  if (indexed.dust_atomic !== chain.dustAtomic) {
    push({ classification: "conflicting", field: "dust_atomic", indexed: indexed.dust_atomic.toString(), chain: chain.dustAtomic.toString() });
  }
  const gross = grossVolume(chain.totalPaidAtomic, chain.totalFeesAtomic, chain.owedToChallengersAtomic, chain.dustAtomic);
  if (indexed.gross_volume_atomic !== gross) {
    push({ classification: "conflicting", field: "gross_volume_atomic", indexed: indexed.gross_volume_atomic.toString(), chain: gross.toString() });
  }
  // Payout accumulates as challengers pull, so a lower indexed figure is lag;
  // a higher one claims money left escrow that the chain never recorded.
  const payout = chain.totalPaidAtomic + chain.pulledNetAtomic;
  if (indexed.payout_atomic !== payout) {
    push({
      classification: indexed.payout_atomic < payout ? "stale" : "conflicting",
      field: "payout_atomic",
      indexed: indexed.payout_atomic.toString(),
      chain: payout.toString(),
    });
  }
}

const CLASS_ORDER: Record<DiscrepancyClass, number> = { missing: 0, conflicting: 1, stale: 2 };

/** Build the report. Pure: same input, same report. */
export function buildDiscrepancyReport(input: DiscrepancyReportInput): DiscrepancyReport {
  const selected = normalizeClaimSelection(input.claimIds, input.maxClaims);
  const maxFindings = Math.min(
    Math.max(1, Math.trunc(input.maxFindings ?? DISCREPANCY_REPORT_MAX_FINDINGS)),
    DISCREPANCY_REPORT_MAX_FINDINGS,
  );
  const selectedSet = new Set(selected);

  // Fold only the selected claims' events: the report is bounded by selection,
  // not by the size of the capture.
  const projection = project(
    input.capture.events.filter((event) => selectedSet.has(event.claimId)),
    { reorgedOut: new Set(input.capture.reorgedOut ?? []) },
  );

  const indexedClaims = new Map(input.indexed.claims.filter((c) => selectedSet.has(c.id)).map((c) => [c.id, c]));
  const indexedSettlements = new Map(
    input.indexed.settlements.filter((s) => selectedSet.has(s.claim_id)).map((s) => [s.claim_id, s]),
  );
  const capturedSettlements = new Map<number, CapturedSettlement>();
  for (const s of input.capture.settlements ?? []) {
    if (!selectedSet.has(s.claimId)) continue;
    const prior = capturedSettlements.get(s.claimId);
    if (prior && prior.transactionHash.toLowerCase() !== s.transactionHash.toLowerCase()) {
      throw new Error(`capture has two different market_settled events for claim ${s.claimId}`);
    }
    capturedSettlements.set(s.claimId, s);
  }

  const findings: DiscrepancyFinding[] = [];
  const unverified: number[] = [];
  let claimsChecked = 0;
  let settlementsChecked = 0;

  for (const claimId of selected) {
    const chain = projection.claims.get(claimId);
    const chainSettlement = capturedSettlements.get(claimId);
    if (!chain && !chainSettlement) {
      unverified.push(claimId);
      continue;
    }

    if (chain) {
      claimsChecked += 1;
      const push = (f: Omit<DiscrepancyFinding, "record" | "claimId" | "chainLedger">) =>
        findings.push({ ...f, record: "claim", claimId, chainLedger: chain.lastBlock });
      const indexed = indexedClaims.get(claimId);
      if (!indexed) push({ classification: "missing", field: "row", indexed: null, chain: chain.state });
      else compareClaim(chain, indexed, push);
    }

    const indexedSettlement = indexedSettlements.get(claimId);
    if (chainSettlement) {
      settlementsChecked += 1;
      const push = (f: Omit<DiscrepancyFinding, "record" | "claimId" | "chainLedger">) =>
        findings.push({ ...f, record: "settlement", claimId, chainLedger: chainSettlement.ledger });
      if (!indexedSettlement) push({ classification: "missing", field: "row", indexed: null, chain: chainSettlement.transactionHash });
      else compareSettlement(chainSettlement, indexedSettlement, push);
    } else if (indexedSettlement && chain && chain.state !== "resolved") {
      // The capture covers this claim and shows it never resolved, yet the index
      // holds a settlement for it.
      settlementsChecked += 1;
      findings.push({
        classification: "conflicting",
        record: "settlement",
        claimId,
        field: "row",
        indexed: indexedSettlement.transaction_hash,
        chain: null,
        chainLedger: chain.lastBlock,
      });
    }
  }

  findings.sort(
    (a, b) =>
      a.claimId - b.claimId ||
      a.record.localeCompare(b.record) ||
      CLASS_ORDER[a.classification] - CLASS_ORDER[b.classification] ||
      a.field.localeCompare(b.field),
  );

  const summary = { missing: 0, stale: 0, conflicting: 0, unverified: unverified.length };
  for (const f of findings) summary[f.classification] += 1;

  return {
    reportVersion: 1,
    capturedThroughLedger: input.capture.capturedThroughLedger,
    selectedClaimIds: selected,
    checked: { claims: claimsChecked, settlements: settlementsChecked },
    summary,
    unverifiedClaimIds: unverified,
    findings: findings.slice(0, maxFindings),
    truncated: findings.length > maxFindings,
  };
}

// ── Capture parsing ──────────────────────────────────────────────────────────

export type DiscrepancyCapture = DiscrepancyReportInput["capture"];

function atomicField(value: unknown, path: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`discrepancy capture ${path}: must be an unsigned base-10 string`);
  }
  return BigInt(value);
}

/**
 * Parse a capture: a saved ledger fixture (see docs/LEDGER_REPLAY.md) plus an
 * optional `settlements` array of captured `market_settled` events.
 *
 *   { "claimId": 1, "transactionHash": "...", "ledger": 1005,
 *     "totalPaidAtomic": "0", "totalFeesAtomic": "0",
 *     "owedToChallengersAtomic": "25000000", "dustAtomic": "0",
 *     "pulledNetAtomic": "0" }
 *
 * Atomic USDC amounts are base-10 strings; JavaScript numbers are rejected.
 */
export function parseDiscrepancyCapture(value: unknown): DiscrepancyCapture {
  const fixture = parseLedgerFixture(value);
  const root = value as Record<string, unknown>;
  const rawSettlements = root.settlements ?? [];
  if (!Array.isArray(rawSettlements)) throw new Error("discrepancy capture settlements: must be an array");
  const settlements = rawSettlements.map((raw, i): CapturedSettlement => {
    const path = `settlements[${i}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`discrepancy capture ${path}: must be an object`);
    const row = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(row.claimId) || (row.claimId as number) <= 0) {
      throw new Error(`discrepancy capture ${path}.claimId: must be a positive safe integer`);
    }
    if (typeof row.transactionHash !== "string" || row.transactionHash.trim() === "") {
      throw new Error(`discrepancy capture ${path}.transactionHash: must be a non-empty string`);
    }
    const ledger = row.ledger;
    if (!Number.isSafeInteger(ledger) || (ledger as number) < fixture.deployLedger || (ledger as number) > fixture.capturedThroughLedger) {
      throw new Error(`discrepancy capture ${path}.ledger: must be inside the declared capture range`);
    }
    return {
      claimId: row.claimId as number,
      transactionHash: row.transactionHash,
      ledger: ledger as number,
      totalPaidAtomic: atomicField(row.totalPaidAtomic, `${path}.totalPaidAtomic`),
      totalFeesAtomic: atomicField(row.totalFeesAtomic, `${path}.totalFeesAtomic`),
      owedToChallengersAtomic: atomicField(row.owedToChallengersAtomic, `${path}.owedToChallengersAtomic`),
      dustAtomic: atomicField(row.dustAtomic, `${path}.dustAtomic`),
      pulledNetAtomic: atomicField(row.pulledNetAtomic ?? "0", `${path}.pulledNetAtomic`),
    };
  });
  return {
    capturedThroughLedger: fixture.capturedThroughLedger,
    events: fixture.events,
    reorgedOut: fixture.reorgedOut,
    settlements,
  };
}

// ── Against the live read index ──────────────────────────────────────────────

/**
 * Read only the selected rows from Postgres and build the report.
 * Two bounded SELECTs (`id IN (...)`), no writes, no RPC.
 */
export async function runIndexDiscrepancyReport(
  capture: DiscrepancyCapture,
  claimIds: readonly number[],
  opts: { maxClaims?: number; maxFindings?: number } = {},
): Promise<DiscrepancyReport> {
  const selected = normalizeClaimSelection(claimIds, opts.maxClaims);
  const [claims, settlements] = await Promise.all([
    getClaimsByFilter({ ids: selected, limit: selected.length }),
    getMarketSettlementsByClaimIds(selected),
  ]);
  return buildDiscrepancyReport({ claimIds: selected, capture, indexed: { claims, settlements }, ...opts });
}
