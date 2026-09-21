import assert from "node:assert/strict";
import test from "node:test";
import nextConfig from "../../next.config.js";

async function headerMatrix() {
  assert.ok(nextConfig.headers);
  const rules = await nextConfig.headers!();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].source, "/:path*");
  const entries = rules[0].headers.map((entry: { key: string; value: string }) => [entry.key, entry.value] as const);
  assert.equal(new Set(entries.map(([key]) => key)).size, entries.length, "duplicate security header");
  return new Map(entries);
}

test("all routes receive the complete browser security-header matrix", async () => {
  const headers = await headerMatrix();
  const expected = {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(self)",
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  };
  for (const [key, value] of Object.entries(expected)) assert.equal(headers.get(key), value, key);
});

test("content security policy is fail-closed with an explicit wallet frame allowlist", async () => {
  const headers = await headerMatrix();
  const csp = headers.get("Content-Security-Policy") ?? "";
  for (const directive of [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "connect-src 'self' https: wss:",
    "frame-src 'self' https://wallet.xbull.app https://albedo.link",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ]) assert.match(csp, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), directive);
  assert.doesNotMatch(csp, /frame-src\s+https?:\/\//, "wallet frame policy must remain origin-scoped");
});

test("security headers include no credentials or environment-specific values", async () => {
  const headers = await headerMatrix();
  for (const value of headers.values()) {
    assert.doesNotMatch(value, /(?:S[A-Z2-7]{55}|(?:api[_-]?key|secret|token)\s*[=:])/i);
  }
});
