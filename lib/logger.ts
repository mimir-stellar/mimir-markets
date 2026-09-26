/**
 * Structured worker logger for Mimir agents.
 *
 * Replaces scattered `console.log/warn/error` calls across the five worker
 * processes (oracle, market-creator, council, sync, traders) with a single,
 * consistent interface that:
 *
 *   - Tags every line with a `worker` name so Railway / logfmt grep works.
 *   - Emits an ISO timestamp on every entry.
 *   - Distinguishes four severity levels: info, warn, error, debug.
 *   - Accepts a structured `context` bag alongside the message so fields
 *     like `claimId`, `txHash`, `amountUsdc`, `persona` are first-class.
 *   - Never leaks secrets: known secret-shaped keys are redacted before any
 *     serialisation so a miscall with a wallet signer or private key does not
 *     write it to stdout.
 *   - Stays synchronous and allocation-light — this runs in a poll loop that
 *     touches the Stellar ledger, so logging must never add I/O back-pressure.
 *
 * Output format (one JSON object per line):
 *
 *   {"ts":"2026-09-25T18:00:00.000Z","level":"info","worker":"oracle","msg":"...","claimId":7}
 *
 * Human-readable banner lines (startup boxes) are still plain text — they are
 * not actionable events, just orientation noise, and structured format there
 * hurts readability more than it helps grep.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *
 *   import { makeLogger } from "../../lib/logger";
 *   const log = makeLogger("oracle");
 *
 *   log.info("Poll started", { total: 42 });
 *   log.warn("Council vote failed, falling back to solo", { claimId: 7 });
 *   log.error("Fatal error in settler", { claimId: 7, err });
 *   log.debug("Kelly fraction", { fraction: 0.12, bankrollUsdc: 10 });
 *
 *   // Banner lines — unchanged format
 *   log.banner("═══════════════════════\n  Mimir Oracle Agent\n═══════════════════════");
 */

/** Severity levels, ordered from least to most severe. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Structured context fields attached to a log entry.
 *
 * All values must be JSON-serialisable primitives or plain objects. Functions,
 * Promises and class instances are stripped before output.
 */
export type LogContext = Record<string, unknown>;

/**
 * Known environment variable patterns whose values must never appear in logs.
 *
 * Matching is case-insensitive and covers substring presence so variants like
 * `ORACLE_SECRET`, `COUNCIL_WHALE_PRIVATE_KEY`, `DATABASE_URL`, etc. are all
 * caught without enumerating every env name.
 */
const SECRET_PATTERNS = /secret|private.?key|api.?key|database.?url|password|token/i;

function isSecretKey(key: string): boolean {
  return SECRET_PATTERNS.test(key);
}

/**
 * Redact the value of any context key that looks like a secret.
 * Operates shallowly — deep nesting is not expected in log context.
 */
function redactSecrets(ctx: LogContext): LogContext {
  const out: LogContext = {};
  for (const [k, v] of Object.entries(ctx)) {
    out[k] = isSecretKey(k) ? "[REDACTED]" : v;
  }
  return out;
}

/**
 * Serialize a context value to something JSON-safe. Strips non-serialisable
 * types rather than letting JSON.stringify produce `undefined` gaps.
 */
function safeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Error) return { message: v.message, name: v.name };
  if (typeof v === "function" || typeof v === "symbol") return undefined;
  if (typeof v === "object") {
    // Plain objects — shallow copy with same rules.
    try {
      const obj = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(obj)) {
        const safe = safeValue(val);
        if (safe !== undefined) out[k] = safe;
      }
      return out;
    } catch {
      return String(v);
    }
  }
  return v;
}

function serialize(ctx: LogContext): LogContext {
  const out: LogContext = {};
  for (const [k, v] of Object.entries(ctx)) {
    const safe = safeValue(v);
    if (safe !== undefined) out[k] = safe;
  }
  return out;
}

/** Minimum level to emit. DEBUG lines are suppressed unless LOG_LEVEL=debug. */
function minLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL ?? "").toLowerCase().trim();
  if (env === "debug") return "debug";
  if (env === "warn")  return "warn";
  if (env === "error") return "error";
  return "info";
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldEmit(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel()];
}

function emit(level: LogLevel, worker: string, msg: string, ctx: LogContext): void {
  if (!shouldEmit(level)) return;

  const entry: Record<string, unknown> = {
    ts:     new Date().toISOString(),
    level,
    worker,
    msg,
    ...serialize(redactSecrets(ctx)),
  };

  const line = JSON.stringify(entry);
  if (level === "error") {
    process.stderr.write(line + "\n");
  } else if (level === "warn") {
    // warn → stderr so Railway warning-level filters can catch it without
    // mixing it into the info stream.
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export interface Logger {
  /** Normal operational events: polls, settlements, stakes, syncs. */
  info(msg: string, ctx?: LogContext): void;
  /** Recoverable problems: fallbacks triggered, skipped claims, soft errors. */
  warn(msg: string, ctx?: LogContext): void;
  /** Unrecoverable errors and fatal conditions. */
  error(msg: string, ctx?: LogContext): void;
  /** High-volume diagnostic events suppressed unless LOG_LEVEL=debug. */
  debug(msg: string, ctx?: LogContext): void;
  /**
   * Print a human-readable banner line (startup box, separator).
   * Always goes to stdout as plain text, never structured.
   */
  banner(text: string): void;
  /**
   * Return a child logger bound to additional context merged into every entry.
   * Useful to avoid repeating `{ claimId }` on every call inside a settle loop.
   */
  child(extra: LogContext): Logger;
}

/**
 * Create a structured logger for a named worker.
 *
 * @param worker  Short identifier that appears in every log line: "oracle",
 *                "market-creator", "council", "sync", "traders".
 * @param base    Optional context fields merged into every entry from this logger.
 */
export function makeLogger(worker: string, base: LogContext = {}): Logger {
  function log(level: LogLevel, msg: string, ctx: LogContext = {}): void {
    emit(level, worker, msg, { ...base, ...ctx });
  }

  return {
    info:  (msg, ctx = {}) => log("info",  msg, ctx),
    warn:  (msg, ctx = {}) => log("warn",  msg, ctx),
    error: (msg, ctx = {}) => log("error", msg, ctx),
    debug: (msg, ctx = {}) => log("debug", msg, ctx),
    banner: (text) => process.stdout.write(text + "\n"),
    child: (extra) => makeLogger(worker, { ...base, ...extra }),
  };
}
