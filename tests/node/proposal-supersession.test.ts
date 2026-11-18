/**
 * Proposal supersession tests.
 *
 * Uses an in-memory fake of the market_proposals table so the transaction,
 * guards and per-row review/expiry can be observed end to end, with no real
 * database. Covers:
 * - linking a revision to its predecessor without editing approved intent
 * - independent review and expiry for each revision
 * - refusals: self, missing, non-queued successor, double links, cycles
 * - the `supersede` action on POST /api/proposals/review
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { NextRequest } from "next/server";

import { planSupersession, supersessionErrorStatus, type SupersessionNode } from "../../lib/proposal-supersession";

const CRON_SECRET = "test-cron-secret-value";

type Row = Record<string, unknown>;
const table = new Map<string, Row>();
const statements: string[] = [];

function proposal(id: string, overrides: Row = {}): Row {
  return {
    proposal_id: id,
    question: `Will ${id} happen?`,
    creator_position: "Yes",
    counter_position: "No",
    settlement_rule: "Resolve YES if it happens",
    stake_policy: '{"creatorStakeUsdc":2}',
    review_status: "queued",
    review: "unreviewed",
    reviewer: null,
    reviewed_at: null,
    deadline: 2_000_000_000,
    supersedes_proposal_id: null,
    superseded_by_proposal_id: null,
    revision: 1,
    ...overrides,
  };
}

function seed(...rows: Row[]): void {
  table.clear();
  statements.length = 0;
  for (const row of rows) table.set(String(row.proposal_id), { ...row });
}

function snapshot(): Map<string, Row> {
  return new Map([...table].map(([k, v]) => [k, { ...v }]));
}

function fakeQuery(state: { saved: Map<string, Row> | null }) {
  return async (rawSql: string, args: unknown[] = []) => {
    const sql = rawSql.replace(/\s+/g, " ").trim();
    if (sql === "BEGIN") {
      state.saved = snapshot();
      return { rows: [], rowCount: 0 };
    }
    if (sql === "COMMIT") {
      state.saved = null;
      return { rows: [], rowCount: 0 };
    }
    if (sql === "ROLLBACK") {
      if (state.saved) {
        table.clear();
        for (const [k, v] of state.saved) table.set(k, v);
      }
      state.saved = null;
      return { rows: [], rowCount: 0 };
    }
    statements.push(sql);
    if (/^SELECT .* FROM market_proposals WHERE proposal_id IN \(\$1, \$2\) FOR UPDATE$/.test(sql)) {
      const rows = [args[0], args[1]].map((id) => table.get(String(id))).filter(Boolean) as Row[];
      return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length };
    }
    if (/^SELECT supersedes_proposal_id FROM market_proposals WHERE proposal_id = \$1$/.test(sql)) {
      const row = table.get(String(args[0]));
      return { rows: row ? [{ supersedes_proposal_id: row.supersedes_proposal_id }] : [], rowCount: row ? 1 : 0 };
    }
    if (/^UPDATE market_proposals SET supersedes_proposal_id = \$1, revision = \$2 WHERE proposal_id = \$3 AND supersedes_proposal_id IS NULL AND review_status = 'queued'$/.test(sql)) {
      const row = table.get(String(args[2]));
      if (!row || row.supersedes_proposal_id !== null || row.review_status !== "queued") return { rows: [], rowCount: 0 };
      row.supersedes_proposal_id = args[0];
      row.revision = args[1];
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE market_proposals SET superseded_by_proposal_id = \$1 WHERE proposal_id = \$2 AND superseded_by_proposal_id IS NULL$/.test(sql)) {
      const row = table.get(String(args[1]));
      if (!row || row.superseded_by_proposal_id !== null) return { rows: [], rowCount: 0 };
      row.superseded_by_proposal_id = args[0];
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE market_proposals SET review_status = 'in_review'/.test(sql)) {
      const [now, reviewer, id] = args;
      const row = table.get(String(id));
      if (!row || row.review_status !== "queued") return { rows: [], rowCount: 0 };
      Object.assign(row, { review_status: "in_review", claimed_at: now, reviewer });
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE market_proposals SET review_status = \$1, reviewed_at = \$2, reviewer = \$3, review = \$4/.test(sql)) {
      const [status, now, reviewer, review, id, who] = args;
      const row = table.get(String(id));
      if (!row || row.review_status !== "in_review" || row.reviewer !== who) return { rows: [], rowCount: 0 };
      Object.assign(row, { review_status: status, reviewed_at: now, reviewer, review });
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE market_proposals SET review_status = 'stale'/.test(sql)) {
      const [now, nowSeconds] = args as [number, number];
      let count = 0;
      for (const row of table.values()) {
        const deadline = Number(row.deadline);
        if (["queued", "in_review"].includes(String(row.review_status)) && deadline > 0 && deadline < nowSeconds) {
          Object.assign(row, { review_status: "stale", reviewed_at: now, failure_reason: "review deadline passed" });
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }
    return { rows: [], rowCount: 0 };
  };
}

function installFakePool(): void {
  const state = { saved: null as Map<string, Row> | null };
  const query = fakeQuery(state);
  const pool = {
    query,
    connect: async () => ({ query, release: () => {} }),
  };
  process.env.DATABASE_URL = "postgres://fake/mimir";
  const g = globalThis as unknown as Record<string, unknown>;
  g.__mimirDbPool = pool;
  g.__mimirDbReady = Promise.resolve(pool);
}

installFakePool();
process.env.CRON_SECRET = CRON_SECRET;

import * as db from "../../lib/db";
import { POST } from "../../app/api/proposals/review/route";

function post(body: unknown, token: string | null = CRON_SECRET): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const req = new Request("http://localhost/api/proposals/review", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return POST(req);
}

const INTENT_FIELDS = ["question", "creator_position", "counter_position", "settlement_rule", "stake_policy", "review", "review_status", "reviewer", "reviewed_at", "deadline"];

function intentOf(id: string): Row {
  const row = table.get(id)!;
  return Object.fromEntries(INTENT_FIELDS.map((f) => [f, row[f]]));
}

// ── Pure planner ──────────────────────────────────────────────────────────────

function node(id: string, overrides: Partial<SupersessionNode> = {}): SupersessionNode {
  return { proposal_id: id, review_status: "queued", supersedes_proposal_id: null, superseded_by_proposal_id: null, revision: 1, ...overrides };
}

test("planner: a queued revision of an approved draft becomes revision 2", () => {
  const plan = planSupersession(node("p1", { review_status: "approved" }), node("p2"));
  assert.deepEqual(plan, { ok: true, predecessorId: "p1", successorId: "p2", revision: 2 });
});

test("planner: refusals carry typed codes and HTTP statuses", () => {
  const cases: Array<[ReturnType<typeof planSupersession>, string, number]> = [
    [planSupersession(null, node("p2")), "not_found", 404],
    [planSupersession(node("p1"), null), "not_found", 404],
    [planSupersession(node("p1"), node("p1")), "invalid_request", 400],
    [planSupersession(node("p1"), node("p2", { review_status: "approved" })), "successor_not_queued", 409],
    [planSupersession(node("p1"), node("p2", { supersedes_proposal_id: "p0" })), "successor_already_linked", 409],
    [planSupersession(node("p1", { superseded_by_proposal_id: "p9" }), node("p2")), "predecessor_already_superseded", 409],
    [planSupersession(node("p2"), node("p0"), ["p1", "p0"]), "cycle", 409],
  ];
  for (const [plan, code, status] of cases) {
    assert.equal(plan.ok, false);
    if (plan.ok) continue;
    assert.equal(plan.code, code);
    assert.equal(supersessionErrorStatus(plan.code), status);
  }
});

// ── Linking without editing approved intent ───────────────────────────────────

test("supersedeProposal links a revision and leaves the approved predecessor's intent untouched", async () => {
  seed(
    proposal("p1", { review_status: "approved", review: "agree", reviewer: "alice", reviewed_at: 1_700_000_000_000 }),
    proposal("p2", { question: "Will p1 happen (revised wording)?", deadline: 2_100_000_000 }),
  );
  const before = intentOf("p1");
  const plan = await db.supersedeProposal("p1", "p2");
  assert.deepEqual(plan, { ok: true, predecessorId: "p1", successorId: "p2", revision: 2 });

  assert.deepEqual(intentOf("p1"), before, "approved intent, review and deadline must not change");
  assert.equal(table.get("p1")!.superseded_by_proposal_id, "p2");
  assert.equal(table.get("p2")!.supersedes_proposal_id, "p1");
  assert.equal(table.get("p2")!.revision, 2);
  assert.equal(table.get("p2")!.review_status, "queued", "the revision starts its own review");

  const updates = statements.filter((s) => s.startsWith("UPDATE"));
  assert.equal(updates.length, 2);
  for (const sql of updates) {
    const setClause = sql.slice(sql.indexOf(" SET "), sql.indexOf(" WHERE "));
    assert.doesNotMatch(setClause, /question|position|settlement_rule|stake_policy|review|deadline/);
  }
});

test("each revision is reviewed independently", async () => {
  seed(proposal("p1"), proposal("p2"));
  assert.equal((await db.supersedeProposal("p1", "p2")).ok, true);

  assert.equal(await db.claimProposalForReview("p1", "alice"), true);
  assert.equal(await db.completeProposalReview("p1", "alice", false), true);
  assert.equal(table.get("p1")!.review_status, "rejected");
  assert.equal(table.get("p2")!.review_status, "queued", "rejecting the predecessor does not touch the revision");

  assert.equal(await db.claimProposalForReview("p2", "bob"), true);
  assert.equal(await db.completeProposalReview("p2", "bob", true), true);
  assert.equal(table.get("p2")!.review_status, "approved");
  assert.equal(table.get("p2")!.reviewer, "bob");
  assert.equal(table.get("p1")!.reviewer, "alice");
});

test("each revision expires on its own deadline", async () => {
  const nowSeconds = 1_800_000_000;
  seed(proposal("p1", { deadline: nowSeconds - 60 }), proposal("p2", { deadline: nowSeconds + 3_600 }));
  assert.equal((await db.supersedeProposal("p1", "p2")).ok, true);

  assert.equal(await db.markStaleProposals(nowSeconds), 1);
  assert.equal(table.get("p1")!.review_status, "stale");
  assert.equal(table.get("p2")!.review_status, "queued", "the revision's later deadline is not inherited or shortened");
  assert.equal(table.get("p2")!.deadline, nowSeconds + 3_600);
});

test("a chain grows revision by revision", async () => {
  seed(proposal("p1", { review_status: "approved" }), proposal("p2"), proposal("p3"));
  assert.equal((await db.supersedeProposal("p1", "p2")).ok, true);
  const third = await db.supersedeProposal("p2", "p3");
  assert.deepEqual(third, { ok: true, predecessorId: "p2", successorId: "p3", revision: 3 });
});

// ── Failure and boundary cases ────────────────────────────────────────────────

test("a predecessor cannot be superseded twice (no forked history)", async () => {
  seed(proposal("p1"), proposal("p2"), proposal("p3"));
  assert.equal((await db.supersedeProposal("p1", "p2")).ok, true);
  const second = await db.supersedeProposal("p1", "p3");
  assert.equal(second.ok === false && second.code, "predecessor_already_superseded");
  assert.equal(table.get("p3")!.supersedes_proposal_id, null);
});

test("an already-reviewed draft cannot be attached as a revision", async () => {
  seed(proposal("p1"), proposal("p2", { review_status: "approved", review: "agree" }));
  const plan = await db.supersedeProposal("p1", "p2");
  assert.equal(plan.ok === false && plan.code, "successor_not_queued");
  assert.equal(table.get("p1")!.superseded_by_proposal_id, null);
});

test("cycles are refused and nothing is written", async () => {
  seed(proposal("p1"), proposal("p2"), proposal("p3"));
  await db.supersedeProposal("p1", "p2");
  await db.supersedeProposal("p2", "p3");
  // p3 -> p1 would close the loop. p1 is not queued-with-no-link-fresh anyway,
  // so reset it to isolate the cycle check.
  table.get("p1")!.review_status = "queued";
  const before = snapshot();
  const plan = await db.supersedeProposal("p3", "p1");
  assert.equal(plan.ok, false);
  assert.deepEqual(snapshot(), before);
});

test("a lost race rolls back both link writes", async () => {
  seed(proposal("p1"), proposal("p2"));
  // Simulate another writer linking p1 between our read and our write: the
  // predecessor guard (superseded_by IS NULL) then matches no row.
  const original = table.get("p1")!;
  let reads = 0;
  Object.defineProperty(original, "superseded_by_proposal_id", {
    configurable: true,
    enumerable: true,
    get: () => (reads++ < 2 ? null : "someone-else"),
    set: () => {},
  });
  const plan = await db.supersedeProposal("p1", "p2");
  assert.equal(plan.ok, false);
  assert.equal(table.get("p2")!.supersedes_proposal_id, null, "successor link rolled back");
  assert.equal(table.get("p2")!.revision, 1);
});

// ── Route ─────────────────────────────────────────────────────────────────────

test("POST supersede links a revision and reports its revision number", async () => {
  seed(proposal("p1", { review_status: "approved" }), proposal("p2"));
  const res = await post({ action: "supersede", proposalId: "p1", successorId: "p2" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, proposalId: "p1", successorId: "p2", revision: 2, status: "queued" });
});

test("POST supersede validates input and maps refusals to 400/404/409", async () => {
  seed(proposal("p1"), proposal("p2", { review_status: "in_review" }));
  assert.equal((await post({ action: "supersede", proposalId: "p1" })).status, 400);
  assert.equal((await post({ action: "supersede", proposalId: "p1", successorId: "p1" })).status, 400);
  assert.equal((await post({ action: "supersede", proposalId: "p1", successorId: "missing" })).status, 404);
  const conflict = await post({ action: "supersede", proposalId: "p1", successorId: "p2" });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "successor_not_queued");
});

test("POST supersede still requires the worker secret", async () => {
  seed(proposal("p1"), proposal("p2"));
  const res = await post({ action: "supersede", proposalId: "p1", successorId: "p2" }, "wrong");
  assert.notEqual(res.status, 200);
  assert.equal(table.get("p2")!.supersedes_proposal_id, null);
});
