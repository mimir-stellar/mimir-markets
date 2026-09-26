/**
 * Tests for lib/logger.ts — structured worker logger.
 *
 * Validates JSON output format, severity routing, secret redaction,
 * child context merging, banner passthrough, and level filtering.
 * No production secrets or live services required.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { makeLogger } from "../../lib/logger";
import type { LogLevel } from "../../lib/logger";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Capture one write to stdout/stderr as a parsed JSON object. */
function capture(fn: () => void): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as any).write = (chunk: string) => { out.push(chunk); return true; };
  (process.stderr as any).write = (chunk: string) => { err.push(chunk); return true; };
  try {
    fn();
  } finally {
    (process.stdout as any).write = origOut;
    (process.stderr as any).write = origErr;
  }
  return { out, err };
}

function parseLines(lines: string[]): unknown[] {
  return lines
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ── Output shape ──────────────────────────────────────────────────────────────

test("info line is valid JSON with required fields", () => {
  const log = makeLogger("oracle");
  const { out } = capture(() => log.info("Poll started", { total: 42 }));
  const [entry] = parseLines(out) as any[];
  assert.ok(entry, "must emit a line");
  assert.equal(entry.level, "info");
  assert.equal(entry.worker, "oracle");
  assert.equal(entry.msg, "Poll started");
  assert.equal(entry.total, 42);
  assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test("warn and error go to stderr, info and debug go to stdout", () => {
  const log = makeLogger("sync");
  const saved = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "debug";
  try {
    const { out: o1, err: e1 } = capture(() => log.info("hi"));
    const { out: o2, err: e2 } = capture(() => log.warn("oops"));
    const { out: o3, err: e3 } = capture(() => log.error("boom"));
    const { out: o4 } = capture(() => log.debug("verbose"));
    assert.ok(o1.length > 0 && e1.length === 0, "info → stdout");
    assert.ok(o2.length === 0 && e2.length > 0, "warn → stderr");
    assert.ok(o3.length === 0 && e3.length > 0, "error → stderr");
    assert.ok(o4.length > 0, "debug → stdout");
  } finally {
    if (saved === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = saved;
  }
});

test("each line is terminated with a newline", () => {
  const log = makeLogger("traders");
  const { out } = capture(() => log.info("tick"));
  assert.ok(out[0]?.endsWith("\n"), "line must end with newline");
});

// ── Secret redaction ─────────────────────────────────────────────────────────

test("context keys matching secret patterns are redacted", () => {
  const log = makeLogger("council");
  const { out } = capture(() =>
    log.info("test", {
      apiKey: "sk-super-secret",
      database_url: "postgres://user:pass@host/db",
      normalField: "visible",
    }),
  );
  const [entry] = parseLines(out) as any[];
  assert.equal(entry.apiKey, "[REDACTED]", "apiKey must be redacted");
  assert.equal(entry.database_url, "[REDACTED]", "database_url must be redacted");
  assert.equal(entry.normalField, "visible", "normal field must pass through");
});

test("secret redaction is case-insensitive on key names", () => {
  const log = makeLogger("oracle");
  const { out } = capture(() =>
    log.info("keys", { ORACLE_SECRET: "x", PrivateKey: "y", TOKEN: "z" }),
  );
  const [entry] = parseLines(out) as any[];
  assert.equal(entry.ORACLE_SECRET, "[REDACTED]");
  assert.equal(entry.PrivateKey, "[REDACTED]");
  assert.equal(entry.TOKEN, "[REDACTED]");
});

// ── BigInt and Error serialisation ────────────────────────────────────────────

test("bigint context values are serialised as strings", () => {
  const log = makeLogger("oracle");
  const { out } = capture(() => log.info("amount", { atomic: 90071992547409931234567n }));
  const [entry] = parseLines(out) as any[];
  assert.equal(entry.atomic, "90071992547409931234567");
});

test("Error context values are serialised as {message, name}", () => {
  const log = makeLogger("sync");
  const err = new TypeError("bad input");
  const { err: errLines } = capture(() => log.warn("caught", { err }));
  const [entry] = parseLines(errLines) as any[];
  assert.ok(entry, "must emit a line");
  assert.equal(entry.err.message, "bad input");
  assert.equal(entry.err.name, "TypeError");
});

test("function values are stripped from context", () => {
  const log = makeLogger("oracle");
  const { out } = capture(() => log.info("ctx", { fn: () => "nope", kept: 1 }));
  const [entry] = parseLines(out) as any[];
  assert.equal(entry.fn, undefined, "function must be stripped");
  assert.equal(entry.kept, 1);
});

// ── Child logger ──────────────────────────────────────────────────────────────

test("child logger merges base context into every entry", () => {
  const log = makeLogger("oracle");
  const clog = log.child({ claimId: 7 });
  const { out } = capture(() => clog.info("settling"));
  const [entry] = parseLines(out) as any[];
  assert.equal(entry.claimId, 7);
  assert.equal(entry.worker, "oracle");
  assert.equal(entry.msg, "settling");
});

test("child context does not pollute the parent logger", () => {
  const log = makeLogger("oracle");
  const clog = log.child({ claimId: 99 });
  void clog; // ensure child is created
  const { out } = capture(() => log.info("parent line"));
  const [entry] = parseLines(out) as any[];
  assert.equal(entry.claimId, undefined, "parent must not carry child context");
});

test("child override wins over parent context for the same key", () => {
  const log = makeLogger("council").child({ slug: "optimist" });
  const inner = log.child({ slug: "pessimist" });
  const { out } = capture(() => inner.info("vote"));
  const [entry] = parseLines(out) as any[];
  assert.equal(entry.slug, "pessimist");
});

// ── Banner ────────────────────────────────────────────────────────────────────

test("banner writes plain text to stdout, not JSON", () => {
  const log = makeLogger("sync");
  const { out } = capture(() => log.banner("═══\n  Mimir Sync\n═══"));
  const raw = out.join("");
  assert.ok(raw.includes("Mimir Sync"), "banner text must appear");
  assert.throws(() => JSON.parse(raw), "banner output must not be valid JSON");
});

// ── Level filtering ───────────────────────────────────────────────────────────

test("debug lines are suppressed when LOG_LEVEL is not debug", () => {
  const saved = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "info";
  try {
    const log = makeLogger("traders");
    const { out } = capture(() => log.debug("verbose details"));
    assert.equal(out.length, 0, "debug must be suppressed at info level");
  } finally {
    if (saved === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = saved;
  }
});

test("debug lines appear when LOG_LEVEL=debug", () => {
  const saved = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "debug";
  try {
    const log = makeLogger("traders");
    const { out } = capture(() => log.debug("trace me"));
    const [entry] = parseLines(out) as any[];
    assert.equal(entry?.level, "debug");
  } finally {
    if (saved === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = saved;
  }
});

test("warn level suppresses info and debug", () => {
  const saved = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "warn";
  try {
    const log = makeLogger("oracle");
    const { out: o1 } = capture(() => log.info("info line"));
    const { out: o2 } = capture(() => log.debug("debug line"));
    const { err: e1 } = capture(() => log.warn("warn line"));
    assert.equal(o1.length, 0, "info suppressed at warn level");
    assert.equal(o2.length, 0, "debug suppressed at warn level");
    assert.ok(e1.length > 0, "warn still emitted");
  } finally {
    if (saved === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = saved;
  }
});

// ── Positive coverage: all five workers emit their worker tag ─────────────────

test("worker tag is set correctly for each worker name", () => {
  const workers = ["oracle", "market-creator", "council", "sync", "traders"] as const;
  for (const w of workers) {
    const log = makeLogger(w);
    const { out } = capture(() => log.info("heartbeat"));
    const [entry] = parseLines(out) as any[];
    assert.equal(entry.worker, w, `worker tag must be '${w}'`);
  }
});

// ── Regression: empty context ─────────────────────────────────────────────────

test("log call with no context object does not throw", () => {
  const log = makeLogger("sync");
  assert.doesNotThrow(() => {
    const { out } = capture(() => log.info("no ctx"));
    const [entry] = parseLines(out) as any[];
    assert.equal(entry.msg, "no ctx");
  });
});
