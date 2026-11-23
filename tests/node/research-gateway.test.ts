import assert from "node:assert/strict";
import test from "node:test";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  budgetRemaining,
  buildResearchIncidentBundle,
  commitReservation,
  gatewayFetch,
  invalidateIncompatibleResearchCache,
  invalidateResearchCache,
  normalizeSourceIdentity,
  reconcileInterruptedAttempts,
  releaseReservation,
  reserveBudget,
  resetBudgets,
  resetResearchCache,
  validateHop,
} from "../../lib/research/gateway";
import { validateResearchContent } from "../../lib/research/content-validation";
import { sha256Hex } from "../../lib/content-hash";

const PUBLIC_POLICY = { allow: [], deny: [] };
const publicDns = async () => ["93.184.216.34"];
const privateDns = async () => ["127.0.0.1"];

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    ...init,
  });
}

function redirectTo(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

function fresh() {
  resetBudgets();
  resetResearchCache();
}

// ── Hop validation ────────────────────────────────────────────────────────────

test("a public URL resolving publicly is allowed", async () => {
  const hop = await validateHop("https://example.com/report", PUBLIC_POLICY, publicDns);
  assert.equal(hop.allowed, true);
});

test("a public hostname resolving to loopback is refused — DNS rebinding", async () => {
  const hop = await validateHop("https://evil.example.com/", PUBLIC_POLICY, privateDns);
  assert.equal(hop.allowed, false);
  assert.equal(hop.allowed === false && hop.reason, "private_ip");
});

test("the domain policy is applied before DNS is even consulted", async () => {
  let resolved = false;
  const spy = async () => {
    resolved = true;
    return ["93.184.216.34"];
  };
  const hop = await validateHop("https://evil.com/", { allow: ["good.com"], deny: [] }, spy);
  assert.equal(hop.allowed, false);
  assert.equal(resolved, false, "DNS is the expensive check and must come last");
});

test("a host that does not resolve is refused, not assumed public", async () => {
  const hop = await validateHop("https://nx.example/", PUBLIC_POLICY, async () => {
    throw new Error("ENOTFOUND");
  });
  assert.equal(hop.allowed, false);
});

// ── Fetching ──────────────────────────────────────────────────────────────────

test("a plain successful fetch returns the body and a content hash", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/report",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("<html>BTC closed at 98,410</html>"),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.body, /98,410/);
  // SHA-256, bare hex — see lib/content-hash.ts.
  assert.match(result.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(result.fromCache, false);
  assert.equal(result.redirects, 0);
});

test("an SSRF target is refused with a typed reason, not an exception", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "http://169.254.169.254/latest/meta-data/",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("credentials"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "blocked");
});

test("a redirect INTO the metadata service is caught at the hop", async () => {
  // The reason redirects are followed manually: automatic following would make
  // this fetch succeed.
  fresh();
  let calls = 0;
  const result = await gatewayFetch({
    url: "https://example.com/start",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? redirectTo("http://169.254.169.254/latest/meta-data/")
        : htmlResponse("credentials");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "blocked");
  assert.equal(calls, 1, "the second hop must never be requested");
});

test("a redirect to a private IP is caught even when the first host was fine", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/start",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => redirectTo("http://10.0.0.5/secret"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "blocked");
});

test("a legitimate redirect chain is followed", async () => {
  fresh();
  let calls = 0;
  const result = await gatewayFetch({
    url: "https://example.com/a",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? redirectTo("https://example.com/b") : htmlResponse("final");
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.body, "final");
  assert.equal(result.redirects, 1);
  assert.equal(result.finalUrl, "https://example.com/b");
});

test("a redirect loop is bounded", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/loop",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => redirectTo("https://example.com/loop"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && (result.kind === "redirect_loop" || result.kind === "too_many_redirects"), true);
  assert.ok(MAX_REDIRECTS < 10);
});

test("a multi-hop redirect cycle is caught as a redirect_loop", async () => {
  fresh();
  let calls = 0;
  const result = await gatewayFetch({
    url: "https://example.com/a",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return redirectTo("https://example.com/b");
      if (calls === 2) return redirectTo("https://example.com/a");
      return htmlResponse("unreachable");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "redirect_loop");
});

test("a linear redirect chain exceeding maxRedirects is refused", async () => {
  fresh();
  let step = 0;
  const result = await gatewayFetch({
    url: "https://example.com/hop0",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    maxRedirects: 2,
    resolve: publicDns,
    fetchImpl: async () => {
      step += 1;
      return redirectTo(`https://example.com/hop${step}`);
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "too_many_redirects");
});

test("redirectChain records the full sequence of visited URLs", async () => {
  fresh();
  let step = 0;
  const result = await gatewayFetch({
    url: "https://example.com/start",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => {
      step += 1;
      if (step === 1) return redirectTo("https://example.com/middle");
      if (step === 2) return redirectTo("https://example.com/final");
      return htmlResponse("done");
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.finalUrl, "https://example.com/final");
  assert.equal(result.redirects, 2);
  assert.deepEqual(result.redirectChain, [
    "https://example.com/start",
    "https://example.com/middle",
    "https://example.com/final",
  ]);
});

test("protocol downgrade from https to http on redirect is refused", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/secure",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => redirectTo("http://example.com/insecure"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "protocol_downgrade");
});

test("cross-domain redirect is refused when allowCrossDomainRedirects is false", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/a",
    agentId: "oracle",
    policy: { allow: [], deny: [], allowCrossDomainRedirects: false },
    resolve: publicDns,
    fetchImpl: async () => redirectTo("https://other-domain.com/b"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "blocked");
  assert.equal(result.ok === false && result.kind === "blocked" && result.reason, "cross_domain");
});

test("sensitive headers are stripped on cross-origin redirects", async () => {
  fresh();
  let call = 0;
  let secondHopHeaders: Record<string, string> = {};
  const result = await gatewayFetch({
    url: "https://source.com/a",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    headers: {
      authorization: "Bearer secret-token",
      "x-api-key": "private-key-123",
      "x-wallet-address": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      "custom-trace": "trace-999",
    },
    resolve: publicDns,
    fetchImpl: async (_url, init) => {
      call += 1;
      if (call === 1) return redirectTo("https://target.com/b");
      secondHopHeaders = (init?.headers as Record<string, string>) ?? {};
      return htmlResponse("ok");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(secondHopHeaders["authorization"], undefined);
  assert.equal(secondHopHeaders["x-api-key"], undefined);
  assert.equal(secondHopHeaders["x-wallet-address"], undefined);
  assert.equal(secondHopHeaders["custom-trace"], "trace-999");
});

test("empty or missing location on redirect returns invalid_redirect", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/start",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "" } }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "invalid_redirect");
});

test("cancelled fetch with AbortSignal returns cancelled failure", async () => {
  fresh();
  const controller = new AbortController();
  controller.abort();
  const result = await gatewayFetch({
    url: "https://example.com/report",
    agentId: "oracle",
    signal: controller.signal,
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("not reached"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "cancelled");
});

test("a relative redirect target is resolved against the current URL", async () => {
  fresh();
  let calls = 0;
  const result = await gatewayFetch({
    url: "https://example.com/dir/a",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? redirectTo("/dir/b") : htmlResponse("ok");
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.finalUrl, "https://example.com/dir/b");
});

test("a non-text content type is refused", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/file.zip",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () =>
      new Response("PK", { status: 200, headers: { "content-type": "application/zip" } }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "content_type");
});

test("an oversized response is REFUSED, not silently truncated", async () => {
  // A truncated source is a silent correctness hazard for settlement.
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/huge",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("x".repeat(MAX_RESPONSE_BYTES + 1_000)),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "too_large");
});

test("a size limit is enforced even when Content-Length lies", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/liar",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () =>
      new Response("y".repeat(MAX_RESPONSE_BYTES + 500), {
        status: 200,
        headers: { "content-type": "text/plain", "content-length": "10" },
      }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "too_large");
});

test("an upstream error is reported with its status", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/gone",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => new Response("nope", { status: 503 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "http_error");
  assert.equal(result.ok === false && result.kind === "http_error" && result.status, 503);
});

test("a transport failure is a typed refusal, not a thrown error", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/x",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => {
      throw new Error("socket hang up");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "transport");
});

// ── Cache ─────────────────────────────────────────────────────────────────────

test("an identical fetch is served from cache and does not hit the source twice", async () => {
  fresh();
  let calls = 0;
  const impl = async () => {
    calls += 1;
    return htmlResponse("cached body");
  };
  const args = {
    url: "https://example.com/report",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: impl,
  };
  const first = await gatewayFetch(args);
  const second = await gatewayFetch(args);
  assert.equal(calls, 1, "the source must not be hammered");
  assert.equal(first.ok && first.fromCache, false);
  assert.equal(second.ok && second.fromCache, true);
});

test("a cache hit does not consume request budget", async () => {
  fresh();
  const args = {
    url: "https://example.com/report",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("body"),
  };
  await gatewayFetch(args);
  const afterFirst = budgetRemaining("oracle").requests;
  await gatewayFetch(args);
  assert.equal(budgetRemaining("oracle").requests, afterFirst);
});


test("cached research results are bound to content-validation policy revision", async () => {
  fresh();
  let calls = 0;
  const impl = async () => {
    calls += 1;
    return htmlResponse(`response ${calls}`);
  };
  const args = {
    url: "https://example.com/data",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: impl,
    policyRevision: "rev-2026-11-a",
  };
  const first = await gatewayFetch(args);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.fromCache, false);
  assert.equal(first.policyRevision, "rev-2026-11-a");

  const second = await gatewayFetch(args);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.fromCache, true);
  assert.equal(second.policyRevision, "rev-2026-11-a");
  assert.equal(calls, 1, "identical policy revision serves from cache");
});

test("invalidates incompatible cached decisions when validation changes", async () => {
  fresh();
  let calls = 0;
  const impl = async () => {
    calls += 1;
    return htmlResponse(`fetch-count-${calls}`);
  };
  const baseArgs = {
    url: "https://example.com/policy-bound-source",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: impl,
  };

  // 1. Fetch under initial policy revision "v1"
  const v1Result = await gatewayFetch({ ...baseArgs, policyRevision: "v1" });
  assert.equal(v1Result.ok, true);
  if (!v1Result.ok) return;
  assert.equal(v1Result.fromCache, false);
  assert.equal(v1Result.policyRevision, "v1");
  assert.match(v1Result.body, /fetch-count-1/);

  // 2. Repeat fetch under identical policy revision "v1" -> cache hit
  const v1Cached = await gatewayFetch({ ...baseArgs, policyRevision: "v1" });
  assert.equal(v1Cached.ok, true);
  if (!v1Cached.ok) return;
  assert.equal(v1Cached.fromCache, true);
  assert.equal(calls, 1);

  // 3. Validation policy changes to "v2" -> incompatible decision is invalidated and evicted
  const v2Result = await gatewayFetch({ ...baseArgs, policyRevision: "v2" });
  assert.equal(v2Result.ok, true);
  if (!v2Result.ok) return;
  assert.equal(v2Result.fromCache, false, "incompatible cached decision must not be served");
  assert.equal(v2Result.policyRevision, "v2");
  assert.match(v2Result.body, /fetch-count-2/);
  assert.equal(calls, 2, "validation change triggers fresh fetch");

  // 4. Repeat fetch under new revision "v2" -> serves the newly bound cached decision
  const v2Cached = await gatewayFetch({ ...baseArgs, policyRevision: "v2" });
  assert.equal(v2Cached.ok, true);
  if (!v2Cached.ok) return;
  assert.equal(v2Cached.fromCache, true);
  assert.equal(calls, 2);
});

test("invalidates incompatible cached decisions when validation changes via environment variable", async () => {
  fresh();
  const prevEnv = process.env.RESEARCH_CONTENT_VALIDATION_POLICY_REVISION;
  try {
    process.env.RESEARCH_CONTENT_VALIDATION_POLICY_REVISION = "env-policy-alpha";
    let calls = 0;
    const impl = async () => {
      calls += 1;
      return htmlResponse(`env-body-${calls}`);
    };
    const args = {
      url: "https://example.com/env-bound-source",
      agentId: "oracle",
      policy: PUBLIC_POLICY,
      resolve: publicDns,
      fetchImpl: impl,
    };

    const first = await gatewayFetch(args);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.fromCache, false);
    assert.equal(first.policyRevision, "env-policy-alpha");

    const second = await gatewayFetch(args);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.fromCache, true);
    assert.equal(calls, 1);

    // Operator updates policy revision in environment
    process.env.RESEARCH_CONTENT_VALIDATION_POLICY_REVISION = "env-policy-beta";
    const third = await gatewayFetch(args);
    assert.equal(third.ok, true);
    if (!third.ok) return;
    assert.equal(third.fromCache, false, "env change invalidates incompatible cached decision");
    assert.equal(third.policyRevision, "env-policy-beta");
    assert.equal(calls, 2);
  } finally {
    if (prevEnv !== undefined) {
      process.env.RESEARCH_CONTENT_VALIDATION_POLICY_REVISION = prevEnv;
    } else {
      delete process.env.RESEARCH_CONTENT_VALIDATION_POLICY_REVISION;
    }
  }
});

test("preserves separate cache entries for distinct normalized source identities", async () => {
  fresh();
  const fetches: Record<string, number> = {};
  const impl = async (input: RequestInfo | URL) => {
    const u = String(input);
    fetches[u] = (fetches[u] ?? 0) + 1;
    return htmlResponse(`body for ${u}`);
  };

  const mkArgs = (url: string) => ({
    url,
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: impl as typeof fetch,
    policyRevision: "v1",
  });

  // Distinct paths on same domain
  const resPathA = await gatewayFetch(mkArgs("https://example.com/market/btc"));
  const resPathB = await gatewayFetch(mkArgs("https://example.com/market/eth"));
  assert.equal(resPathA.ok, true);
  assert.equal(resPathB.ok, true);
  if (!resPathA.ok || !resPathB.ok) return;
  assert.match(resPathA.body, /market\/btc/);
  assert.match(resPathB.body, /market\/eth/);

  // Distinct query parameters
  const resQuery1 = await gatewayFetch(mkArgs("https://example.com/api/price?symbol=USDC"));
  const resQuery2 = await gatewayFetch(mkArgs("https://example.com/api/price?symbol=XLM"));
  assert.equal(resQuery1.ok, true);
  assert.equal(resQuery2.ok, true);
  if (!resQuery1.ok || !resQuery2.ok) return;
  assert.match(resQuery1.body, /symbol=USDC/);
  assert.match(resQuery2.body, /symbol=XLM/);

  // Re-fetch all 4 entries: every distinct normalized identity is preserved and hits cache
  const cachedA = await gatewayFetch(mkArgs("https://example.com/market/btc"));
  const cachedB = await gatewayFetch(mkArgs("https://example.com/market/eth"));
  const cachedQ1 = await gatewayFetch(mkArgs("https://example.com/api/price?symbol=USDC"));
  const cachedQ2 = await gatewayFetch(mkArgs("https://example.com/api/price?symbol=XLM"));

  assert.equal(cachedA.ok && cachedA.fromCache, true);
  assert.equal(cachedB.ok && cachedB.fromCache, true);
  assert.equal(cachedQ1.ok && cachedQ1.fromCache, true);
  assert.equal(cachedQ2.ok && cachedQ2.fromCache, true);

  assert.match(cachedA.ok ? cachedA.body : "", /market\/btc/);
  assert.match(cachedB.ok ? cachedB.body : "", /market\/eth/);
  assert.match(cachedQ1.ok ? cachedQ1.body : "", /symbol=USDC/);
  assert.match(cachedQ2.ok ? cachedQ2.body : "", /symbol=XLM/);
});

test("equivalent source identities resolve to the same normalized entry (casing, default port, fragments)", async () => {
  fresh();
  let calls = 0;
  const impl = async () => {
    calls += 1;
    return htmlResponse("canonical content");
  };

  const args1 = {
    url: "HTTPS://EXAMPLE.COM:443/report/q3?tab=all#section-intro",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: impl,
    policyRevision: "v1",
  };
  const first = await gatewayFetch(args1);
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.fromCache, false);
  assert.equal(calls, 1);

  // Different scheme casing, host casing, default port omitted, different fragment
  const args2 = {
    url: "https://example.com/report/q3?tab=all#section-conclusion",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: impl,
    policyRevision: "v1",
  };
  const second = await gatewayFetch(args2);
  assert.equal(second.ok, true);
  assert.equal(second.ok && second.fromCache, true);
  assert.equal(calls, 1, "equivalent normalized source identity must hit cache");
});

test("invalidateResearchCache purges entries matching normalized source identity", async () => {
  fresh();
  let calls = 0;
  const impl = async () => {
    calls += 1;
    return htmlResponse(`fetch-${calls}`);
  };
  const args = {
    url: "https://example.com/targeted-purge",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: impl,
    policyRevision: "v1",
  };
  await gatewayFetch(args);
  assert.equal(calls, 1);

  // Invalidate using differently cased URL with fragment and default port
  const deleted = invalidateResearchCache("HTTPS://EXAMPLE.COM:443/targeted-purge#fragment");
  assert.equal(deleted, true);

  // Next fetch must miss cache and re-hit source
  const refetched = await gatewayFetch(args);
  assert.equal(refetched.ok && refetched.fromCache, false);
  assert.equal(calls, 2);
});

test("invalidateIncompatibleResearchCache purges only incompatible entries", async () => {
  fresh();
  const impl = async (u: RequestInfo | URL) => htmlResponse(`body for ${u}`);
  await gatewayFetch({
    url: "https://example.com/v1-entry-1",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: impl as typeof fetch,
    policyRevision: "v1",
  });
  await gatewayFetch({
    url: "https://example.com/v1-entry-2",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: impl as typeof fetch,
    policyRevision: "v1",
  });
  await gatewayFetch({
    url: "https://example.com/v2-entry",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: impl as typeof fetch,
    policyRevision: "v2",
  });

  // Purge entries incompatible with "v2"
  const purged = invalidateIncompatibleResearchCache("v2");
  assert.equal(purged, 2);

  // v2 entry remains cached
  let v2Called = false;
  const v2Check = await gatewayFetch({
    url: "https://example.com/v2-entry",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: (async () => {
      v2Called = true;
      return htmlResponse("fresh");
    }) as typeof fetch,
    policyRevision: "v2",
  });
  assert.equal(v2Check.ok && v2Check.fromCache, true);
  assert.equal(v2Called, false);

  // v1 entries were purged
  let v1Called = false;
  const v1Check = await gatewayFetch({
    url: "https://example.com/v1-entry-1",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: (async () => {
      v1Called = true;
      return htmlResponse("fresh-v1");
    }) as typeof fetch,
    policyRevision: "v1",
  });
  assert.equal(v1Check.ok && v1Check.fromCache, false);
  assert.equal(v1Called, true);
});

test("normalizeSourceIdentity boundary cases", () => {
  assert.equal(normalizeSourceIdentity("  https://EXAMPLE.com/foo/bar?q=1#hash  "), "https://example.com/foo/bar?q=1");
  assert.equal(normalizeSourceIdentity("not-a-valid-url"), "not-a-valid-url");
  assert.equal(normalizeSourceIdentity("   "), "");
});
// ── Budget ────────────────────────────────────────────────────────────────────

test("an agent that exhausts its request budget is refused", async () => {
  fresh();
  const budget = { maxRequests: 2, maxBytes: 1_000_000 };
  const args = (n: number) => ({
    url: `https://example.com/${n}`,
    agentId: "greedy",
    policy: PUBLIC_POLICY,
    budget,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("body"),
  });
  assert.equal((await gatewayFetch(args(1))).ok, true);
  assert.equal((await gatewayFetch(args(2))).ok, true);
  const third = await gatewayFetch(args(3));
  assert.equal(third.ok, false);
  assert.equal(third.ok === false && third.kind, "budget");
});

test("budgets are per agent, so one greedy worker cannot starve another", async () => {
  fresh();
  const budget = { maxRequests: 1, maxBytes: 1_000_000 };
  const make = (agentId: string, n: number) => ({
    url: `https://example.com/${agentId}/${n}`,
    agentId,
    policy: PUBLIC_POLICY,
    budget,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("body"),
  });
  assert.equal((await gatewayFetch(make("a", 1))).ok, true);
  assert.equal((await gatewayFetch(make("a", 2))).ok, false);
  assert.equal((await gatewayFetch(make("b", 1))).ok, true, "agent b has its own budget");
});

test("a byte budget is enforced as well as a request count", async () => {
  fresh();
  const budget = { maxRequests: 100, maxBytes: 50 };
  const args = (n: number) => ({
    url: `https://example.com/${n}`,
    agentId: "chunky",
    policy: PUBLIC_POLICY,
    budget,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("z".repeat(60)),
  });
  assert.equal((await gatewayFetch(args(1))).ok, true);
  const second = await gatewayFetch(args(2));
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.kind, "budget");
});

test("a blocked request still costs nothing, so a refusal cannot drain a budget", async () => {
  fresh();
  const before = budgetRemaining("oracle").requests;
  await gatewayFetch({
    url: "http://127.0.0.1/x",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("x"),
  });
  assert.equal(budgetRemaining("oracle").requests, before);
});

test("budgetRemaining reports what is left and when the window resets", async () => {
  fresh();
  const budget = { maxRequests: 5, maxBytes: 1_000 };
  await gatewayFetch({
    url: "https://example.com/x",
    agentId: "reporter",
    policy: PUBLIC_POLICY,
    budget,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("body"),
  });
  const remaining = budgetRemaining("reporter", budget);
  assert.equal(remaining.requests, 4);
  assert.ok(remaining.bytes < 1_000);
  assert.ok(remaining.windowResetsAt > Date.now());
});

// ── Budget windows ────────────────────────────────────────────────────────────

test("a budget window resets once the period has elapsed", async () => {
  fresh();
  const budget = { maxRequests: 1, maxBytes: 1_000_000, windowMs: 60_000 };
  const t0 = 1_000_000;
  const args = (n: number, now: number) => ({
    url: `https://example.com/${n}`,
    agentId: "windowed",
    policy: PUBLIC_POLICY,
    budget,
    now,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("body"),
  });
  assert.equal((await gatewayFetch(args(1, t0))).ok, true);
  const exhausted = await gatewayFetch(args(2, t0 + 1));
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.ok === false && exhausted.kind, "budget");
  // Just before the boundary the window is still closed.
  const justBefore = await gatewayFetch(args(3, t0 + 60_000 - 1));
  assert.equal(justBefore.ok, false);
  assert.equal(justBefore.ok === false && justBefore.kind, "budget");
  // At the boundary the window has reset.
  const afterReset = await gatewayFetch(args(4, t0 + 60_000));
  assert.equal(afterReset.ok, true);
});

test("budgetRemaining reports a reset time that reflects the injected clock", () => {
  fresh();
  const budget = { maxRequests: 3, maxBytes: 1_000, windowMs: 30_000 };
  const now = 5_000_000;
  const remaining = budgetRemaining("clocked", budget, now);
  assert.equal(remaining.requests, 3);
  assert.equal(remaining.bytes, 1_000);
  assert.equal(remaining.windowResetsAt, now + 30_000);
});

test("budget windows are isolated between agents", async () => {
  fresh();
  const budget = { maxRequests: 1, maxBytes: 1_000_000, windowMs: 60_000 };
  const now = 2_000_000;
  const make = (agentId: string, n: number) => ({
    url: `https://example.com/${agentId}/${n}`,
    agentId,
    policy: PUBLIC_POLICY,
    budget,
    now,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("body"),
  });
  assert.equal((await gatewayFetch(make("alpha", 1))).ok, true);
  assert.equal((await gatewayFetch(make("alpha", 2))).ok, false);
  assert.equal((await gatewayFetch(make("beta", 1))).ok, true);
  assert.equal((await gatewayFetch(make("beta", 2))).ok, false);
  // Resetting alpha's window must not reset beta's.
  assert.equal((await gatewayFetch(make("alpha", 3))).ok, false);
  const alphaReset = await gatewayFetch({
    ...make("alpha", 4),
    now: now + 60_000,
  });
  assert.equal(alphaReset.ok, true);
  const betaStillClosed = await gatewayFetch(make("beta", 3));
  assert.equal(betaStillClosed.ok, false);
  assert.equal(betaStillClosed.ok === false && betaStillClosed.kind, "budget");
});

test("a cache hit does not advance the budget window", async () => {
  fresh();
  const budget = { maxRequests: 2, maxBytes: 1_000_000, windowMs: 60_000 };
  const t0 = 3_000_000;
  const args = {
    url: "https://example.com/cached",
    agentId: "cachebudget",
    policy: PUBLIC_POLICY,
    budget,
    now: t0,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("body"),
  };
  await gatewayFetch(args);
  const afterMiss = budgetRemaining("cachebudget", budget, t0);
  assert.equal(afterMiss.requests, 1);
  const hit = await gatewayFetch({ ...args, now: t0 + 1 });
  assert.equal(hit.ok, true);
  assert.equal(hit.ok && hit.fromCache, true);
  const afterHit = budgetRemaining("cachebudget", budget, t0 + 1);
  assert.equal(afterHit.requests, 1, "a cache hit must not be charged");
  assert.equal(afterHit.bytes, afterMiss.bytes);
  assert.equal(afterHit.windowResetsAt, afterMiss.windowResetsAt);
});

test("a cache miss after the window resets is charged against the new window", async () => {
  fresh();
  const budget = { maxRequests: 1, maxBytes: 1_000_000, windowMs: 60_000 };
  const t0 = 4_000_000;
  const args = (url: string, now: number) => ({
    url,
    agentId: "missreset",
    policy: PUBLIC_POLICY,
    budget,
    now,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("body"),
  });
  assert.equal((await gatewayFetch(args("https://example.com/a", t0))).ok, true);
  assert.equal((await gatewayFetch(args("https://example.com/b", t0 + 1))).ok, false);
  const afterReset = await gatewayFetch(args("https://example.com/c", t0 + 60_000));
  assert.equal(afterReset.ok, true);
  assert.equal(afterReset.ok && afterReset.fromCache, false);
});

test("resetBudgets clears every agent's window", async () => {
  fresh();
  const budget = { maxRequests: 1, maxBytes: 1_000_000, windowMs: 60_000 };
  const now = 6_000_000;
  const make = (agentId: string, n: number) => ({
    url: `https://example.com/${agentId}/${n}`,
    agentId,
    policy: PUBLIC_POLICY,
    budget,
    now,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("body"),
  });
  assert.equal((await gatewayFetch(make("one", 1))).ok, true);
  assert.equal((await gatewayFetch(make("two", 1))).ok, true);
  assert.equal((await gatewayFetch(make("one", 2))).ok, false);
  assert.equal((await gatewayFetch(make("two", 2))).ok, false);
  resetBudgets();
  assert.equal((await gatewayFetch(make("one", 3))).ok, true);
  assert.equal((await gatewayFetch(make("two", 3))).ok, true);
  const remaining = budgetRemaining("one", budget, now);
  assert.equal(remaining.requests, 0);
});

test("reserveBudget reserves bounded request and paid-fetch units before dispatch", async () => {
  fresh();
  const now = 1_000_000;
  const budget = { maxRequests: 5, maxBytes: 1_000_000, maxPaidUnits: 15_000, windowMs: 60_000 };

  // First reservation: 1 request, 5000 paid units
  const res1 = reserveBudget({
    agentId: "agent-a",
    requests: 1,
    paidUnits: 5000,
    budget,
    now,
  });
  assert.equal(res1.ok, true);
  if (res1.ok) {
    assert.equal(res1.reservation.agentId, "agent-a");
    assert.equal(res1.reservation.status, "reserved");
    assert.equal(res1.reservation.requests, 1);
    assert.equal(res1.reservation.paidUnits, 5000);
  }

  // Budget remaining accounts for the pending reservation
  const rem1 = budgetRemaining("agent-a", budget, now);
  assert.equal(rem1.requests, 4);
  assert.equal(rem1.paidUnits, 10000);

  // Second reservation: exceeds remaining paid units (needs 12000, only 10000 left)
  const resExceed = reserveBudget({
    agentId: "agent-a",
    requests: 1,
    paidUnits: 12000,
    budget,
    now,
  });
  assert.equal(resExceed.ok, false);
  if (!resExceed.ok) {
    assert.equal(resExceed.kind, "budget");
    assert.match(resExceed.detail, /paid-fetch unit budget/);
  }

  // Release first reservation: budget is restored
  if (res1.ok) {
    releaseReservation(res1.reservation.id);
  }
  const rem2 = budgetRemaining("agent-a", budget, now);
  assert.equal(rem2.requests, 5);
  assert.equal(rem2.paidUnits, 15000);
});

test("gatewayFetch enforces paid-fetch budget limits", async () => {
  fresh();
  const budget = { maxRequests: 10, maxBytes: 1_000_000, maxPaidUnits: 10_000 };
  let fetchCount = 0;
  const mockFetch = async () => {
    fetchCount++;
    return htmlResponse("paid content");
  };

  // First fetch with 6000 paidUnits: succeeds
  const res1 = await gatewayFetch({
    url: "https://example.com/paid-1",
    agentId: "paid-agent",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: mockFetch as typeof fetch,
    budget,
    paidUnits: 6000,
  });
  assert.equal(res1.ok, true);
  assert.equal(fetchCount, 1);

  // Second fetch with 5000 paidUnits: exceeds 10,000 ceiling (6000 + 5000 = 11000 > 10000)
  const res2 = await gatewayFetch({
    url: "https://example.com/paid-2",
    agentId: "paid-agent",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: mockFetch as typeof fetch,
    budget,
    paidUnits: 5000,
  });
  assert.equal(res2.ok, false);
  if (!res2.ok) {
    assert.equal(res2.kind, "budget");
    assert.match(res2.detail, /paid-fetch unit budget/);
  }
  // Upstream network was not hit for rejected fetch
  assert.equal(fetchCount, 1);
});

test("a request blocked before network releases reservation and costs no budget", async () => {
  fresh();
  const budget = { maxRequests: 2, maxBytes: 1_000_000, maxPaidUnits: 10_000 };
  const res = await gatewayFetch({
    url: "http://127.0.0.1/private-data",
    agentId: "agent-blocked",
    policy: PUBLIC_POLICY,
    resolve: privateDns,
    budget,
    paidUnits: 5000,
  });
  assert.equal(res.ok, false);
  // Entire allowance remains intact
  const remaining = budgetRemaining("agent-blocked", budget);
  assert.equal(remaining.requests, 2);
  assert.equal(remaining.paidUnits, 10000);
});

test("persists research acquisition budgets across simulated worker restarts", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "mimir-research-budget-"));
  try {
    fresh();
    const budget = { maxRequests: 5, maxBytes: 1_000_000, maxPaidUnits: 20_000 };
    const now = 2_000_000;

    // Dispatch a successful fetch with 8000 paid units in tempDir
    const fetchRes = await gatewayFetch({
      url: "https://example.com/worker-restart",
      agentId: "worker-agent",
      policy: PUBLIC_POLICY,
      resolve: publicDns,
      fetchImpl: (async () => htmlResponse("persisted")) as typeof fetch,
      budget,
      paidUnits: 8000,
      stateDir: tempDir,
      now,
    });
    assert.equal(fetchRes.ok, true);

    const remBefore = budgetRemaining("worker-agent", budget, now, tempDir);
    assert.equal(remBefore.requests, 4);
    assert.equal(remBefore.paidUnits, 12000);

    // Simulate worker process restart by clearing in-memory state
    resetBudgets();

    // After in-memory restart, disk state is restored seamlessly
    const remAfter = budgetRemaining("worker-agent", budget, now, tempDir);
    assert.equal(remAfter.requests, 4);
    assert.equal(remAfter.paidUnits, 12000);
  } finally {
    resetBudgets(tempDir);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reconciles interrupted attempts without resetting an agent's authorized budget", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "mimir-research-interrupted-"));
  try {
    fresh();
    const budget = { maxRequests: 5, maxBytes: 1_000_000, maxPaidUnits: 20_000 };
    const now = 3_000_000;

    // 1. First request committed normally (uses 1 request, 5000 paid units)
    const committed = await gatewayFetch({
      url: "https://example.com/committed",
      agentId: "crash-agent",
      policy: PUBLIC_POLICY,
      resolve: publicDns,
      fetchImpl: (async () => htmlResponse("done")) as typeof fetch,
      budget,
      paidUnits: 5000,
      stateDir: tempDir,
      now,
    });
    assert.equal(committed.ok, true);

    // 2. Second request reserved, but interrupted before network completion (e.g. process crash)
    const pendingRes = reserveBudget({
      agentId: "crash-agent",
      requests: 1,
      paidUnits: 10000,
      budget,
      now: now + 10,
      stateDir: tempDir,
      url: "https://example.com/interrupted-fetch",
    });
    assert.equal(pendingRes.ok, true);

    // While reserved, headroom is held: 3 requests left, 5000 paidUnits left
    const remWhileReserved = budgetRemaining("crash-agent", budget, now + 15, tempDir);
    assert.equal(remWhileReserved.requests, 3);
    assert.equal(remWhileReserved.paidUnits, 5000);

    // 3. Worker process crashes / restarts
    resetBudgets();

    // 4. On worker boot, reconcileInterruptedAttempts runs
    const reconcile = reconcileInterruptedAttempts({
      stateDir: tempDir,
      now: now + 50,
    });
    assert.equal(reconcile.reconciledCount, 1);
    assert.equal(reconcile.releasedRequests, 1);
    assert.equal(reconcile.releasedPaidUnits, 10000);
    assert.equal(reconcile.interruptedReservations[0].status, "interrupted");

    // 5. Verify the agent's authorized budget was NOT reset:
    // The committed 1 request and 5000 paidUnits remain accounted for (4 requests, 15000 paidUnits left),
    // and the dangling reservation headroom has been restored.
    const remAfterReconcile = budgetRemaining("crash-agent", budget, now + 60, tempDir);
    assert.equal(remAfterReconcile.requests, 4);
    assert.equal(remAfterReconcile.paidUnits, 15000);
  } finally {
    resetBudgets(tempDir);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("content validation marks interrupted attempts as unusable for settlement", () => {
  const body = "<html>partial</html>";
  const dummySuccess = {
    url: "https://example.com/interrupted",
    finalUrl: "https://example.com/interrupted",
    status: 200,
    contentType: "text/html",
    body,
    contentHash: sha256Hex(body),
    capturedAt: Date.now(),
    bytes: 20,
    fromCache: false,
    redirects: 0,
    redirectChain: ["https://example.com/interrupted"],
  };

  const validation = validateResearchContent(dummySuccess, {
    interrupted: true,
  });

  assert.equal(validation.usable, false);
  assert.equal(validation.state, "interrupted");
  assert.match(validation.reason, /interrupted/);
});

// ── Cache provenance (#864) ───────────────────────────────────────────────────

test("a fresh fetch reports itself as fetched, with capture time and policy revision", async () => {
  fresh();
  const t0 = 7_000_000;
  const result = await gatewayFetch({
    url: "https://example.com/provenance-fresh",
    agentId: "provenance-fresh",
    policy: PUBLIC_POLICY,
    now: t0,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("fresh body"),
    policyRevision: "v7",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.acquisition, "fetched");
  assert.equal(result.fromCache, false);
  assert.equal(result.capturedAt, t0);
  assert.equal(result.servedAt, t0);
  assert.equal(result.policyRevision, "v7");
});

test("a cache hit keeps the original capture time and revision instead of the replay time", async () => {
  fresh();
  const t0 = 8_000_000;
  const args = {
    url: "https://example.com/provenance-cached",
    agentId: "provenance-cached",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("cached body"),
    policyRevision: "v7",
  };
  const first = await gatewayFetch({ ...args, now: t0 });
  const replay = await gatewayFetch({ ...args, now: t0 + 30_000 });
  assert.equal(first.ok && replay.ok, true);
  if (!first.ok || !replay.ok) return;
  assert.equal(replay.acquisition, "cache");
  assert.equal(replay.fromCache, true);
  assert.equal(replay.capturedAt, t0, "replay time must not be presented as acquisition time");
  assert.equal(replay.servedAt, t0 + 30_000);
  assert.equal(replay.policyRevision, "v7");
  assert.equal(replay.policyRevision, first.policyRevision);
  assert.equal(replay.contentHash, first.contentHash);
});

test("a cache replay is judged stale by its original capture time, not the replay time", async () => {
  fresh();
  const replayAt = Date.now();
  const t0 = replayAt - 120_000; // captured two minutes ago, inside the cache TTL
  const args = {
    url: "https://example.com/provenance-stale",
    agentId: "provenance-stale",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("<p>BTC closed at 64,000</p>"),
  };
  await gatewayFetch({ ...args, now: t0 });
  const replay = await gatewayFetch({ ...args, now: replayAt });
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.acquisition, "cache");
  // 120 s after capture with a 60 s limit: stale, even though it was served just now.
  assert.equal(replay.capturedAt, t0);
  const verdict = validateResearchContent(replay, { maxAgeSeconds: 60 });
  assert.equal(verdict.state, "stale");
  assert.equal(verdict.policyRevision, replay.policyRevision);
});

test("serving a cache hit does not rewrite the cached entry", async () => {
  fresh();
  const t0 = 9_000_000;
  const args = {
    url: "https://example.com/provenance-repeat",
    agentId: "provenance-repeat",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("body"),
  };
  await gatewayFetch({ ...args, now: t0 });
  const hit1 = await gatewayFetch({ ...args, now: t0 + 1_000 });
  if (hit1.ok) hit1.redirectChain.push("https://tampered.example/");
  const hit2 = await gatewayFetch({ ...args, now: t0 + 2_000 });
  assert.equal(hit2.ok, true);
  if (!hit2.ok) return;
  assert.equal(hit2.capturedAt, t0);
  assert.equal(hit2.servedAt, t0 + 2_000);
  assert.deepEqual(hit2.redirectChain, ["https://example.com/provenance-repeat"]);
});

test("once the cache entry expires the next request is a new fetch with a new capture time", async () => {
  fresh();
  const t0 = 10_000_000;
  let calls = 0;
  const args = {
    url: "https://example.com/provenance-expired",
    agentId: "provenance-expired",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => {
      calls += 1;
      return htmlResponse(`body ${calls}`);
    },
  };
  await gatewayFetch({ ...args, now: t0 });
  const later = t0 + 24 * 60 * 60 * 1000;
  const refetch = await gatewayFetch({ ...args, now: later });
  assert.equal(calls, 2);
  assert.equal(refetch.ok, true);
  if (!refetch.ok) return;
  assert.equal(refetch.acquisition, "fetched");
  assert.equal(refetch.capturedAt, later);
  assert.equal(refetch.servedAt, later);
});
