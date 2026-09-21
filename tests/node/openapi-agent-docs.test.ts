import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const OPENAPI = readFileSync(join(process.cwd(), "docs", "openapi-agent-v1.yaml"), "utf8");
const LIVE_API = readFileSync(join(process.cwd(), "lib", "agents", "api.ts"), "utf8");

test("OpenAPI action enum stays aligned with the live agent route", () => {
  const match = OPENAPI.match(/name: action[\s\S]*?enum: \[([^\]]+)\]/);
  assert.ok(match, "OpenAPI action parameter enum is missing");
  const documented = match[1].split(",").map((action) => action.trim());
  const liveMatch = LIVE_API.match(/export const AGENT_API_ACTIONS = \[([\s\S]*?)\] as const;/);
  assert.ok(liveMatch, "live agent action list is missing");
  const live = [...liveMatch[1].matchAll(/"([^\"]+)"/g)].map((entry) => entry[1]);
  assert.deepEqual(documented, live);
});

test("OpenAPI publishes sanitized request and response examples", () => {
  assert.match(OPENAPI, /examples:\n\s+heartbeat:/);
  assert.match(OPENAPI, /signature: BASE64_ED25519_SIGNATURE/);
  assert.match(OPENAPI, /summary: Safe policy preview/);
  assert.doesNotMatch(OPENAPI, /\bS[A-Z2-7]{55}\b/);
});
