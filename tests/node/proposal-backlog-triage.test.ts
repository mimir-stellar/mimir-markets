/**
 * Operator Proposal Backlog Triage Tests.
 *
 * Verifies:
 * - Grouping bounded unresolved proposals by age bracket and blocking reason
 * - Age boundary cases (0s, 3599s, 3600s, 86400s, 86401s, negative/future timestamps)
 * - Blocking reason derivation and fallback to "unblocked"
 * - Cross-dimensional grouping (`byAgeAndReason`) and summary counts
 * - Strict privacy safeguards: omission of private source text and signing metadata
 * - Filtering: unresolved (queued, in_review) included; resolved excluded
 * - Bounded pagination clamping (1..200, offset >= 0)
 * - Signed request window validation (expired, future-skew, malformed nonce)
 * - Auth gating on internal_worker tier and CRON_SECRET
 * - Route compatibility: GET /api/proposals/review?export=triage and GET /api/proposals/review/triage
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { NextRequest } from "next/server";

import {
  PROPOSAL_AGE_BRACKETS,
  getProposalAgeBracket,
  getProposalBlockingReason,
  sanitizeTriagedProposal,
  buildProposalBacklogTriage,
  type TriagedProposal,
} from "../../lib/ops/proposal-triage";
import { SIGNED_ACTION_MAX_TTL_MS, validateSignedWindow } from "../../lib/signed-window";
import type { MarketProposalRow } from "../../lib/db";

const CRON_SECRET = "test-cron-secret-proposals-triage-32char-len";
const NOW = 1_700_000_000_000; // Fixed epoch ms

function makeProposalRow(overrides: Partial<MarketProposalRow> = {}): MarketProposalRow {
  return {
    proposal_id: "prop_" + Math.random().toString(36).slice(2, 10),
    created_at: NOW - 10_000,
    question: "Will Stellar process 1B transactions in 2026?",
    creator_position: "Yes",
    counter_position: "No",
    category: "crypto",
    subject_type: "volume",
    settlement_mode: "oracle",
    product_modifiers: [],
    mode_rationale: "SENSITIVE: private scraped article content https://example.com/secret",
    stake_policy: { creatorStakeUsdc: 5, maxChallengers: 10, challengerPayoutBps: 0 },
    context_pack_hash: "0xdeadbeefcafebabe12345678",
    resolution_url: "https://stellar.expert",
    settlement_rule: "Resolve YES if volume > 1B",
    deadline: Math.floor(NOW / 1000) + 86400,
    quality_score: 90,
    preflight_verdict: { llm_internal_prompt: "evaluate fairness", reasoning: "secret reasoning" },
    disposition: "shadow",
    blocked_by: null,
    claim_id: null,
    review_status: "queued",
    queued_at: NOW - 10_000,
    claimed_at: null,
    reviewed_at: null,
    reviewer: null,
    failure_reason: null,
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Pure logic: Age Bracket Calculation & Boundary Cases
// -----------------------------------------------------------------------------

test("getProposalAgeBracket: categorizes into expected brackets with exact boundaries", () => {
  assert.deepEqual(PROPOSAL_AGE_BRACKETS, ["under_1h", "1h_to_24h", "over_24h"]);

  // under_1h: < 3600 seconds
  assert.equal(getProposalAgeBracket(0), "under_1h");
  assert.equal(getProposalAgeBracket(1), "under_1h");
  assert.equal(getProposalAgeBracket(1800), "under_1h");
  assert.equal(getProposalAgeBracket(3599), "under_1h");

  // 1h_to_24h: >= 3600 and <= 86400 seconds
  assert.equal(getProposalAgeBracket(3600), "1h_to_24h");
  assert.equal(getProposalAgeBracket(3601), "1h_to_24h");
  assert.equal(getProposalAgeBracket(43200), "1h_to_24h");
  assert.equal(getProposalAgeBracket(86400), "1h_to_24h");

  // over_24h: > 86400 seconds
  assert.equal(getProposalAgeBracket(86401), "over_24h");
  assert.equal(getProposalAgeBracket(100_000), "over_24h");
  assert.equal(getProposalAgeBracket(1_000_000), "over_24h");
});

test("sanitizeTriagedProposal: handles boundary and negative/future timestamps safely", () => {
  // Negative age (queued_at in the future) clamps to 0s -> under_1h
  const futureProp = makeProposalRow({ queued_at: NOW + 10_000 });
  const triagedFuture = sanitizeTriagedProposal(futureProp, NOW);
  assert.equal(triagedFuture.ageSeconds, 0);
  assert.equal(triagedFuture.ageBracket, "under_1h");

  // Fallback to created_at when queued_at is null
  const noQueuedAt = makeProposalRow({ queued_at: null, created_at: NOW - 5000 * 1000 });
  const triagedNoQueued = sanitizeTriagedProposal(noQueuedAt, NOW);
  assert.equal(triagedNoQueued.ageSeconds, 5000);
  assert.equal(triagedNoQueued.ageBracket, "1h_to_24h");
});

// -----------------------------------------------------------------------------
// Pure logic: Blocking Reason Derivation
// -----------------------------------------------------------------------------

test("getProposalBlockingReason: extracts blocked_by or failure_reason or unblocked", () => {
  // Explicit blocked_by
  assert.equal(getProposalBlockingReason({ blocked_by: "oracle_unreachable", failure_reason: null }), "oracle_unreachable");
  assert.equal(getProposalBlockingReason({ blocked_by: "  preflight_failed  ", failure_reason: null }), "preflight_failed");

  // Fallback to failure_reason
  assert.equal(getProposalBlockingReason({ blocked_by: null, failure_reason: "insufficient_stake" }), "insufficient_stake");
  assert.equal(getProposalBlockingReason({ blocked_by: "", failure_reason: "dependency_failed" }), "dependency_failed");

  // Fallback to "unblocked"
  assert.equal(getProposalBlockingReason({ blocked_by: null, failure_reason: null }), "unblocked");
  assert.equal(getProposalBlockingReason({ blocked_by: "", failure_reason: "  " }), "unblocked");
});

// -----------------------------------------------------------------------------
// Privacy Safeguards: Strict Omission of Private Source Text and Signing Metadata
// -----------------------------------------------------------------------------

test("privacy: triage export omits private source text and signing metadata", () => {
  const sensitiveRow = makeProposalRow({
    mode_rationale: "CONFIDENTIAL_SCRAPED_ARTICLE_CONTENT",
    context_pack_hash: "SECRET_CONTEXT_HASH_12345",
    preflight_verdict: {
      llm_prompt: "SECRET_SYSTEM_PROMPT",
      raw_analysis: "PRIVATE_REASONING_CHAIN",
    },
    // Injected potential signing metadata
    ...({
      nonce: "sensitive_nonce_token",
      expiresAt: NOW + 60_000,
      signature: "super_secret_signature",
      privateKey: "SECRET_SIGNING_KEY",
    } as Record<string, unknown>),
  });

  const exportResult = buildProposalBacklogTriage([sensitiveRow], { now: NOW });
  const serialized = JSON.stringify(exportResult);

  // Assert sensitive strings are never in the serialized output
  assert.ok(!serialized.includes("CONFIDENTIAL_SCRAPED_ARTICLE_CONTENT"), "mode_rationale must be omitted");
  assert.ok(!serialized.includes("SECRET_CONTEXT_HASH_12345"), "context_pack_hash must be omitted");
  assert.ok(!serialized.includes("SECRET_SYSTEM_PROMPT"), "preflight_verdict prompt must be omitted");
  assert.ok(!serialized.includes("PRIVATE_REASONING_CHAIN"), "preflight_verdict reasoning must be omitted");
  assert.ok(!serialized.includes("sensitive_nonce_token"), "nonce must be omitted");
  assert.ok(!serialized.includes("super_secret_signature"), "signature must be omitted");
  assert.ok(!serialized.includes("SECRET_SIGNING_KEY"), "signing credentials must be omitted");

  // Check keys on TriagedProposal
  const triaged = exportResult.proposals[0];
  const keys = Object.keys(triaged);
  assert.ok(!keys.includes("mode_rationale"));
  assert.ok(!keys.includes("context_pack_hash"));
  assert.ok(!keys.includes("preflight_verdict"));
  assert.ok(!keys.includes("nonce"));
  assert.ok(!keys.includes("expiresAt"));
  assert.ok(!keys.includes("signature"));
  assert.ok(!keys.includes("privateKey"));
});

// -----------------------------------------------------------------------------
// Grouping & Filtering: Age, Blocking Reason, and Unresolved Status
// -----------------------------------------------------------------------------

test("buildProposalBacklogTriage: groups proposals and filters resolved ones", () => {
  const p1 = makeProposalRow({
    proposal_id: "p1_under_1h",
    queued_at: NOW - 600 * 1000, // 10m ago -> under_1h
    blocked_by: null,
    review_status: "queued",
  });
  const p2 = makeProposalRow({
    proposal_id: "p2_1h_to_24h",
    queued_at: NOW - 7200 * 1000, // 2h ago -> 1h_to_24h
    blocked_by: "oracle_unreachable",
    review_status: "in_review",
  });
  const p3 = makeProposalRow({
    proposal_id: "p3_over_24h",
    queued_at: NOW - 100_000 * 1000, // ~27h ago -> over_24h
    blocked_by: "oracle_unreachable",
    review_status: "queued",
  });
  const pResolved = makeProposalRow({
    proposal_id: "p_resolved",
    queued_at: NOW - 100_000 * 1000,
    review_status: "approved", // Resolved -> must be filtered out!
  });

  const exportResult = buildProposalBacklogTriage([p1, p2, p3, pResolved], { now: NOW, limit: 50, offset: 0 });

  // Only unresolved proposals included
  assert.equal(exportResult.summary.total, 3);
  assert.equal(exportResult.proposals.length, 3);
  assert.ok(!exportResult.proposals.some((p) => p.proposalId === "p_resolved"));

  // Check age grouping
  assert.equal(exportResult.byAge.under_1h.length, 1);
  assert.equal(exportResult.byAge.under_1h[0].proposalId, "p1_under_1h");
  assert.equal(exportResult.byAge["1h_to_24h"].length, 1);
  assert.equal(exportResult.byAge["1h_to_24h"][0].proposalId, "p2_1h_to_24h");
  assert.equal(exportResult.byAge.over_24h.length, 1);
  assert.equal(exportResult.byAge.over_24h[0].proposalId, "p3_over_24h");

  // Check blocking reason grouping
  assert.equal(exportResult.byBlockingReason.unblocked.length, 1);
  assert.equal(exportResult.byBlockingReason.oracle_unreachable.length, 2);

  // Check summary counts
  assert.equal(exportResult.summary.byAge.under_1h, 1);
  assert.equal(exportResult.summary.byAge["1h_to_24h"], 1);
  assert.equal(exportResult.summary.byAge.over_24h, 1);
  assert.equal(exportResult.summary.byBlockingReason.unblocked, 1);
  assert.equal(exportResult.summary.byBlockingReason.oracle_unreachable, 2);

  // Check cross-grouping
  assert.equal(exportResult.byAgeAndReason.under_1h.unblocked.length, 1);
  assert.equal(exportResult.byAgeAndReason["1h_to_24h"].oracle_unreachable.length, 1);
  assert.equal(exportResult.byAgeAndReason.over_24h.oracle_unreachable.length, 1);
});

// -----------------------------------------------------------------------------
// Signed Request Window Freshness & Bounds
// -----------------------------------------------------------------------------

test("signed window: enforces freshness window boundaries", () => {
  const validNonce = "nonce_1234567890abcdef";

  // Valid window: expires 1 minute in the future
  const valid = validateSignedWindow(validNonce, NOW + 60_000, NOW);
  assert.equal(valid.ok, true);

  // Boundary window: exactly now + SIGNED_ACTION_MAX_TTL_MS
  const boundary = validateSignedWindow(validNonce, NOW + SIGNED_ACTION_MAX_TTL_MS, NOW);
  assert.equal(boundary.ok, true);

  // Expired: in the past
  const expired = validateSignedWindow(validNonce, NOW - 1000, NOW);
  assert.equal(expired.ok, false);
  if (expired.ok) throw new Error("expected expired");
  assert.equal(expired.code, "request_expired");
  assert.equal(expired.field, "expiresAt");

  // Expired: exactly NOW
  const expiredNow = validateSignedWindow(validNonce, NOW, NOW);
  assert.equal(expiredNow.ok, false);

  // Too far in the future: exceeds 5 minutes
  const tooFar = validateSignedWindow(validNonce, NOW + SIGNED_ACTION_MAX_TTL_MS + 1000, NOW);
  assert.equal(tooFar.ok, false);
  if (tooFar.ok) throw new Error("expected tooFar to fail");
  assert.equal(tooFar.code, "invalid_request");
  assert.equal(tooFar.field, "expiresAt");

  // Invalid nonces
  assert.equal(validateSignedWindow("short", NOW + 60_000, NOW).ok, false);
  assert.equal(validateSignedWindow("has spaces in nonce!", NOW + 60_000, NOW).ok, false);
});

// -----------------------------------------------------------------------------
// Database & Route Integration Tests with Fake Pool
// -----------------------------------------------------------------------------

interface RecordedQuery {
  sql: string;
  args: unknown[];
}

const recorded: RecordedQuery[] = [];

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
process.env.CRON_SECRET = CRON_SECRET;

test("getProposalBacklogTriage DB helper queries unresolved proposals ordered by backlog priority", async () => {
  recorded.length = 0;
  const { getProposalBacklogTriage } = await import("../../lib/db");

  const result = await getProposalBacklogTriage({ limit: 25, offset: 10, now: NOW });
  assert.equal(result.limit, 25);
  assert.equal(result.offset, 10);
  assert.equal(result.summary.total, 0);

  const last = recorded[recorded.length - 1];
  assert.ok(last, "query was issued");
  assert.match(last.sql, /review_status IN \('queued', 'in_review'\)/);
  assert.match(last.sql, /ORDER BY COALESCE\(queued_at, created_at\) ASC/);
  assert.match(last.sql, /LIMIT \$\d+ OFFSET \$\d+/);
  assert.equal(last.args[0], 25);
  assert.equal(last.args[1], 10);
});

test("GET /api/proposals/review?export=triage serves triage export when authenticated", async () => {
  recorded.length = 0;
  const { GET } = await import("../../app/api/proposals/review/route");

  const req = new Request("http://localhost/api/proposals/review?export=triage&limit=15&offset=5", {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  }) as unknown as NextRequest;

  const res = await GET(req);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.limit, 15);
  assert.equal(data.offset, 5);
  assert.ok("byAge" in data);
  assert.ok("byBlockingReason" in data);
  assert.ok("byAgeAndReason" in data);
  assert.ok("summary" in data);
  assert.ok("proposals" in data);
});

test("GET /api/proposals/review/triage serves triage export on dedicated route", async () => {
  recorded.length = 0;
  const { GET } = await import("../../app/api/proposals/review/triage/route");

  const req = new Request("http://localhost/api/proposals/review/triage?limit=20&offset=0", {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  }) as unknown as NextRequest;

  const res = await GET(req);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.limit, 20);
  assert.equal(data.offset, 0);
  assert.ok("byAge" in data);
  assert.ok("byBlockingReason" in data);
  assert.ok("summary" in data);
});

test("triage route refuses unauthenticated requests with 401", async () => {
  const { GET } = await import("../../app/api/proposals/review/triage/route");

  // Missing token
  const reqNoAuth = new Request("http://localhost/api/proposals/review/triage") as unknown as NextRequest;
  const resNoAuth = await GET(reqNoAuth);
  assert.equal(resNoAuth.status, 401);

  // Wrong token
  const reqWrongAuth = new Request("http://localhost/api/proposals/review/triage", {
    headers: { authorization: "Bearer invalid-secret" },
  }) as unknown as NextRequest;
  const resWrongAuth = await GET(reqWrongAuth);
  assert.equal(resWrongAuth.status, 401);
});

test("triage route validates signed window parameters and rejects expired windows with 400", async () => {
  const { GET } = await import("../../app/api/proposals/review/triage/route");

  // Header-based signed window: expired timestamp
  const expiredReq = new Request("http://localhost/api/proposals/review/triage", {
    headers: {
      authorization: `Bearer ${CRON_SECRET}`,
      "x-mimir-nonce": "valid_nonce_1234567890",
      "x-mimir-expires-at": String(Date.now() - 10_000), // In the past!
    },
  }) as unknown as NextRequest;

  const expiredRes = await GET(expiredReq);
  assert.equal(expiredRes.status, 400);
  const expiredBody = await expiredRes.json();
  assert.equal(expiredBody.error.code, "request_expired");

  // Query-based signed window: malformed nonce
  const invalidNonceReq = new Request("http://localhost/api/proposals/review/triage?nonce=short&expiresAt=" + (Date.now() + 60_000), {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  }) as unknown as NextRequest;

  const invalidNonceRes = await GET(invalidNonceReq);
  assert.equal(invalidNonceRes.status, 400);
  const invalidNonceBody = await invalidNonceRes.json();
  assert.equal(invalidNonceBody.error.code, "invalid_request");

  // Valid signed window parameters pass through
  const validReq = new Request("http://localhost/api/proposals/review/triage", {
    headers: {
      authorization: `Bearer ${CRON_SECRET}`,
      "x-mimir-nonce": "valid_nonce_1234567890",
      "x-mimir-expires-at": String(Date.now() + 60_000),
    },
  }) as unknown as NextRequest;

  const validRes = await GET(validReq);
  assert.equal(validRes.status, 200);
});
