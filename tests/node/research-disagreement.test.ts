/**
 * Research-source disagreement report (#865).
 *
 * Synthetic captures only: no network. Each case builds the FetchSuccess /
 * FetchFailure shapes the gateway returns.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex } from "../../lib/content-hash";
import type { FetchResult, FetchSuccess } from "../../lib/research/gateway";
import {
  buildDisagreementReport,
  normalizeBoolean,
  normalizeNumber,
  normalizeString,
  summariseDisagreement,
  type FactSpec,
  type SourceCapture,
} from "../../lib/research/disagreement";
import { validateResearchContent } from "../../lib/research/content-validation";

const NOW = 1_800_000_000_000;

function captured(body: string, contentType = "application/json"): FetchResult {
  const s: FetchSuccess = {
    url: "https://example.test/x",
    finalUrl: "https://example.test/x",
    status: 200,
    contentType,
    body,
    contentHash: sha256Hex(body),
    capturedAt: NOW,
    bytes: Buffer.byteLength(body),
    fromCache: false,
    redirects: 0,
    redirectChain: ["https://example.test/x"],
  };
  return { ok: true, ...s };
}

const json = (v: unknown) => captured(JSON.stringify(v));

const TEMP: FactSpec = {
  key: "max_temp_c",
  kind: "number",
  locate: { a: "daily.max.0", b: "forecast.high", c: /High:\s*([^<\n]+)/ },
  absTolerance: 0.5,
};

const sources = (a: FetchResult | null, b: FetchResult | null, c?: FetchResult | null): SourceCapture[] => [
  { id: "a", capture: a },
  { id: "b", capture: b },
  ...(c === undefined ? [] : [{ id: "c", capture: c }]),
];

// ── Before/after anchor ───────────────────────────────────────────────────────

test("before: content validation alone calls both conflicting sources valid", () => {
  // The gap this module closes: each capture passes on its own, and nothing
  // compares what they say.
  const a = json({ daily: { max: [21.4] } }) as FetchSuccess;
  const b = json({ forecast: { high: "27 °C" } }) as FetchSuccess;
  assert.equal(validateResearchContent(a, { maxAgeSeconds: 1e12 }).state, "valid");
  assert.equal(validateResearchContent(b, { maxAgeSeconds: 1e12 }).state, "valid");
});

// ── Verdicts ──────────────────────────────────────────────────────────────────

test("agreeing sources within tolerance agree, across JSON and text bodies", () => {
  const r = buildDisagreementReport(
    sources(json({ daily: { max: [21.4] } }), json({ forecast: { high: "21.6 °C" } }), captured("<p>High: 21.2°C</p>", "text/html")),
    [TEMP],
  );
  assert.equal(r.facts[0]!.verdict, "agree");
  assert.equal(r.disagreement, false);
  assert.equal(r.facts[0]!.counts.value, 3);
});

test("values outside tolerance disagree, and the report names who said what", () => {
  const r = buildDisagreementReport(
    sources(json({ daily: { max: [21.4] } }), json({ forecast: { high: "27 °C" } })),
    [TEMP],
  );
  const f = r.facts[0]!;
  assert.equal(f.verdict, "disagree");
  assert.equal(r.disagreement, true);
  assert.deepEqual(f.groups, [{ value: 21.4, sources: ["a"] }, { value: 27, sources: ["b"] }]);
  assert.match(summariseDisagreement(r), /max_temp_c: disagree: 21\.4 \(a\) vs 27 \(b\)/);
});

test("a source missing the field is missing, not a dissent", () => {
  const r = buildDisagreementReport(
    sources(json({ daily: { max: [21.4] } }), json({ forecast: {} }), captured("<p>High: 21.5</p>", "text/html")),
    [TEMP],
  );
  const f = r.facts[0]!;
  assert.equal(f.verdict, "agree");
  assert.equal(f.cells.find((c) => c.source === "b")!.status, "missing");
});

test("an unparseable value is unparseable, not a dissent", () => {
  const r = buildDisagreementReport(
    sources(json({ daily: { max: [21.4] } }), json({ forecast: { high: "warm" } }), captured("<p>High: 21.5</p>", "text/html")),
    [TEMP],
  );
  const f = r.facts[0]!;
  assert.equal(f.verdict, "agree");
  assert.equal(f.counts.unparseable, 1);
  assert.equal(f.cells.find((c) => c.source === "b")!.detail, "no number found");
});

test("a failed fetch is unavailable, and one value alone is insufficient rather than agreement", () => {
  const down: FetchResult = { ok: false, kind: "http_error", status: 503, detail: "upstream down" };
  const r = buildDisagreementReport(sources(json({ daily: { max: [21.4] } }), down), [TEMP]);
  const f = r.facts[0]!;
  assert.equal(f.verdict, "insufficient");
  assert.equal(r.disagreement, false);
  assert.deepEqual(f.cells[1], { source: "b", status: "unavailable", detail: "fetch failed: http 503" });
  assert.deepEqual(r.sources[1], { id: "b", status: "unavailable", detail: "fetch failed: http 503" });
});

test("a capture that content validation marked unusable is unavailable", () => {
  const stale = json({ forecast: { high: 30 } });
  const r = buildDisagreementReport(
    [
      { id: "a", capture: json({ daily: { max: [21.4] } }) },
      { id: "b", capture: stale, validation: { state: "stale", reason: "old", privacyFindings: [], usable: false } },
    ],
    [TEMP],
  );
  assert.equal(r.facts[0]!.verdict, "insufficient");
  assert.equal(r.facts[0]!.cells[1]!.detail, "content validation: stale");
});

test("broken JSON is unparseable for JSON-path facts but regex facts still read the text", () => {
  const broken = captured('{"forecast": {"high": 21', "application/json");
  const r = buildDisagreementReport(
    [{ id: "a", capture: json({ daily: { max: [21.4] } }) }, { id: "b", capture: broken }],
    [TEMP, { key: "raw", kind: "number", locate: { a: "daily.max.0", b: /"high":\s*(\d+)/ } }],
  );
  assert.equal(r.facts[0]!.cells[1]!.status, "unparseable");
  assert.equal(r.facts[0]!.cells[1]!.detail, "body is not valid JSON");
  assert.equal(r.facts[1]!.cells[1]!.status, "value");
  assert.equal(r.facts[1]!.verdict, "disagree"); // 21.4 vs 21, no tolerance
});

test("a JSON path that lands on an object is unparseable, and null is missing", () => {
  const r = buildDisagreementReport(
    [{ id: "a", capture: json({ daily: { max: { v: 1 } } }) }, { id: "b", capture: json({ forecast: { high: null } }) }],
    [{ ...TEMP, locate: { a: "daily.max", b: "forecast.high" } }],
  );
  assert.equal(r.facts[0]!.cells[0]!.status, "unparseable");
  assert.equal(r.facts[0]!.cells[1]!.status, "missing");
});

test("string and boolean facts normalise before comparing", () => {
  const r = buildDisagreementReport(
    [
      { id: "a", capture: json({ winner: "  Arsenal ", final: "FT" }) },
      { id: "b", capture: json({ result: { team: "ARSENAL" }, done: true }) },
    ],
    [
      { key: "winner", kind: "string", locate: { a: "winner", b: "result.team" } },
      { key: "final", kind: "boolean", locate: { a: "final", b: "done" } },
    ],
  );
  assert.deepEqual(r.facts.map((f) => f.verdict), ["agree", "agree"]);
});

test("relative tolerance applies to large values", () => {
  const r = buildDisagreementReport(
    [{ id: "a", capture: json({ p: "$64,100" }) }, { id: "b", capture: json({ p: 64_300 }) }],
    [{ key: "btc_usd", kind: "number", locate: { a: "p", b: "p" }, relTolerance: 0.005 }],
  );
  assert.equal(r.facts[0]!.verdict, "agree");
});

test("a tolerance chain cannot launder a disagreement, whatever the source order", () => {
  const fact: FactSpec = { key: "t", kind: "number", locate: { a: "v", b: "v", c: "v" }, absTolerance: 0.5 };
  for (const order of [[10.4, 10, 10.8], [10, 10.4, 10.8], [10.8, 10.4, 10]]) {
    const r = buildDisagreementReport(
      order.map((v, i) => ({ id: "abc"[i]!, capture: json({ v }) })),
      [fact],
    );
    assert.equal(r.facts[0]!.verdict, "disagree", `order ${order.join(",")}`);
  }
});

// ── Bounds ────────────────────────────────────────────────────────────────────

test("sources and facts past the bounds are listed as skipped, not dropped silently", () => {
  const many: SourceCapture[] = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, capture: json({ v: 1 }) }));
  many.push({ id: "s0", capture: json({ v: 2 }) });
  const facts: FactSpec[] = Array.from({ length: 20 }, (_, i) => ({ key: `f${i}`, kind: "number" as const, locate: { s0: "v", s1: "v" } }));
  const r = buildDisagreementReport(many, facts);
  assert.equal(r.sources.length, 8);
  assert.deepEqual(r.skipped.sources, ["s8", "s9", "s0 (duplicate id)"]);
  assert.equal(r.facts.length, 16);
  assert.deepEqual(r.skipped.facts, ["f16", "f17", "f18", "f19"]);
});

test("an oversized body is not parsed, and long strings are truncated in the report", () => {
  const big = json({ forecast: { high: 21 }, pad: "x".repeat(2_000) });
  const r = buildDisagreementReport(
    [{ id: "a", capture: json({ name: "y".repeat(500) }) }, { id: "b", capture: big }],
    [{ key: "name", kind: "string", locate: { a: "name", b: "forecast.high" } }],
    { maxBodyBytes: 1_000, maxValueChars: 50 },
  );
  assert.equal(r.facts[0]!.cells[1]!.status, "unavailable");
  assert.match(r.facts[0]!.cells[1]!.detail!, /over 1000 bytes/);
  assert.equal((r.facts[0]!.cells[0]!.value as string).length, 50);
});

test("the report never carries a body", () => {
  const secret = "BODY-MARKER-should-not-appear";
  const r = buildDisagreementReport(
    [{ id: "a", capture: captured(`<p>High: 20</p>${secret}`, "text/html") }, { id: "b", capture: captured(`{"x":"${secret}"`) }],
    [{ ...TEMP, locate: { a: /High:\s*(\d+)/, b: "x" } }],
  );
  assert.equal(JSON.stringify(r).includes(secret), false);
  assert.equal(summariseDisagreement(r).includes(secret), false);
});

test("no sources or no facts give an empty, non-disagreeing report", () => {
  assert.deepEqual(buildDisagreementReport([], [TEMP]).facts[0]!.verdict, "insufficient");
  assert.equal(buildDisagreementReport(sources(null, null), []).facts.length, 0);
});

// ── Normalizers ───────────────────────────────────────────────────────────────

test("number normalisation accepts units and separators but refuses ambiguity", () => {
  assert.deepEqual(normalizeNumber("1,234.5"), { ok: true, value: 1234.5 });
  assert.deepEqual(normalizeNumber("−3 °C"), { ok: true, value: -3 });
  assert.deepEqual(normalizeNumber("12%"), { ok: true, value: 12 });
  assert.equal(normalizeNumber("12-14").ok, false);
  assert.equal(normalizeNumber("about 12 or 13").ok, false);
  assert.equal(normalizeNumber(Number.NaN).ok, false);
  assert.equal(normalizeNumber({}).ok, false);
});

test("string and boolean normalisation", () => {
  assert.deepEqual(normalizeString("  Man\u00A0City "), { ok: true, value: "man city" });
  assert.equal(normalizeString("   ").ok, false);
  assert.deepEqual(normalizeBoolean("Yes"), { ok: true, value: true });
  assert.deepEqual(normalizeBoolean(0), { ok: true, value: false });
  assert.equal(normalizeBoolean("maybe").ok, false);
});
