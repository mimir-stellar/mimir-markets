/**
 * Proposal review revision & stale conflict tests.
 *
 * Validates:
 * 1. Optimistic concurrency control using `expectedRevision`.
 * 2. Return of typed conflict (HTTP 409, code: "conflict", field: "expectedRevision")
 *    when a review request carries a stale revision.
 * 3. Invariant: a newer review decision in the database remains unchanged when a
 *    stale revision conflict occurs.
 * 4. Boundary cases: invalid/negative expectedRevision, non-existent proposal,
 *    and expired signed request windows.
 * 5. Backward compatibility: requests without expectedRevision remain supported.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { NextRequest } from "next/server";

import {
  validateSignedWindow,
  validateReviewRevision,
  SIGNED_ACTION_MAX_TTL_MS,
} from "../../lib/signed-window";
import { getProposalRevision } from "../../app/api/proposals/review/route";
import type { MarketProposalRow } from "../../lib/db";

const CRON_SECRET = "test-cron-secret-32-chars-long-abc";
process.env.CRON_SECRET = CRON_SECRET;
process.env.DATABASE_URL = "postgres://fake/mimir";

// ─────────────────────────────────────────────────────────────────────────────
// In-Memory Database Fixture
// ─────────────────────────────────────────────────────────────────────────────

interface RecordedQuery {
  sql: string;
  args: unknown[];
}

const recorded: RecordedQuery[] = [];
const proposalsTable = new Map<string, MarketProposalRow>();

function installMockPool(): void {
  const query = async (sql: string, args: unknown[] = []) => {
    recorded.push({ sql, args });

    // SELECT by proposal_id
    if (/SELECT \* FROM market_proposals WHERE proposal_id =/i.test(sql)) {
      const id = String(args[0]);
      const found = proposalsTable.get(id);
      return { rows: found ? [{ ...found }] : [], rowCount: found ? 1 : 0 };
    }

    // SELECT all / list
    if (/SELECT \* FROM market_proposals/i.test(sql)) {
      const rows = Array.from(proposalsTable.values()).map((r) => ({ ...r }));
      return { rows, rowCount: rows.length };
    }

    // UPDATE completeProposalReview
    if (/UPDATE market_proposals\s+SET review_status = \$\d+, reviewed_at = \$\d+, reviewer = \$\d+, review = \$\d+\s+WHERE proposal_id = \$\d+ AND review_status = 'in_review' AND reviewer = \$\d+/i.test(sql)) {
      const [newStatus, reviewedAt, reviewer, reviewVal, proposalId, expectedReviewer] = args;
      const target = proposalsTable.get(String(proposalId));
      if (target && target.review_status === "in_review" && target.reviewer === expectedReviewer) {
        target.review_status = newStatus as MarketProposalRow["review_status"];
        target.reviewed_at = Number(reviewedAt);
        target.reviewer = String(reviewer);
        (target as unknown as Record<string, unknown>).review = reviewVal;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // UPDATE claimProposalForReview
    if (/UPDATE market_proposals\s+SET review_status = 'in_review', claimed_at = \$\d+, reviewer = \$\d+\s+WHERE proposal_id = \$\d+ AND review_status = 'queued'/i.test(sql)) {
      const [claimedAt, reviewer, proposalId] = args;
      const target = proposalsTable.get(String(proposalId));
      if (target && target.review_status === "queued") {
        target.review_status = "in_review";
        target.claimed_at = Number(claimedAt);
        target.reviewer = String(reviewer);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // UPDATE general status update
    if (/UPDATE market_proposals SET/i.test(sql)) {
      const proposalId = String(args[args.length - 1]);
      const target = proposalsTable.get(proposalId);
      if (target) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    return { rows: [], rowCount: 1 };
  };

  const pool = {
    query,
    connect: async () => ({
      query,
      release: () => {},
    }),
  };

  const g = globalThis as unknown as Record<string, unknown>;
  g.__mimirDbPool = pool;
  g.__mimirDbReady = Promise.resolve(pool);
}

installMockPool();

import { POST, PATCH } from "../../app/api/proposals/review/route";

function makeRequest(method: string, body?: unknown, secret = CRON_SECRET): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) {
    headers.authorization = `Bearer ${secret}`;
  }
  return new Request("http://localhost/api/proposals/review", {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as NextRequest;
}

function createProposalFixture(overrides: Partial<MarketProposalRow> = {}): MarketProposalRow {
  return {
    proposal_id: "prop-100",
    created_at: 1_700_000_000_000,
    question: "Will Stellar exceed 10M accounts by year end?",
    creator_position: "Yes",
    counter_position: "No",
    category: "crypto",
    subject_type: "metric",
    settlement_mode: "oracle",
    product_modifiers: [],
    mode_rationale: "Public dashboard metric",
    stake_policy: {},
    context_pack_hash: null,
    resolution_url: "https://stellar.expert",
    settlement_rule: "Official ledger accounts > 10M",
    deadline: 1_800_000_000,
    quality_score: 90,
    preflight_verdict: {},
    disposition: "create",
    blocked_by: null,
    claim_id: null,
    review_status: "in_review",
    queued_at: 1_700_000_000_000,
    claimed_at: 1_700_000_001_000,
    reviewed_at: null,
    reviewer: "reviewer-alpha",
    failure_reason: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests: validateReviewRevision & validateSignedWindow
// ─────────────────────────────────────────────────────────────────────────────

test("validateReviewRevision: succeeds on matching or higher expected revision", () => {
  assert.deepEqual(validateReviewRevision(0, 0), { ok: true, expectedRevision: 0 });
  assert.deepEqual(validateReviewRevision(1, 1), { ok: true, expectedRevision: 1 });
  assert.deepEqual(validateReviewRevision(undefined, 0), { ok: true });
});

test("validateReviewRevision: returns typed conflict when revision is stale", () => {
  const result = validateReviewRevision(0, 1);
  assert.ok(!result.ok);
  assert.equal(result.code, "conflict");
  assert.equal(result.field, "expectedRevision");
  assert.match(result.message, /stale/);
});

test("validateReviewRevision: rejects invalid expectedRevision shapes", () => {
  const neg = validateReviewRevision(-1, 0);
  assert.ok(!neg.ok);
  assert.equal(neg.code, "invalid_request");
  assert.equal(neg.field, "expectedRevision");

  const str = validateReviewRevision("1", 0);
  assert.ok(!str.ok);

  const float = validateReviewRevision(1.5, 0);
  assert.ok(!float.ok);
});

test("validateSignedWindow: integrates expectedRevision validation", () => {
  const now = 1_700_000_000_000;
  const nonce = "valid_nonce_1234567890";
  const expiresAt = now + 60_000;

  // Matching revision succeeds
  const okResult = validateSignedWindow(nonce, expiresAt, {
    now,
    expectedRevision: 0,
    currentRevision: 0,
  });
  assert.ok(okResult.ok);
  assert.equal(okResult.expectedRevision, 0);

  // Stale revision produces typed conflict
  const staleResult = validateSignedWindow(nonce, expiresAt, {
    now,
    expectedRevision: 0,
    currentRevision: 1,
  });
  assert.ok(!staleResult.ok);
  assert.equal(staleResult.code, "conflict");
  assert.equal(staleResult.field, "expectedRevision");
});

// ─────────────────────────────────────────────────────────────────────────────
// Route Tests: POST /api/proposals/review (complete review decision)
// ─────────────────────────────────────────────────────────────────────────────

test("POST /api/proposals/review: accepts review decision with matching expectedRevision", async () => {
  proposalsTable.clear();
  recorded.length = 0;

  const prop = createProposalFixture({
    proposal_id: "prop-match",
    review_status: "in_review",
    reviewer: "reviewer-alpha",
    reviewed_at: null,
  });
  proposalsTable.set(prop.proposal_id, prop);

  const res = await POST(
    makeRequest("POST", {
      action: "complete",
      proposalId: "prop-match",
      reviewer: "reviewer-alpha",
      approve: true,
      expectedRevision: 0,
    }),
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.status, "approved");

  // In-memory proposal updated
  const updated = proposalsTable.get("prop-match");
  assert.equal(updated?.review_status, "approved");
  assert.equal(getProposalRevision(updated!), 1);
});

test("POST /api/proposals/review: returns 409 typed conflict when expectedRevision is stale", async () => {
  proposalsTable.clear();
  recorded.length = 0;

  // Proposal already has a completed review decision recorded (revision 1)
  const existingDecision = createProposalFixture({
    proposal_id: "prop-stale",
    review_status: "approved",
    reviewer: "reviewer-alpha",
    reviewed_at: 1_700_000_050_000,
  });
  (existingDecision as unknown as Record<string, unknown>).review = "agree";
  proposalsTable.set(existingDecision.proposal_id, existingDecision);

  // A concurrent or stale worker attempts to complete review expecting revision 0
  const res = await POST(
    makeRequest("POST", {
      action: "complete",
      proposalId: "prop-stale",
      reviewer: "reviewer-beta",
      approve: false,
      expectedRevision: 0,
    }),
  );

  // Must return HTTP 409 with machine-readable error body
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.ok(body.error, "response body must contain typed error");
  assert.equal(body.error.code, "conflict");
  assert.equal(body.error.field, "expectedRevision");
  assert.equal(body.error.retryable, false);

  // CRITICAL INVARIANT: newer review decision must remain UNCHANGED
  const proposalAfter = proposalsTable.get("prop-stale");
  assert.equal(proposalAfter?.review_status, "approved", "newer review decision must not be overwritten");
  assert.equal(proposalAfter?.reviewer, "reviewer-alpha", "original reviewer must be preserved");
  assert.equal(proposalAfter?.reviewed_at, 1_700_000_050_000, "original review timestamp must be preserved");
});

test("POST /api/proposals/review: returns 409 typed conflict when proposal is already decided even without expectedRevision", async () => {
  proposalsTable.clear();
  recorded.length = 0;

  // Proposal was already decided
  const existingDecision = createProposalFixture({
    proposal_id: "prop-already-decided",
    review_status: "approved",
    reviewer: "reviewer-alpha",
    reviewed_at: 1_700_000_050_000,
  });
  (existingDecision as unknown as Record<string, unknown>).review = "agree";
  proposalsTable.set(existingDecision.proposal_id, existingDecision);

  const res = await POST(
    makeRequest("POST", {
      action: "complete",
      proposalId: "prop-already-decided",
      reviewer: "reviewer-beta",
      approve: false,
    }),
  );

  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error.code, "conflict");
  assert.equal(body.error.field, "expectedRevision");

  // Invariant preserved
  const unchanged = proposalsTable.get("prop-already-decided");
  assert.equal(unchanged?.review_status, "approved");
});

test("POST /api/proposals/review: returns 400 for negative or non-integer expectedRevision", async () => {
  proposalsTable.clear();
  const prop = createProposalFixture({ proposal_id: "prop-invalid-rev" });
  proposalsTable.set(prop.proposal_id, prop);

  // Negative revision
  const resNegative = await POST(
    makeRequest("POST", {
      action: "complete",
      proposalId: "prop-invalid-rev",
      reviewer: "reviewer-alpha",
      approve: true,
      expectedRevision: -1,
    }),
  );
  assert.equal(resNegative.status, 400);
  const bodyNegative = await resNegative.json();
  assert.equal(bodyNegative.error.code, "invalid_request");
  assert.equal(bodyNegative.error.field, "expectedRevision");

  // Float revision
  const resFloat = await POST(
    makeRequest("POST", {
      action: "complete",
      proposalId: "prop-invalid-rev",
      reviewer: "reviewer-alpha",
      approve: true,
      expectedRevision: 2.7,
    }),
  );
  assert.equal(resFloat.status, 400);
});

test("POST /api/proposals/review: validates signed request window expiration", async () => {
  proposalsTable.clear();
  const prop = createProposalFixture({ proposal_id: "prop-window" });
  proposalsTable.set(prop.proposal_id, prop);

  const pastExpiry = Date.now() - 5_000;
  const res = await POST(
    makeRequest("POST", {
      action: "complete",
      proposalId: "prop-window",
      reviewer: "reviewer-alpha",
      approve: true,
      nonce: "nonce_1234567890123456",
      expiresAt: pastExpiry,
      expectedRevision: 0,
    }),
  );

  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, "request_expired");
  assert.equal(body.error.field, "expiresAt");
});

test("POST /api/proposals/review: returns 404 when proposalId is not found", async () => {
  proposalsTable.clear();
  const res = await POST(
    makeRequest("POST", {
      action: "complete",
      proposalId: "prop-nonexistent",
      reviewer: "reviewer-alpha",
      approve: true,
      expectedRevision: 0,
    }),
  );
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, "not_found");
});

// ─────────────────────────────────────────────────────────────────────────────
// Route Tests: PATCH /api/proposals/review
// ─────────────────────────────────────────────────────────────────────────────

test("PATCH /api/proposals/review: returns 409 typed conflict when updating with stale expectedRevision", async () => {
  proposalsTable.clear();

  const decided = createProposalFixture({
    proposal_id: "prop-patch-stale",
    review_status: "approved",
    reviewer: "reviewer-alpha",
    reviewed_at: 1_700_000_090_000,
  });
  proposalsTable.set(decided.proposal_id, decided);

  const res = await PATCH(
    makeRequest("PATCH", {
      proposalId: "prop-patch-stale",
      status: "rejected",
      reviewer: "reviewer-beta",
      expectedRevision: 0,
    }),
  );

  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error.code, "conflict");
  assert.equal(body.error.field, "expectedRevision");

  // Invariant preserved
  const untouched = proposalsTable.get("prop-patch-stale");
  assert.equal(untouched?.review_status, "approved");
});

test("PATCH /api/proposals/review: succeeds with matching expectedRevision", async () => {
  proposalsTable.clear();

  const pending = createProposalFixture({
    proposal_id: "prop-patch-ok",
    review_status: "in_review",
    reviewed_at: null,
  });
  proposalsTable.set(pending.proposal_id, pending);

  const res = await PATCH(
    makeRequest("PATCH", {
      proposalId: "prop-patch-ok",
      status: "approved",
      reviewer: "reviewer-alpha",
      expectedRevision: 0,
    }),
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.status, "approved");
});
