import assert from "node:assert/strict";
import test from "node:test";
import { MimirAgentClient, MimirAgentError } from "../../sdk/agents";

function createClient() {
  return new MimirAgentClient({
    baseUrl: "https://agent.mimir.test",
    agentId: "test-agent",
    signMessage: async () => "dGVzdC1zaWduYXR1cmU=",
    now: () => 1_700_000_000_000,
    nonce: () => "test-nonce-123",
  });
}

async function withMockFetch(
  mock: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = mock as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("400 invalid_request throws MimirAgentError with parsed error fields", async () => {
  await withMockFetch(
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "invalid_request",
            message: "Field 'amount' must be positive",
            retryable: false,
            field: "amount",
            trace_id: "trace-400-abc",
          },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      ),
    async () => {
      const client = createClient();
      await assert.rejects(
        async () => {
          await client.heartbeat();
        },
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err instanceof MimirAgentError);
          assert.equal(err.name, "MimirAgentError");
          assert.equal(err.status, 400);
          assert.equal(err.code, "invalid_request");
          assert.equal(err.retryable, false);
          assert.equal(err.retryAfterSeconds, undefined);
          assert.equal(err.field, "amount");
          assert.equal(err.traceId, "trace-400-abc");
          assert.equal(err.message, "Field 'amount' must be positive");
          return true;
        },
      );
    },
  );
});

test("429 with retry-after header throws MimirAgentError and prefers header", async () => {
  await withMockFetch(
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "rate_limited",
            message: "Rate limit exceeded",
            retryable: true,
            retryAfterSeconds: 30, // header should take precedence
            trace_id: "trace-429-xyz",
          },
        }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "60",
          },
        },
      ),
    async () => {
      const client = createClient();
      await assert.rejects(
        async () => {
          await client.heartbeat();
        },
        (err: unknown) => {
          assert.ok(err instanceof MimirAgentError);
          assert.equal(err.status, 429);
          assert.equal(err.code, "rate_limited");
          assert.equal(err.retryable, true);
          assert.equal(err.retryAfterSeconds, 60);
          assert.equal(err.traceId, "trace-429-xyz");
          assert.equal(err.message, "Rate limit exceeded");
          return true;
        },
      );
    },
  );
});

test("HTML 502 never surfaces a SyntaxError and throws MimirAgentError", async () => {
  const htmlBody = `<!DOCTYPE html>
<html>
<head><title>502 Bad Gateway</title></head>
<body>
<h1>502 Bad Gateway</h1>
<p>Cloudflare / Proxy upstream failure</p>
</body>
</html>`;

  await withMockFetch(
    async () =>
      new Response(htmlBody, {
        status: 502,
        headers: {
          "content-type": "text/html; charset=UTF-8",
          "x-mimir-trace-id": "proxy-trace-999",
        },
      }),
    async () => {
      const client = createClient();
      await assert.rejects(
        async () => {
          await client.heartbeat();
        },
        (err: unknown) => {
          assert.ok(err instanceof MimirAgentError);
          assert.equal(err.status, 502);
          assert.equal(err.code, "upstream_unavailable");
          assert.equal(err.retryable, true);
          assert.equal(err.retryAfterSeconds, undefined);
          assert.equal(err.traceId, "proxy-trace-999");
          assert.equal(err.message, "Mimir Agent API 502");
          return true;
        },
      );
    },
  );
});

test("200 successful response resolves unchanged without error", async () => {
  const expectedPayload = {
    ok: true,
    agentId: "test-agent",
    action: "heartbeat",
  };

  await withMockFetch(
    async () =>
      new Response(JSON.stringify(expectedPayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      const client = createClient();
      const result = await client.heartbeat();
      assert.deepEqual(result, expectedPayload);
    },
  );
});

test("defensive fallbacks for non-JSON or missing error bodies", async () => {
  // 500 without JSON body -> upstream_unavailable, retryable: true
  await withMockFetch(
    async () =>
      new Response("Internal Server Error", {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
    async () => {
      const client = createClient();
      await assert.rejects(
        async () => {
          await client.heartbeat();
        },
        (err: unknown) => {
          assert.ok(err instanceof MimirAgentError);
          assert.equal(err.status, 500);
          assert.equal(err.code, "upstream_unavailable");
          assert.equal(err.retryable, true);
          return true;
        },
      );
    },
  );

  // 404 without JSON body -> internal_error, retryable: false
  await withMockFetch(
    async () =>
      new Response("Not Found", {
        status: 404,
        headers: { "content-type": "text/plain" },
      }),
    async () => {
      const client = createClient();
      await assert.rejects(
        async () => {
          await client.heartbeat();
        },
        (err: unknown) => {
          assert.ok(err instanceof MimirAgentError);
          assert.equal(err.status, 404);
          assert.equal(err.code, "internal_error");
          assert.equal(err.retryable, false);
          return true;
        },
      );
    },
  );

  // 429 without header falls back to retryAfterSeconds in body
  await withMockFetch(
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "rate_limited",
            retryable: true,
            retryAfterSeconds: 45,
          },
        }),
        {
          status: 429,
          headers: { "content-type": "application/json" },
        },
      ),
    async () => {
      const client = createClient();
      await assert.rejects(
        async () => {
          await client.heartbeat();
        },
        (err: unknown) => {
          assert.ok(err instanceof MimirAgentError);
          assert.equal(err.status, 429);
          assert.equal(err.retryAfterSeconds, 45);
          return true;
        },
      );
    },
  );
});
