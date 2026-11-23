/**
 * Proposal Review History Tests
 *
 * Covers:
 * - Recording accepted, rejected, superseded, and expired decisions with stable reason codes
 * - Public read endpoint GET /api/proposals/review/history
 * - Redaction of privileged actor credentials (`actorId`) and `privateNote` from public views
 * - Filtering, pagination bounds, and failure/boundary cases
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { NextRequest } from "next/server";

const CRON_SECRET = "test-cron-secret-0123456789abcdef";

interface StoredHistoryRow {
  id: number;
  proposal_id: string;
  decision: string;
  reason_code: string;
  recorded_at: number;
  superseded_by_proposal_id: string | null;
  actor_id: string | null;
  private_note: string | null;
}

const historyRows: StoredHistoryRow[] = [];
let nextId = 1;
let forceDbError = false;

function installFakePool(): void {
  const exec = async (sql: string, args: unknown[] = []) => {
    if (forceDbError) {
      throw new Error("simulated postgres failure: secret-host.internal");
    }

    const trimmed = sql.trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(trimmed)) {
      return { rows: [], rowCount: 0 };
    }

    if (trimmed.startsWith("INSERT INTO proposal_review_history")) {
      const row: StoredHistoryRow = {
        id: nextId++,
        proposal_id: String(args[0]),
        decision: String(args[1]),
        reason_code: String(args[2]),
        recorded_at: Number(args[3]),
        superseded_by_proposal_id: (args[4] as string | null) ?? null,
        actor_id: (args[5] as string | null) ?? null,
        private_note: (args[6] as string | null) ?? null,
      };
      historyRows.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (trimmed.includes("FROM proposal_review_history")) {
      let filtered = [...historyRows];
      let argIndex = 0;

      if (trimmed.includes("proposal_id =")) {
        const val = String(args[argIndex++]);
        filtered = filtered.filter((r) => r.proposal_id === val);
      }
      if (trimmed.includes("decision =")) {
        const val = String(args[argIndex++]);
        filtered = filtered.filter((r) => r.decision === val);
      }
      if (trimmed.includes("reason_code =")) {
        const val = String(args[argIndex++]);
        filtered = filtered.filter((r) => r.reason_code === val);
      }

      const limit = Number(args[argIndex++] ?? 50);
      const offset = Number(args[argIndex++] ?? 0);

      filtered.sort((a, b) => b.recorded_at - a.recorded_at || b.id - a.id);
      const paged = filtered.slice(offset, offset + limit);
      return { rows: paged, rowCount: paged.length };
    }

    return { rows: [], rowCount: 1 };
  };

  const pool = {
    query: (sql: string, args: unknown[] = []) => exec(sql, args),
    connect: async () => ({
      query: (sql: string, args: unknown[] = []) => exec(sql, args),
      release: () => {},
    }),
  };

  process.env.DATABASE_URL = "postgres://fake/mimir";
  process.env.CRON_SECRET = CRON_SECRET;
  const g = globalThis as unknown as Record<string, unknown>;
  g.__mimirDbPool = pool;
  g.__mimirDbReady = Promise.resolve(pool);
}

function reset(): void {
  historyRows.length = 0;
  nextId = 1;
  forceDbError = false;
  process.env.DATABASE_URL = "postgres://fake/mimir";
  process.env.CRON_SECRET = CRON_SECRET;
}

function makeRequest(url: string, method = "GET", body?: unknown, bearer?: string | null): NextRequest {
  const headers = new Headers();
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}

installFakePool();

test("records accepted, rejected, superseded, and expired decisions via POST /api/proposals/review", async () => {
  reset();
  const { POST } = await import("../../app/api/proposals/review/route");

  // 1. accepted
  const acceptedRes = await POST(
    makeRequest(
      "http://localhost/api/proposals/review",
      "POST",
      {
        action: "complete",
        proposalId: "prop-1",
        reviewer: "G_OPERATOR_SECRET_CREDENTIAL",
        approve: true,
        reasonCode: "REVIEW_APPROVED",
        privateNote: "Internal note: verified oracle feed manually",
      },
      CRON_SECRET,
    ),
  );
  assert.equal(acceptedRes.status, 200);
  const acceptedBody = await acceptedRes.json();
  assert.equal(acceptedBody.decision, "accepted");
  assert.equal(acceptedBody.reasonCode, "REVIEW_APPROVED");

  // 2. rejected
  const rejectedRes = await POST(
    makeRequest(
      "http://localhost/api/proposals/review",
      "POST",
      {
        action: "complete",
        proposalId: "prop-2",
        reviewer: "G_OPERATOR_SECRET_CREDENTIAL",
        approve: false,
        reasonCode: "POLICY_VIOLATION",
        privateNote: "Internal note: creator flagged on watchlist",
      },
      CRON_SECRET,
    ),
  );
  assert.equal(rejectedRes.status, 200);
  const rejectedBody = await rejectedRes.json();
  assert.equal(rejectedBody.decision, "rejected");
  assert.equal(rejectedBody.reasonCode, "POLICY_VIOLATION");

  // 3. superseded
  const supersededRes = await POST(
    makeRequest(
      "http://localhost/api/proposals/review",
      "POST",
      {
        action: "supersede",
        proposalId: "prop-3",
        supersededByProposalId: "prop-4",
        reviewer: "G_OPERATOR_SECRET_CREDENTIAL",
        reasonCode: "SUPERSEDED_BY_NEWER_PROPOSAL",
        privateNote: "Internal note: replaced by cleaner wording",
      },
      CRON_SECRET,
    ),
  );
  assert.equal(supersededRes.status, 200);
  const supersededBody = await supersededRes.json();
  assert.equal(supersededBody.decision, "superseded");
  assert.equal(supersededBody.reasonCode, "SUPERSEDED_BY_NEWER_PROPOSAL");
  assert.equal(supersededBody.supersededByProposalId, "prop-4");

  // 4. expired
  const expiredRes = await POST(
    makeRequest(
      "http://localhost/api/proposals/review",
      "POST",
      {
        action: "expire",
        proposalId: "prop-5",
        reviewer: "cron-worker-key-xyz",
        reasonCode: "SIGNED_WINDOW_EXPIRED",
        privateNote: "Internal note: signed window TTL exceeded by 42s",
      },
      CRON_SECRET,
    ),
  );
  assert.equal(expiredRes.status, 200);
  const expiredBody = await expiredRes.json();
  assert.equal(expiredBody.decision, "expired");
  assert.equal(expiredBody.reasonCode, "SIGNED_WINDOW_EXPIRED");

  assert.equal(historyRows.length, 4);
  assert.deepEqual(
    historyRows.map((r) => [r.proposal_id, r.decision, r.reason_code]),
    [
      ["prop-1", "accepted", "REVIEW_APPROVED"],
      ["prop-2", "rejected", "POLICY_VIOLATION"],
      ["prop-3", "superseded", "SUPERSEDED_BY_NEWER_PROPOSAL"],
      ["prop-5", "expired", "SIGNED_WINDOW_EXPIRED"],
    ],
  );
});

test("GET /api/proposals/review/history exposes public history without actor credentials or private notes", async () => {
  reset();
  const db = await import("../../lib/db");
  const { GET } = await import("../../app/api/proposals/review/history/route");

  await db.recordProposalReviewDecision({
    proposalId: "prop-public-1",
    decision: "rejected",
    reasonCode: "INVALID_RESOLUTION_SOURCE",
    recordedAt: 1_700_000_000_000,
    actorId: "S_PRIVILEGED_OPERATOR_SECRET",
    privateNote: "CONFIDENTIAL: internal compliance escalation #991",
  });

  // No Authorization header required for public read view
  const res = await GET(makeRequest("http://localhost/api/proposals/review/history?proposalId=prop-public-1"));
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.history.length, 1);
  const entry = body.history[0] as Record<string, unknown>;
  assert.equal(entry.proposalId, "prop-public-1");
  assert.equal(entry.decision, "rejected");
  assert.equal(entry.reasonCode, "INVALID_RESOLUTION_SOURCE");
  assert.equal(entry.recordedAt, 1_700_000_000_000);
  assert.equal(entry.supersededByProposalId, null);

  // Privileged fields must never be present in the public payload
  assert.equal("actorId" in entry, false);
  assert.equal("privateNote" in entry, false);
  assert.equal("reviewer" in entry, false);

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("S_PRIVILEGED_OPERATOR_SECRET"), false);
  assert.equal(serialized.includes("CONFIDENTIAL"), false);
});

test("GET /api/proposals/review/history supports filtering by decision, reasonCode, and pagination", async () => {
  reset();
  const db = await import("../../lib/db");
  const { GET } = await import("../../app/api/proposals/review/history/route");

  await db.recordProposalReviewDecision({
    proposalId: "p-1",
    decision: "accepted",
    reasonCode: "REVIEW_APPROVED",
    recordedAt: 1_700_000_001_000,
  });
  await db.recordProposalReviewDecision({
    proposalId: "p-2",
    decision: "expired",
    reasonCode: "REVIEW_DEADLINE_EXPIRED",
    recordedAt: 1_700_000_002_000,
  });
  await db.recordProposalReviewDecision({
    proposalId: "p-3",
    decision: "expired",
    reasonCode: "SIGNED_WINDOW_EXPIRED",
    recordedAt: 1_700_000_003_000,
  });

  const byDecision = await GET(makeRequest("http://localhost/api/proposals/review/history?decision=expired&limit=1&offset=0"));
  assert.equal(byDecision.status, 200);
  const byDecisionBody = await byDecision.json();
  assert.equal(byDecisionBody.history.length, 1);
  assert.equal(byDecisionBody.history[0].proposalId, "p-3");
  assert.equal(byDecisionBody.limit, 1);
  assert.equal(byDecisionBody.offset, 0);

  const byReason = await GET(
    makeRequest("http://localhost/api/proposals/review/history?reasonCode=REVIEW_DEADLINE_EXPIRED"),
  );
  assert.equal(byReason.status, 200);
  const byReasonBody = await byReason.json();
  assert.equal(byReasonBody.history.length, 1);
  assert.equal(byReasonBody.history[0].proposalId, "p-2");
});

test("rejects invalid decision and reasonCode parameters with 400", async () => {
  reset();
  const { GET } = await import("../../app/api/proposals/review/history/route");
  const { POST } = await import("../../app/api/proposals/review/route");

  const badDecision = await GET(makeRequest("http://localhost/api/proposals/review/history?decision=bogus"));
  assert.equal(badDecision.status, 400);

  const badReason = await GET(makeRequest("http://localhost/api/proposals/review/history?reasonCode=NOT_A_CODE"));
  assert.equal(badReason.status, 400);

  const badPostReason = await POST(
    makeRequest(
      "http://localhost/api/proposals/review",
      "POST",
      {
        action: "complete",
        proposalId: "prop-1",
        reviewer: "r1",
        approve: true,
        reasonCode: "UNSTABLE_FREEFORM_REASON",
      },
      CRON_SECRET,
    ),
  );
  assert.equal(badPostReason.status, 400);
});

test("handles DB errors without leaking internal details and returns 503 when unconfigured", async () => {
  reset();
  const { GET } = await import("../../app/api/proposals/review/history/route");

  forceDbError = true;
  const errRes = await GET(makeRequest("http://localhost/api/proposals/review/history"));
  assert.equal(errRes.status, 500);
  const errText = await errRes.text();
  assert.equal(errText.includes("secret-host.internal"), false);

  forceDbError = false;
  delete process.env.DATABASE_URL;
  const unconfiguredRes = await GET(makeRequest("http://localhost/api/proposals/review/history"));
  assert.equal(unconfiguredRes.status, 503);
});
