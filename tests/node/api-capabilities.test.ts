import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CAPABILITIES_CACHE_CONTROL,
  CAPABILITIES_ROUTE,
  CapabilityRedactionError,
  assertCapabilityJsonSafe,
  buildCapabilityDocument,
  serializeCapabilityDocument,
  validateCapabilityDocument,
  type CapabilityDocument,
} from "../../lib/api/capabilities";
import { resetRateLimits } from "../../lib/api/rate-limit";
import {
  API_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  SCHEMA_VERSION_HEADER,
  SUPPORTED_CAPABILITY_SCHEMA_VERSIONS,
  resolveCapabilityVersionQuery,
} from "../../lib/api/schema";
import { NETWORK_PASSPHRASE, STELLAR_NETWORK } from "../../lib/stellar";
import { MIN_STAKE_USDC, USDC_ASSET, USDC_DECIMALS, USDC_ISSUER } from "../../lib/usdc";
import { PRICES, X402_NETWORK, X402_SCHEME } from "../../lib/x402/config";
import { DELETE, GET, HEAD, PATCH, POST, PUT } from "../../app/api/capabilities/route";

function cloneDoc(doc: CapabilityDocument): Record<string, unknown> {
  return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
}

const savedEnvEntries: Array<[string, string | undefined]> = [];

function injectEnv(vars: Record<string, string>): void {
  for (const [key, value] of Object.entries(vars)) {
    savedEnvEntries.push([key, process.env[key]]);
    process.env[key] = value;
  }
}

beforeEach(() => {
  resetRateLimits();
});

afterEach(() => {
  resetRateLimits();
  while (savedEnvEntries.length > 0) {
    const [key, prev] = savedEnvEntries.pop()!;
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
});

// ── 1. Positive capability document construction & HTTP GET ───────────────────

test("buildCapabilityDocument builds a deterministic, valid capability document", () => {
  const first = buildCapabilityDocument();
  const second = buildCapabilityDocument();

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));

  const validation = validateCapabilityDocument(first);
  assert.equal(validation.ok, true, validation.errors.join("; "));
  assert.deepEqual(validation.errors, []);

  assert.equal(first.schemaVersion, CAPABILITY_SCHEMA_VERSION);
  assert.equal(first.schemaVersion, "mimir.capabilities.v1");
  assert.equal(first.apiSchemaVersion, API_SCHEMA_VERSION);
  assert.deepEqual(first.supportedSchemaVersions, [...SUPPORTED_CAPABILITY_SCHEMA_VERSIONS]);
  assert.equal(first.discoveryPath, CAPABILITIES_ROUTE);
  assert.equal(first.service.schemaVersionHeader, SCHEMA_VERSION_HEADER);

  assert.equal(first.network.caip2, X402_NETWORK);
  assert.equal(first.network.caip2, "stellar:testnet");
  assert.equal(first.network.network, STELLAR_NETWORK);
  assert.equal(first.network.passphrase, NETWORK_PASSPHRASE);
  assert.deepEqual(first.network.addressKinds, ["G", "C"]);
  assert.deepEqual(first.network.nativeFeeAsset, { code: "XLM", decimals: 7 });

  assert.equal(first.asset.code, "USDC");
  assert.equal(first.asset.symbol, "USDC");
  assert.equal(first.asset.issuer, USDC_ISSUER);
  assert.equal(first.asset.asset, USDC_ASSET);
  assert.equal(first.asset.decimals, USDC_DECIMALS);
  assert.equal(first.asset.minStakeUsdc, MIN_STAKE_USDC);

  assert.equal(first.paymentProtocol.protocol, "x402");
  assert.equal(first.paymentProtocol.version, 2);
  assert.equal(first.paymentProtocol.scheme, X402_SCHEME);
  assert.equal(first.paymentProtocol.network, "stellar:testnet");
  assert.equal(first.paymentProtocol.asset, USDC_ASSET);

  const byPath = new Map(first.endpoints.map((ep) => [ep.path, ep]));
  assert.equal(byPath.get("/api/capabilities")?.category, "discovery");
  assert.equal(byPath.get("/api/capabilities")?.schemaVersion, "mimir.capabilities.v1");
  assert.equal(byPath.get("/api/vs")?.rateLimit.tier, "public_read");
  assert.equal(byPath.get("/api/health")?.paymentRequired, false);
  assert.equal(byPath.get("/api/oracle")?.paymentRequired, true);
  assert.equal(byPath.get("/api/oracle")?.payment?.priceUsd, PRICES.oracle);
  assert.equal(byPath.get("/api/oracle")?.payment?.priceAtomic, "50000");
  assert.equal(byPath.get("/api/council/reasoning")?.auth, "x402_or_pass");
  assert.equal(byPath.get("/api/council/reasoning")?.payment?.passPlan, "council");
  assert.equal(byPath.get("/api/agents/v1/{action}")?.category, "agent_api");
  assert.equal(byPath.get("/api/agents/v1/{action}")?.rateLimit.tier, "registered_agent");
  assert.equal(byPath.get("/api/agents/v1/{action}")?.schemaVersion, "v1");
});

test("GET /api/capabilities returns 200 with Cache-Control, schema headers, ETag, and deterministic JSON", async () => {
  const res1 = await GET(
    new Request("http://localhost/api/capabilities", {
      headers: { "x-forwarded-for": "198.51.100.10" },
    }),
  );
  const res2 = await GET(
    new Request("http://localhost/api/capabilities", {
      headers: { "x-forwarded-for": "198.51.100.10" },
    }),
  );

  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);
  assert.equal(res1.headers.get("content-type"), "application/json");
  assert.equal(res1.headers.get("cache-control"), CAPABILITIES_CACHE_CONTROL);
  assert.equal(res1.headers.get(SCHEMA_VERSION_HEADER), String(API_SCHEMA_VERSION));

  const etag1 = res1.headers.get("etag");
  const etag2 = res2.headers.get("etag");
  assert.ok(etag1 && etag1.startsWith('W/"mimir.capabilities.v1-'));
  assert.equal(etag1, etag2);

  const text1 = await res1.text();
  const text2 = await res2.text();
  assert.equal(text1, text2);

  const body = JSON.parse(text1) as CapabilityDocument;
  assert.equal(validateCapabilityDocument(body).ok, true);
  assert.equal(body.schemaVersion, "mimir.capabilities.v1");

  const notModified = await GET(
    new Request("http://localhost/api/capabilities", {
      headers: {
        "x-forwarded-for": "198.51.100.10",
        "if-none-match": etag1,
      },
    }),
  );
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.get("cache-control"), CAPABILITIES_CACHE_CONTROL);
  assert.equal(notModified.headers.get("etag"), etag1);
  assert.equal(await notModified.text(), "");
});

test("GET /api/capabilities accepts supported explicit version/schemaVersion queries and HEAD", async () => {
  const urls = [
    "http://localhost/api/capabilities?schemaVersion=mimir.capabilities.v1",
    "http://localhost/api/capabilities?version=mimir.capabilities.v1",
    "http://localhost/api/capabilities?version=1",
    "http://localhost/api/capabilities?version=v1",
    "http://localhost/api/capabilities?version=1&schemaVersion=mimir.capabilities.v1",
  ];

  const expectedBody = JSON.stringify(buildCapabilityDocument());
  for (const url of urls) {
    const res = await GET(
      new Request(url, { headers: { "x-forwarded-for": "198.51.100.11" } }),
    );
    assert.equal(res.status, 200, url);
    assert.equal(await res.text(), expectedBody, url);
  }

  const headRes = await HEAD(
    new Request("http://localhost/api/capabilities", {
      method: "HEAD",
      headers: { "x-forwarded-for": "198.51.100.11" },
    }),
  );
  assert.equal(headRes.status, 200);
  assert.equal(headRes.headers.get("cache-control"), CAPABILITIES_CACHE_CONTROL);
  assert.equal(await headRes.text(), "");
});

// ── 2. Boundary & error cases ─────────────────────────────────────────────────

test("rejects unsupported version and schemaVersion parameters cleanly via lib/api/errors.ts", async () => {
  const cases: Array<{ url: string; field: string }> = [
    { url: "http://localhost/api/capabilities?schemaVersion=mimir.capabilities.v2", field: "schemaVersion" },
    { url: "http://localhost/api/capabilities?schemaVersion=mimir.capabilities.v0", field: "schemaVersion" },
    { url: "http://localhost/api/capabilities?version=mimir.capabilities.v2", field: "version" },
    { url: "http://localhost/api/capabilities?version=2", field: "version" },
    { url: "http://localhost/api/capabilities?version=v2", field: "version" },
    { url: "http://localhost/api/capabilities?version=0", field: "version" },
  ];

  for (const testCase of cases) {
    const res = await GET(
      new Request(testCase.url, { headers: { "x-forwarded-for": "198.51.100.12" } }),
    );
    assert.equal(res.status, 400, testCase.url);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = (await res.json()) as {
      error: { code: string; retryable: boolean; field?: string };
    };
    assert.equal(body.error.code, "unsupported_version", testCase.url);
    assert.equal(body.error.retryable, false, testCase.url);
    assert.equal(body.error.field, testCase.field, testCase.url);
  }

  const headerUnsupported = await GET(
    new Request("http://localhost/api/capabilities", {
      headers: {
        "x-forwarded-for": "198.51.100.12",
        [SCHEMA_VERSION_HEADER]: "2",
      },
    }),
  );
  assert.equal(headerUnsupported.status, 400);
  const headerBody = (await headerUnsupported.json()) as {
    error: { code: string; retryable: boolean; field?: string };
  };
  assert.equal(headerBody.error.code, "unsupported_version");
  assert.equal(headerBody.error.retryable, false);
  assert.equal(headerBody.error.field, SCHEMA_VERSION_HEADER);
});

test("rejects malformed and conflicting duplicate scalar query parameters", async () => {
  const badUrls: Array<{ url: string; field: string }> = [
    { url: "http://localhost/api/capabilities?schemaVersion=", field: "schemaVersion" },
    { url: "http://localhost/api/capabilities?schemaVersion=1.0", field: "schemaVersion" },
    { url: "http://localhost/api/capabilities?schemaVersion=mimir.capabilities.v01", field: "schemaVersion" },
    { url: "http://localhost/api/capabilities?version=", field: "version" },
    { url: "http://localhost/api/capabilities?version=1abc", field: "version" },
    { url: "http://localhost/api/capabilities?version=latest", field: "version" },
    { url: "http://localhost/api/capabilities?version=1&version=2", field: "version" },
    { url: "http://localhost/api/capabilities?version=1&version=1", field: "version" },
    {
      url: "http://localhost/api/capabilities?schemaVersion=mimir.capabilities.v1&schemaVersion=mimir.capabilities.v2",
      field: "schemaVersion",
    },
    {
      url: "http://localhost/api/capabilities?schemaVersion=mimir.capabilities.v1&schemaVersion=mimir.capabilities.v1",
      field: "schemaVersion",
    },
  ];

  for (const testCase of badUrls) {
    const res = await GET(
      new Request(testCase.url, { headers: { "x-forwarded-for": "198.51.100.13" } }),
    );
    assert.equal(res.status, 400, testCase.url);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = (await res.json()) as {
      error: { code: string; retryable: boolean; field?: string };
    };
    assert.equal(body.error.code, "invalid_request", testCase.url);
    assert.equal(body.error.retryable, false, testCase.url);
    assert.equal(body.error.field, testCase.field, testCase.url);
  }

  const conflictingCrossParams = await GET(
    new Request("http://localhost/api/capabilities?version=2&schemaVersion=mimir.capabilities.v1", {
      headers: { "x-forwarded-for": "198.51.100.13" },
    }),
  );
  assert.equal(conflictingCrossParams.status, 400);
  const crossBody = (await conflictingCrossParams.json()) as {
    error: { code: string; retryable: boolean };
  };
  assert.equal(crossBody.error.retryable, false);
});

test("POST and other unsupported HTTP methods return 405 with Allow header", async () => {
  const methodHandlers = [
    ["POST", POST],
    ["PUT", PUT],
    ["PATCH", PATCH],
    ["DELETE", DELETE],
  ] as const;

  for (const [method, handler] of methodHandlers) {
    const res = await handler(
      new Request("http://localhost/api/capabilities", { method }),
    );
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get("allow"), "GET, HEAD", method);
    assert.equal(res.headers.get("cache-control"), "no-store", method);
    const body = (await res.json()) as {
      error: { code: string; retryable: boolean };
    };
    assert.equal(body.error.code, "invalid_request", method);
    assert.equal(body.error.retryable, false, method);
  }

  const directPostToGet = await GET(
    new Request("http://localhost/api/capabilities", { method: "POST" }),
  );
  assert.equal(directPostToGet.status, 405);
  assert.equal(directPostToGet.headers.get("allow"), "GET, HEAD");
});

test("public_read rate limit returns 429 retryable envelope", async () => {
  const ip = "198.51.100.99";
  let last: Response | undefined;
  for (let i = 0; i < 310; i += 1) {
    last = await GET(
      new Request("http://localhost/api/capabilities", {
        headers: { "x-forwarded-for": ip },
      }),
    );
    if (last.status === 429) break;
  }

  assert.ok(last);
  assert.equal(last.status, 429);
  assert.equal(last.headers.get("cache-control"), "no-store");
  assert.equal(last.headers.get("retry-after"), "60");
  const body = (await last.json()) as {
    error: { code: string; retryable: boolean; retryAfterSeconds?: number };
  };
  assert.equal(body.error.code, "rate_limited");
  assert.equal(body.error.retryable, true);
  assert.equal(body.error.retryAfterSeconds, 60);
});

// ── 3. Adversarial security & redaction regression tests ──────────────────────

test("adversarial env injection of secrets, DB URLs, RPC keys, and admin toggles produces zero leakage", async () => {
  const dummySeed = `S${"A".repeat(55)}`;
  const dummyDbUrl = "postgresql://mimir_admin:topsecretpass@internal-db.private:5432/mimir";
  const dummyTursoUrl = "libsql://secret-token@turso-internal.local";
  const dummyCronSecret = "cron-super-secret-value-987654321";
  const dummyPassSecret = "pass-hmac-signing-secret-123456789";
  const dummyRpcUrl = "https://rpc.private-provider.example/v1/api-key-99887766";
  const dummyHorizonUrl = "https://horizon-internal:adminpass@internal.horizon.local";
  const dummyApiKey = `sk_live_${"9".repeat(24)}`;
  const dummySeller = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

  injectEnv({
    DATABASE_URL: dummyDbUrl,
    TURSO_DATABASE_URL: dummyTursoUrl,
    CRON_SECRET: dummyCronSecret,
    PASS_SECRET: dummyPassSecret,
    ORACLE_SECRET_SEED: dummySeed,
    STELLAR_ORACLE_SECRET: dummySeed,
    CREATOR_SECRET: dummySeed,
    COINGECKO_API_KEY: dummyApiKey,
    GROQ_API_KEY: dummyApiKey,
    STELLAR_RPC_URL: dummyRpcUrl,
    NEXT_PUBLIC_STELLAR_RPC_URL: dummyRpcUrl,
    STELLAR_HORIZON_URL: dummyHorizonUrl,
    NEXT_PUBLIC_STELLAR_HORIZON_URL: dummyHorizonUrl,
    SELLER_ADDRESS: dummySeller,
    MIMIR_PAUSE_ALL: "1",
    MIMIR_PAUSE_STAKE: "1",
  });

  const doc = buildCapabilityDocument();
  const res = await GET(
    new Request("http://localhost/api/capabilities", {
      headers: { "x-forwarded-for": "198.51.100.77" },
    }),
  );
  assert.equal(res.status, 200);
  const json = await res.text();
  assert.equal(json, JSON.stringify(doc));

  const forbiddenNeedles = [
    dummySeed,
    dummyDbUrl,
    dummyTursoUrl,
    dummyCronSecret,
    dummyPassSecret,
    dummyRpcUrl,
    dummyHorizonUrl,
    dummyApiKey,
    dummySeller,
    "DATABASE_URL",
    "TURSO_DATABASE_URL",
    "CRON_SECRET",
    "PASS_SECRET",
    "ORACLE_SECRET_SEED",
    "MIMIR_PAUSE_",
    "internal_worker",
    "/api/cron",
    "/api/proposals/review",
    "/api/admin",
    "http://",
    "https://",
  ];

  for (const needle of forbiddenNeedles) {
    assert.equal(
      json.includes(needle),
      false,
      `serialized capability response must never contain ${needle}`,
    );
  }
});

test("allowlist serializer and denylist guard fail closed on injected admin/secret fields", () => {
  const base = buildCapabilityDocument();

  const tamperedKeys = [
    { key: "cronSecret", value: "abc" },
    { key: "databaseUrl", value: "x" },
    { key: "passSecret", value: "x" },
    { key: "oracleSecretSeed", value: "x" },
    { key: "adminConfig", value: { enabled: true } },
    { key: "internalUrl", value: "internal" },
    { key: "rpcApiKey", value: "xyz" },
    { key: "killSwitch", value: false },
  ];

  for (const { key, value } of tamperedKeys) {
    const poisoned = { ...cloneDoc(base), [key]: value };
    assert.throws(
      () => serializeCapabilityDocument(poisoned),
      CapabilityRedactionError,
      `denylisted key ${key} must fail closed`,
    );
    const verdict = validateCapabilityDocument(poisoned);
    assert.equal(verdict.ok, false, `validator must reject ${key}`);
  }

  // Unexpected non-denylisted property is still rejected by strict schema check
  const withUnexpected = { ...cloneDoc(base), extraDebugNote: "internal" };
  assert.equal(validateCapabilityDocument(withUnexpected).ok, false);
  assert.throws(() => serializeCapabilityDocument(withUnexpected), /Invalid capability document/);

  // Secret-shaped values in otherwise valid fields fail closed
  const dummySeed = `S${"B".repeat(55)}`;
  const withSeedInSummary = cloneDoc(base);
  ((withSeedInSummary.endpoints as Array<Record<string, unknown>>)[0]!).summary =
    `Leaked ${dummySeed}`;
  assert.throws(() => serializeCapabilityDocument(withSeedInSummary), CapabilityRedactionError);

  const withInternalRoute = cloneDoc(base);
  ((withInternalRoute.endpoints as Array<Record<string, unknown>>)[0]!).path = "/api/cron/sync";
  assert.throws(() => serializeCapabilityDocument(withInternalRoute), /Invalid capability document/);

  const withInternalTier = cloneDoc(base);
  (((withInternalTier.endpoints as Array<Record<string, unknown>>)[0]!)
    .rateLimit as Record<string, unknown>).tier = "internal_worker";
  assert.throws(() => serializeCapabilityDocument(withInternalTier), /Invalid capability document/);

  // Runtime JSON env leakage check catches any env value present in serialized text
  assert.throws(
    () =>
      assertCapabilityJsonSafe('{"leak":"super-secret-cron-value-999"}', {
        CRON_SECRET: "super-secret-cron-value-999",
      }),
    CapabilityRedactionError,
  );
});

test("resolveCapabilityVersionQuery enforces strict scalar negotiation and published OpenAPI doc includes /api/capabilities", () => {
  assert.deepEqual(resolveCapabilityVersionQuery(new URLSearchParams("")), {
    ok: true,
    schemaVersion: "mimir.capabilities.v1",
  });
  assert.deepEqual(resolveCapabilityVersionQuery(new URLSearchParams("version=1")), {
    ok: true,
    schemaVersion: "mimir.capabilities.v1",
  });
  assert.deepEqual(resolveCapabilityVersionQuery(new URLSearchParams("version=v1")), {
    ok: true,
    schemaVersion: "mimir.capabilities.v1",
  });
  assert.deepEqual(
    resolveCapabilityVersionQuery(new URLSearchParams("schemaVersion=mimir.capabilities.v1")),
    { ok: true, schemaVersion: "mimir.capabilities.v1" },
  );

  const dupVersion = resolveCapabilityVersionQuery(new URLSearchParams("version=1&version=2"));
  assert.equal(dupVersion.ok, false);
  assert.equal(dupVersion.reason, "conflicting_version");
  assert.equal(dupVersion.field, "version");

  const unsupported = resolveCapabilityVersionQuery(
    new URLSearchParams("schemaVersion=mimir.capabilities.v2"),
  );
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.reason, "unsupported_version");
  assert.equal(unsupported.field, "schemaVersion");

  const malformed = resolveCapabilityVersionQuery(new URLSearchParams("schemaVersion=not-valid"));
  assert.equal(malformed.ok, false);
  assert.equal(malformed.reason, "malformed_version");
  assert.equal(malformed.field, "schemaVersion");

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const openApiYaml = readFileSync(path.join(repoRoot, "docs", "openapi-public-v1.yaml"), "utf8");
  assert.ok(openApiYaml.includes('"/api/capabilities":'));
  assert.ok(openApiYaml.includes("CapabilityDocumentResponse:"));
});
