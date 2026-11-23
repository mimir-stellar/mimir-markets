/**
 * Durable paid-response fulfillment receipts (#851).
 *
 * Offline and deterministic: an in-memory Horizon, fixed keypairs, a pinned
 * clock, and an in-memory receipt store. `serve()` below replays the order the
 * resource server runs for a paid request (beforeVerify → verify → handler →
 * beforeSettle → settle → afterSettle), using the same functions
 * `lib/x402/server.ts` registers as hooks.
 */

import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

import { ExactStellarFacilitator, type StellarHorizonReader } from "../../lib/x402/stellar-scheme";
import {
  bindFulfillment,
  canonicalResourceDigest,
  canonicalResourceText,
  durableReceiptStore,
  isRedelivery,
  memoryReceiptStore,
  redeliverySettle,
  redeliveryVerify,
  resourceFromTransport,
  type FulfillmentReceiptStore,
} from "../../lib/x402/fulfillment-receipt";
import { X402_NETWORK } from "../../lib/x402/config";
import {
  FIXTURE_PAYER,
  FIXTURE_SECOND_PAYER,
  fakeHorizonBackend,
  landedPayment,
  makeRequirements,
  settleFixtures,
  signedProof,
  toPaymentPayload,
} from "./x402-fixtures";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

beforeEach(() => settleFixtures.reset());

function transport(url: string, method = "GET") {
  const parsed = new URL(url);
  return {
    request: {
      path: parsed.pathname,
      method,
      adapter: { getUrl: () => url, getMethod: () => method },
    },
  };
}

const PRICE_URL = "https://mimir.test/api/premium/price?symbol=BTC&window=1h";

interface Harness {
  store: FulfillmentReceiptStore & { size(): number };
  backend: StellarHorizonReader;
  facilitator: ExactStellarFacilitator;
  revenueRows: string[];
  handlerRuns: number;
  now: () => number;
}

function harness(backend: StellarHorizonReader, clock: { now: number }): Harness {
  return {
    store: memoryReceiptStore(),
    backend,
    facilitator: new ExactStellarFacilitator(backend),
    revenueRows: [],
    handlerRuns: 0,
    now: () => clock.now,
  };
}

/**
 * One paid request through the resource server's hook order. `deliver: false`
 * models a response produced and settled but lost before the buyer read it.
 */
async function serve(
  h: Harness,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  url = PRICE_URL,
): Promise<{ status: number; reason?: string; redelivery?: boolean }> {
  const ctx = transport(url);
  const opts = { store: h.store, backend: h.backend, now: h.now() };

  const verified =
    (await redeliveryVerify(payload, requirements, ctx, opts)) ??
    (await h.facilitator.verify(payload, requirements));
  if (!verified.isValid) return { status: 402, reason: verified.invalidReason };

  h.handlerRuns += 1;

  const settled =
    (await redeliverySettle(payload, requirements, ctx, opts)) ??
    (await h.facilitator.settle(payload, requirements));
  if (!settled.success) return { status: 402, reason: settled.errorReason };

  if (!isRedelivery(settled)) {
    const resource = resourceFromTransport(settled.network, ctx)!;
    await bindFulfillment({
      network: settled.network,
      transaction: settled.transaction,
      payer: settled.payer!,
      amountAtomic: settled.amount ?? requirements.amount,
      resource,
      now: h.now(),
      store: h.store,
    });
    h.revenueRows.push(settled.transaction);
  }
  return { status: 200, redelivery: isRedelivery(settled) };
}

function paidRequest(t: test.TestContext, overrides: { payer?: typeof FIXTURE_PAYER } = {}) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const clock = { now: NOW };
  const payer = overrides.payer ?? FIXTURE_PAYER;
  const payment = landedPayment({ createdAtMs: NOW - 1_000, from: payer.publicKey() });
  const backend = fakeHorizonBackend([payment]);
  const requirements = makeRequirements();
  const payload = toPaymentPayload(signedProof(payment.transaction, requirements, payer), requirements);
  const advance = (ms: number) => {
    clock.now += ms;
    t.mock.timers.tick(ms);
  };
  return { payment, backend, requirements, payload, clock, advance };
}

// ── Canonical resource digest ────────────────────────────────────────────────

test("the resource digest ignores query order, trailing slashes and method case", () => {
  const a = canonicalResourceDigest({ network: X402_NETWORK, method: "get", path: "/api/premium/price/", query: "?window=1h&symbol=BTC" });
  const b = canonicalResourceDigest({ network: X402_NETWORK, method: "GET", path: "/api/premium/price", query: { symbol: "BTC", window: "1h" } });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("the resource digest separates different query values, paths, methods and networks", () => {
  const base = { network: X402_NETWORK, method: "GET", path: "/api/premium/price", query: "symbol=BTC" };
  const digest = canonicalResourceDigest(base);
  assert.notEqual(digest, canonicalResourceDigest({ ...base, query: "symbol=ETH" }));
  assert.notEqual(digest, canonicalResourceDigest({ ...base, path: "/api/oracle" }));
  assert.notEqual(digest, canonicalResourceDigest({ ...base, method: "POST" }));
  assert.notEqual(digest, canonicalResourceDigest({ ...base, network: "stellar:pubnet" }));
  assert.match(canonicalResourceText(base), /^Mimir x402 resource v1\n/);
});

test("a transport context with no request yields no resource rather than a guess", () => {
  assert.equal(resourceFromTransport(X402_NETWORK, undefined), null);
  assert.equal(resourceFromTransport(X402_NETWORK, {}), null);
});

// ── Before: the stuck buyer ───────────────────────────────────────────────────

test("before receipts: a retry after a lost response is refused, so the buyer would pay twice", async (t) => {
  const { backend, requirements, payload } = paidRequest(t);
  const facilitator = new ExactStellarFacilitator(backend);
  assert.equal((await facilitator.settle(payload, requirements)).success, true);
  // The response is lost; the buyer retries with the proof it already paid with.
  const retry = await facilitator.verify(payload, requirements);
  assert.equal(retry.isValid, false);
  assert.equal(retry.invalidReason, "already_settled");
});

// ── After: reconciliation ─────────────────────────────────────────────────────

test("a lost response is redelivered for the same resource without a second charge", async (t) => {
  const { payment, backend, requirements, payload, clock, advance } = paidRequest(t);
  const h = harness(backend, clock);

  const first = await serve(h, payload, requirements);
  assert.deepEqual(first, { status: 200, redelivery: false });

  advance(30_000);
  const retry = await serve(h, payload, requirements);
  assert.deepEqual(retry, { status: 200, redelivery: true });

  assert.equal(h.handlerRuns, 2);
  assert.equal(h.revenueRows.length, 1, "one payment, one revenue row");
  const receipt = await h.store.get(X402_NETWORK, payment.transaction);
  assert.equal(receipt?.redeliveries, 1);
  assert.equal(receipt?.amountAtomic, requirements.amount);
});

test("the receipt binds the payment to the canonical digest of what it bought", async (t) => {
  const { payment, backend, requirements, payload, clock } = paidRequest(t);
  const h = harness(backend, clock);
  await serve(h, payload, requirements);
  const receipt = await h.store.get(X402_NETWORK, payment.transaction);
  assert.ok(receipt);
  assert.equal(receipt.resource, "/api/premium/price");
  assert.equal(receipt.payer, FIXTURE_PAYER.publicKey());
  assert.equal(
    receipt.resourceDigest,
    canonicalResourceDigest({ network: X402_NETWORK, method: "GET", path: "/api/premium/price", query: "window=1h&symbol=BTC" }),
  );
});

test("the same proof cannot be moved to another resource", async (t) => {
  const { backend, requirements, payload, clock } = paidRequest(t);
  const h = harness(backend, clock);
  await serve(h, payload, requirements);

  const otherQuery = await serve(h, payload, requirements, "https://mimir.test/api/premium/price?symbol=ETH&window=1h");
  assert.deepEqual(otherQuery, { status: 402, reason: "already_settled" });
  const otherPath = await serve(h, payload, requirements, "https://mimir.test/api/oracle?symbol=BTC&window=1h");
  assert.deepEqual(otherPath, { status: 402, reason: "already_settled" });
  assert.equal(h.handlerRuns, 1);
});

test("first binding wins: a later bind for another resource does not rewrite it", async (t) => {
  const { payment, backend, requirements, payload, clock } = paidRequest(t);
  const h = harness(backend, clock);
  await serve(h, payload, requirements);
  const again = await bindFulfillment({
    network: X402_NETWORK,
    transaction: payment.transaction,
    payer: FIXTURE_PAYER.publicKey(),
    amountAtomic: 10_000n,
    resource: { network: X402_NETWORK, method: "GET", path: "/api/oracle" },
    store: h.store,
  });
  assert.equal(again.created, false);
  assert.equal(again.receipt.resource, "/api/premium/price");
});

test("redelivery closes after the window", async (t) => {
  const { backend, requirements, payload, clock, advance } = paidRequest(t);
  const h = harness(backend, clock);
  await serve(h, payload, requirements);
  advance(15 * MINUTE + 1);
  // Past the window the facilitator decides alone, and the payment is stale.
  const late = await serve(h, payload, requirements);
  assert.equal(late.status, 402);
  assert.equal(late.reason, "payment_too_old");
  assert.equal(h.handlerRuns, 1);
});

test("redelivery stops at the limit", async (t) => {
  const { backend, requirements, payload, clock, advance } = paidRequest(t);
  const h = harness(backend, clock);
  await serve(h, payload, requirements);
  for (let i = 0; i < 3; i++) {
    advance(1_000);
    assert.equal((await serve(h, payload, requirements)).redelivery, true);
  }
  advance(1_000);
  assert.deepEqual(await serve(h, payload, requirements), { status: 402, reason: "already_settled" });
  assert.equal(h.revenueRows.length, 1);
});

test("a proof re-signed by another account cannot claim the redelivery", async (t) => {
  const { payment, backend, requirements, payload, clock } = paidRequest(t);
  const h = harness(backend, clock);
  await serve(h, payload, requirements);
  const forged = toPaymentPayload(signedProof(payment.transaction, requirements, FIXTURE_SECOND_PAYER), requirements);
  const result = await serve(h, forged, requirements);
  assert.equal(result.status, 402);
  assert.notEqual(result.redelivery, true);
  assert.equal(h.handlerRuns, 1);
});

test("a proof that never settled is not treated as a redelivery", async (t) => {
  const { backend, requirements, payload, clock } = paidRequest(t);
  const h = harness(backend, clock);
  const ctx = transport(PRICE_URL);
  assert.equal(await redeliveryVerify(payload, requirements, ctx, { store: h.store, backend, now: NOW }), null);
  assert.equal(await redeliverySettle(payload, requirements, ctx, { store: h.store, backend, now: NOW }), null);
});

test("a redelivery limit of 0 turns reconciliation off", async (t) => {
  const { backend, requirements, payload, clock } = paidRequest(t);
  const h = harness(backend, clock);
  await serve(h, payload, requirements);
  const ctx = transport(PRICE_URL);
  assert.equal(
    await redeliveryVerify(payload, requirements, ctx, { store: h.store, backend, now: NOW, maxRedeliveries: 0 }),
    null,
  );
});

// ── Storage ───────────────────────────────────────────────────────────────────

test("without DATABASE_URL the durable store keeps receipts in process", async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const store = durableReceiptStore();
    const bound = await bindFulfillment({
      network: X402_NETWORK,
      transaction: "AB".repeat(32),
      payer: FIXTURE_PAYER.publicKey(),
      amountAtomic: 10_000n,
      resource: { network: X402_NETWORK, method: "GET", path: "/api/premium/price" },
      now: NOW,
      store,
    });
    assert.equal(bound.created, true);
    const read = await store.get(X402_NETWORK, "ab".repeat(32));
    assert.equal(read?.transaction, "ab".repeat(32));
    await store.noteRedelivery(X402_NETWORK, "ab".repeat(32), NOW + 1);
    assert.equal((await store.get(X402_NETWORK, "ab".repeat(32)))?.redeliveries, 1);
  } finally {
    if (previous !== undefined) process.env.DATABASE_URL = previous;
  }
});

test("the in-process store is bounded and drops the oldest receipt", async () => {
  const store = memoryReceiptStore(2);
  for (const tx of ["01", "02", "03"]) {
    await store.bind({
      network: X402_NETWORK, transaction: tx.repeat(32), resource: "/r", resourceDigest: "d",
      payer: "p", amountAtomic: "1", settledAt: NOW, redeliveries: 0, lastDeliveredAt: NOW,
    });
  }
  assert.equal(store.size(), 2);
  assert.equal(await store.get(X402_NETWORK, "01".repeat(32)), null);
});
