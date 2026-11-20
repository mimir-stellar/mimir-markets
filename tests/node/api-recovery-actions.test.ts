import assert from "node:assert/strict";
import test from "node:test";

import { apiError, apiErrorCatalogue, isRetryable, statusFor, withRequestId, type ApiErrorCode } from "../../lib/api/errors";
import { API_RECOVERY_ACTIONS, apiRecoveryActionSchema, isApiRecoveryAction, type ApiRecoveryAction } from "../../lib/api/schema";
import { validateAgainstSchema } from "../../lib/ops/json-schema-subset";
import { runWithTrace } from "../../lib/ops/trace";
import { MimirAgentClient, MimirAgentError, type MimirAgentErrorOptions } from "../../sdk/agents";

// Pin the pre-change wire contract independently of the live catalogue.
const LEGACY: Record<ApiErrorCode, [number, boolean, number?]> = {
  invalid_request: [400, false], invalid_signature: [400, false],
  unsupported_version: [400, false], payload_too_large: [413, false],
  idempotency_conflict: [409, false], unauthenticated: [401, false],
  nonce_reused: [401, false], request_expired: [401, true, 0],
  forbidden: [403, false], capability_missing: [403, false],
  agent_revoked: [403, false], agent_paused: [403, true, 300],
  not_found: [404, false], conflict: [409, false],
  rate_limited: [429, true, 60], budget_exhausted: [429, true, 3600],
  upstream_unavailable: [503, true, 30], internal_error: [500, true, 5],
};

const ACTIONS: Partial<Record<ApiErrorCode, ApiRecoveryAction>> = {
  request_expired: "refresh_request", invalid_signature: "reconnect_wallet",
  agent_paused: "retry_later", rate_limited: "retry_later",
  budget_exhausted: "retry_later", upstream_unavailable: "retry_later",
  internal_error: "retry_later",
};

test("recovery actions accept only the three exact vocabulary values", () => {
  assert.deepEqual(API_RECOVERY_ACTIONS, ["refresh_request", "reconnect_wallet", "retry_later"]);
  assert.equal(Object.isFrozen(API_RECOVERY_ACTIONS), true);
  for (const action of API_RECOVERY_ACTIONS) assert.equal(isApiRecoveryAction(action), true);
  for (const value of [undefined, null, false, 0, {}, [], ["retry_later"], "", "RETRY_LATER", " retry_later", "retry_later\n", "run_command", { action: "retry_later" }]) {
    assert.equal(isApiRecoveryAction(value), false);
  }
});

test("the response schema keeps guidance optional and rejects unknown advice", () => {
  const property = apiRecoveryActionSchema();
  const schema = { type: "object", properties: { recoveryAction: property }, additionalProperties: false };
  assert.equal(validateAgainstSchema(schema, {}).ok, true);
  for (const action of API_RECOVERY_ACTIONS) {
    assert.equal(validateAgainstSchema(schema, { recoveryAction: action }).ok, true);
  }
  for (const value of ["run_command", { action: "retry_later" }, null, 1]) {
    assert.equal(validateAgainstSchema(schema, { recoveryAction: value }).ok, false);
  }
  property.enum.length = 0;
  assert.deepEqual(apiRecoveryActionSchema().enum, [...API_RECOVERY_ACTIONS]);
});

test("all 18 codes retain their previous status, retryability, delay, headers and fields", () => {
  const catalogue = apiErrorCatalogue();
  assert.deepEqual(catalogue.map((row) => row.code), Object.keys(LEGACY));
  for (const code of Object.keys(LEGACY) as ApiErrorCode[]) {
    const [status, retryable, retryAfterSeconds] = LEGACY[code];
    const result = apiError(code, "Synthetic failure", { field: "body.example", requestId: "request-example" });
    const { recoveryAction, ...oldFields } = result.body.error;
    assert.equal(result.status, status, code);
    assert.equal(statusFor(code), status, code);
    assert.equal(isRetryable(code), retryable, code);
    assert.deepEqual(oldFields, {
      code, message: "Synthetic failure", retryable,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      field: "body.example", requestId: "request-example",
    }, code);
    assert.deepEqual(result.headers, retryable && retryAfterSeconds !== undefined && retryAfterSeconds > 0
      ? { "retry-after": String(retryAfterSeconds) } : {}, code);
    assert.equal(recoveryAction, ACTIONS[code], code);
    assert.equal(Object.hasOwn(result.body.error, "recoveryAction"), ACTIONS[code] !== undefined, code);
    assert.deepEqual(catalogue.find((row) => row.code === code), {
      code, status, retryable,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      ...(ACTIONS[code] !== undefined ? { recoveryAction: ACTIONS[code] } : {}),
    }, code);
  }
});

test("expired requests advise a fresh request at zero delay; invalid signatures remain nonretryable", () => {
  const expired = apiError("request_expired", "Request expired");
  assert.equal(expired.body.error.recoveryAction, "refresh_request");
  assert.equal(expired.body.error.retryAfterSeconds, 0);
  assert.deepEqual(expired.headers, {});
  const signature = apiError("invalid_signature", "Signature invalid");
  assert.equal(signature.body.error.recoveryAction, "reconnect_wallet");
  assert.equal(signature.body.error.retryable, false);
  assert.equal(signature.body.error.retryAfterSeconds, undefined);
  assert.deepEqual(signature.headers, {});
});

test("server recovery advice cannot be overridden by caller-supplied instructions", () => {
  const options = { recoveryAction: "run_command", retryAfterSeconds: 7 };
  assert.equal(apiError("rate_limited", "Try later", options).body.error.recoveryAction, "retry_later");
  assert.equal(apiError("forbidden", "Forbidden", options).body.error.recoveryAction, undefined);
});

test("zero and fractional delay overrides preserve Retry-After semantics", () => {
  for (const seconds of [0, 0.1, 60.5]) {
    const result = apiError("rate_limited", "Try later", { retryAfterSeconds: seconds });
    assert.equal(result.body.error.recoveryAction, "retry_later");
    assert.equal(result.body.error.retryAfterSeconds, seconds);
    assert.deepEqual(result.headers, seconds > 0 ? { "retry-after": String(Math.ceil(seconds)) } : {});
  }
  const terminal = apiError("forbidden", "Forbidden", { retryAfterSeconds: 10 });
  assert.equal(terminal.body.error.retryable, false);
  assert.equal(terminal.body.error.recoveryAction, undefined);
  assert.deepEqual(terminal.headers, {});
});

test("request and trace correlation preserve bounded recovery advice", () => {
  const traceId = "mh_0123456789abcdef0123456789abcdef";
  const result = runWithTrace(traceId, () => withRequestId(apiError("upstream_unavailable", "Try later"), "request-example"));
  assert.equal(result.body.error.recoveryAction, "retry_later");
  assert.equal(result.body.error.trace_id, traceId);
  assert.equal(result.body.error.requestId, "request-example");
  assert.equal(result.headers["x-mimir-trace-id"], traceId);
});

test("both SDK error constructors preserve known advice and reject arbitrary instructions", () => {
  for (const recoveryAction of API_RECOVERY_ACTIONS) {
    const options = { status: 400, code: "example", retryable: false, recoveryAction };
    assert.equal(new MimirAgentError(options).recoveryAction, recoveryAction);
    assert.equal(new MimirAgentError("Example", options).recoveryAction, recoveryAction);
  }
  const unknown = { status: 400, code: "example", retryable: false, recoveryAction: "run_command" } as unknown as MimirAgentErrorOptions;
  assert.equal(new MimirAgentError(unknown).recoveryAction, undefined);
  assert.equal(new MimirAgentError("Example", unknown).recoveryAction, undefined);
});

test("SDK exposes guidance without automatically retrying or signing another request", async () => {
  for (const code of ["request_expired", "invalid_signature", "rate_limited"] as ApiErrorCode[]) {
    let fetches = 0;
    let signatures = 0;
    const result = apiError(code, "Synthetic failure");
    const client = new MimirAgentClient({
      baseUrl: "https://agent.example", agentId: "agent-example", now: () => 1, nonce: () => "nonce-example",
      signMessage: async () => { signatures++; return "synthetic-signature"; },
      fetch: async () => { fetches++; return new Response(JSON.stringify(result.body), { status: result.status, headers: result.headers }); },
    });
    await assert.rejects(() => client.request("heartbeat", {}, "key-example"), (error: unknown) => {
      assert.ok(error instanceof MimirAgentError);
      assert.equal(error.recoveryAction, ACTIONS[code]);
      assert.equal(error.retryable, LEGACY[code][1]);
      assert.equal(error.retryAfterSeconds, LEGACY[code][2]);
      return true;
    });
    assert.equal(fetches, 1);
    assert.equal(signatures, 1);
  }
});

test("SDK ignores malformed/newer guidance and supports legacy errors with header precedence", async () => {
  for (const action of [undefined, "run_command", { command: "example" }, ["retry_later"], null, 0]) {
    const client = new MimirAgentClient({
      baseUrl: "https://agent.example", agentId: "agent-example",
      signMessage: async () => "synthetic-signature",
      fetch: async () => new Response(JSON.stringify({ error: {
        code: "rate_limited", message: "Try later", retryable: true, retryAfterSeconds: 60,
        ...(action !== undefined ? { recoveryAction: action } : {}),
      } }), { status: 429, headers: { "retry-after": "7" } }),
    });
    await assert.rejects(() => client.request("heartbeat", {}), (error: unknown) => {
      assert.ok(error instanceof MimirAgentError);
      assert.equal(error.recoveryAction, undefined);
      assert.equal(error.code, "rate_limited");
      assert.equal(error.retryable, true);
      assert.equal(error.retryAfterSeconds, 7);
      return true;
    });
  }
});
