/**
 * LLM drafting and statement revision review for market creator.
 *
 * This module owns:
 * 1. The drafting prompt and response parsing for candidate markets.
 * 2. The statement revision review step: binding approved wording, deadline,
 *    and source commitment to a cryptographic SHA-256 digest.
 * 3. Pre-signing verification: rejecting signing if any reviewed statement
 *    field changed between review and on-chain submission.
 */

import * as crypto from "node:crypto";
import { extractUsdThresholds, cryptoThresholdReason } from "./thresholds.js";
import {
  computeStatementDigest,
  buildDeduplicationIdentity,
  reconcileSubmission,
  type MarketCreationIntent,
  type ReconciliationResult,
} from "./dedupe.js";

export interface ClaimCandidate {
  question: string;
  resolutionUrl: string;
  /** Canonical UTC ISO-8601 deadline timestamp (e.g. "2026-05-01T18:00:00.000Z"). */
  deadline: string;
  /** Source time-zone designator or IANA zone retained as metadata (e.g. "UTC", "+02:00", "America/New_York"). */
  sourceZone?: string;
  /** Explicit time-zone interpretation metadata recorded for `deadline`. */
  deadlineInterpretation?: DeadlineInterpretation;
  category?: string;
  threshold?: number;
  statementDigest?: string;
  deduplicationId?: string;
  creatorPosition?: string;
  counterPosition?: string;
  settlementRule?: string;
  qualityScore?: number;
  [key: string]: unknown;
}

/**
 * Reasons a drafted candidate can be rejected before transaction attempts.
 * Stable identifiers: consumers may key on these strings.
 */
export type CandidateRejectionReason =
  | "missing_fields"
  | "unsafe_crypto_threshold"
  | "source_fetch_failed"
  | "duplicate_question";

/**
 * Per-source retry bookkeeping for rejected source fetches.
 * `nextEligibleAt` is an epoch-ms timestamp before which the source must not be retried.
 */
export interface SourceRetryState {
  sourceUrl: string;
  reason: CandidateRejectionReason;
  attempts: number;
  nextEligibleAt: number;
}

export interface RetryQueueOptions {
  /** Maximum number of tracked sources; oldest entries are evicted beyond this. */
  maxEntries?: number;
  /** Base backoff in ms; doubled per attempt. */
  baseBackoffMs?: number;
  /** Upper bound on backoff in ms. */
  maxBackoffMs?: number;
  /** Maximum attempts before a source is dropped from the queue. */
  maxAttempts?: number;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

const DEFAULT_RETRY_OPTIONS = {
  maxEntries: 100,
  baseBackoffMs: 60_000,
  maxBackoffMs: 3_600_000,
  maxAttempts: 5,
} as const;

/**
 * Bounded retry queue for rejected source fetches. Tracks a stable reason and
 * next eligibility per source so that low-quality or unreachable sources are
 * not re-attempted immediately.
 */
export class SourceRetryQueue {
  private readonly entries = new Map<string, SourceRetryState>();
  private readonly maxEntries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;

  constructor(options: RetryQueueOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_RETRY_OPTIONS.maxEntries;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_RETRY_OPTIONS.baseBackoffMs;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_RETRY_OPTIONS.maxBackoffMs;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_RETRY_OPTIONS.maxAttempts;
    this.now = options.now ?? (() => Date.now());
  }

  /** Record a rejection for a source and compute its next eligibility. */
  recordRejection(sourceUrl: string, reason: CandidateRejectionReason): SourceRetryState {
    const prev = this.entries.get(sourceUrl);
    const attempts = (prev?.attempts ?? 0) + 1;
    const backoff = Math.min(
      this.baseBackoffMs * 2 ** (attempts - 1),
      this.maxBackoffMs,
    );
    const state: SourceRetryState = {
      sourceUrl,
      reason,
      attempts,
      nextEligibleAt: this.now() + backoff,
    };
    this.entries.delete(sourceUrl);
    this.entries.set(sourceUrl, state);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return state;
  }

  /** True when the source may be fetched again now. */
  isEligible(sourceUrl: string): boolean {
    const state = this.entries.get(sourceUrl);
    if (!state) return true;
    if (state.attempts >= this.maxAttempts) return false;
    return this.now() >= state.nextEligibleAt;
  }

  get(sourceUrl: string): SourceRetryState | undefined {
    return this.entries.get(sourceUrl);
  }

  clear(sourceUrl: string): void {
    this.entries.delete(sourceUrl);
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Drop candidates whose source is currently ineligible for retry. Candidates
 * are never sent on to transaction attempts while their source is backed off.
 */
export function filterByRetryEligibility(
  candidates: readonly ClaimCandidate[],
  queue: SourceRetryQueue,
): ClaimCandidate[] {
  return candidates.filter((candidate) => queue.isEligible(candidate.resolutionUrl));
}

export interface DraftingContext {
  /** Source material the LLM should read from. */
  sourceText: string;
  /**
   * Identity of the source snapshot the draft was generated from (e.g. URL or
   * document id). Bound onto every candidate so that identical questions drawn
   * from different sources are not collapsed during deduplication.
   */
  sourceId?: string;
  /**
   * Version / capture timestamp of the source snapshot. Changes to the source
   * content over time produce distinct drafts.
   */
  captureVersion?: string;
  /**
   * Normalization policy version(s) in effect for this draft. Included in
   * deduplication keys so that decisions cached under an incompatible policy
   * are invalidated explicitly rather than silently reused.
   */
  normalizationPolicyVersion?: string;
  /** Optional existing questions to avoid duplicating. */
  existingQuestions?: readonly string[];
  /** Maximum number of candidates to request. */
  maxCandidates?: number;
  /** Category hint for the prompt. */
  category?: string;
  /** Optional time-zone hint to include in the drafting prompt. */
  timeZone?: string;
}

export type LlmCompleter = (prompt: string) => Promise<string>;

const DEFAULT_MAX_CANDIDATES = 5;
const MAX_UTC_OFFSET_MINUTES = 14 * 60;

const AMBIGUOUS_ZONE_ABBREVIATIONS = new Set([
  "ACDT",
  "ACST",
  "ACT",
  "ADT",
  "AEDT",
  "AEST",
  "AFT",
  "AKDT",
  "AKST",
  "ART",
  "AST",
  "AWST",
  "AZOST",
  "AZOT",
  "BDT",
  "BOT",
  "BRST",
  "BRT",
  "BST",
  "BTT",
  "CAT",
  "CCT",
  "CDT",
  "CEST",
  "CET",
  "CHADT",
  "CHAST",
  "CLT",
  "CLST",
  "COT",
  "CST",
  "CT",
  "CVT",
  "EAT",
  "ECT",
  "EDT",
  "EEST",
  "EET",
  "EST",
  "ET",
  "FET",
  "FJST",
  "FJT",
  "GFT",
  "GST",
  "GYT",
  "HDT",
  "HKT",
  "HST",
  "ICT",
  "IDT",
  "IRST",
  "IST",
  "JST",
  "KGT",
  "KST",
  "MDT",
  "MET",
  "MEST",
  "MMT",
  "MSK",
  "MST",
  "MT",
  "MUT",
  "MYT",
  "NDT",
  "NFT",
  "NPT",
  "NST",
  "NZDT",
  "NZST",
  "PDT",
  "PET",
  "PGT",
  "PHOT",
  "PHT",
  "PKT",
  "PMDT",
  "PMST",
  "PST",
  "PT",
  "PYST",
  "PYT",
  "RET",
  "SAST",
  "SBT",
  "SCT",
  "SGT",
  "SLST",
  "SRT",
  "SST",
  "TRT",
  "ULAT",
  "UYT",
  "VET",
  "VLAT",
  "WAT",
  "WEDT",
  "WEST",
  "WET",
  "WIB",
  "WIT",
  "WITA",
  "WST",
  "YAKT",
  "YEKT",
]);

const LOCAL_ONLY_LABELS = new Set([
  "local",
  "localtime",
  "local_time",
  "local-time",
  "system",
  "auto",
  "unspecified",
  "unknown",
]);

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

/**
 * Format a signed offset in minutes as a canonical ISO-8601 `+HH:MM` / `-HH:MM` string.
 */
export function formatUtcOffset(offsetMinutes: number): string {
  const normalized = Object.is(offsetMinutes, -0) ? 0 : Math.trunc(offsetMinutes);
  const sign = normalized < 0 ? "-" : "+";
  const abs = Math.abs(normalized);
  const hours = String(Math.floor(abs / 60)).padStart(2, "0");
  const minutes = String(abs % 60).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

interface ParsedOffsetSpec {
  offsetMinutes: number;
  utcOffset: string;
}

function parseOffsetSpec(raw: string): ParsedOffsetSpec | null {
  const trimmed = raw.trim();
  const match = trimmed.match(/^(?:(?:UTC|GMT)\s*)?([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!match) return null;

  const signChar = match[1];
  const hourStr = match[2];
  const minStr = match[3] ?? "00";

  // Without a colon, 3-digit offsets like "+230" are ambiguous in ISO-8601; require 1-2 digit hour or 4 digits total.
  if (!trimmed.includes(":") && match[3] !== undefined && hourStr.length !== 2) {
    return null;
  }

  const hours = Number.parseInt(hourStr, 10);
  const minutes = Number.parseInt(minStr, 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 14 || minutes < 0 || minutes > 59) return null;

  // RFC 3339 section 4.3 defines "-00:00" as "unknown local offset".
  if (signChar === "-" && hours === 0 && minutes === 0) {
    return null;
  }

  const totalMinutes = (signChar === "-" ? -1 : 1) * (hours * 60 + minutes);
  if (Math.abs(totalMinutes) > MAX_UTC_OFFSET_MINUTES) return null;

  return {
    offsetMinutes: totalMinutes,
    utcOffset: formatUtcOffset(totalMinutes),
  };
}

export type ValidClassifiedZone =
  | { kind: "utc"; sourceZone: "UTC" }
  | { kind: "offset"; sourceZone: string; offsetMinutes: number; utcOffset: string }
  | { kind: "iana"; sourceZone: string };

export type ClassifiedZone =
  | ValidClassifiedZone
  | { kind: "invalid"; reason: DeadlineRejectionReason; error: string };

function classifyExplicitZone(rawZone: string): ClassifiedZone {
  const trimmed = rawZone.trim();
  if (!trimmed) {
    return {
      kind: "invalid",
      reason: "invalid_timezone",
      error: "Explicit time zone must not be empty.",
    };
  }

  const lower = trimmed.toLowerCase();
  if (LOCAL_ONLY_LABELS.has(lower)) {
    return {
      kind: "invalid",
      reason: "ambiguous_local_deadline",
      error: `Time zone "${trimmed}" is local-only and ambiguous.`,
    };
  }

  if (lower === "z" || lower === "utc" || lower === "gmt") {
    return { kind: "utc", sourceZone: "UTC" };
  }

  if (/^(?:(?:utc|gmt)\s*)?[+-]/i.test(trimmed)) {
    // Reject "-00:00" specifically as unknown local offset (RFC 3339 §4.3).
    if (/^(?:(?:utc|gmt)\s*)?-0{1,2}(?::?00)?$/i.test(trimmed)) {
      return {
        kind: "invalid",
        reason: "ambiguous_local_deadline",
        error: `Offset "${trimmed}" denotes an unknown local offset.`,
      };
    }
    const parsedOffset = parseOffsetSpec(trimmed);
    if (!parsedOffset) {
      return {
        kind: "invalid",
        reason: "invalid_timezone",
        error: `Invalid UTC offset "${trimmed}".`,
      };
    }
    return {
      kind: "offset",
      sourceZone: parsedOffset.utcOffset,
      offsetMinutes: parsedOffset.offsetMinutes,
      utcOffset: parsedOffset.utcOffset,
    };
  }

  const upper = trimmed.toUpperCase();
  if (AMBIGUOUS_ZONE_ABBREVIATIONS.has(upper) || (!trimmed.includes("/") && /^[A-Za-z]{2,5}$/.test(trimmed))) {
    return {
      kind: "invalid",
      reason: "ambiguous_timezone",
      error: `Time-zone abbreviation "${trimmed}" is ambiguous; use an IANA zone or explicit UTC offset.`,
    };
  }

  if (!trimmed.includes("/")) {
    return {
      kind: "invalid",
      reason: "invalid_timezone",
      error: `Unrecognized time zone "${trimmed}".`,
    };
  }

  const segments = trimmed.split("/");
  if (segments.some((seg) => !seg || !/^[A-Za-z0-9_+-]+$/.test(seg))) {
    return {
      kind: "invalid",
      reason: "invalid_timezone",
      error: `Malformed IANA time zone "${trimmed}".`,
    };
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    return { kind: "iana", sourceZone: trimmed };
  } catch {
    return {
      kind: "invalid",
      reason: "invalid_timezone",
      error: `Unknown IANA time zone "${trimmed}".`,
    };
  }
}

interface WallClockComponents {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

function getZonedWallClock(utcMs: number, timeZone: string): Omit<WallClockComponents, "millisecond"> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(new Date(utcMs));
  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = Number.parseInt(part.value, 10);
    }
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour === 24 ? 0 : values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function getZoneOffsetMinutesAt(utcMs: number, timeZone: string): number {
  const wholeSecondUtcMs = Math.floor(utcMs / 1000) * 1000;
  const zoned = getZonedWallClock(wholeSecondUtcMs, timeZone);
  const zonedAsUtcMs = Date.UTC(
    zoned.year,
    zoned.month - 1,
    zoned.day,
    zoned.hour,
    zoned.minute,
    zoned.second,
    0,
  );
  return Math.round((zonedAsUtcMs - wholeSecondUtcMs) / 60_000);
}

function resolveWallClockInIanaZone(
  wall: WallClockComponents,
  timeZone: string,
): Array<{ utcMs: number; offsetMinutes: number }> {
  const wallAsUtcMs = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
    wall.millisecond,
  );

  const candidateOffsets = new Set<number>();
  const probeHours = [-14, -10, -6, -3, -2, -1, 0, 1, 2, 3, 6, 10, 14];
  for (const h of probeHours) {
    const offset = getZoneOffsetMinutesAt(wallAsUtcMs + h * 3_600_000, timeZone);
    candidateOffsets.add(offset);
  }
  const initialOffsets = Array.from(candidateOffsets);
  for (const offset of initialOffsets) {
    const refinedCenter = wallAsUtcMs - offset * 60_000;
    candidateOffsets.add(getZoneOffsetMinutesAt(refinedCenter - 3_600_000, timeZone));
    candidateOffsets.add(getZoneOffsetMinutesAt(refinedCenter, timeZone));
    candidateOffsets.add(getZoneOffsetMinutesAt(refinedCenter + 3_600_000, timeZone));
  }

  const matches: Array<{ utcMs: number; offsetMinutes: number }> = [];
  const seenUtcMs = new Set<number>();

  const allOffsets = Array.from(candidateOffsets);
  for (const offsetMinutes of allOffsets) {
    const candidateUtcMs = wallAsUtcMs - offsetMinutes * 60_000;
    if (seenUtcMs.has(candidateUtcMs)) continue;
    const zoned = getZonedWallClock(candidateUtcMs, timeZone);
    const actualOffset = getZoneOffsetMinutesAt(candidateUtcMs, timeZone);
    if (
      actualOffset === offsetMinutes &&
      zoned.year === wall.year &&
      zoned.month === wall.month &&
      zoned.day === wall.day &&
      zoned.hour === wall.hour &&
      zoned.minute === wall.minute &&
      zoned.second === wall.second
    ) {
      seenUtcMs.add(candidateUtcMs);
      matches.push({ utcMs: candidateUtcMs, offsetMinutes });
    }
  }

  return matches.sort((a, b) => a.utcMs - b.utcMs);
}

type VerifyZoneResult =
  | { ok: true; sourceZone: string }
  | { ok: false; reason: DeadlineRejectionReason; error: string };

function verifyZoneAlignment(
  utcMs: number,
  inlineOffsetMinutes: number,
  inlineSourceZone: string,
  metadataZone: ValidClassifiedZone | undefined,
): VerifyZoneResult {
  if (!metadataZone) {
    return { ok: true, sourceZone: inlineSourceZone };
  }
  if (metadataZone.kind === "utc") {
    if (inlineOffsetMinutes !== 0) {
      return {
        ok: false,
        reason: "timezone_offset_mismatch",
        error: `Inline offset ${formatUtcOffset(inlineOffsetMinutes)} conflicts with explicit zone "${metadataZone.sourceZone}".`,
      };
    }
    return { ok: true, sourceZone: metadataZone.sourceZone };
  }
  if (metadataZone.kind === "offset") {
    if (metadataZone.offsetMinutes !== inlineOffsetMinutes) {
      return {
        ok: false,
        reason: "timezone_offset_mismatch",
        error: `Inline offset ${formatUtcOffset(inlineOffsetMinutes)} conflicts with explicit offset "${metadataZone.sourceZone}".`,
      };
    }
    return { ok: true, sourceZone: metadataZone.sourceZone };
  }
  // metadataZone.kind === "iana"
  const expectedOffset = getZoneOffsetMinutesAt(utcMs, metadataZone.sourceZone);
  if (expectedOffset !== inlineOffsetMinutes) {
    return {
      ok: false,
      reason: "timezone_offset_mismatch",
      error: `Inline offset ${formatUtcOffset(inlineOffsetMinutes)} does not match "${metadataZone.sourceZone}" (${formatUtcOffset(expectedOffset)}) at ${new Date(utcMs).toISOString()}.`,
    };
  }
  return { ok: true, sourceZone: metadataZone.sourceZone };
}

/**
 * Parse and validate a deadline string with explicit time-zone interpretation.
 *
 * Normalizes valid deadlines to a canonical UTC ISO-8601 timestamp (`YYYY-MM-DDTHH:mm:ss.sssZ`)
 * while retaining the source time zone (`"UTC"`, normalized `±HH:MM` offset, or IANA zone name)
 * as metadata. Rejects date-only inputs, local-only timestamps without a zone designator,
 * ambiguous time-zone abbreviations, invalid calendar dates, conflicting offsets, and
 * nonexistent or ambiguous DST transition wall-clock times.
 */
export function parseExplicitDeadline(
  rawDeadline: string,
  explicitZone?: string,
): DeadlineParseResult {
  if (typeof rawDeadline !== "string") {
    return {
      ok: false,
      reason: "empty_deadline",
      error: "Deadline must be a string.",
      rawDeadline: "",
    };
  }

  const trimmed = rawDeadline.trim();
  if (!trimmed) {
    return {
      ok: false,
      reason: "empty_deadline",
      error: "Deadline must not be empty.",
      rawDeadline: "",
    };
  }

  // Extract optional RFC 9557 bracketed zone suffix, e.g. "2026-05-01T14:00:00-04:00[America/New_York]".
  let datetimePart = trimmed;
  let bracketZoneRaw: string | undefined;
  if (trimmed.endsWith("]")) {
    const openIdx = trimmed.lastIndexOf("[");
    if (openIdx <= 0) {
      return {
        ok: false,
        reason: "invalid_datetime",
        error: `Malformed bracketed time-zone annotation in "${trimmed}".`,
        rawDeadline: trimmed,
      };
    }
    bracketZoneRaw = trimmed.slice(openIdx + 1, -1).trim();
    datetimePart = trimmed.slice(0, openIdx).trim();
    if (!bracketZoneRaw) {
      return {
        ok: false,
        reason: "invalid_timezone",
        error: `Empty bracketed time-zone annotation in "${trimmed}".`,
        rawDeadline: trimmed,
      };
    }
  }

  // Detect date-only strings explicitly so they report as ambiguous local deadlines.
  if (/^\d{4}-\d{2}-\d{2}$/.test(datetimePart)) {
    return {
      ok: false,
      reason: "ambiguous_local_deadline",
      error: `Date-only deadline "${trimmed}" lacks a time-of-day and explicit time zone.`,
      rawDeadline: trimmed,
    };
  }

  const dtMatch = datetimePart.match(
    /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(.*)$/,
  );
  if (!dtMatch) {
    return {
      ok: false,
      reason: "invalid_datetime",
      error: `Deadline "${trimmed}" is not a valid ISO-8601 date-time.`,
      rawDeadline: trimmed,
    };
  }

  const year = Number.parseInt(dtMatch[1], 10);
  const month = Number.parseInt(dtMatch[2], 10);
  const day = Number.parseInt(dtMatch[3], 10);
  const hour = Number.parseInt(dtMatch[4], 10);
  const minute = Number.parseInt(dtMatch[5], 10);
  const second = dtMatch[6] !== undefined ? Number.parseInt(dtMatch[6], 10) : 0;
  const fracRaw = dtMatch[7] ?? "";
  const millisecond = fracRaw ? Number.parseInt(fracRaw.slice(0, 3).padEnd(3, "0"), 10) : 0;
  const inlineTail = (dtMatch[8] ?? "").trim();

  const maxDay = daysInMonth(year, month);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > maxDay ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return {
      ok: false,
      reason: "invalid_datetime",
      error: `Deadline "${trimmed}" contains out-of-range calendar or clock components.`,
      rawDeadline: trimmed,
    };
  }

  const wall: WallClockComponents = {
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond,
  };

  const inlineZoneSpec = inlineTail ? classifyExplicitZone(inlineTail) : undefined;
  if (inlineZoneSpec && inlineZoneSpec.kind === "invalid") {
    return {
      ok: false,
      reason: inlineZoneSpec.reason,
      error: inlineZoneSpec.error,
      rawDeadline: trimmed,
    };
  }

  const bracketZoneSpec = bracketZoneRaw !== undefined ? classifyExplicitZone(bracketZoneRaw) : undefined;
  if (bracketZoneSpec && bracketZoneSpec.kind === "invalid") {
    return {
      ok: false,
      reason: bracketZoneSpec.reason,
      error: bracketZoneSpec.error,
      rawDeadline: trimmed,
    };
  }

  const externalZoneTrimmed = explicitZone !== undefined ? explicitZone.trim() : undefined;
  const externalZoneSpec =
    externalZoneTrimmed !== undefined ? classifyExplicitZone(externalZoneTrimmed) : undefined;
  if (externalZoneSpec && externalZoneSpec.kind === "invalid") {
    return {
      ok: false,
      reason: externalZoneSpec.reason,
      error: externalZoneSpec.error,
      rawDeadline: trimmed,
    };
  }

  const validInlineZone: ValidClassifiedZone | undefined =
    inlineZoneSpec && inlineZoneSpec.kind !== "invalid" ? inlineZoneSpec : undefined;
  const validBracketZone: ValidClassifiedZone | undefined =
    bracketZoneSpec && bracketZoneSpec.kind !== "invalid" ? bracketZoneSpec : undefined;
  const validExternalZone: ValidClassifiedZone | undefined =
    externalZoneSpec && externalZoneSpec.kind !== "invalid" ? externalZoneSpec : undefined;

  // If both a bracketed zone and an external explicitZone parameter are present, they must agree.
  if (validBracketZone && validExternalZone) {
    if (validBracketZone.sourceZone.toLowerCase() !== validExternalZone.sourceZone.toLowerCase()) {
      const bothUtc = validBracketZone.kind === "utc" && validExternalZone.kind === "utc";
      const bothSameOffset =
        validBracketZone.kind === "offset" &&
        validExternalZone.kind === "offset" &&
        validBracketZone.offsetMinutes === validExternalZone.offsetMinutes;
      if (!bothUtc && !bothSameOffset) {
        return {
          ok: false,
          reason: "timezone_offset_mismatch",
          error: `Bracketed zone "${validBracketZone.sourceZone}" conflicts with explicit zone "${validExternalZone.sourceZone}".`,
          rawDeadline: trimmed,
        };
      }
    }
  }

  const metadataZoneSpec: ValidClassifiedZone | undefined = validExternalZone ?? validBracketZone;

  // Reject local-only deadlines that have neither an inline designator nor an explicit zone.
  if (!validInlineZone && !metadataZoneSpec) {
    return {
      ok: false,
      reason: "ambiguous_local_deadline",
      error: `Local-only deadline "${trimmed}" lacks an explicit time-zone offset or zone identifier.`,
      rawDeadline: trimmed,
    };
  }

  if (validInlineZone) {
    if (validInlineZone.kind === "utc") {
      const utcMs = Date.UTC(
        wall.year,
        wall.month - 1,
        wall.day,
        wall.hour,
        wall.minute,
        wall.second,
        wall.millisecond,
      );
      const check = verifyZoneAlignment(utcMs, 0, validInlineZone.sourceZone, metadataZoneSpec);
      if (check.ok === false) {
        return {
          ok: false,
          reason: check.reason,
          error: check.error,
          rawDeadline: trimmed,
        };
      }
      return {
        ok: true,
        canonicalUtc: new Date(utcMs).toISOString(),
        sourceZone: check.sourceZone,
        offsetMinutes: 0,
        utcOffset: "+00:00",
        rawDeadline: trimmed,
      };
    }

    if (validInlineZone.kind === "offset") {
      const wallAsUtcMs = Date.UTC(
        wall.year,
        wall.month - 1,
        wall.day,
        wall.hour,
        wall.minute,
        wall.second,
        wall.millisecond,
      );
      const utcMs = wallAsUtcMs - validInlineZone.offsetMinutes * 60_000;
      const check = verifyZoneAlignment(
        utcMs,
        validInlineZone.offsetMinutes,
        validInlineZone.sourceZone,
        metadataZoneSpec,
      );
      if (check.ok === false) {
        return {
          ok: false,
          reason: check.reason,
          error: check.error,
          rawDeadline: trimmed,
        };
      }
      return {
        ok: true,
        canonicalUtc: new Date(utcMs).toISOString(),
        sourceZone: check.sourceZone,
        offsetMinutes: validInlineZone.offsetMinutes,
        utcOffset: validInlineZone.utcOffset,
        rawDeadline: trimmed,
      };
    }

    // validInlineZone.kind === "iana"
    const matches = resolveWallClockInIanaZone(wall, validInlineZone.sourceZone);
    if (matches.length !== 1) {
      return {
        ok: false,
        reason: "ambiguous_local_deadline",
        error:
          matches.length === 0
            ? `Wall-clock deadline "${trimmed}" falls in a nonexistent DST gap for "${validInlineZone.sourceZone}".`
            : `Wall-clock deadline "${trimmed}" is ambiguous across a DST fall-back transition in "${validInlineZone.sourceZone}".`,
        rawDeadline: trimmed,
      };
    }
    const { utcMs, offsetMinutes } = matches[0];
    const check = verifyZoneAlignment(utcMs, offsetMinutes, validInlineZone.sourceZone, metadataZoneSpec);
    if (check.ok === false) {
      return {
        ok: false,
        reason: check.reason,
        error: check.error,
        rawDeadline: trimmed,
      };
    }
    return {
      ok: true,
      canonicalUtc: new Date(utcMs).toISOString(),
      sourceZone: check.sourceZone,
      offsetMinutes,
      utcOffset: formatUtcOffset(offsetMinutes),
      rawDeadline: trimmed,
    };
  }

  // No inline zone in datetimePart; interpret using metadataZoneSpec.
  const resolvedMetaZone = metadataZoneSpec!;
  if (resolvedMetaZone.kind === "utc") {
    const utcMs = Date.UTC(
      wall.year,
      wall.month - 1,
      wall.day,
      wall.hour,
      wall.minute,
      wall.second,
      wall.millisecond,
    );
    return {
      ok: true,
      canonicalUtc: new Date(utcMs).toISOString(),
      sourceZone: resolvedMetaZone.sourceZone,
      offsetMinutes: 0,
      utcOffset: "+00:00",
      rawDeadline: trimmed,
    };
  }

  if (resolvedMetaZone.kind === "offset") {
    const wallAsUtcMs = Date.UTC(
      wall.year,
      wall.month - 1,
      wall.day,
      wall.hour,
      wall.minute,
      wall.second,
      wall.millisecond,
    );
    const utcMs = wallAsUtcMs - resolvedMetaZone.offsetMinutes * 60_000;
    return {
      ok: true,
      canonicalUtc: new Date(utcMs).toISOString(),
      sourceZone: resolvedMetaZone.sourceZone,
      offsetMinutes: resolvedMetaZone.offsetMinutes,
      utcOffset: resolvedMetaZone.utcOffset,
      rawDeadline: trimmed,
    };
  }

  // resolvedMetaZone.kind === "iana"
  const matches = resolveWallClockInIanaZone(wall, resolvedMetaZone.sourceZone);
  if (matches.length !== 1) {
    return {
      ok: false,
      reason: "ambiguous_local_deadline",
      error:
        matches.length === 0
          ? `Wall-clock deadline "${trimmed}" falls in a nonexistent DST gap for "${resolvedMetaZone.sourceZone}".`
          : `Wall-clock deadline "${trimmed}" is ambiguous across a DST fall-back transition in "${resolvedMetaZone.sourceZone}".`,
      rawDeadline: trimmed,
    };
  }
  const { utcMs, offsetMinutes } = matches[0];
  return {
    ok: true,
    canonicalUtc: new Date(utcMs).toISOString(),
    sourceZone: resolvedMetaZone.sourceZone,
    offsetMinutes,
    utcOffset: formatUtcOffset(offsetMinutes),
    rawDeadline: trimmed,
  };
}

/**
 * Convenience wrapper around `parseExplicitDeadline` returning `DeadlineInterpretation`
 * on success or `null` when the deadline is missing, malformed, or ambiguous.
 */
export function interpretDeadline(
  rawDeadline: string,
  explicitZone?: string,
): DeadlineInterpretation | null {
  const parsed = parseExplicitDeadline(rawDeadline, explicitZone);
  if (parsed.ok === false) return null;
  return {
    canonicalUtc: parsed.canonicalUtc,
    sourceZone: parsed.sourceZone,
    offsetMinutes: parsed.offsetMinutes,
    utcOffset: parsed.utcOffset,
    rawDeadline: parsed.rawDeadline,
  };
}

function extractCandidateZoneField(
  rec: Record<string, unknown>,
): { ok: true; zone?: string } | { ok: false } {
  const keys = ["sourceZone", "timeZone", "timezone", "deadlineTimeZone", "deadlineTimezone"] as const;
  let selected: string | undefined;

  for (const key of keys) {
    const val = rec[key];
    if (val === undefined || val === null) continue;
    if (typeof val !== "string") return { ok: false };
    const trimmed = val.trim();
    if (!trimmed) return { ok: false };
    if (selected !== undefined && selected.toLowerCase() !== trimmed.toLowerCase()) {
      return { ok: false };
    }
    selected = trimmed;
  }

  return { ok: true, zone: selected };
}

/**
 * Build a deterministic deduplication key for a drafted candidate. The key
 * includes the normalization policy version so that a policy change produces
 * a distinct identity, and cached decisions under the old version are not
 * reused.
 */
export function buildDedupeKey(
  candidate: Pick<ClaimCandidate, "question" | "resolutionUrl" | "deadline">,
  normalizationPolicyVersion: string = "unversioned",
): string {
  const normalizedQuestion = candidate.question.trim().toLowerCase().replace(/\s+/g, " ");
  return [
    `policy=${normalizationPolicyVersion}`,
    `q=${normalizedQuestion}`,
    `url=${candidate.resolutionUrl.trim()}`,
    `deadline=${candidate.deadline.trim()}`,
  ].join("|");
}

export function buildDraftingPrompt(context: DraftingContext): string {
  const max = context.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const categoryLine = context.category ? `Category: ${context.category}\n` : "";
  const timeZoneLine = context.timeZone ? `Time zone: ${context.timeZone}\n` : "";
  const existingLine = context.existingQuestions?.length
    ? `Existing questions (do not duplicate):\n${context.existingQuestions.map((q) => `- ${q}`).join("\n")}\n`
    : "";

  return [
    "You are drafting prediction market candidates.",
    "Each candidate must be settleable by fetching ONE resolutionUrl and reading a number or a date out of it.",
    categoryLine,
    timeZoneLine,
    existingLine,
    `Return at most ${max} candidates as a JSON array of objects with fields: question, resolutionUrl, deadline (ISO 8601), category, threshold (optional, USD). Every deadline must include an explicit time zone ('Z', numeric UTC offset like '+02:00', or an explicit timeZone field); ambiguous local-only deadlines are rejected.`,
    "Source material:",
    context.sourceText,
  ].filter(Boolean).join("\n\n");
}

/**
 * Parse the LLM response into candidates. Tolerates code fences and
 * surrounding prose. Normalizes each candidate's deadline to a canonical
 * UTC timestamp with `sourceZone` and `deadlineInterpretation` retained as
 * metadata, and drops candidates with ambiguous local-only or invalid deadlines.
 * Returns [] on any parsing failure - the caller treats that as "no candidates this run".
 */
export function parseDraftedCandidates(raw: string): ClaimCandidate[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*)```/i);
  const jsonText = fenceMatch ? fenceMatch[1] : trimmed;

  const start = jsonText.indexOf("[");
  const end = jsonText.lastIndexOf("]");
  if (start < 0 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: ClaimCandidate[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const question = typeof rec.question === "string" ? rec.question.trim() : "";
    const resolutionUrl = typeof rec.resolutionUrl === "string" ? rec.resolutionUrl.trim() : "";
    const deadline = typeof rec.deadline === "string" ? rec.deadline.trim() : "";
    if (!question || !resolutionUrl || !deadline) continue;
    const candidate: ClaimCandidate = {
      question,
      resolutionUrl,
      deadline: interpreted.canonicalUtc,
      sourceZone: interpreted.sourceZone,
      deadlineInterpretation: interpreted,
      category: typeof rec.category === "string" ? rec.category : undefined,
      threshold: typeof rec.threshold === "number" ? rec.threshold : undefined,
      creatorPosition: typeof rec.creatorPosition === "string" ? rec.creatorPosition : undefined,
      counterPosition: typeof rec.counterPosition === "string" ? rec.counterPosition : undefined,
      settlementRule: typeof rec.settlementRule === "string" ? rec.settlementRule : undefined,
      qualityScore: typeof rec.qualityScore === "number" ? rec.qualityScore : undefined,
    };
    candidate.statementDigest = computeStatementDigest(candidate);
    candidate.deduplicationId = buildDeduplicationIdentity(candidate);
    out.push(candidate);
  }
  return out;
}

/**
 * Drop candidates whose crypto threshold fails the sanity check.
 * Candidates without a threshold are kept unchanged.
 */
export function filterUnsafeCryptoThresholds(
  candidates: readonly ClaimCandidate[],
): ClaimCandidate[] {
  return candidates.filter((candidate) => {
    if (candidate.threshold === undefined) return true;
    return cryptoThresholdReason(candidate.threshold) === null;
  });
}

/**
 * Create a durable market creation intent from a drafted candidate.
 */
export function createMarketCreationIntent(
  candidate: ClaimCandidate,
  options?: { qualityScore?: number; status?: MarketCreationIntent["status"] },
): MarketCreationIntent {
  const statementDigest = computeStatementDigest(candidate);
  const id = buildDeduplicationIdentity(candidate);
  const now = Date.now();
  return {
    id,
    statementDigest,
    question: candidate.question,
    resolutionUrl: candidate.resolutionUrl,
    deadline: candidate.deadline,
    category: candidate.category,
    creatorPosition: candidate.creatorPosition,
    counterPosition: candidate.counterPosition,
    settlementRule: candidate.settlementRule,
    qualityScore: options?.qualityScore ?? candidate.qualityScore,
    status: options?.status ?? "draft",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Draft candidates by calling the provided completer with the drafting
 * prompt, then parsing and sanitising the response.
 */
export async function draftClaimCandidates(
  completer: LlmCompleter,
  context: DraftingContext,
): Promise<ClaimCandidate[]> {
  const prompt = buildDraftingPrompt(context);
  const raw = await completer(prompt);
  const parsed = parseDraftedCandidates(raw).map((candidate) => ({
    ...candidate,
    sourceId: context.sourceId,
    captureVersion: context.captureVersion,
  }));
  return filterUnsafeCryptoThresholds(parsed);
}

/**
 * Drafting variant that also consults a retry queue: candidates whose source
 * is backed off are excluded so low-quality drafts never reach transaction attempts.
 */
export async function draftClaimCandidatesWithRetry(
  completer: LlmCompleter,
  context: DraftingContext,
  queue: SourceRetryQueue,
): Promise<ClaimCandidate[]> {
  const drafted = await draftClaimCandidates(completer, context);
  return filterByRetryEligibility(drafted, queue);
}

/**
 * Exported for tests and for callers that want to inspect threshold
 * mentions in a drafted question without running the full filter.
 */
export {
  extractUsdThresholds,
  cryptoThresholdReason,
  computeStatementDigest,
  buildDeduplicationIdentity,
  reconcileSubmission,
  type MarketCreationIntent,
  type ReconciliationResult,
};
