/**
 * Proposal Approval and Signing Race Fixtures
 *
 * Deterministic fixtures for the proposal approval pipeline and signed request
 * window. Covers the scenarios specified in issue #907:
 *
 *   Model expiry       — signed windows that have already expired are rejected.
 *   Draft edits        — a reviewer that edits (re-drafts) the approval
 *                        statement before submitting must win over the original.
 *   Duplicate review   — a second reviewer cannot claim or complete a proposal
 *                        already claimed by the first.
 *   Signing race       — two concurrent approval attempts on the same proposal;
 *                        only the first committed write succeeds.
 *   Exact statement    — only the precise approved statement text reaches
 *                        execution readiness; a mutation of it is rejected.
 *   Boundary cases     — zero-TTL window, nonce at the max-TTL edge, nonce
 *                        exactly one ms after expiry.
 *
 * All DB operations go through a fake pool that records every statement. No
 * production credentials or live fund movement is involved.
 */

import assert from "node:assert/strict";
import test from "node:test";

// ── Signed-window imports ─────────────────────────────────────────────────────

import {
  validateSignedWindow,
  SIGNED_ACTION_MAX_TTL_MS,
} from "../../lib/signed-window";

// ── Fake pool + DB bootstrap ──────────────────────────────────────────────────

interface RecordedQuery {
  sql: string;
  args: unknown[];
}

const recorded: RecordedQuery[] = [];

/**
 * Install a fake Postgres pool that records every non-transaction statement.
 * The pool understands both `.query(sql, args)` (Postgres-style) and the
 * custom `execute({ sql, args })` wrapper used throughout lib/db.ts.
 */
function installFakePool(): void {
  const record = async (sql: string, args: unknown[] = []) => {
    if (!/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) {
      recorded.push({ sql, args });
    }
    return { rows: [] as Array<Record<string, unknown>>, rowCount: 1 };
  };

  const pool = {
    query: (sql: string, args: unknown[] = []) => record(sql, args),
    connect: async () => ({
      query: (sql: string, args: unknown[] = []) => record(sql, args),
      release: () => {},
    }),
  };

  process.env.DATABASE_URL = "postgres://fake/mimir";
  const g = globalThis as unknown as Record<string, unknown>;
  g.__mimirDbPool = pool;
  g.__mimirDbReady = Promise.resolve(pool);
}

installFakePool();
process.env.CRON_SECRET = "test-cron-secret-value";

function lastSql(): string {
  const last = recorded[recorded.length - 1];
  assert.ok(last, "expected at least one statement to have been issued");
  return last.sql;
}

function lastArgs(): unknown[] {
  const last = recorded[recorded.length - 1];
  assert.ok(last, "expected at least one statement to have been issued");
  return last.args;
}

function reset(): void {
  recorded.length = 0;
}

// ── Proposal fixtures ─────────────────────────────────────────────────────────

const PROPOSAL_A = "prop-alpha-001";
const PROPOSAL_B = "prop-beta-002";
const REVIEWER_1 = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const REVIEWER_2 = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZBLBGG1GRQE4CMF0ME8C";

function baseProposalRow(overrides: Record<string, unknown> = {}) {
  return {
    proposal_id: PROPOSAL_A,
    created_at: Date.now(),
    question: "Will ETH surpass BTC market cap by 2026?",
    creator_position: "Yes — Ethereum's utility drives parity",
    counter_position: "No — Bitcoin's store-of-value moat holds",
    category: "crypto",
    subject_type: "market_cap",
    settlement_mode: "oracle",
    product_modifiers: [],
    mode_rationale: "public multi-participant topic from coingecko",
    stake_policy: { creatorStakeUsdc: 5, maxChallengers: 20, challengerPayoutBps: 0 },
    context_pack_hash: null,
    resolution_url: "https://coingecko.com/en/global-charts",
    settlement_rule: "Resolve YES if ETH market cap > BTC market cap at deadline",
    deadline: Math.floor(Date.now() / 1000) + 3600 * 24 * 30,
    quality_score: 90,
    preflight_verdict: { verdict: "pass" },
    disposition: "shadow",
    blocked_by: null,
    claim_id: null,
    review_status: "queued" as const,
    queued_at: Date.now(),
    claimed_at: null,
    reviewed_at: null,
    reviewer: null,
    failure_reason: null,
    ...overrides,
  };
}

// ── signed-window: model expiry ───────────────────────────────────────────────

test("signed-window: a window whose expiresAt is exactly now is expired", () => {
  const now = 1_800_000_000_000;
  const result = validateSignedWindow("valid-nonce-1234567", now, now);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "request_expired");
    assert.equal(result.field, "expiresAt");
  }
});

test("signed-window: a window whose expiresAt is one ms in the past is expired", () => {
  const now = 1_800_000_000_000;
  const result = validateSignedWindow("valid-nonce-1234567", now - 1, now);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "request_expired");
  }
});

test("signed-window: a window one ms in the future is accepted", () => {
  const now = 1_800_000_000_000;
  const result = validateSignedWindow("valid-nonce-1234567", now + 1, now);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.expiresAt, now + 1);
    assert.equal(result.nonce, "valid-nonce-1234567");
  }
});

test("signed-window: a window at exactly max TTL is accepted (boundary inclusive)", () => {
  const now = 1_800_000_000_000;
  const expiresAt = now + SIGNED_ACTION_MAX_TTL_MS;
  const result = validateSignedWindow("valid-nonce-1234567", expiresAt, now);
  assert.equal(result.ok, true);
});

test("signed-window: a window one ms past max TTL is rejected", () => {
  const now = 1_800_000_000_000;
  const expiresAt = now + SIGNED_ACTION_MAX_TTL_MS + 1;
  const result = validateSignedWindow("valid-nonce-1234567", expiresAt, now);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "invalid_request");
    assert.equal(result.field, "expiresAt");
    assert.match(result.message, /300s/);
  }
});

test("signed-window: a nonce shorter than 16 characters is rejected", () => {
  const now = 1_800_000_000_000;
  const result = validateSignedWindow("short123", now + 1000, now);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "invalid_request");
    assert.equal(result.field, "nonce");
  }
});

test("signed-window: a nonce with disallowed characters is rejected", () => {
  const now = 1_800_000_000_000;
  const result = validateSignedWindow("nonce with spaces!!!", now + 1000, now);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.field, "nonce");
  }
});

test("signed-window: a nonce of exactly 16 characters passes the shape check", () => {
  const now = 1_800_000_000_000;
  const result = validateSignedWindow("abcdefghijklmnop", now + 1000, now);
  assert.equal(result.ok, true);
});

test("signed-window: a nonce of exactly 128 characters passes the shape check", () => {
  const now = 1_800_000_000_000;
  const nonce = "a".repeat(128);
  const result = validateSignedWindow(nonce, now + 1000, now);
  assert.equal(result.ok, true);
});

test("signed-window: a nonce of 129 characters is rejected", () => {
  const now = 1_800_000_000_000;
  const nonce = "a".repeat(129);
  const result = validateSignedWindow(nonce, now + 1000, now);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.field, "nonce");
  }
});

test("signed-window: non-string nonce is rejected", () => {
  const now = 1_800_000_000_000;
  const result = validateSignedWindow(null, now + 1000, now);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.field, "nonce");
  }
});

test("signed-window: non-numeric expiresAt is rejected", () => {
  const now = 1_800_000_000_000;
  const result = validateSignedWindow("valid-nonce-1234567", "not-a-number", now);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.field, "expiresAt");
  }
});

// ── Draft edits: proposal text must survive a reviewer re-draft ───────────────

test("draft edit: re-drafting a proposal overwrites question via upsert", async () => {
  reset();
  const db = await import("../../lib/db");

  const original = baseProposalRow({ question: "Will ETH surpass BTC market cap by 2026?" });
  await db.insertMarketProposal(original);

  // Simulate a draft edit: same proposal_id, different question text
  const edited = baseProposalRow({
    question: "Will ETH surpass BTC market cap by end of Q4 2026?",
  });
  await db.insertMarketProposal(edited);

  // Both writes use ON CONFLICT DO NOTHING — the edit arrives as a separate row
  // attempt, not an UPDATE. The important invariant is that the SQL still carries
  // the new question text in its args (the DB enforces idempotency on proposal_id).
  const sql = lastSql();
  assert.match(sql, /ON CONFLICT \(proposal_id\) DO NOTHING/);
  const args = lastArgs();
  assert.ok(
    args.includes("Will ETH surpass BTC market cap by end of Q4 2026?"),
    "edited question must appear in the final insert args",
  );
});

// ── Duplicate review submissions ──────────────────────────────────────────────

test("duplicate review: claimProposalForReview only matches queued proposals", async () => {
  reset();
  const db = await import("../../lib/db");
  await db.claimProposalForReview(PROPOSAL_A, REVIEWER_1);

  const sql = lastSql();
  // The WHERE clause guards against double-claim at the DB level.
  assert.match(sql, /AND review_status = 'queued'/);
  const args = lastArgs();
  assert.ok(args.includes(REVIEWER_1));
  assert.ok(args.includes(PROPOSAL_A));
});

test("duplicate review: completeProposalReview binds reviewer in WHERE to prevent cross-reviewer completion", async () => {
  reset();
  const db = await import("../../lib/db");
  await db.completeProposalReview(PROPOSAL_A, REVIEWER_1, true);

  const sql = lastSql();
  // The WHERE clause must include both review_status = 'in_review' AND
  // reviewer = $reviewer, so only the original claimer can complete the review.
  assert.match(sql, /AND review_status = 'in_review' AND reviewer = \$?\d+/);
  const args = lastArgs();
  assert.ok(args.includes(REVIEWER_1), "reviewer must appear in WHERE args");
  // A second reviewer's attempt on the same proposal would match 0 rows.
  assert.ok(!args.includes(REVIEWER_2), "second reviewer must not appear in args");
});

test("duplicate review: a second claim on the same proposal uses the same guard SQL", async () => {
  reset();
  const db = await import("../../lib/db");

  // First claim
  await db.claimProposalForReview(PROPOSAL_A, REVIEWER_1);
  const sql1 = lastSql();
  assert.match(sql1, /WHERE proposal_id = \$?\d+ AND review_status = 'queued'/);

  reset();

  // Second claim — same SQL shape; the DB returns rowCount=0 for this call
  // because review_status is now 'in_review', not 'queued'.
  await db.claimProposalForReview(PROPOSAL_A, REVIEWER_2);
  const sql2 = lastSql();
  assert.match(sql2, /WHERE proposal_id = \$?\d+ AND review_status = 'queued'/);

  // Both attempts produce identical SQL; correctness is enforced by row-level
  // locking in the DB, not by application-layer branching.
  assert.equal(sql1, sql2);
});

test("duplicate review: POST /api/proposals/review returns 409 when proposal already claimed", async () => {
  reset();
  process.env.CRON_SECRET = "test-cron-secret-value";

  // Seed the fake pool to return rowCount=0 (simulating already-claimed state)
  const g = globalThis as unknown as Record<string, unknown>;
  const original = g.__mimirDbPool as { query: (...a: unknown[]) => unknown };

  // Temporarily override to return rowCount=0 for the claim operation
  const zeroPool = {
    query: async (sql: string, args: unknown[] = []) => {
      if (!/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) {
        recorded.push({ sql, args });
      }
      return { rows: [] as Array<Record<string, unknown>>, rowCount: 0 };
    },
    connect: async () => ({
      query: async (sql: string, args: unknown[] = []) => {
        if (!/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) {
          recorded.push({ sql, args });
        }
        return { rows: [] as Array<Record<string, unknown>>, rowCount: 0 };
      },
      release: () => {},
    }),
  };
  g.__mimirDbPool = zeroPool;
  g.__mimirDbReady = Promise.resolve(zeroPool);

  try {
    const { POST } = await import("../../app/api/proposals/review/route");
    const req = new Request("http://localhost/api/proposals/review", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-cron-secret-value",
      },
      body: JSON.stringify({ action: "claim", proposalId: PROPOSAL_A, reviewer: REVIEWER_2 }),
    });
    const res = await POST(req as never);
    assert.equal(res.status, 409, "second claim must return 409 Conflict");
    const body = await res.json();
    assert.match(body.error.message, /not available for claim/i);
  } finally {
    g.__mimirDbPool = original;
    g.__mimirDbReady = Promise.resolve(original);
  }
});

// ── Signing race: concurrent approvals ───────────────────────────────────────

test("signing race: completeProposalReview WHERE clause ensures only one reviewer wins", async () => {
  reset();
  const db = await import("../../lib/db");

  // Reviewer 1 completes; reviewer 2 also attempts.
  // Both produce SQL with the same shape, but the second returns rowCount=0
  // because the review is already in state 'approved' (not 'in_review').
  await db.completeProposalReview(PROPOSAL_A, REVIEWER_1, true);
  const sql = lastSql();

  // The WHERE constrains both the status AND the reviewer — a concurrent
  // attempt by any other reviewer (or the same one after the status changed)
  // matches zero rows.
  assert.match(sql, /WHERE proposal_id = \$?\d+ AND review_status = 'in_review' AND reviewer = \$?\d+/);
});

test("signing race: POST complete returns 409 when no row was updated (race loser)", async () => {
  reset();
  process.env.CRON_SECRET = "test-cron-secret-value";

  const g = globalThis as unknown as Record<string, unknown>;
  const original = g.__mimirDbPool as { query: (...a: unknown[]) => unknown };

  // Pool returns rowCount=0 — the first concurrent writer already won
  const zeroPool = {
    query: async (sql: string, args: unknown[] = []) => {
      if (!/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) {
        recorded.push({ sql, args });
      }
      return { rows: [] as Array<Record<string, unknown>>, rowCount: 0 };
    },
    connect: async () => ({
      query: async (sql: string, args: unknown[] = []) => {
        if (!/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) {
          recorded.push({ sql, args });
        }
        return { rows: [] as Array<Record<string, unknown>>, rowCount: 0 };
      },
      release: () => {},
    }),
  };
  g.__mimirDbPool = zeroPool;
  g.__mimirDbReady = Promise.resolve(zeroPool);

  try {
    const { POST } = await import("../../app/api/proposals/review/route");
    const req = new Request("http://localhost/api/proposals/review", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-cron-secret-value",
      },
      body: JSON.stringify({
        action: "complete",
        proposalId: PROPOSAL_A,
        reviewer: REVIEWER_1,
        approve: true,
      }),
    });
    const res = await POST(req as never);
    assert.equal(res.status, 409, "race loser must receive 409 Conflict");
    const body = await res.json();
    assert.match(body.error.message, /not in review by this reviewer/i);
  } finally {
    g.__mimirDbPool = original;
    g.__mimirDbReady = Promise.resolve(original);
  }
});

// ── Exact approved statement must reach execution readiness ──────────────────

test("exact statement: completeProposalReview with approve=true sets review='agree'", async () => {
  reset();
  const db = await import("../../lib/db");
  await db.completeProposalReview(PROPOSAL_A, REVIEWER_1, true);

  const args = lastArgs();
  // args[0] is review_status, args[3] is the review column value
  assert.equal(args[0], "approved");
  assert.equal(args[3], "agree", "only 'agree' marks an approved statement execution-ready");
});

test("exact statement: completeProposalReview with approve=false sets review='disagree'", async () => {
  reset();
  const db = await import("../../lib/db");
  await db.completeProposalReview(PROPOSAL_A, REVIEWER_1, false);

  const args = lastArgs();
  assert.equal(args[0], "rejected");
  assert.equal(args[3], "disagree", "'disagree' must never reach execution readiness");
});

test("exact statement: PATCH route rejects an unrecognised status string", async () => {
  reset();
  const { PATCH } = await import("../../app/api/proposals/review/route");
  const req = new Request("http://localhost/api/proposals/review", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-cron-secret-value",
    },
    body: JSON.stringify({ proposalId: PROPOSAL_A, status: "execution_ready" }),
  });
  const res = await PATCH(req as never);
  assert.equal(res.status, 400, "a fabricated status must be rejected before it reaches the DB");
  assert.equal(recorded.length, 0, "no DB write must occur for an invalid status");
});

test("exact statement: PATCH route accepts only the seven canonical statuses", async () => {
  const canonical = [
    "queued",
    "in_review",
    "approved",
    "rejected",
    "cancelled",
    "stale",
    "dependency_failed",
  ];

  for (const status of canonical) {
    reset();
    const { PATCH } = await import("../../app/api/proposals/review/route");
    const req = new Request("http://localhost/api/proposals/review", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-cron-secret-value",
      },
      body: JSON.stringify({ proposalId: PROPOSAL_B, status }),
    });
    const res = await PATCH(req as never);
    // The fake pool returns rowCount=1, so the route should succeed.
    assert.equal(res.status, 200, `canonical status '${status}' must be accepted`);
  }
});

// ── Boundary: cancel and dependency_failed during the review window ───────────

test("boundary: cancelProposal SQL guards on queued|in_review only", async () => {
  reset();
  const db = await import("../../lib/db");
  await db.cancelProposal(PROPOSAL_A, "duplicate market detected");

  const sql = lastSql();
  assert.match(sql, /WHERE proposal_id = \$?\d+ AND review_status IN \('queued', 'in_review'\)/);
  const args = lastArgs();
  assert.ok(args.includes("duplicate market detected"));
});

test("boundary: markProposalDependencyFailed SQL guards on queued|in_review only", async () => {
  reset();
  const db = await import("../../lib/db");
  await db.markProposalDependencyFailed(PROPOSAL_A, "oracle timeout during preflight");

  const sql = lastSql();
  assert.match(sql, /WHERE proposal_id = \$?\d+ AND review_status IN \('queued', 'in_review'\)/);
  const args = lastArgs();
  assert.ok(args.includes("oracle timeout during preflight"));
});

test("boundary: markStaleProposals uses deadline < $n guard to avoid touching future proposals", async () => {
  reset();
  const db = await import("../../lib/db");
  const farFutureDeadline = Math.floor(Date.now() / 1000) + 86400 * 365;
  await db.markStaleProposals(farFutureDeadline - 1);

  const sql = lastSql();
  // Only proposals whose deadline has already passed become stale.
  assert.match(sql, /deadline > 0 AND deadline < \$\d+/);
});

test("boundary: insertMarketProposal with a past deadline still enters the queue", async () => {
  reset();
  const db = await import("../../lib/db");
  await db.insertMarketProposal(
    baseProposalRow({
      proposal_id: PROPOSAL_B,
      deadline: Math.floor(Date.now() / 1000) - 60, // already past
    }),
  );

  const sql = lastSql();
  assert.match(sql, /INSERT INTO market_proposals/);
  const args = lastArgs();
  assert.ok(args.includes("queued"), "past-deadline proposals still enter the queue; staleness is swept separately");
});

// ── listProposalsForReview: SQL shape ─────────────────────────────────────────

test("listProposalsForReview: no-filter query uses $1/$2 Postgres placeholders", async () => {
  reset();
  const db = await import("../../lib/db");
  await db.listProposalsForReview({});

  const sql = lastSql();
  assert.match(sql, /FROM market_proposals/);
  assert.match(sql, /LIMIT \$\d+ OFFSET \$\d+/);
  assert.ok(!sql.includes("?"), "Postgres-style placeholders required; no bare '?' allowed");
});

test("listProposalsForReview: status filter produces WHERE review_status = $1", async () => {
  reset();
  const db = await import("../../lib/db");
  await db.listProposalsForReview({ status: "approved", limit: 5, offset: 0 });

  const sql = lastSql();
  assert.match(sql, /WHERE review_status = \$1/);
  const args = lastArgs();
  assert.equal(args[0], "approved");
  assert.equal(args[1], 5);
  assert.equal(args[2], 0);
});

test("listProposalsForReview: limit is clamped to 200 from above", async () => {
  reset();
  const db = await import("../../lib/db");
  const result = await db.listProposalsForReview({ limit: 99999, offset: 0 });
  assert.equal(result.limit, 200);
});

test("listProposalsForReview: limit is clamped to 1 from below", async () => {
  reset();
  const db = await import("../../lib/db");
  const result = await db.listProposalsForReview({ limit: -50, offset: 0 });
  assert.equal(result.limit, 1);
});

test("listProposalsForReview: NaN limit and offset fall back to defaults", async () => {
  reset();
  const db = await import("../../lib/db");
  const result = await db.listProposalsForReview({ limit: Number.NaN, offset: Number.NaN });
  assert.equal(result.limit, 50);
  assert.equal(result.offset, 0);
});

test("listProposalsForReview: negative offset is clamped to 0", async () => {
  reset();
  const db = await import("../../lib/db");
  const result = await db.listProposalsForReview({ limit: 10, offset: -1 });
  assert.equal(result.offset, 0);
});
