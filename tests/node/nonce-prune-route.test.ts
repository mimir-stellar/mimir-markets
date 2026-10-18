/**
 * Tests for GET /api/cron/nonce-prune route.
 *
 * Covers:
 *  - Success: authorized caller prunes expired nonces and receives { pruned, at } with Cache-Control: no-store
 *  - Thrown prune error: returns 500 with machine-readable apiError shape (code: "internal_error"),
 *    retryable hint, Cache-Control: no-store, and no raw exception text leaked to client
 *  - Missing bearer token: refuses unauthenticated callers with 401
 *  - Invalid bearer token: refuses wrong secret with 401
 *  - Fails closed: refuses callers when CRON_SECRET is unset
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { NextRequest } from "next/server";

const CRON_SECRET = "test-cron-secret-value";

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
    return { rows: [] as Array<Record<string, unknown>>, rowCount: 3 };
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

import { GET, _setPruneExpiredNoncesForTest } from "../../app/api/cron/nonce-prune/route";

function request(url: string, method: string, body?: unknown, token?: string | null): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null && token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }
  return new Request(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as NextRequest;
}

function reset(): void {
  recorded.length = 0;
  _setPruneExpiredNoncesForTest(null);
}

test("GET /api/cron/nonce-prune: refuses a request with no Authorization header", async () => {
  reset();
  const res = await GET(request("http://localhost/api/cron/nonce-prune", "GET", undefined, null));
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, "unauthenticated");
  assert.equal(recorded.length, 0, "the cron sweep must not run unauthenticated");
});

test("GET /api/cron/nonce-prune: refuses an arbitrary bearer token", async () => {
  reset();
  const res = await GET(request("http://localhost/api/cron/nonce-prune", "GET", undefined, "wrong-token"));
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, "unauthenticated");
  assert.equal(recorded.length, 0, "must not prune on invalid credentials");
});

test("GET /api/cron/nonce-prune: serves successful prune to the worker secret", async () => {
  reset();
  const startTime = Date.now();
  const res = await GET(request("http://localhost/api/cron/nonce-prune", "GET", undefined, CRON_SECRET));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");

  const body = await res.json();
  assert.equal(body.pruned, 3);
  assert.equal(typeof body.at, "number");
  assert.ok(body.at >= startTime, "at timestamp should be >= test start time");
  assert.ok(recorded.some((q) => /DELETE FROM agent_api_nonces/.test(q.sql)), "must execute nonce delete query");
});

test("GET /api/cron/nonce-prune: handles thrown prune error with machine-readable internal_error and no raw exception text", async () => {
  reset();
  const rawErrorMessage = "synthetic connection pool exhausted error: secret-db-host.internal";
  let loggedError: unknown = null;
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    loggedError = args;
  };

  try {
    _setPruneExpiredNoncesForTest(async () => {
      throw new Error(rawErrorMessage);
    });

    const res = await GET(request("http://localhost/api/cron/nonce-prune", "GET", undefined, CRON_SECRET));

    // Verify status 500 and Cache-Control: no-store
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("retry-after"), "5");

    const body = await res.json();

    // Verify machine-readable error shape
    assert.equal(body.error.code, "internal_error");
    assert.equal(body.error.retryable, true);
    assert.equal(body.error.retryAfterSeconds, 5);
    assert.equal(typeof body.error.message, "string");

    // Critical: raw exception details must NOT be returned in response body
    const bodyString = JSON.stringify(body);
    assert.ok(
      !bodyString.includes(rawErrorMessage),
      "raw exception text must not leak to caller",
    );
    assert.ok(
      !bodyString.includes("secret-db-host"),
      "internal details must not leak to caller",
    );

    // Verify underlying error was logged server-side
    assert.ok(loggedError !== null, "error must be logged to console.error server-side");
    const loggedString = String(loggedError);
    assert.ok(
      loggedString.includes("secret-db-host.internal"),
      "server-side logs must contain the underlying error",
    );
  } finally {
    console.error = originalConsoleError;
    reset();
  }
});

test("GET /api/cron/nonce-prune: handles thrown prune error via dependency injection argument", async () => {
  reset();
  const rawErrorMessage = "database connection failure";
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const res = await GET(
      request("http://localhost/api/cron/nonce-prune", "GET", undefined, CRON_SECRET),
      {
        pruneExpiredNonces: async () => {
          throw new Error(rawErrorMessage);
        },
      },
    );

    assert.equal(res.status, 500);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.error.code, "internal_error");
    assert.equal(body.error.retryable, true);
    assert.ok(!JSON.stringify(body).includes(rawErrorMessage));
  } finally {
    console.error = originalConsoleError;
    reset();
  }
});

test("GET /api/cron/nonce-prune: fails closed when CRON_SECRET is unset", async () => {
  reset();
  const previousSecret = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;

  try {
    const res = await GET(request("http://localhost/api/cron/nonce-prune", "GET", undefined, CRON_SECRET));
    assert.equal(res.status, 403);
    assert.equal(recorded.length, 0, "sweep must not run when CRON_SECRET is unset");
  } finally {
    process.env.CRON_SECRET = previousSecret;
  }
});
