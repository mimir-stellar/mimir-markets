/**
 * Synthetic regression scenarios for the market creator: duplicate evidence,
 * stale evidence, and a retry after an uncertain create (#827).
 *
 * Everything is deterministic: source responses are captured fixtures served by
 * a fake fetch, the clock is pinned with mock timers, and the "chain" is an
 * in-memory list. No network, credentials or funds are touched.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExistingClaimSignature,
  filterDuplicateCandidates,
  normalizeComparableText,
  normalizeResolutionUrl,
  type CandidateLike,
  type ExistingClaimSignature,
} from "../../agents/market-creator/dedupe";
import { fetchLaunchEvents, fetchWeatherEvents } from "../../agents/market-creator/sources";

// ── Captured clock and sources ────────────────────────────────────────────────

const CAPTURED_AT = Date.parse("2026-11-18T12:00:00.000Z");
const HOUR = 3_600_000;

const LAUNCH_FIXTURE = {
  results: [
    { id: "launch-a", name: "Falcon 9 | Starlink 12-1", net: "2026-11-19T03:00:00Z", launch_service_provider: { name: "SpaceX" } },
    // The same launch again (status update mixed into the list): duplicate evidence.
    { id: "launch-a", name: "Falcon 9 | Starlink 12-1", net: "2026-11-19T03:00:00Z", launch_service_provider: { name: "SpaceX" } },
    { id: "launch-b", name: "Electron | Synthetic Sat", net: "2026-11-18T14:00:00Z", launch_service_provider: { name: "Rocket Lab" } },
  ],
};

function weatherFixture(date: string, high: number) {
  return { daily: { time: ["2026-11-18", date], temperature_2m_max: [10, high] } };
}

function installFakeFetch(t: test.TestContext, route: (url: string) => unknown | null): string[] {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const body = route(url);
    if (body === null) return new Response("unavailable", { status: 503 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}

// ── In-memory chain for the retry scenario ────────────────────────────────────

interface FakeClaim {
  id: number;
  state: "open" | "active" | "cancelled";
  category: string;
  question: string;
  resolution_url: string;
  deadline: number;
}

class FakeChain {
  claims: FakeClaim[] = [];
  submit(candidate: Required<Pick<CandidateLike, "question" | "resolutionUrl" | "category">>, deadline: number): number {
    const id = this.claims.length + 1;
    this.claims.push({
      id,
      state: "open",
      category: candidate.category,
      question: candidate.question,
      resolution_url: candidate.resolutionUrl,
      deadline,
    });
    return id;
  }
  /** Mirrors sweepAndCount: OPEN/ACTIVE claims whose deadline has not passed. */
  joinableSignatures(nowSeconds: number): ExistingClaimSignature[] {
    return this.claims
      .filter((c) => (c.state === "open" || c.state === "active") && c.deadline > nowSeconds)
      .map((c) => buildExistingClaimSignature(c));
  }
}

class UncertainCreateError extends Error {}

/**
 * One creator run reduced to the steps that decide whether a market is opened:
 * snapshot the chain, dedupe drafts against it, then create. `create` may throw
 * after the transaction landed, which is the uncertain-success case.
 */
async function runCreator(
  chain: FakeChain,
  drafts: Array<Required<Pick<CandidateLike, "question" | "resolutionUrl" | "category">>>,
  create: (candidate: (typeof drafts)[number]) => Promise<number>,
): Promise<{ attempted: number; errors: number }> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const candidates = filterDuplicateCandidates(drafts, chain.joinableSignatures(nowSeconds));
  let errors = 0;
  for (const candidate of candidates) {
    try {
      await create(candidate);
    } catch (err) {
      if (!(err instanceof UncertainCreateError)) throw err;
      errors++;
    }
  }
  return { attempted: candidates.length, errors };
}

// ── Duplicate evidence ────────────────────────────────────────────────────────

test("normalisation treats cosmetic re-drafts as the same market", () => {
  assert.equal(
    normalizeComparableText("Will the Falcon 9 launch BEFORE 06:00 UTC?"),
    normalizeComparableText("falcon 9 launch 06 00 utc"),
  );
  assert.equal(
    normalizeResolutionUrl("https://LL.thespacedevs.com/2.2.0/launch/launch-a/#status"),
    normalizeResolutionUrl("https://ll.thespacedevs.com/2.2.0/launch/launch-a"),
  );
  assert.equal(
    normalizeResolutionUrl("https://api.open-meteo.com/v1/forecast?longitude=-0.13&latitude=51.51&utm_source=x"),
    normalizeResolutionUrl("https://api.open-meteo.com/v1/forecast?latitude=51.51&longitude=-0.13"),
  );
});

test("different cities on the same API stay distinct sources", () => {
  const drafts = [
    { question: "London high above 12C tomorrow?", category: "weather", resolutionUrl: "https://api.open-meteo.com/v1/forecast?latitude=51.51&longitude=-0.13" },
    { question: "Berlin high above 9C tomorrow?", category: "weather", resolutionUrl: "https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41" },
  ];
  assert.equal(filterDuplicateCandidates(drafts, []).length, 2);
});

test("duplicate drafts in one batch keep only the first", () => {
  const drafts = [
    { question: "Will Starlink 12-1 launch before 06:00 UTC?", category: "science", resolutionUrl: "https://ll.thespacedevs.com/2.2.0/launch/launch-a/" },
    { question: "Starlink 12-1 launches before 06:00 UTC", category: "science", resolutionUrl: "https://ll.thespacedevs.com/2.2.0/launch/launch-a" },
  ];
  const kept = filterDuplicateCandidates(drafts, []);
  assert.deepEqual(kept, [drafts[0]]);
});

test("a draft that repeats an open on-chain claim is dropped; other categories are not", () => {
  const existing = [
    buildExistingClaimSignature({
      id: 7,
      category: "Science",
      question: "Will Starlink 12-1 launch before 06:00 UTC?",
      resolution_url: "https://ll.thespacedevs.com/2.2.0/launch/launch-a/",
    }),
  ];
  const sameSource = { question: "Does Starlink 12-1 lift off by 05:00 UTC?", category: "science", resolutionUrl: "https://ll.thespacedevs.com/2.2.0/launch/launch-a" };
  const sameQuestion = { question: "Starlink 12-1 launch before 06:00 UTC", category: "science", resolutionUrl: "https://example.test/other" };
  const otherCategory = { question: "Will Starlink 12-1 launch before 06:00 UTC?", category: "culture", resolutionUrl: "https://example.test/culture" };
  assert.deepEqual(filterDuplicateCandidates([sameSource, sameQuestion, otherCategory], existing), [otherCategory]);
});

test("the Set form keeps its existing batch behaviour", () => {
  const seen = new Set<string>();
  const a = { question: "Q one?", resolutionUrl: "https://x.test/a", deadline: "2026-11-19T00:00:00Z" };
  assert.deepEqual(filterDuplicateCandidates([a, { ...a, question: "q ONE" }], seen), [a]);
  assert.deepEqual(filterDuplicateCandidates([a], seen), []);
});

test("captured launch source with a repeated record yields one event", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: CAPTURED_AT });
  installFakeFetch(t, () => LAUNCH_FIXTURE);
  const { events } = await fetchLaunchEvents();
  assert.deepEqual(events.map((e) => e.id), ["launch-a", "launch-b"]);
});

// ── Stale evidence ────────────────────────────────────────────────────────────

test("replaying captured launch evidence after its window opened drops it", async (t) => {
  // Same captured response, read 3 hours later: launch-b's window (14:00Z) has
  // opened, so it is no longer an open question and must not become a market.
  t.mock.timers.enable({ apis: ["Date"], now: CAPTURED_AT + 3 * HOUR });
  installFakeFetch(t, () => LAUNCH_FIXTURE);
  const { events } = await fetchLaunchEvents();
  assert.deepEqual(events.map((e) => e.id), ["launch-a"]);
});

test("replaying captured launch evidence past every window yields no launch markets", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: CAPTURED_AT + 24 * HOUR });
  installFakeFetch(t, () => LAUNCH_FIXTURE);
  const { events, text } = await fetchLaunchEvents();
  assert.equal(events.length, 0);
  assert.match(text, /no launches scheduled/);
});

test("a weather source that is down yields no events instead of stale ones", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: CAPTURED_AT });
  installFakeFetch(t, (url) => (url.includes("latitude=51.51") ? weatherFixture("2026-11-19", 12.34) : null));
  const { events } = await fetchWeatherEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].city, "London");
  assert.equal(events[0].forecastHighC, 12.3);
  assert.equal(events[0].targetDate, "2026-11-19");
});

// ── Retry after an uncertain success ──────────────────────────────────────────

const DRAFT = {
  question: "Will Starlink 12-1 launch before 06:00 UTC on 2026-11-19?",
  category: "science",
  resolutionUrl: "https://ll.thespacedevs.com/2.2.0/launch/launch-a/",
};

test("a retry after a create that landed but reported failure does not open a second market", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: CAPTURED_AT });
  const chain = new FakeChain();
  const deadline = Math.floor((CAPTURED_AT + 18 * HOUR) / 1000);

  // Run 1: the transaction lands, then the RPC times out before we see the result.
  const first = await runCreator(chain, [DRAFT], async (c) => {
    chain.submit(c, deadline);
    throw new UncertainCreateError("timeout waiting for transaction result");
  });
  assert.deepEqual(first, { attempted: 1, errors: 1 });
  assert.equal(chain.claims.length, 1);

  // Run 2 an hour later re-drafts the same market, cosmetically different.
  t.mock.timers.tick(HOUR);
  const redraft = { ...DRAFT, question: "Starlink 12-1 launches before 06:00 UTC on 2026-11-19", resolutionUrl: DRAFT.resolutionUrl.replace(/\/$/, "") };
  let creates = 0;
  const second = await runCreator(chain, [redraft], async (c) => {
    creates++;
    return chain.submit(c, deadline);
  });
  assert.deepEqual(second, { attempted: 0, errors: 0 });
  assert.equal(creates, 0);
  assert.equal(chain.claims.length, 1);
});

test("a create that truly failed is retried on the next run", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: CAPTURED_AT });
  const chain = new FakeChain();
  const deadline = Math.floor((CAPTURED_AT + 18 * HOUR) / 1000);

  await runCreator(chain, [DRAFT], async () => {
    throw new UncertainCreateError("rejected before submission");
  });
  assert.equal(chain.claims.length, 0);

  t.mock.timers.tick(HOUR);
  const second = await runCreator(chain, [DRAFT], async (c) => chain.submit(c, deadline));
  assert.equal(second.attempted, 1);
  assert.equal(chain.claims.length, 1);
});

test("an expired or cancelled claim does not block a fresh market on the same source", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: CAPTURED_AT });
  const chain = new FakeChain();
  chain.submit(DRAFT, Math.floor((CAPTURED_AT - HOUR) / 1000)); // expired
  chain.submit(DRAFT, Math.floor((CAPTURED_AT + 18 * HOUR) / 1000));
  chain.claims[1].state = "cancelled";

  const run = await runCreator(chain, [DRAFT], async (c) => chain.submit(c, Math.floor((CAPTURED_AT + 18 * HOUR) / 1000)));
  assert.equal(run.attempted, 1);
});
