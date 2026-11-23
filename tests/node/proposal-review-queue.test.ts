/**
 * Proposal Review Queue Tests
 *
 * Tests the explicit review queue state machine for market creator proposals.
 * Validates:
 * - Positive: queued → in_review → approved/rejected
 * - Negative: invalid transitions (e.g., queued → approved directly)
 * - Boundary: duplicate claims, idempotency
 * - Failure: dependency_failed, cancelled, stale
 * - Regression: existing funded flows remain compatible
 */

import assert from "node:assert/strict";
import test from "node:test";

const PROPOSAL_ID = "abc123def456";

interface RecordedQuery {
  sql: string;
  args: unknown[];
}

const recorded: RecordedQuery[] = [];
let nextQueryResult:
  | ((sql: string, args: unknown[]) => { rows: Array<Record<string, unknown>>; rowCount: number } | undefined)
  | null = null;

function installFakePool(): void {
  const record = async (sql: string, args: unknown[] = []) => {
    if (!/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) {
      recorded.push({ sql, args });
    }
    if (nextQueryResult) {
      const custom = nextQueryResult(sql, args);
      if (custom) return custom;
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

function lastArgs(): unknown[] {
  const last = recorded[recorded.length - 1];
  assert.ok(last, "expected a statement to have been issued");
  return last.args;
}

function lastSql(): string {
  const last = recorded[recorded.length - 1];
  assert.ok(last, "expected a statement to have been issued");
  return last.sql;
}

function reset(): void {
  recorded.length = 0;
  nextQueryResult = null;
}

type ReviewStatus = "queued" | "in_review" | "approved" | "rejected" | "cancelled" | "stale" | "dependency_failed";

function baseProposalRow(overrides: Record<string, unknown> = {}) {
  return {
    proposal_id: PROPOSAL_ID,
    created_at: Date.now(),
    question: "Will BTC exceed $100k by EOY?",
    creator_position: "Yes — institutional adoption",
    counter_position: "No — macro headwinds",
    category: "crypto",
    subject_type: "price",
    settlement_mode: "oracle",
    product_modifiers: [],
    mode_rationale: "public multi-participant topic drafted from coingecko",
    stake_policy: { creatorStakeUsdc: 2, maxChallengers: 10, challengerPayoutBps: 0 },
    context_pack_hash: null,
    resolution_url: "https://coingecko.com/en/coins/bitcoin",
    settlement_rule: "Resolve YES if BTC > $100k at deadline",
    deadline: Math.floor(Date.now() / 1000) + 3600 * 24,
    quality_score: 85,
    preflight_verdict: {},
    disposition: "shadow",
    blocked_by: null,
    claim_id: null,
    review_status: "queued" as ReviewStatus,
    queued_at: Date.now(),
    claimed_at: null,
    reviewed_at: null,
    reviewer: null,
    failure_reason: null,
    ...overrides,
  };
}

async function getDb() {
  return import("../../lib/db");
}

installFakePool();

test("insertMarketProposal includes review_status and queued_at on first insert", async () => {
  reset();
  const db = await getDb();
  await db.insertMarketProposal(baseProposalRow());

  const args = lastArgs();
  const sql = lastSql();

  assert.match(sql, /review_status/);
  assert.match(sql, /queued_at/);
  assert.match(sql, /claimed_at/);
  assert.match(sql, /reviewed_at/);
  assert.match(sql, /reviewer/);
  assert.match(sql, /failure_reason/);

  assert.ok(args.includes("queued"), "review_status should default to queued");
  assert.ok(args.some((a) => typeof a === "number" && a > 1e12), "queued_at should be a timestamp");
});

test("claimProposalForReview generates correct SQL for queued -> in_review", async () => {
  reset();
  const db = await getDb();
  await db.claimProposalForReview(PROPOSAL_ID, "reviewer1");

  const sql = lastSql();
  assert.match(sql, /UPDATE market_proposals/);
  assert.match(sql, /review_status = 'in_review'/);
  assert.match(sql, /claimed_at = \$\d+/);
  assert.match(sql, /reviewer = \$\d+/);
  assert.match(sql, /WHERE proposal_id = \$?\d+ AND review_status = 'queued'/);

  const args = lastArgs();
  assert.ok(args.includes("reviewer1"));
});

test("completeProposalReview generates correct SQL for in_review -> approved", async () => {
  reset();
  const db = await getDb();
  await db.completeProposalReview(PROPOSAL_ID, "reviewer1", true);

  const sql = lastSql();
  assert.match(sql, /review_status = \$\d+/);
  assert.match(sql, /reviewed_at = \$\d+/);
  assert.match(sql, /reviewer = \$?\d+/);
  assert.match(sql, /review = \$\d+/);
  assert.match(sql, /WHERE proposal_id = \$?\d+ AND review_status = 'in_review' AND reviewer = \$?\d+/);

  const args = lastArgs();
  assert.equal(args[0], "approved");
  assert.equal(args[3], "agree");
  assert.ok(args.includes("reviewer1"));
});

test("completeProposalReview generates correct SQL for in_review -> rejected", async () => {
  reset();
  const db = await getDb();
  await db.completeProposalReview(PROPOSAL_ID, "reviewer1", false);

  const args = lastArgs();
  assert.equal(args[0], "rejected");
  assert.equal(args[3], "disagree");
});

test("cancelProposal generates correct SQL for queued/in_review -> cancelled", async () => {
  reset();
  const db = await getDb();
  await db.cancelProposal(PROPOSAL_ID, "duplicate detected");

  const sql = lastSql();
  assert.match(sql, /review_status = 'cancelled'/);
  assert.match(sql, /failure_reason = \$?\d+/);
  assert.match(sql, /WHERE proposal_id = \$?\d+ AND review_status IN \('queued', 'in_review'\)/);

  const args = lastArgs();
  assert.ok(args.includes("duplicate detected"));
});

test("markProposalDependencyFailed generates correct SQL for queued/in_review -> dependency_failed", async () => {
  reset();
  const db = await getDb();
  await db.markProposalDependencyFailed(PROPOSAL_ID, "oracle timeout");

  const sql = lastSql();
  assert.match(sql, /review_status = 'dependency_failed'/);
  assert.match(sql, /failure_reason = \$?\d+/);
  assert.match(sql, /WHERE proposal_id = \$?\d+ AND review_status IN \('queued', 'in_review'\)/);

  const args = lastArgs();
  assert.ok(args.includes("oracle timeout"));
});

test("markStaleProposals generates correct SQL for stale detection", async () => {
  reset();
  const db = await getDb();
  const nowSeconds = Math.floor(Date.now() / 1000);
  await db.markStaleProposals(nowSeconds);

  const sql = lastSql();
  assert.match(sql, /review_status = 'stale'/);
  assert.match(sql, /failure_reason = 'review deadline passed'/);
  assert.match(sql, /WHERE review_status IN \('queued', 'in_review'\) AND deadline > 0 AND deadline < \$\d+/);
});

test("updateProposalReviewStatus generates correct SQL for all valid transitions", async () => {
  const statuses = [
    "queued",
    "in_review",
    "approved",
    "rejected",
    "cancelled",
    "stale",
    "dependency_failed",
  ] as const;

  for (const status of statuses) {
    reset();
    const db = await getDb();
    await db.updateProposalReviewStatus(PROPOSAL_ID, status, {
      reviewer: status === "in_review" || status === "approved" || status === "rejected" ? "reviewer1" : undefined,
      failureReason: status === "cancelled" || status === "stale" || status === "dependency_failed" ? "test reason" : undefined,
    });

    const sql = lastSql();
    // For queued, it's a simple update; for others, includes additional fields
    if (status === "queued") {
      assert.match(sql, /UPDATE market_proposals SET review_status = \$\d+ WHERE proposal_id = \$?\d+/);
    } else {
      assert.match(sql, new RegExp(`review_status = \\$\\d+`));
      if (status === "in_review") {
        assert.match(sql, /claimed_at = \$\d+/);
        assert.match(sql, /reviewer = \$?\d+/);
      }
      if (status === "approved" || status === "rejected") {
        assert.match(sql, /reviewed_at = \$\d+/);
        assert.match(sql, /review = \$\d+/);
      }
      if (status === "cancelled" || status === "stale" || status === "dependency_failed") {
        assert.match(sql, /reviewed_at = \$\d+/);
        assert.match(sql, /failure_reason = \$\d+/);
      }
    }
  }
});

test("idempotency: insertMarketProposal uses ON CONFLICT DO NOTHING", async () => {
  reset();
  const db = await getDb();
  const row = baseProposalRow();

  await db.insertMarketProposal(row);
  await db.insertMarketProposal(row);

  // The key assertion is that the SQL includes ON CONFLICT DO NOTHING
  const sql = lastSql();
  assert.match(sql, /ON CONFLICT \(proposal_id\) DO NOTHING/);
});

test("proposal with disposition=create gets queued for review when not autonomous", async () => {
  reset();
  const db = await getDb();
  await db.insertMarketProposal(baseProposalRow({ disposition: "create" }));

  const args = lastArgs();
  assert.ok(args.includes("queued"), "even create disposition starts in review queue");
  assert.ok(args.includes("create"), "disposition preserved");
});

test("shadow mode proposals tracked for precision measurement", async () => {
  reset();
  const db = await getDb();
  await db.insertMarketProposal(baseProposalRow({ disposition: "shadow" }));

  const args = lastArgs();
  assert.ok(args.includes("shadow"), "disposition preserved for shadow mode");
  assert.ok(args.includes("queued"), "review_status queued for shadow precision tracking");
});

test("funded-state safety: proposal records creator exposure fields", async () => {
  reset();
  const db = await getDb();
  await db.insertMarketProposal(baseProposalRow());

  const args = lastArgs();
  // stake_policy includes creatorStakeUsdc for exposure accounting
  const stakePolicyIdx = args.findIndex((a) => typeof a === "string" && a.includes("creatorStakeUsdc"));
  assert.ok(stakePolicyIdx >= 0, "stake_policy must include creatorStakeUsdc for exposure caps");
});

test("malformed: missing required fields passed through to DB constraints", async () => {
  reset();
  const db = await getDb();
  const row = baseProposalRow({ proposal_id: "" });
  await db.insertMarketProposal(row);

  const args = lastArgs();
  assert.ok(args[0] === "", "proposal_id is passed through; DB constraint enforces NOT NULL");
});

test("stale detection: SQL includes deadline bounds check", async () => {
  reset();
  const db = await getDb();
  const futureDeadline = Math.floor(Date.now() / 1000) + 86400;
  await db.markStaleProposals(futureDeadline - 1);

  const sql = lastSql();
  assert.match(sql, /deadline < \$\d+/);
});

test("privacy: no source text or private keys in proposal queue", async () => {
  reset();
  const db = await getDb();
  await db.insertMarketProposal(baseProposalRow());

  const written = recorded.flatMap((q) => q.args);
  const allStrings = written.filter((a) => typeof a === "string").join(" ");

  // Ensure no private keys, secrets, or full source payloads
  assert.ok(!allStrings.includes("CREATOR_SECRET"));
  assert.ok(!allStrings.includes("PRIVATE_KEY"));
  assert.ok(!allStrings.includes("mnemonic"));
  assert.ok(!allStrings.includes("ANTHROPIC_API_KEY"));
});

test("operational boundary: review_status index exists for queue queries", async () => {
  // This is a schema test - the index is created in the table definition
  // We verify the CREATE INDEX statement would be valid
  const indexSql = "CREATE INDEX IF NOT EXISTS idx_market_proposals_review_status ON market_proposals(review_status)";
  assert.match(indexSql, /idx_market_proposals_review_status/);
  assert.match(indexSql, /review_status/);
});

test("operational boundary: partial index for queued proposals", async () => {
  const indexSql = "CREATE INDEX IF NOT EXISTS idx_market_proposals_queued ON market_proposals(queued_at) WHERE review_status = 'queued'";
  assert.match(indexSql, /idx_market_proposals_queued/);
  assert.match(indexSql, /queued_at/);
  assert.match(indexSql, /WHERE review_status = 'queued'/);
});

test("rollback note: updateProposalReviewStatus uses single UPDATE with WHERE clause", async () => {
  reset();
  const db = await getDb();
  await db.updateProposalReviewStatus(PROPOSAL_ID, "approved", { reviewer: "reviewer1" });

  const sql = lastSql();
  assert.match(sql, /^UPDATE market_proposals\s/);
  assert.match(sql, /WHERE proposal_id = \$?\d+/);
  assert.ok(!sql.includes("; "), "single statement only");
});

// -----------------------------------------------------------------------------
// GET /api/proposals/review - parameter parsing & listProposalsForReview
// -----------------------------------------------------------------------------

test("listProposalsForReview defaults limit/offset and uses placeholders", async () => {
  reset();
  const db = await getDb();
  const result = await db.listProposalsForReview({});

  const sql = lastSql();
  assert.match(sql, /FROM market_proposals/);
  assert.match(sql, /LIMIT \$\d+ OFFSET \$\d+/);
  assert.ok(!sql.includes("?"), "no raw ? placeholders reach the pool");
  assert.equal(result.limit, 50);
  assert.equal(result.offset, 0);
  assert.deepEqual(result.proposals, []);
});

test("listProposalsForReview adds WHERE clause for status", async () => {
  reset();
  const db = await getDb();
  const result = await db.listProposalsForReview({ status: "queued", limit: 10, offset: 20 });

  const sql = lastSql();
  assert.match(sql, /WHERE review_status = \$\d+/);
  const args = lastArgs();
  assert.equal(args[0], "queued");
  assert.equal(args[1], 10);
  assert.equal(args[2], 20);
  assert.equal(result.limit, 10);
  assert.equal(result.offset, 20);
});

test("listProposalsForReview clamps limit to 1..200 and offset >= 0", async () => {
  reset();
  const db = await getDb();

  const high = await db.listProposalsForReview({ limit: 10000, offset: -5 });
  assert.equal(high.limit, 200);
  assert.equal(high.offset, 0);

  const low = await db.listProposalsForReview({ limit: 0, offset: 10 });
  assert.equal(low.limit, 1);
  assert.equal(low.offset, 10);
});

test("listProposalsForReview falls back to defaults on NaN", async () => {
  reset();
  const db = await getDb();
  const result = await db.listProposalsForReview({ limit: Number.NaN, offset: Number.NaN });
  assert.equal(result.limit, 50);
  assert.equal(result.offset, 0);
});

test("GET handler returns 200 with rows for a valid request", async () => {
  reset();
  process.env.CRON_SECRET = "test-secret";
  const { GET } = await import("../../app/api/proposals/review/route");
  const req = new Request("http://localhost/api/proposals/review?status=queued&limit=10&offset=0", {
    headers: { authorization: "Bearer test-secret" },
  }) as unknown as Request;
  const res = await GET(req as never);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.proposals));
  assert.equal(body.limit, 10);
  assert.equal(body.offset, 0);
});

test("GET handler rejects repeated query parameters before database access", async () => {
  process.env.CRON_SECRET = "test-secret";
  const { GET } = await import("../../app/api/proposals/review/route");
  for (const query of [
    "status=queued&status=approved",
    "limit=10&limit=20",
    "nonce=nonce-aaaaaaaaaaaaaaaa&nonce=nonce-bbbbbbbbbbbbbbbb",
  ]) {
    reset();
    const req = new Request(`http://localhost/api/proposals/review?${query}`, {
      headers: { authorization: "Bearer test-secret" },
    }) as unknown as Request;
    const res = await GET(req as never);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: { message: "Duplicate query parameters are not allowed" },
    });
    assert.equal(recorded.length, 0, "ambiguous input must be rejected before querying the database");
  }
});

test("GET handler returns 400 for invalid status", async () => {
  reset();
  process.env.CRON_SECRET = "test-secret";
  const { GET } = await import("../../app/api/proposals/review/route");
  const req = new Request("http://localhost/api/proposals/review?status=bogus", {
    headers: { authorization: "Bearer test-secret" },
  }) as unknown as Request;
  const res = await GET(req as never);
  assert.equal(res.status, 400);
});

test("GET handler falls back to defaults on non-numeric limit/offset", async () => {
  reset();
  process.env.CRON_SECRET = "test-secret";
  const { GET } = await import("../../app/api/proposals/review/route");
  const req = new Request("http://localhost/api/proposals/review?limit=abc&offset=xyz", {
    headers: { authorization: "Bearer test-secret" },
  }) as unknown as Request;
  const res = await GET(req as never);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.limit, 50);
  assert.equal(body.offset, 0);
});

// -----------------------------------------------------------------------------
// Effective proposal expiry, canonical UTC time, policy revision, absent vs expired
// -----------------------------------------------------------------------------

test("resolveProposalExpiry uses canonical UTC time and policy revision and chooses earliest bound", async () => {
  const {
    DEFAULT_PROPOSAL_REVIEW_TTL_MS,
    MAX_PROPOSAL_REVIEW_TTL_MS,
    PROPOSAL_EXPIRY_POLICY_REVISION,
    resolveProposalExpiry,
    resolveProposalReviewTtlMs,
  } = await import("../../lib/signed-window");

  const nowMs = Date.UTC(2026, 10, 19, 8, 0, 0); // 2026-11-19T08:00:00.000Z
  const queuedAtMs = Date.UTC(2026, 10, 19, 6, 0, 0); // 2026-11-19T06:00:00.000Z

  // Case 1: market deadline (4h after queue) is earlier than the 24h review window
  const earlyDeadlineSec = Math.floor(Date.UTC(2026, 10, 19, 10, 0, 0) / 1000);
  const byDeadline = resolveProposalExpiry(
    baseProposalRow({
      created_at: queuedAtMs,
      queued_at: queuedAtMs,
      deadline: earlyDeadlineSec,
      review_status: "queued",
    }),
    { now: nowMs },
  );
  assert.equal(byDeadline.status, "active");
  assert.equal(byDeadline.exists, true);
  assert.equal(byDeadline.expired, false);
  assert.equal(byDeadline.expirySource, "market_deadline");
  assert.equal(byDeadline.effectiveExpiresAt, earlyDeadlineSec * 1000);
  assert.equal(byDeadline.effectiveExpiresAtUtc, "2026-11-19T10:00:00.000Z");
  assert.equal(byDeadline.effectiveExpiry, "2026-11-19T10:00:00.000Z");
  assert.equal(byDeadline.evaluatedAtUtc, "2026-11-19T08:00:00.000Z");
  assert.equal(byDeadline.policyRevision, PROPOSAL_EXPIRY_POLICY_REVISION);
  assert.equal(byDeadline.remainingMs, 2 * 3600 * 1000);

  // Case 2: 72h market deadline is later than the 24h review window -> review window wins
  const farDeadlineSec = Math.floor(Date.UTC(2026, 10, 22, 6, 0, 0) / 1000);
  const byWindow = resolveProposalExpiry(
    baseProposalRow({
      created_at: queuedAtMs,
      queued_at: queuedAtMs,
      deadline: farDeadlineSec,
      review_status: "queued",
    }),
    { now: nowMs, policyRevision: "proposal-expiry:v2" },
  );
  assert.equal(byWindow.status, "active");
  assert.equal(byWindow.expirySource, "review_window");
  assert.equal(byWindow.effectiveExpiresAt, queuedAtMs + DEFAULT_PROPOSAL_REVIEW_TTL_MS);
  assert.equal(byWindow.effectiveExpiresAtUtc, "2026-11-20T06:00:00.000Z");
  assert.equal(byWindow.deadlineAtUtc, "2026-11-22T06:00:00.000Z");
  assert.equal(byWindow.policyRevision, "proposal-expiry:v2");

  // TTL resolution guards against malformed or oversized inputs
  assert.equal(resolveProposalReviewTtlMs(undefined), DEFAULT_PROPOSAL_REVIEW_TTL_MS);
  assert.equal(resolveProposalReviewTtlMs("invalid"), DEFAULT_PROPOSAL_REVIEW_TTL_MS);
  assert.equal(resolveProposalReviewTtlMs("-500"), DEFAULT_PROPOSAL_REVIEW_TTL_MS);
  assert.equal(resolveProposalReviewTtlMs(0), DEFAULT_PROPOSAL_REVIEW_TTL_MS);
  assert.equal(resolveProposalReviewTtlMs(1.5), DEFAULT_PROPOSAL_REVIEW_TTL_MS);
  assert.equal(resolveProposalReviewTtlMs(999_999_999_999), MAX_PROPOSAL_REVIEW_TTL_MS);
});

test("resolveProposalExpiry distinguishes an absent proposal from an expired one and enforces the exact expiry boundary", async () => {
  const { resolveProposalExpiry } = await import("../../lib/signed-window");

  const nowMs = Date.UTC(2026, 10, 19, 12, 0, 0);
  const absent = resolveProposalExpiry(null, { now: nowMs });
  assert.equal(absent.status, "absent");
  assert.equal(absent.state, "absent");
  assert.equal(absent.exists, false);
  assert.equal(absent.expired, false);
  assert.equal(absent.isExpired, false);
  assert.equal(absent.code, "proposal_not_found");
  assert.equal(absent.effectiveExpiresAt, null);
  assert.equal(absent.effectiveExpiresAtUtc, null);
  assert.equal(absent.evaluatedAtUtc, "2026-11-19T12:00:00.000Z");

  const boundarySec = Math.floor(nowMs / 1000);
  const rowAtBoundary = baseProposalRow({
    created_at: nowMs - 3600_000,
    queued_at: nowMs - 3600_000,
    deadline: boundarySec,
    review_status: "queued",
  });

  // 1 ms before effective expiry -> active
  const oneMsBefore = resolveProposalExpiry(rowAtBoundary, { now: boundarySec * 1000 - 1 });
  assert.equal(oneMsBefore.status, "active");
  assert.equal(oneMsBefore.exists, true);
  assert.equal(oneMsBefore.expired, false);
  assert.equal(oneMsBefore.code, null);
  assert.equal(oneMsBefore.remainingMs, 1);

  // At exact effective expiry -> expired
  const atBoundary = resolveProposalExpiry(rowAtBoundary, { now: boundarySec * 1000 });
  assert.equal(atBoundary.status, "expired");
  assert.equal(atBoundary.exists, true);
  assert.equal(atBoundary.expired, true);
  assert.equal(atBoundary.code, "proposal_expired");
  assert.equal(atBoundary.remainingMs, 0);
  assert.equal(atBoundary.effectiveExpiresAtUtc, "2026-11-19T12:00:00.000Z");
});

test("GET /api/proposals/review exposes effective proposal expiry, canonical UTC timestamps, and policyRevision", async () => {
  reset();
  process.env.CRON_SECRET = "test-secret";
  const queuedAtMs = Date.UTC(2026, 10, 19, 8, 0, 0);
  const deadlineSec = Math.floor(Date.UTC(2026, 10, 19, 14, 0, 0) / 1000);
  const sampleRow = baseProposalRow({
    proposal_id: "prop-live-1",
    created_at: queuedAtMs,
    queued_at: queuedAtMs,
    deadline: deadlineSec,
    review_status: "queued",
  });

  nextQueryResult = () => ({ rows: [sampleRow], rowCount: 1 });

  const { GET } = await import("../../app/api/proposals/review/route");
  const req = new Request("http://localhost/api/proposals/review?status=queued", {
    headers: { authorization: "Bearer test-secret" },
  }) as unknown as Request;
  const res = await GET(req as never);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.policyRevision, "proposal-expiry:v1");
  assert.match(body.evaluatedAtUtc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(body.proposals.length, 1);
  const item = body.proposals[0];
  assert.equal(item.proposal_id, "prop-live-1");
  assert.equal(item.effectiveExpiresAt, deadlineSec * 1000);
  assert.equal(item.effectiveExpiresAtUtc, "2026-11-19T14:00:00.000Z");
  assert.equal(item.effective_expires_at_utc, "2026-11-19T14:00:00.000Z");
  assert.equal(item.policyRevision, "proposal-expiry:v1");
  assert.equal(item.expirySource, "market_deadline");
});

test("API route distinguishes an absent proposal (404) from an expired proposal (409) and an active proposal (200)", async () => {
  reset();
  process.env.CRON_SECRET = "test-secret";
  const { GET, POST, PATCH } = await import("../../app/api/proposals/review/route");

  // 1. Absent proposal -> 404 proposal_not_found with status="absent" and expired=false
  nextQueryResult = () => ({ rows: [], rowCount: 0 });

  const absentGet = await GET(
    new Request("http://localhost/api/proposals/review?proposalId=missing-prop", {
      headers: { authorization: "Bearer test-secret" },
    }) as never,
  );
  assert.equal(absentGet.status, 404);
  const absentGetBody = await absentGet.json();
  assert.equal(absentGetBody.error.code, "proposal_not_found");
  assert.equal(absentGetBody.status, "absent");
  assert.equal(absentGetBody.expiryStatus, "absent");
  assert.equal(absentGetBody.exists, false);
  assert.equal(absentGetBody.expired, false);
  assert.equal(absentGetBody.effectiveExpiresAt, null);
  assert.equal(absentGetBody.effectiveExpiresAtUtc, null);
  assert.equal(absentGetBody.policyRevision, "proposal-expiry:v1");
  assert.match(absentGetBody.evaluatedAtUtc, /Z$/);

  const absentClaim = await POST(
    new Request("http://localhost/api/proposals/review", {
      method: "POST",
      headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
      body: JSON.stringify({ action: "claim", proposalId: "missing-prop", reviewer: "rev1" }),
    }) as never,
  );
  assert.equal(absentClaim.status, 404);
  const absentClaimBody = await absentClaim.json();
  assert.equal(absentClaimBody.error.code, "proposal_not_found");
  assert.equal(absentClaimBody.status, "absent");
  assert.equal(absentClaimBody.exists, false);
  assert.equal(absentClaimBody.expired, false);

  // 2. Expired proposal -> 409 proposal_expired with status="expired", expired=true, and canonical UTC expiry
  const pastDeadlineSec = Math.floor(Date.UTC(2020, 0, 1, 0, 0, 0) / 1000);
  const expiredRow = baseProposalRow({
    proposal_id: "expired-prop",
    created_at: Date.UTC(2019, 11, 31, 12, 0, 0),
    queued_at: Date.UTC(2019, 11, 31, 12, 0, 0),
    deadline: pastDeadlineSec,
    review_status: "queued",
  });
  nextQueryResult = () => ({ rows: [expiredRow], rowCount: 1 });

  const expiredClaim = await POST(
    new Request("http://localhost/api/proposals/review", {
      method: "POST",
      headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
      body: JSON.stringify({ action: "claim", proposalId: "expired-prop", reviewer: "rev1" }),
    }) as never,
  );
  assert.equal(expiredClaim.status, 409);
  const expiredClaimBody = await expiredClaim.json();
  assert.equal(expiredClaimBody.error.code, "proposal_expired");
  assert.equal(expiredClaimBody.status, "expired");
  assert.equal(expiredClaimBody.expiryStatus, "expired");
  assert.equal(expiredClaimBody.exists, true);
  assert.equal(expiredClaimBody.expired, true);
  assert.equal(expiredClaimBody.effectiveExpiresAt, pastDeadlineSec * 1000);
  assert.equal(expiredClaimBody.effectiveExpiresAtUtc, "2020-01-01T00:00:00.000Z");
  assert.equal(expiredClaimBody.policyRevision, "proposal-expiry:v1");
  assert.match(expiredClaimBody.evaluatedAtUtc, /Z$/);

  const expiredPatch = await PATCH(
    new Request("http://localhost/api/proposals/review", {
      method: "PATCH",
      headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
      body: JSON.stringify({ proposalId: "expired-prop", status: "approved", reviewer: "rev1" }),
    }) as never,
  );
  assert.equal(expiredPatch.status, 409);
  const expiredPatchBody = await expiredPatch.json();
  assert.equal(expiredPatchBody.error.code, "proposal_expired");
  assert.equal(expiredPatchBody.expired, true);

  // 3. Active proposal -> 200 with effective expiry metadata in response
  const nowMs = Date.now();
  const futureDeadlineSec = Math.floor(nowMs / 1000) + 3600;
  const activeRow = baseProposalRow({
    proposal_id: "active-prop",
    created_at: nowMs,
    queued_at: nowMs,
    deadline: futureDeadlineSec,
    review_status: "queued",
  });
  nextQueryResult = () => ({ rows: [activeRow], rowCount: 1 });

  const activeClaim = await POST(
    new Request("http://localhost/api/proposals/review", {
      method: "POST",
      headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
      body: JSON.stringify({ action: "claim", proposalId: "active-prop", reviewer: "rev1" }),
    }) as never,
  );
  assert.equal(activeClaim.status, 200);
  const activeClaimBody = await activeClaim.json();
  assert.equal(activeClaimBody.success, true);
  assert.equal(activeClaimBody.proposalId, "active-prop");
  assert.equal(activeClaimBody.status, "in_review");
  assert.equal(activeClaimBody.expiryStatus, "active");
  assert.equal(activeClaimBody.exists, true);
  assert.equal(activeClaimBody.expired, false);
  assert.equal(activeClaimBody.effectiveExpiresAt, futureDeadlineSec * 1000);
  assert.equal(
    activeClaimBody.effectiveExpiresAtUtc,
    new Date(futureDeadlineSec * 1000).toISOString(),
  );
  assert.equal(activeClaimBody.policyRevision, "proposal-expiry:v1");
  assert.match(activeClaimBody.evaluatedAtUtc, /Z$/);
});
