import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, test } from "node:test";
import { Keypair } from "@stellar/stellar-sdk";

import {
  AGENT_API_VERSION,
  agentRequestMessage,
  type SignedAgentRequest,
} from "../../lib/agents/api";
import { requiresOwnerSignature } from "../../lib/agents/authenticate";
import { verifyAgentSignature } from "../../lib/agents/signature";
import { AUTHORITY_LEVELS, defaultLimits, type AgentRecord } from "../../lib/agents/registry";
import { saveAgent } from "../../lib/agents/store";
import {
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  MAX_PENDING_WEBHOOK_EVENTS_PER_AGENT,
  MAX_WEBHOOK_DELIVERY_ATTEMPTS,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  buildWebhookClaimSnapshot,
  buildWebhookRetrySchedule,
  computeWebhookHmac,
  computeWebhookRetryDelay,
  detectClaimLifecycleEvents,
  enqueueClaimLifecycleEvent,
  flushWebhookQueue,
  generateWebhookSecret,
  getPendingWebhookDeliveries,
  getWebhookDelivery,
  registerAgentWebhook,
  resetWebhooksForTest,
  signWebhookPayload,
  validateWebhookUrl,
  verifyWebhookSignature,
  webhookRetryCeilingMs,
  webhookSigningPayload,
  type WebhookEventPayload,
} from "../../lib/agents/webhooks";
import type { ClaimData } from "../../lib/contract";
import { WEBHOOK_BACKOFF, resetFailureCounters } from "../../lib/ops/backoff-policies";

const PUBLIC_DNS = async () => ["93.184.216.34"];
const PRIVATE_DNS_LOOPBACK = async () => ["127.0.0.1"];
const PRIVATE_DNS_METADATA = async () => ["169.254.169.254"];
const MIXED_DNS = async () => ["93.184.216.34", "10.0.0.8"];

function sampleClaim(overrides: Partial<ClaimData> = {}): ClaimData {
  return {
    id: 101,
    creator: "GB7RICBT3KM36Z5VDUFC63BYHTVZXM6IQZMWJ3LRNSM5RM63TRTJARRK",
    question: "Will ETH close above 4,000 USD on Friday?",
    creator_position: "Yes, ETH closes above 4,000 USD.",
    counter_position: "No, ETH closes at or below 4,000 USD.",
    resolution_url: "https://example.com/eth-price",
    creator_stake: 50,
    total_challenger_stake: 0,
    reserved_creator_liability: 0,
    available_creator_liability: 50,
    deadline: 1_780_100_000,
    state: "open",
    winner_side: "",
    resolution_summary: "",
    confidence: 0,
    category: "crypto",
    parent_id: 0,
    challenger_count: 0,
    market_type: "binary",
    odds_mode: "pool",
    challenger_payout_bps: 20000,
    handicap_line: "",
    settlement_rule: "CoinGecko daily close",
    max_challengers: 10,
    visibility: "public",
    is_private: false,
    resolve_attempts: 0,
    creator_requested_resolve: false,
    challenger_requested_resolve: false,
    first_challenger: "",
    challenger_addresses: [],
    total_pot: 50,
    ...overrides,
  };
}

afterEach(() => {
  resetWebhooksForTest();
  resetFailureCounters("webhook:agent-alpha");
  resetFailureCounters("webhook:agent-beta");
});

// ── 1. HMAC Signing & Verification ───────────────────────────────────────────

describe("webhook HMAC signing & verification", () => {
  const secret = generateWebhookSecret();
  const rawBody = JSON.stringify({
    schemaVersion: 1,
    deliveryId: "deliv-1",
    event: "claim.created",
    occurredAt: 1_780_000_000_000,
    claim: { id: 101 },
  });
  const timestamp = 1_780_000_000;

  test("generates a secret with whsec_ prefix and 64 hex chars", () => {
    assert.match(secret, /^whsec_[0-9a-f]{64}$/);
    assert.notEqual(generateWebhookSecret(), generateWebhookSecret());
  });

  test("signs and verifies a valid webhook payload within tolerance", () => {
    const signed = signWebhookPayload(secret, rawBody, timestamp);
    assert.equal(signed.timestampSeconds, timestamp);
    assert.match(signed.signature, /^[0-9a-f]{64}$/);
    assert.equal(signed.header, `t=${timestamp},v1=${signed.signature}`);
    assert.equal(
      signed.signature,
      computeWebhookHmac(secret, timestamp, rawBody),
    );
    assert.equal(
      webhookSigningPayload(timestamp, rawBody),
      `${timestamp}.${rawBody}`,
    );

    const verified = verifyWebhookSignature({
      secret,
      rawBody,
      signatureHeader: signed.header,
      nowSeconds: timestamp + 30,
    });
    assert.deepEqual(verified, { ok: true, timestampSeconds: timestamp });
  });

  test("rejects a tampered body with signature_mismatch", () => {
    const signed = signWebhookPayload(secret, rawBody, timestamp);
    const tamperedBody = rawBody.replace("claim.created", "claim.resolved");
    const verified = verifyWebhookSignature({
      secret,
      rawBody: tamperedBody,
      signatureHeader: signed.header,
      nowSeconds: timestamp,
    });
    assert.deepEqual(verified, { ok: false, reason: "signature_mismatch" });
  });

  test("rejects a wrong secret with signature_mismatch", () => {
    const signed = signWebhookPayload(secret, rawBody, timestamp);
    const wrongSecret = generateWebhookSecret();
    const verified = verifyWebhookSignature({
      secret: wrongSecret,
      rawBody,
      signatureHeader: signed.header,
      nowSeconds: timestamp,
    });
    assert.deepEqual(verified, { ok: false, reason: "signature_mismatch" });
  });

  test("rejects a stale or future timestamp outside tolerance window", () => {
    const signed = signWebhookPayload(secret, rawBody, timestamp);
    const expired = verifyWebhookSignature({
      secret,
      rawBody,
      signatureHeader: signed.header,
      nowSeconds: timestamp + DEFAULT_WEBHOOK_TOLERANCE_SECONDS + 1,
    });
    assert.deepEqual(expired, { ok: false, reason: "timestamp_expired" });

    const future = verifyWebhookSignature({
      secret,
      rawBody,
      signatureHeader: signed.header,
      nowSeconds: timestamp - DEFAULT_WEBHOOK_TOLERANCE_SECONDS - 5,
    });
    assert.deepEqual(future, { ok: false, reason: "timestamp_expired" });
  });

  test("rejects missing or malformed signature headers cleanly", () => {
    assert.deepEqual(
      verifyWebhookSignature({ secret, rawBody, signatureHeader: null }),
      { ok: false, reason: "missing_signature" },
    );
    assert.deepEqual(
      verifyWebhookSignature({ secret, rawBody, signatureHeader: "   " }),
      { ok: false, reason: "missing_signature" },
    );
    assert.deepEqual(
      verifyWebhookSignature({ secret, rawBody, signatureHeader: "v1=deadbeef" }),
      { ok: false, reason: "malformed_header" },
    );
    assert.deepEqual(
      verifyWebhookSignature({ secret, rawBody, signatureHeader: "t=1780000000" }),
      { ok: false, reason: "malformed_header" },
    );
    assert.deepEqual(
      verifyWebhookSignature({ secret, rawBody, signatureHeader: "t=abc,v1=deadbeef" }),
      { ok: false, reason: "invalid_timestamp" },
    );
    assert.deepEqual(
      verifyWebhookSignature({
        secret,
        rawBody,
        signatureHeader: `t=${timestamp},v1=not-64-hex`,
        nowSeconds: timestamp,
      }),
      { ok: false, reason: "signature_mismatch" },
    );
  });
});

// ── 2. SSRF & HTTPS URL Validation ───────────────────────────────────────────

describe("webhook URL SSRF and HTTPS validation", () => {
  test("accepts a public HTTPS URL whose DNS resolves publicly", async () => {
    const verdict = await validateWebhookUrl("https://hooks.agent.example/mimir/events", {
      resolve: PUBLIC_DNS,
    });
    assert.equal(verdict.allowed, true);
  });

  test("rejects plain HTTP URLs", async () => {
    const verdict = await validateWebhookUrl("http://hooks.agent.example/mimir/events", {
      resolve: PUBLIC_DNS,
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, "protocol");
  });

  test("rejects non-HTTP schemes (file, ftp, ws, javascript)", async () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://hooks.agent.example/file",
      "wss://hooks.agent.example/socket",
    ]) {
      const verdict = await validateWebhookUrl(url);
      assert.equal(verdict.allowed, false, `expected ${url} to be rejected`);
      assert.equal(verdict.reason, "protocol");
    }
  });

  test("rejects private, loopback, link-local, CGNAT, and IPv6 private literals", async () => {
    for (const url of [
      "https://127.0.0.1/hook",
      "https://10.0.0.12/hook",
      "https://172.16.5.4/hook",
      "https://192.168.1.20/hook",
      "https://169.254.169.254/latest/meta-data/",
      "https://100.64.0.1/hook",
      "https://[::1]/hook",
      "https://[fe80::1]/hook",
      "https://[fd00::1]/hook",
    ]) {
      const verdict = await validateWebhookUrl(url);
      assert.equal(verdict.allowed, false, `expected ${url} to be rejected`);
      assert.equal(verdict.reason, "private_ip");
    }
  });

  test("rejects blocked hostnames and internal domain suffixes", async () => {
    for (const url of [
      "https://localhost/hook",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://agent.local/hook",
      "https://service.internal/hook",
      "https://node.lan/hook",
      "https://box.home.arpa/hook",
    ]) {
      const verdict = await validateWebhookUrl(url);
      assert.equal(verdict.allowed, false, `expected ${url} to be rejected`);
      assert.equal(verdict.reason, "hostname");
    }
  });

  test("rejects URLs carrying credentials or disallowed ports", async () => {
    const credVerdict = await validateWebhookUrl("https://user:pass@hooks.agent.example/hook");
    assert.equal(credVerdict.allowed, false);
    assert.equal(credVerdict.reason, "credentials");

    const portVerdict = await validateWebhookUrl("https://hooks.agent.example:6379/hook");
    assert.equal(portVerdict.allowed, false);
    assert.equal(portVerdict.reason, "port");
  });

  test("rejects DNS rebinding when a public hostname resolves to loopback, metadata, or mixed private IPs", async () => {
    const loopback = await validateWebhookUrl("https://rebind.agent.example/hook", {
      resolve: PRIVATE_DNS_LOOPBACK,
    });
    assert.equal(loopback.allowed, false);
    assert.equal(loopback.reason, "private_ip");

    const metadata = await validateWebhookUrl("https://rebind.agent.example/hook", {
      resolve: PRIVATE_DNS_METADATA,
    });
    assert.equal(metadata.allowed, false);
    assert.equal(metadata.reason, "private_ip");

    const mixed = await validateWebhookUrl("https://rebind.agent.example/hook", {
      resolve: MIXED_DNS,
    });
    assert.equal(mixed.allowed, false);
    assert.equal(mixed.reason, "private_ip");
  });
});

// ── 3. Retry Schedule & Per-Agent Cap ────────────────────────────────────────

describe("webhook retry schedule & per-agent queue cap", () => {
  test("retry schedule uses WEBHOOK_BACKOFF exponential ceilings and bounds attempts", () => {
    const schedule = buildWebhookRetrySchedule({ deterministic: true });
    // maxConsecutiveDependencyFailures is 5 -> 4 retry intervals after attempt 1..4; attempt 5 is exhausted.
    assert.equal(MAX_WEBHOOK_DELIVERY_ATTEMPTS, 5);
    assert.equal(schedule.length, 4);
    assert.deepEqual(
      schedule.map((s) => ({ attempt: s.attempt, ceilingMs: s.ceilingMs, delayMs: s.delayMs })),
      [
        { attempt: 1, ceilingMs: 2_000, delayMs: 2_000 },
        { attempt: 2, ceilingMs: 4_000, delayMs: 4_000 },
        { attempt: 3, ceilingMs: 8_000, delayMs: 8_000 },
        { attempt: 4, ceilingMs: 16_000, delayMs: 16_000 },
      ],
    );

    // Jittered schedule stays within [0, ceilingMs] for every attempt.
    const jittered = buildWebhookRetrySchedule({ deterministic: false });
    for (const step of jittered) {
      assert.ok(step.delayMs >= 0 && step.delayMs <= step.ceilingMs);
    }

    // Reaching MAX_WEBHOOK_DELIVERY_ATTEMPTS marks the delivery exhausted.
    const exhausted = computeWebhookRetryDelay("agent-alpha", MAX_WEBHOOK_DELIVERY_ATTEMPTS, {
      policy: WEBHOOK_BACKOFF,
    });
    assert.equal(exhausted.exhausted, true);
    assert.equal(exhausted.delayMs, 0);
    assert.equal(webhookRetryCeilingMs(10), 60_000, "capped at 60s");
  });

  test("enforces per-agent pending delivery cap by evicting oldest pending items", async () => {
    const reg = await registerAgentWebhook({
      agentId: "agent-alpha",
      url: "https://hooks.agent.example/alpha",
      resolve: PUBLIC_DNS,
    });
    assert.equal(reg.ok, true);

    const cap = 3;
    for (let i = 1; i <= 5; i += 1) {
      await enqueueClaimLifecycleEvent({
        event: "claim.created",
        claim: sampleClaim({ id: i }),
        now: 1_780_000_000_000 + i * 100,
        maxPendingPerAgent: cap,
      });
    }

    const pending = getPendingWebhookDeliveries("agent-alpha");
    assert.equal(pending.length, cap);
    assert.deepEqual(
      pending.map((d) => d.claimId),
      [3, 4, 5],
      "oldest deliveries (claims 1 and 2) must be evicted when cap=3 is exceeded",
    );
    assert.ok(MAX_PENDING_WEBHOOK_EVENTS_PER_AGENT >= 10);
  });

  test("detects claim.created, claim.challenged, and claim.resolved transitions and sanitizes private claims", () => {
    const openClaim = sampleClaim({ id: 10, state: "open", challenger_count: 0, total_challenger_stake: 0 });
    assert.deepEqual(
      detectClaimLifecycleEvents({ previous: null, current: openClaim }),
      ["claim.created"],
    );

    const challengedClaim = sampleClaim({
      id: 10,
      state: "active",
      challenger_count: 1,
      total_challenger_stake: 50,
    });
    assert.deepEqual(
      detectClaimLifecycleEvents({ previous: openClaim, current: challengedClaim }),
      ["claim.challenged"],
    );

    const resolvedClaim = sampleClaim({
      id: 10,
      state: "resolved",
      challenger_count: 1,
      total_challenger_stake: 50,
      winner_side: "creator",
    });
    assert.deepEqual(
      detectClaimLifecycleEvents({ previous: challengedClaim, current: resolvedClaim }),
      ["claim.resolved"],
    );

    // Private claims have sensitive text stripped from the webhook snapshot.
    const privateSnapshot = buildWebhookClaimSnapshot(
      sampleClaim({
        id: 99,
        visibility: "private",
        is_private: true,
        question: "Secret question",
        creator_position: "Secret A",
        counter_position: "Secret B",
        resolution_summary: "Secret summary",
      }),
    );
    assert.equal(privateSnapshot.question, "");
    assert.equal(privateSnapshot.creatorPosition, "");
    assert.equal(privateSnapshot.counterPosition, "");
    assert.equal(privateSnapshot.resolutionSummary, "");
  });
});

// ── 4. Owner-Signed Route Action (/api/agents/v1/registerWebhook) ────────────

describe("POST /api/agents/v1/registerWebhook owner-signed action", () => {
  const ownerKp = Keypair.random();
  const operatorKp = Keypair.random();
  const agentId = "webhook-test-agent";

  async function seedAgent(): Promise<AgentRecord> {
    const record: AgentRecord = {
      schemaVersion: 1,
      agentId,
      ownerWallet: ownerKp.publicKey(),
      operatorWallet: operatorKp.publicKey(),
      payoutWallet: ownerKp.publicKey(),
      displayName: "Webhook Test Agent",
      description: "Tests signed webhook registration.",
      capabilities: ["researcher"],
      authorityLevel: AUTHORITY_LEVELS.READ_ONLY,
      limits: defaultLimits(),
      status: "active",
      reputationBps: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await saveAgent(record);
    return record;
  }

  function signEnvelope<T extends Record<string, unknown>>(
    signer: Keypair,
    body: T,
    nonce = `nonce-${Date.now()}-${Math.random()}`,
  ): SignedAgentRequest<T> {
    const unsigned: Omit<SignedAgentRequest<T>, "signature"> = {
      version: AGENT_API_VERSION,
      agentId,
      action: "registerWebhook",
      idempotencyKey: `idem-${nonce}`,
      nonce,
      signedAt: Date.now(),
      body,
    };
    const msg = agentRequestMessage(unsigned);
    const sig = signer.sign(Buffer.from(msg, "utf8")).toString("base64");
    return { ...unsigned, signature: sig };
  }

  test("registerWebhook requires an owner signature and rejects operator signatures or private URLs", async () => {
    assert.equal(requiresOwnerSignature("registerWebhook"), true);
    await seedAgent();

    // 1. Operator signature must be rejected because registerWebhook is owner-signed.
    const operatorSigned = signEnvelope(operatorKp, {
      url: "https://hooks.agent.example/mimir",
    });
    const msg = agentRequestMessage(operatorSigned);
    const validWithOperator = await verifyAgentSignature({
      address: operatorKp.publicKey(),
      message: msg,
      signature: operatorSigned.signature,
    });
    assert.equal(validWithOperator, true);
    // Verifying against the agent's owner wallet MUST fail with operator signature:
    const validWithOwner = await verifyAgentSignature({
      address: ownerKp.publicKey(),
      message: msg,
      signature: operatorSigned.signature,
    });
    assert.equal(validWithOwner, false);

    // 2. Owner signature with a private-network URL must be rejected by SSRF guard.
    const ssrfResult = await registerAgentWebhook({
      agentId,
      url: "https://127.0.0.1/internal-webhook",
    });
    assert.equal(ssrfResult.ok, false);
    if (!ssrfResult.ok) {
      assert.equal(ssrfResult.reason, "private_ip");
    }

    // 3. Owner signature with a valid HTTPS URL succeeds and returns the HMAC secret.
    const ownerSigned = signEnvelope(ownerKp, {
      url: "https://hooks.agent.example/mimir",
      events: ["claim.created", "claim.resolved"],
    });
    const ownerMsg = agentRequestMessage(ownerSigned);
    const ownerVerified = await verifyAgentSignature({
      address: ownerKp.publicKey(),
      message: ownerMsg,
      signature: ownerSigned.signature,
    });
    assert.equal(ownerVerified, true);

    const okResult = await registerAgentWebhook({
      agentId,
      url: ownerSigned.body.url as string,
      events: ownerSigned.body.events as any,
      resolve: PUBLIC_DNS,
    });
    assert.equal(okResult.ok, true);
    if (okResult.ok) {
      assert.equal(okResult.webhook.agentId, agentId);
      assert.equal(okResult.webhook.url, "https://hooks.agent.example/mimir");
      assert.deepEqual(okResult.webhook.events, ["claim.created", "claim.resolved"]);
      assert.match(okResult.secret, /^whsec_[0-9a-f]{64}$/);
      assert.equal(WEBHOOK_SIGNATURE_HEADER, "x-mimir-webhook-signature");
    }
  });
});

// ── 5. Local HTTP Server Integration Test ────────────────────────────────────

describe("local HTTP server integration: delivery, HMAC verification, retry & non-blocking failure", () => {
  test("delivers signed lifecycle events to a local HTTP server, retries transient 500s, and never throws on unreachable endpoints", async () => {
    const received: Array<{
      headers: IncomingMessage["headers"];
      rawBody: string;
      payload: WebhookEventPayload;
    }> = [];
    let requestCount = 0;
    let failFirstRequest = true;

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        requestCount += 1;
        const rawBody = Buffer.concat(chunks).toString("utf8");
        if (failFirstRequest && requestCount === 1) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "temporary overload" }));
          return;
        }
        received.push({
          headers: req.headers,
          rawBody,
          payload: JSON.parse(rawBody) as WebhookEventPayload,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ received: true }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const localTargetUrl = `http://127.0.0.1:${port}/webhook-receiver`;

    try {
      // Register with a public HTTPS URL (as required by registration), then rewrite
      // the outbound request URL in fetchImpl to hit our local 127.0.0.1 test server.
      const reg = await registerAgentWebhook({
        agentId: "agent-alpha",
        url: "https://hooks.agent.example/webhook-receiver",
        events: [...WEBHOOK_EVENTS],
        resolve: PUBLIC_DNS,
      });
      assert.equal(reg.ok, true);
      if (!reg.ok) return;

      const localFetch: typeof globalThis.fetch = (input, init) => {
        const target = String(input).replace(
          "https://hooks.agent.example/webhook-receiver",
          localTargetUrl,
        );
        return globalThis.fetch(target, init);
      };

      const now = 1_780_000_000_000;
      const claim = sampleClaim({ id: 77, state: "open" });
      const enq = await enqueueClaimLifecycleEvent({
        event: "claim.created",
        claim,
        now,
      });
      assert.equal(enq.enqueued, 1);
      const deliveryId = enq.deliveries[0]!.deliveryId;

      // First flush: server returns 503, so the event stays pending with backoff scheduled.
      const firstFlush = await flushWebhookQueue({
        now,
        resolve: PUBLIC_DNS,
        fetchImpl: localFetch,
        deterministicBackoff: true,
      });
      assert.equal(firstFlush.processed, 1);
      assert.equal(firstFlush.delivered, 0);
      assert.equal(firstFlush.retried, 1);

      const afterFirst = getWebhookDelivery(deliveryId)!;
      assert.equal(afterFirst.status, "pending");
      assert.equal(afterFirst.attempts, 1);
      assert.equal(afterFirst.nextAttemptAt, now + 2_000);

      // Second flush before nextAttemptAt does nothing.
      const earlyFlush = await flushWebhookQueue({
        now: now + 500,
        resolve: PUBLIC_DNS,
        fetchImpl: localFetch,
      });
      assert.equal(earlyFlush.processed, 0);

      // Second flush at now + 2000ms succeeds (200 OK) and verifies HMAC on the receiver side.
      const secondFlush = await flushWebhookQueue({
        now: now + 2_000,
        resolve: PUBLIC_DNS,
        fetchImpl: localFetch,
        deterministicBackoff: true,
      });
      assert.equal(secondFlush.processed, 1);
      assert.equal(secondFlush.delivered, 1);
      assert.equal(received.length, 1);

      const captured = received[0]!;
      assert.equal(captured.headers[WEBHOOK_EVENT_HEADER], "claim.created");
      assert.equal(captured.headers[WEBHOOK_DELIVERY_HEADER], deliveryId);
      assert.equal(captured.headers[WEBHOOK_TIMESTAMP_HEADER], String(Math.floor((now + 2_000) / 1000)));

      const sigHeader = String(captured.headers[WEBHOOK_SIGNATURE_HEADER] ?? "");
      const verification = verifyWebhookSignature({
        secret: reg.secret,
        rawBody: captured.rawBody,
        signatureHeader: sigHeader,
        nowSeconds: Math.floor((now + 2_000) / 1000),
      });
      assert.deepEqual(verification, {
        ok: true,
        timestampSeconds: Math.floor((now + 2_000) / 1000),
      });
      assert.equal(captured.payload.claim.id, 77);
      assert.equal(captured.payload.event, "claim.created");

      // Verify that a completely dead/failing endpoint never throws from flushWebhookQueue.
      failFirstRequest = false;
      await registerAgentWebhook({
        agentId: "agent-beta",
        url: "https://dead.agent.example/webhook",
        events: ["claim.resolved"],
        resolve: PUBLIC_DNS,
      });
      await enqueueClaimLifecycleEvent({
        event: "claim.resolved",
        claim: sampleClaim({ id: 88, state: "resolved" }),
        now: now + 3_000,
      });

      const deadFlush = await flushWebhookQueue({
        now: now + 3_000,
        resolve: PUBLIC_DNS,
        fetchImpl: async () => {
          throw new Error("ECONNREFUSED simulated network failure");
        },
      });
      // Both agent-alpha (subscribed to all events) and agent-beta (subscribed to claim.resolved)
      // received the claim.resolved event.
      assert.equal(deadFlush.processed, 2);
      assert.equal(deadFlush.delivered, 0);
      assert.equal(deadFlush.retried, 2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
