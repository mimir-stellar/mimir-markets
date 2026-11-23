/**
 * tests/node/research-redirect-diagnostics.test.ts
 *
 * Tests for offline research redirect policy diagnostics:
 * - Redaction of URL identities (credentials, tokens, wallet strkeys, hex secrets).
 * - Per-hop scheme, domain, and SSRF verdicts.
 * - Offline evaluation of captured redirect chains (no network requests).
 * - Boundary handling: maxRedirects ceiling, loop detection, empty chains, malformed URLs.
 * - Integration with validateResearchContent.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  diagnoseRedirectPolicy,
  redactUrlIdentity,
  validateResearchContent,
  type ContentValidationResult,
  type RedirectPolicyDiagnostics,
} from "../../lib/research/content-validation";
import { type FetchSuccess } from "../../lib/research/gateway";
import { type DomainPolicy } from "../../lib/research/ssrf";

const PUBLIC_POLICY: DomainPolicy = { allow: [], deny: [] };

function makeSuccess(overrides: Partial<FetchSuccess> = {}): FetchSuccess {
  const body = "BTC close: 98,410.22 USD";
  const { createHash } = require("node:crypto");
  const contentHash = createHash("sha256").update(body).digest("hex");
  return {
    url: "https://example.com/initial",
    finalUrl: "https://example.com/target",
    status: 200,
    contentType: "text/html; charset=utf-8",
    body,
    contentHash,
    capturedAt: Date.now(),
    bytes: Buffer.byteLength(body),
    fromCache: false,
    redirects: 1,
    redirectChain: [
      "https://example.com/initial",
      "https://example.com/target",
    ],
    ...overrides,
  };
}

// ── 1. URL Identity Redaction ─────────────────────────────────────────────────

test("redactUrlIdentity preserves safe public URLs and paths", () => {
  const url = "https://example.com/market/btc-usd?page=1&sort=desc";
  assert.equal(redactUrlIdentity(url), url);
});

test("redactUrlIdentity redacts embedded username and password credentials", () => {
  const url = "https://admin:supersecret@example.com/data";
  const redacted = redactUrlIdentity(url);
  assert.equal(redacted, "https://[redacted]:[redacted]@example.com/data");
  assert.ok(!redacted.includes("admin"));
  assert.ok(!redacted.includes("supersecret"));
});

test("redactUrlIdentity redacts sensitive query tokens, API keys, and signatures", () => {
  const url = "https://api.example.com/v1/feed?token=xyz123&apiKey=key_abc&signature=0x1234567890abcdef1234567890abcdef12345678&safe=true";
  const redacted = redactUrlIdentity(url);
  assert.match(redacted, /token=\[redacted\]/);
  assert.match(redacted, /apiKey=\[redacted\]/);
  assert.match(redacted, /signature=\[redacted\]/);
  assert.match(redacted, /safe=true/);
  assert.ok(!redacted.includes("xyz123"));
  assert.ok(!redacted.includes("key_abc"));
});

test("redactUrlIdentity redacts Stellar G... and S... strkeys in path and query", () => {
  const pubkey = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  const seed = "S" + "AY5TUXQGLLD34KHY74R2GTRF2W5J37K4X63P2Z77PBRTRPDKI4B7UHO";
  const url = `https://example.com/accounts/${pubkey}/status?seed=${seed}&other=safe`;
  const redacted = redactUrlIdentity(url);
  assert.ok(!redacted.includes(pubkey));
  assert.ok(!redacted.includes(seed));
  assert.match(redacted, /\/accounts\/\[redacted\]\/status/);
  assert.match(redacted, /seed=\[redacted\]/);
  assert.match(redacted, /other=safe/);
});

test("redactUrlIdentity redacts hex identities and JWT-like tokens in path or query", () => {
  const hex = "0x5c42a24ec08baee12e131d279d46e3444fc6ef647b0df7b03657519bfb858be9";
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.G5XyC7q4sH-8qA0bLzQxK";
  const url = `https://example.com/tx/${hex}?auth=${jwt}`;
  const redacted = redactUrlIdentity(url);
  assert.ok(!redacted.includes(hex));
  assert.ok(!redacted.includes(jwt));
  assert.match(redacted, /\/tx\/\[redacted\]/);
  assert.match(redacted, /auth=\[redacted\]/);
});

test("redactUrlIdentity handles relative paths and malformed strings safely", () => {
  const rel = "/items/GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5?token=abc";
  const redactedRel = redactUrlIdentity(rel);
  assert.equal(redactedRel, "/items/[redacted]?token=[redacted]");

  const malformed = "not a valid url but has GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  const redactedMal = redactUrlIdentity(malformed);
  assert.ok(!redactedMal.includes("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"));
  assert.match(redactedMal, /\[redacted\]/);
});

// ── 2. Positive Offline Redirect Diagnostics ──────────────────────────────────

test("diagnoseRedirectPolicy succeeds for direct (zero redirect) URL", () => {
  const diag = diagnoseRedirectPolicy(["https://example.com/direct"], { policy: PUBLIC_POLICY });
  assert.equal(diag.totalHops, 1);
  assert.equal(diag.redirects, 0);
  assert.equal(diag.evaluatedHops, 1);
  assert.equal(diag.bounded, true);
  assert.equal(diag.allowed, true);
  assert.equal(diag.hops.length, 1);

  const hop0 = diag.hops[0]!;
  assert.equal(hop0.hop, 0);
  assert.equal(hop0.from, undefined);
  assert.equal(hop0.to, "https://example.com/direct");
  assert.equal(hop0.scheme.allowed, true);
  assert.equal(hop0.domain.allowed, true);
  assert.equal(hop0.ssrf.allowed, true);
  assert.equal(hop0.allowed, true);
});

test("diagnoseRedirectPolicy evaluates multi-hop redirect chain offline with redacted identities", () => {
  const chain = [
    "https://example.com/start?token=secret1",
    "https://example.com/hop1/GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    "https://example.com/final",
  ];
  const diag = diagnoseRedirectPolicy(chain, { policy: PUBLIC_POLICY, maxRedirects: 3 });

  assert.equal(diag.totalHops, 3);
  assert.equal(diag.redirects, 2);
  assert.equal(diag.evaluatedHops, 3);
  assert.equal(diag.bounded, true);
  assert.equal(diag.allowed, true);
  assert.equal(diag.hops.length, 3);

  // Check hop 0
  assert.equal(diag.hops[0]!.hop, 0);
  assert.equal(diag.hops[0]!.to, "https://example.com/start?token=[redacted]");

  // Check hop 1
  assert.equal(diag.hops[1]!.hop, 1);
  assert.equal(diag.hops[1]!.from, "https://example.com/start?token=[redacted]");
  assert.equal(diag.hops[1]!.to, "https://example.com/hop1/[redacted]");
  assert.equal(diag.hops[1]!.allowed, true);

  // Check hop 2
  assert.equal(diag.hops[2]!.hop, 2);
  assert.equal(diag.hops[2]!.from, "https://example.com/hop1/[redacted]");
  assert.equal(diag.hops[2]!.to, "https://example.com/final");
  assert.equal(diag.hops[2]!.allowed, true);
});

test("diagnoseRedirectPolicy operates directly on FetchSuccess fixture without network requests", () => {
  const success = makeSuccess({
    redirectChain: [
      "https://coingecko.com/en/coins/bitcoin",
      "https://coingecko.com/en/coins/btc",
    ],
  });
  const diag = diagnoseRedirectPolicy(success, { policy: PUBLIC_POLICY });
  assert.equal(diag.totalHops, 2);
  assert.equal(diag.redirects, 1);
  assert.equal(diag.allowed, true);
  assert.equal(diag.hops.length, 2);
});

// ── 3. Failure & Boundary Cases ───────────────────────────────────────────────

test("diagnoseRedirectPolicy flags protocol downgrade in scheme verdict", () => {
  const chain = ["https://example.com/secure", "http://example.com/insecure"];
  const diag = diagnoseRedirectPolicy(chain, {
    policy: { allow: [], deny: [], disallowProtocolDowngrade: true },
  });

  assert.equal(diag.allowed, false);
  assert.equal(diag.failureReason, "protocol_downgrade");
  assert.equal(diag.hops.length, 2);

  const hop1 = diag.hops[1]!;
  assert.equal(hop1.allowed, false);
  assert.equal(hop1.scheme.allowed, false);
  assert.equal(hop1.scheme.reason, "protocol_downgrade");
  assert.match(hop1.scheme.detail ?? "", /downgrade/i);
});

test("diagnoseRedirectPolicy flags non-fetchable scheme in scheme verdict", () => {
  const chain = ["https://example.com/start", "ftp://example.com/files"];
  const diag = diagnoseRedirectPolicy(chain, { policy: PUBLIC_POLICY });

  assert.equal(diag.allowed, false);
  assert.equal(diag.failureReason, "protocol");
  const hop1 = diag.hops[1]!;
  assert.equal(hop1.allowed, false);
  assert.equal(hop1.scheme.allowed, false);
  assert.equal(hop1.scheme.reason, "protocol");
});

test("diagnoseRedirectPolicy flags SSRF targets (private IPs and cloud metadata)", () => {
  const testCases = [
    { target: "http://169.254.169.254/latest/meta-data", expectedReason: "private_ip" },
    { target: "http://127.0.0.1/admin", expectedReason: "private_ip" },
    { target: "http://10.0.0.5/api", expectedReason: "private_ip" },
    { target: "http://localhost/", expectedReason: "hostname" },
    { target: "https://example.com:6379/", expectedReason: "port" },
  ];

  for (const { target, expectedReason } of testCases) {
    const diag = diagnoseRedirectPolicy(["https://example.com/public", target], { policy: PUBLIC_POLICY });
    assert.equal(diag.allowed, false, `Expected target ${target} to be refused`);
    assert.equal(diag.hops[1]!.ssrf.allowed, false);
    assert.equal(diag.hops[1]!.ssrf.reason, expectedReason);
  }
});

test("diagnoseRedirectPolicy flags cross-domain redirects when restricted", () => {
  const chain = ["https://example.com/a", "https://other-domain.com/b"];
  const diag = diagnoseRedirectPolicy(chain, {
    policy: { allow: [], deny: [], allowCrossDomainRedirects: false },
  });

  assert.equal(diag.allowed, false);
  assert.equal(diag.failureReason, "cross_domain");
  assert.equal(diag.hops[1]!.domain.allowed, false);
  assert.equal(diag.hops[1]!.domain.reason, "cross_domain");
});

test("diagnoseRedirectPolicy permits subdomain redirects under cross-domain restriction", () => {
  const chain = ["https://example.com/a", "https://api.example.com/b"];
  const diag = diagnoseRedirectPolicy(chain, {
    policy: { allow: [], deny: [], allowCrossDomainRedirects: false },
  });

  assert.equal(diag.allowed, true);
  assert.equal(diag.hops[1]!.domain.allowed, true);
});

test("diagnoseRedirectPolicy flags redirects to denied domains", () => {
  const chain = ["https://example.com/a", "https://malicious.com/b"];
  const diag = diagnoseRedirectPolicy(chain, {
    policy: { allow: [], deny: ["malicious.com"] },
  });

  assert.equal(diag.allowed, false);
  assert.equal(diag.hops[1]!.domain.allowed, false);
  assert.equal(diag.hops[1]!.domain.reason, "hostname");
});

test("diagnoseRedirectPolicy flags redirects to non-allowlisted domains", () => {
  const chain = ["https://allowed.com/a", "https://untrusted.com/b"];
  const diag = diagnoseRedirectPolicy(chain, {
    policy: { allow: ["allowed.com"], deny: [] },
  });

  assert.equal(diag.allowed, false);
  assert.equal(diag.hops[1]!.domain.allowed, false);
  assert.equal(diag.hops[1]!.domain.reason, "not_allowlisted");
});

test("diagnoseRedirectPolicy detects redirect cycles / loops offline and bounds execution", () => {
  const chain = [
    "https://example.com/a",
    "https://example.com/b",
    "https://example.com/c",
    "https://example.com/a",
  ];
  const diag = diagnoseRedirectPolicy(chain, { policy: PUBLIC_POLICY });

  assert.equal(diag.bounded, false);
  assert.equal(diag.allowed, false);
  assert.equal(diag.failureReason, "redirect_loop");
  assert.match(diag.failureDetail ?? "", /cycle|duplicate/i);
});

test("diagnoseRedirectPolicy enforces maxRedirects ceiling and marks bounded=false", () => {
  const chain = [
    "https://example.com/0",
    "https://example.com/1",
    "https://example.com/2",
    "https://example.com/3",
  ];
  const diag = diagnoseRedirectPolicy(chain, { policy: PUBLIC_POLICY, maxRedirects: 2 });

  assert.equal(diag.totalHops, 4);
  assert.equal(diag.redirects, 3);
  assert.equal(diag.bounded, false);
  assert.equal(diag.allowed, false);
  assert.equal(diag.failureReason, "too_many_redirects");
  assert.match(diag.failureDetail ?? "", /more than 2 redirects/);
  // Evaluated hops is bounded
  assert.ok(diag.evaluatedHops <= 3);
});

test("diagnoseRedirectPolicy handles empty chain gracefully", () => {
  const diag = diagnoseRedirectPolicy([], { policy: PUBLIC_POLICY });
  assert.equal(diag.totalHops, 0);
  assert.equal(diag.redirects, 0);
  assert.equal(diag.evaluatedHops, 0);
  assert.equal(diag.bounded, true);
  assert.equal(diag.allowed, true);
  assert.deepEqual(diag.hops, []);
});

// ── 4. validateResearchContent Integration ────────────────────────────────────

test("validateResearchContent exposes redirectDiagnostics on clean content", () => {
  const s = makeSuccess();
  const r = validateResearchContent(s);

  assert.equal(r.state, "valid");
  assert.equal(r.usable, true);
  assert.ok(r.redirectDiagnostics);
  assert.equal(r.redirectDiagnostics.allowed, true);
  assert.equal(r.redirectDiagnostics.totalHops, 2);
  assert.equal(r.redirectDiagnostics.redirects, 1);
});

test("validateResearchContent in strict mode rejects content with redirect policy violation", () => {
  const s = makeSuccess({
    redirectChain: [
      "https://example.com/safe",
      "http://example.com/insecure-downgrade",
    ],
  });

  const r = validateResearchContent(s, { strict: true });
  assert.equal(r.state, "invalid");
  assert.equal(r.usable, false);
  assert.match(r.reason, /redirect policy violation/i);
  assert.ok(r.redirectDiagnostics);
  assert.equal(r.redirectDiagnostics.allowed, false);
  assert.equal(r.redirectDiagnostics.failureReason, "protocol_downgrade");
});

test("validateResearchContent rejects content when enforceRedirectPolicy=true even in non-strict mode", () => {
  const s = makeSuccess({
    redirectChain: [
      "https://example.com/safe",
      "http://169.254.169.254/latest/meta-data",
    ],
  });

  const r = validateResearchContent(s, { enforceRedirectPolicy: true });
  assert.equal(r.state, "invalid");
  assert.equal(r.usable, false);
  assert.match(r.reason, /redirect policy violation/i);
  assert.equal(r.redirectDiagnostics?.failureReason, "private_ip");
});
