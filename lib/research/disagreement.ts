/**
 * Research-source disagreement report.
 *
 * Given a handful of captured sources for the same question (two weather
 * APIs, a league site and a score feed, two price endpoints), this compares the
 * normalized facts each one carries and says, per fact, whether the sources
 * agree, disagree, or simply do not give enough usable evidence to tell.
 *
 * The distinction that matters: a source that is down, stale, blocked, lacks the
 * field, or carries a value that cannot be parsed is NOT a dissenting source.
 * Counting it as one would turn an outage into a "conflict"; counting it as
 * agreement would hide it. So every per-source cell carries one of:
 *
 *   value        — a normalized value was extracted
 *   missing      — the source was usable but the fact is absent (or null)
 *   unparseable  — the field exists but could not be normalized to the fact's kind
 *   unavailable  — the capture failed, or content validation marked it unusable
 *
 * and only `value` cells take part in the agree/disagree decision.
 *
 * Bounded by construction: at most `maxSources` sources and `maxFacts` facts
 * are compared (the rest are listed as skipped, never silently dropped), bodies
 * larger than `maxBodyBytes` are not parsed, and string values are truncated to
 * `maxValueChars` in the report. The report never contains a body.
 *
 * Pure and synchronous: no fetching here. Callers pass captures they already
 * have from `gatewayFetch` (and, optionally, `validateResearchContent` results).
 */

import type { FetchFailure, FetchResult, FetchSuccess } from "./gateway";
import type { ContentValidationResult } from "./content-validation";

// ── Inputs ────────────────────────────────────────────────────────────────────

export type FactKind = "number" | "string" | "boolean";

export interface FactSpec {
  /** Stable key for the fact, e.g. `max_temp_c`. */
  key: string;
  kind: FactKind;
  /**
   * Where to read it, per source id. A dotted JSON path (`daily.temperature_max.0`)
   * for JSON bodies, or a regex whose first capture group is the value for text.
   * A source with no locator for this fact is reported as `missing`.
   */
  locate: Record<string, string | RegExp>;
  /** Numbers: largest absolute difference still counted as agreement. Default 0. */
  absTolerance?: number;
  /** Numbers: largest relative difference (0.01 = 1%) still counted as agreement. Default 0. */
  relTolerance?: number;
}

export interface SourceCapture {
  /** Caller's id for the source, e.g. `open-meteo`. */
  id: string;
  /** What the gateway returned. A failure (or null, never fetched) is `unavailable`. */
  capture: FetchResult | FetchSuccess | null;
  /** Optional content-validation verdict; an unusable one makes the source `unavailable`. */
  validation?: ContentValidationResult;
}

export interface DisagreementOptions {
  maxSources?: number;
  maxFacts?: number;
  maxBodyBytes?: number;
  maxValueChars?: number;
}

export const DISAGREEMENT_DEFAULTS = {
  maxSources: 8,
  maxFacts: 16,
  maxBodyBytes: 512 * 1024,
  maxValueChars: 200,
} as const;

// ── Outputs ───────────────────────────────────────────────────────────────────

export type CellStatus = "value" | "missing" | "unparseable" | "unavailable";

export interface FactCell {
  source: string;
  status: CellStatus;
  /** Present only when status is `value`. Strings are truncated to `maxValueChars`. */
  value?: number | string | boolean;
  /** Why the cell is not a value. Never contains body content. */
  detail?: string;
}

export type FactVerdict =
  /** Two or more values, all within tolerance. */
  | "agree"
  /** Two or more values; for numbers, the min and max are outside tolerance. */
  | "disagree"
  /** Fewer than two values: nothing to compare. Not a disagreement. */
  | "insufficient";

export interface FactReport {
  key: string;
  kind: FactKind;
  verdict: FactVerdict;
  /** Distinct normalized values among `value` cells, with the sources carrying each. */
  groups: Array<{ value: number | string | boolean; sources: string[] }>;
  cells: FactCell[];
  counts: Record<CellStatus, number>;
}

export interface DisagreementReport {
  /** True when any compared fact is `disagree`. */
  disagreement: boolean;
  facts: FactReport[];
  sources: Array<{ id: string; status: "usable" | "unavailable"; detail?: string }>;
  skipped: { sources: string[]; facts: string[] };
}

// ── Normalization ─────────────────────────────────────────────────────────────

type Normalized = { ok: true; value: number | string | boolean } | { ok: false; detail: string };

/** Numbers: accepts `1,234.5`, `12 °C`, `-3%`, `$0.42`; rejects anything with two numbers. */
export function normalizeNumber(raw: unknown): Normalized {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? { ok: true, value: raw } : { ok: false, detail: "not a finite number" };
  }
  if (typeof raw !== "string") return { ok: false, detail: `expected a number, got ${typeof raw}` };
  const cleaned = raw.trim().replace(/[\u2212\u2013]/g, "-");
  const matches = cleaned.match(/-?\d[\d,]*(?:\.\d+)?|-?\.\d+/g) ?? [];
  if (matches.length !== 1) {
    return { ok: false, detail: matches.length === 0 ? "no number found" : "more than one number" };
  }
  const rest = cleaned.replace(matches[0]!, "").replace(/[\s$€£%°a-zA-Z/]/g, "");
  if (rest.length > 0) return { ok: false, detail: "unexpected characters around the number" };
  const value = Number(matches[0]!.replace(/,/g, ""));
  return Number.isFinite(value) ? { ok: true, value } : { ok: false, detail: "not a finite number" };
}

/** Strings: NFKC, trimmed, inner whitespace collapsed, lowercased. Empty is missing upstream. */
export function normalizeString(raw: unknown): Normalized {
  if (typeof raw === "number" || typeof raw === "boolean") raw = String(raw);
  if (typeof raw !== "string") return { ok: false, detail: `expected text, got ${typeof raw}` };
  const value = raw.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  return value ? { ok: true, value } : { ok: false, detail: "empty text" };
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "final", "ft", "official"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0"]);

export function normalizeBoolean(raw: unknown): Normalized {
  if (typeof raw === "boolean") return { ok: true, value: raw };
  if (typeof raw === "number") {
    if (raw === 1 || raw === 0) return { ok: true, value: raw === 1 };
    return { ok: false, detail: "number is not 0 or 1" };
  }
  if (typeof raw !== "string") return { ok: false, detail: `expected a boolean, got ${typeof raw}` };
  const word = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return { ok: true, value: true };
  if (FALSE_WORDS.has(word)) return { ok: true, value: false };
  return { ok: false, detail: "not a recognised yes/no value" };
}

function normalize(kind: FactKind, raw: unknown): Normalized {
  if (kind === "number") return normalizeNumber(raw);
  if (kind === "boolean") return normalizeBoolean(raw);
  return normalizeString(raw);
}

// ── Extraction ────────────────────────────────────────────────────────────────

type Extracted = { found: true; raw: unknown } | { found: false } | { error: string };

function readJsonPath(doc: unknown, path: string): Extracted {
  let node: unknown = doc;
  for (const part of path.split(".").filter(Boolean)) {
    if (node === null || typeof node !== "object") return { found: false };
    node = Array.isArray(node)
      ? /^\d+$/.test(part) ? node[Number(part)] : undefined
      : (node as Record<string, unknown>)[part];
    if (node === undefined) return { found: false };
  }
  if (node === null) return { found: false };
  if (typeof node === "object") return { error: "path points at an object, not a value" };
  return { found: true, raw: node };
}

function readRegex(body: string, pattern: RegExp): Extracted {
  // Non-global copy so lastIndex state never leaks between sources.
  const re = new RegExp(pattern.source, pattern.flags.replace("g", ""));
  const match = re.exec(body);
  if (!match) return { found: false };
  const raw = match[1] ?? match[0];
  return raw.trim() ? { found: true, raw } : { found: false };
}

// ── Report ────────────────────────────────────────────────────────────────────

interface PreparedSource {
  id: string;
  usable: boolean;
  detail?: string;
  body?: string;
  json?: unknown;
  jsonError?: string;
}

function failureDetail(f: FetchFailure): string {
  return f.kind === "http_error" ? `fetch failed: http ${f.status}` : `fetch failed: ${f.kind}`;
}

function prepare(src: SourceCapture, maxBodyBytes: number): PreparedSource {
  const cap = src.capture;
  if (!cap) return { id: src.id, usable: false, detail: "not captured" };
  if ("ok" in cap && cap.ok === false) return { id: src.id, usable: false, detail: failureDetail(cap) };
  const success = cap as FetchSuccess;
  if (src.validation && !src.validation.usable) {
    return { id: src.id, usable: false, detail: `content validation: ${src.validation.state}` };
  }
  if (Buffer.byteLength(success.body, "utf8") > maxBodyBytes) {
    return { id: src.id, usable: false, detail: `body over ${maxBodyBytes} bytes; not parsed` };
  }
  const prepared: PreparedSource = { id: src.id, usable: true, body: success.body };
  const looksJson = /json/i.test(success.contentType) || /^\s*[[{]/.test(success.body);
  if (looksJson) {
    try {
      prepared.json = JSON.parse(success.body);
    } catch {
      prepared.jsonError = "body is not valid JSON";
    }
  }
  return prepared;
}

function cellFor(src: PreparedSource, fact: FactSpec, maxValueChars: number): FactCell {
  if (!src.usable) return { source: src.id, status: "unavailable", detail: src.detail };
  const locator = fact.locate[src.id];
  if (locator === undefined) return { source: src.id, status: "missing", detail: "no locator for this source" };

  let extracted: Extracted;
  if (locator instanceof RegExp) {
    extracted = readRegex(src.body ?? "", locator);
  } else if (src.jsonError) {
    return { source: src.id, status: "unparseable", detail: src.jsonError };
  } else if (src.json === undefined) {
    return { source: src.id, status: "unparseable", detail: "JSON path given for a non-JSON body" };
  } else {
    extracted = readJsonPath(src.json, locator);
  }

  if ("error" in extracted) return { source: src.id, status: "unparseable", detail: extracted.error };
  if (!extracted.found) return { source: src.id, status: "missing", detail: "fact not present" };

  const n = normalize(fact.kind, extracted.raw);
  if (!n.ok) return { source: src.id, status: "unparseable", detail: n.detail };
  const value = typeof n.value === "string" && n.value.length > maxValueChars
    ? n.value.slice(0, maxValueChars)
    : n.value;
  return { source: src.id, status: "value", value };
}

function withinTolerance(a: number, b: number, fact: FactSpec): boolean {
  const diff = Math.abs(a - b);
  if (diff <= (fact.absTolerance ?? 0)) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale > 0 && diff / scale <= (fact.relTolerance ?? 0);
}

function group(fact: FactSpec, cells: FactCell[]): FactReport["groups"] {
  const groups: FactReport["groups"] = [];
  for (const cell of cells) {
    if (cell.status !== "value") continue;
    const v = cell.value!;
    const home = groups.find((g) =>
      fact.kind === "number"
        ? withinTolerance(g.value as number, v as number, fact)
        : g.value === v,
    );
    if (home) home.sources.push(cell.source);
    else groups.push({ value: v, sources: [cell.source] });
  }
  return groups;
}

/**
 * Compare facts across captured sources. Never throws on source content: a bad
 * body becomes `unparseable`, a failed capture `unavailable`.
 */
export function buildDisagreementReport(
  sources: SourceCapture[],
  facts: FactSpec[],
  options: DisagreementOptions = {},
): DisagreementReport {
  const maxSources = options.maxSources ?? DISAGREEMENT_DEFAULTS.maxSources;
  const maxFacts = options.maxFacts ?? DISAGREEMENT_DEFAULTS.maxFacts;
  const maxBodyBytes = options.maxBodyBytes ?? DISAGREEMENT_DEFAULTS.maxBodyBytes;
  const maxValueChars = options.maxValueChars ?? DISAGREEMENT_DEFAULTS.maxValueChars;

  const seen = new Set<string>();
  const unique = sources.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  const compared = unique.slice(0, Math.max(0, maxSources)).map((s) => prepare(s, maxBodyBytes));
  const factList = facts.slice(0, Math.max(0, maxFacts));

  const factReports: FactReport[] = factList.map((fact) => {
    const cells = compared.map((src) => cellFor(src, fact, maxValueChars));
    const counts: Record<CellStatus, number> = { value: 0, missing: 0, unparseable: 0, unavailable: 0 };
    for (const c of cells) counts[c.status] += 1;
    const groups = group(fact, cells);
    // Numbers decide on the full spread (min vs max), not on the display groups:
    // greedy grouping could chain 10 → 10.4 → 10.8 into one group under a 0.5
    // tolerance and depend on source order. Spread does not.
    let agrees = groups.length <= 1;
    if (fact.kind === "number" && counts.value >= 2) {
      const values = cells.filter((c) => c.status === "value").map((c) => c.value as number);
      agrees = withinTolerance(Math.min(...values), Math.max(...values), fact);
    }
    const verdict: FactVerdict = counts.value < 2 ? "insufficient" : agrees ? "agree" : "disagree";
    return { key: fact.key, kind: fact.kind, verdict, groups, cells, counts };
  });

  return {
    disagreement: factReports.some((f) => f.verdict === "disagree"),
    facts: factReports,
    sources: compared.map((s) => (s.usable ? { id: s.id, status: "usable" as const } : { id: s.id, status: "unavailable" as const, detail: s.detail })),
    skipped: {
      sources: [
        ...unique.slice(Math.max(0, maxSources)).map((s) => s.id),
        ...sources.filter((s, i) => sources.findIndex((o) => o.id === s.id) !== i).map((s) => `${s.id} (duplicate id)`),
      ],
      facts: facts.slice(Math.max(0, maxFacts)).map((f) => f.key),
    },
  };
}

/** One line per fact for logs and operator views. Never includes bodies. */
export function summariseDisagreement(report: DisagreementReport): string {
  return report.facts
    .map((f) => {
      const c = f.counts;
      const tail = `${c.value} value, ${c.missing} missing, ${c.unparseable} unparseable, ${c.unavailable} unavailable`;
      if (f.verdict === "disagree") {
        const split = f.groups.map((g) => `${String(g.value)} (${g.sources.join(", ")})`).join(" vs ");
        return `${f.key}: disagree: ${split} [${tail}]`;
      }
      return `${f.key}: ${f.verdict} [${tail}]`;
    })
    .join("\n");
}
