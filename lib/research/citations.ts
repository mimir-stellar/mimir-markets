/**
 * Research-source citations for evidence cards and research views.
 *
 * Chain / context-pack sources stay authoritative. This module only shapes them
 * for UI: normalize URLs, drop unsafe schemes, dedupe, flag stale / cancelled /
 * invalid / dependency-failure rows, and strip anything that looks like a wallet
 * address or prompt dump from excerpts.
 *
 * Pure — safe for node tests and SSR.
 */

import { normalizeResolutionSource } from "@/lib/constants";
import { isHash32Hex } from "@/lib/content-hash";
import type { ContextSource, MarketContextPack } from "@/lib/research/context-pack";
import { shortHash } from "@/lib/reasoning/feed-view";

export type CitationTrustTier = "primary" | "corroborating" | "unverified" | "unknown";

export type CitationRowStatus =
  | "ready"
  | "invalid"
  | "stale"
  | "duplicated"
  | "cancelled"
  | "dependency_failure";

export type CitationDigestStatus = "verified" | "malformed" | "missing";

export type CitationSourceAvailability = "available" | "stale" | "unavailable" | "unverified";

export type ResearchCitationsStatus =
  | "ready"
  | "empty"
  | "invalid"
  | "stale"
  | "cancelled"
  | "dependency_failure";

export interface ResearchCitationInput {
  url?: string | null;
  domain?: string | null;
  trustTier?: string | null;
  contentHash?: string | null;
  excerpt?: string | null;
  capturedAt?: number | null;
  publishedAt?: number | null;
  freshnessSeconds?: number | null;
  /** Explicitly withdrawn / cancelled by the producer. */
  cancelled?: boolean;
}

export interface ResearchCitationView {
  id: string;
  status: CitationRowStatus;
  url: string;
  domain: string;
  trustTier: CitationTrustTier;
  contentHash: string;
  shortHash: string;
  excerpt: string;
  /** Age in seconds when known; null when unknown (never invent zero). */
  ageSeconds: number | null;
  /** True when the link is https and safe to open in a new tab. */
  externalSafe: boolean;
  /** Set when this row was collapsed as a duplicate of an earlier citation. */
  duplicatedOf?: string;
  /** Epoch milliseconds when captured, or null if unknown / not recorded. */
  capturedAt: number | null;
  /** ISO 8601 string when captured, or null if unknown / not recorded. */
  capturedAtIso: string | null;
  /** Cryptographic integrity status of the content digest. */
  digestStatus: CitationDigestStatus;
  /** Snapshot availability, explicitly decoupled from claim truth value. */
  sourceAvailability: CitationSourceAvailability;
}

export interface ResearchCitationsView {
  status: ResearchCitationsStatus;
  /** i18n key under `researchCitations.status.*` */
  statusMessageKey: ResearchCitationsStatus;
  citations: ResearchCitationView[];
  /** Citations that can be shown as actionable source links. */
  displayable: ResearchCitationView[];
  primaryCount: number;
  duplicatedDropped: number;
  withoutHash: number;
}

export interface BuildResearchCitationsOptions {
  sources: ResearchCitationInput[];
  /** Claim deadline (unix seconds). Captures after this are treated as stale. */
  deadlineUnix?: number | null;
  /** Max allowed age in seconds before a source is stale. */
  maxAgeSeconds?: number | null;
  /** Wall clock for freshness; defaults to Date.now(). */
  nowMs?: number;
  /** When true, treat the whole list as cancelled (e.g. cancelled market). */
  cancelled?: boolean;
}

const WALLET_LIKE =
  /\b(?:G[A-Z0-9]{55}|0x[a-fA-F0-9]{40}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})\b/g;
const PROMPT_MARKERS = /\b(?:system prompt|developer message|api[_ ]?key|secret)\b/gi;
const MAX_EXCERPT = 280;

function normalizeTrust(raw: string | null | undefined): CitationTrustTier {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "primary") return "primary";
  if (value === "corroborating" || value === "trusted") return "corroborating";
  if (value === "unverified" || value === "discovered") return "unverified";
  return "unknown";
}

function hostFromUrl(url: string, fallback = ""): string {
  if (!url) return fallback;
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return fallback || url;
  }
}

function sanitizeExcerpt(raw: string | null | undefined): string {
  if (!raw) return "";
  let text = raw.replace(/\s+/g, " ").trim();
  text = text.replace(WALLET_LIKE, "[redacted]");
  text = text.replace(PROMPT_MARKERS, "[redacted]");
  if (text.length > MAX_EXCERPT) {
    text = `${text.slice(0, MAX_EXCERPT - 1)}…`;
  }
  return text;
}

function normalizeHash(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const bare = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  return bare.toLowerCase();
}

function isExternalSafe(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function trustRank(tier: CitationTrustTier): number {
  switch (tier) {
    case "primary":
      return 0;
    case "corroborating":
      return 1;
    case "unverified":
      return 2;
    default:
      return 3;
  }
}

/**
 * Evaluates the cryptographic digest status of a hash string.
 * - "verified" if the hash is a valid 32-byte (64 character) hex digest.
 * - "malformed" if non-empty string is provided but is not a valid 32-byte hex hash.
 * - "missing" if null, undefined, or empty/whitespace.
 */
export function getCitationDigestStatus(
  rawHash: string | null | undefined,
): CitationDigestStatus {
  if (!rawHash) return "missing";
  const trimmed = rawHash.trim();
  if (!trimmed) return "missing";
  const bare = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!bare) return "missing";
  return isHash32Hex(bare) ? "verified" : "malformed";
}

/**
 * Derives source availability status decoupled from the claim's truth value.
 * - "unavailable" if row status is cancelled, invalid, or dependency_failure.
 * - "stale" if row status is stale (captured after deadline or exceeds max age).
 * - "unverified" if cryptographic digest is missing.
 * - "available" if snapshot is ready with verified cryptographic digest.
 */
export function getCitationSourceAvailability(
  status: CitationRowStatus,
  digestStatus: CitationDigestStatus,
): CitationSourceAvailability {
  if (status === "cancelled" || status === "invalid" || status === "dependency_failure") {
    return "unavailable";
  }
  if (status === "stale") {
    return "stale";
  }
  if (digestStatus === "missing") {
    return "unverified";
  }
  return "available";
}

function toValidIso(capturedAt: number | null | undefined): string | null {
  if (capturedAt == null || !Number.isFinite(capturedAt) || capturedAt <= 0) {
    return null;
  }
  try {
    const d = new Date(capturedAt);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

/**
 * Format citation capture time to ISO + relative freshness (e.g. "2026-11-13T03:55:00.000Z (2m ago)").
 * Returns empty string if capturedAt is null, non-finite, or <= 0.
 */
export function formatCitationCaptureTime(
  capturedAt: number | null | undefined,
  nowMs: number = Date.now(),
): string {
  if (capturedAt == null || !Number.isFinite(capturedAt) || capturedAt <= 0) {
    return "";
  }
  try {
    const date = new Date(capturedAt);
    if (isNaN(date.getTime())) return "";
    const iso = date.toISOString();
    const diffMs = nowMs - capturedAt;
    if (diffMs < 0) {
      return `${iso} (just now)`;
    }
    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return `${iso} (${seconds}s ago)`;
    if (seconds < 3_600) return `${iso} (${Math.floor(seconds / 60)}m ago)`;
    if (seconds < 86_400) return `${iso} (${Math.floor(seconds / 3_600)}h ago)`;
    return `${iso} (${Math.floor(seconds / 86_400)}d ago)`;
  } catch {
    return "";
  }
}

/**
 * Build a citation list from raw research / evidence sources.
 * Dedupes by content hash (preferred) then by normalized URL.
 */
export function buildResearchCitations(
  options: BuildResearchCitationsOptions,
): ResearchCitationsView {
  const {
    sources,
    deadlineUnix = null,
    maxAgeSeconds = null,
    nowMs = Date.now(),
    cancelled = false,
  } = options;

  if (cancelled) {
    return {
      status: "cancelled",
      statusMessageKey: "cancelled",
      citations: [],
      displayable: [],
      primaryCount: 0,
      duplicatedDropped: 0,
      withoutHash: 0,
    };
  }

  if (!Array.isArray(sources) || sources.length === 0) {
    return {
      status: "empty",
      statusMessageKey: "empty",
      citations: [],
      displayable: [],
      primaryCount: 0,
      duplicatedDropped: 0,
      withoutHash: 0,
    };
  }

  const prepared: ResearchCitationView[] = [];
  let dependencyFailure = false;

  for (let index = 0; index < sources.length; index++) {
    const source = sources[index] ?? {};
    if (source.cancelled) {
      prepared.push({
        id: `cancelled-${index}`,
        status: "cancelled",
        url: "",
        domain: "",
        trustTier: normalizeTrust(source.trustTier),
        contentHash: "",
        shortHash: "",
        excerpt: "",
        ageSeconds: null,
        externalSafe: false,
        capturedAt: null,
        capturedAtIso: null,
        digestStatus: "missing",
        sourceAvailability: "unavailable",
      });
      continue;
    }

    const rawCapturedAt =
      typeof source.capturedAt === "number" &&
      Number.isFinite(source.capturedAt) &&
      source.capturedAt > 0
        ? source.capturedAt
        : null;
    const capturedAtIso = toValidIso(rawCapturedAt);
    const digestStatus = getCitationDigestStatus(source.contentHash);

    const normalizedUrl = normalizeResolutionSource(String(source.url ?? ""));
    const trustTier = normalizeTrust(source.trustTier);
    const contentHash = normalizeHash(source.contentHash);
    const domain =
      (source.domain ?? "").trim().replace(/^www\./i, "") ||
      hostFromUrl(normalizedUrl);

    if (!normalizedUrl || !isExternalSafe(normalizedUrl)) {
      prepared.push({
        id: `invalid-${index}`,
        status: "invalid",
        url: "",
        domain,
        trustTier,
        contentHash,
        shortHash: contentHash ? shortHash(contentHash) : "",
        excerpt: sanitizeExcerpt(source.excerpt),
        ageSeconds: null,
        externalSafe: false,
        capturedAt: rawCapturedAt,
        capturedAtIso,
        digestStatus,
        sourceAvailability: "unavailable",
      });
      continue;
    }

    if (contentHash && !isHash32Hex(contentHash)) {
      dependencyFailure = true;
      prepared.push({
        id: `dep-${index}`,
        status: "dependency_failure",
        url: normalizedUrl,
        domain,
        trustTier,
        contentHash,
        shortHash: shortHash(contentHash),
        excerpt: sanitizeExcerpt(source.excerpt),
        ageSeconds: null,
        externalSafe: true,
        capturedAt: rawCapturedAt,
        capturedAtIso,
        digestStatus: "malformed",
        sourceAvailability: "unavailable",
      });
      continue;
    }

    let ageSeconds: number | null = null;
    if (
      typeof source.freshnessSeconds === "number" &&
      Number.isFinite(source.freshnessSeconds)
    ) {
      ageSeconds = Math.max(0, Math.floor(source.freshnessSeconds));
    } else if (rawCapturedAt != null) {
      ageSeconds = Math.max(0, Math.floor((nowMs - rawCapturedAt) / 1000));
    }

    let status: CitationRowStatus = "ready";
    if (
      deadlineUnix != null &&
      Number.isFinite(deadlineUnix) &&
      rawCapturedAt != null &&
      rawCapturedAt > deadlineUnix * 1000
    ) {
      status = "stale";
    } else if (
      maxAgeSeconds != null &&
      Number.isFinite(maxAgeSeconds) &&
      ageSeconds != null &&
      ageSeconds > maxAgeSeconds
    ) {
      status = "stale";
    }

    const sourceAvailability = getCitationSourceAvailability(status, digestStatus);

    prepared.push({
      id: `${trustTier}:${contentHash || normalizedUrl}:${index}`,
      status,
      url: normalizedUrl,
      domain,
      trustTier,
      contentHash,
      shortHash: contentHash ? shortHash(contentHash) : "",
      excerpt: sanitizeExcerpt(source.excerpt),
      ageSeconds,
      externalSafe: true,
      capturedAt: rawCapturedAt,
      capturedAtIso,
      digestStatus,
      sourceAvailability,
    });
  }

  // Prefer primary / earlier rows when collapsing duplicates.
  const ranked = [...prepared].sort((a, b) => {
    const trust = trustRank(a.trustTier) - trustRank(b.trustTier);
    if (trust !== 0) return trust;
    return a.id.localeCompare(b.id);
  });

  const seenHash = new Map<string, string>();
  const seenUrl = new Map<string, string>();
  let duplicatedDropped = 0;
  const citations: ResearchCitationView[] = [];

  for (const row of ranked) {
    if (row.status === "invalid" || row.status === "cancelled") {
      citations.push(row);
      continue;
    }

    const hashKey = row.contentHash;
    const urlKey = row.url.toLowerCase();

    if (hashKey && seenHash.has(hashKey)) {
      duplicatedDropped += 1;
      citations.push({
        ...row,
        status: "duplicated",
        duplicatedOf: seenHash.get(hashKey),
      });
      continue;
    }
    if (!hashKey && urlKey && seenUrl.has(urlKey)) {
      duplicatedDropped += 1;
      citations.push({
        ...row,
        status: "duplicated",
        duplicatedOf: seenUrl.get(urlKey),
      });
      continue;
    }

    if (hashKey) seenHash.set(hashKey, row.id);
    if (urlKey) seenUrl.set(urlKey, row.id);
    citations.push(row);
  }

  // Restore input-ish order for display: primary first already from sort, then
  // keep stable by original index embedded in id suffix.
  citations.sort((a, b) => {
    const trust = trustRank(a.trustTier) - trustRank(b.trustTier);
    if (trust !== 0) return trust;
    const ai = Number(a.id.split(":").pop());
    const bi = Number(b.id.split(":").pop());
    if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return ai - bi;
    return a.id.localeCompare(b.id);
  });

  const displayable = citations.filter(
    (row) =>
      row.externalSafe &&
      (row.status === "ready" || row.status === "stale" || row.status === "dependency_failure"),
  );
  const primaryCount = displayable.filter((row) => row.trustTier === "primary").length;
  const withoutHash = displayable.filter((row) => !row.contentHash).length;

  let status: ResearchCitationsStatus = "ready";
  if (displayable.length === 0) {
    status = dependencyFailure ? "dependency_failure" : "invalid";
  } else if (displayable.every((row) => row.status === "stale")) {
    status = "stale";
  } else if (dependencyFailure && displayable.every((row) => row.status === "dependency_failure")) {
    status = "dependency_failure";
  }

  return {
    status,
    statusMessageKey: status,
    citations,
    displayable,
    primaryCount,
    duplicatedDropped,
    withoutHash,
  };
}

/** Map a context-pack source into a citation input. */
export function citationInputFromContextSource(
  source: ContextSource,
): ResearchCitationInput {
  return {
    url: source.url,
    domain: source.domain,
    trustTier: source.trustTier,
    contentHash: source.contentHash,
    excerpt: source.excerpt,
    capturedAt: source.capturedAt,
    publishedAt: source.publishedAt,
  };
}

/** Citations from a full market context pack (primary + corroborating). */
export function citationsFromContextPack(
  pack: MarketContextPack,
  options: Omit<BuildResearchCitationsOptions, "sources"> = {},
): ResearchCitationsView {
  const sources: ResearchCitationInput[] = [
    citationInputFromContextSource(pack.primarySource),
    ...pack.corroboratingSources.map(citationInputFromContextSource),
  ];
  return buildResearchCitations({
    ...options,
    sources,
    deadlineUnix: options.deadlineUnix ?? pack.deadline,
  });
}

/**
 * Citations from a settled claim's locked resolution URL + optional evidence hash.
 * Used by evidence cards when the full context pack is not on the page.
 */
export function citationsFromResolutionSource(args: {
  resolutionUrl?: string | null;
  evidenceHash?: string | null;
  excerpt?: string | null;
  cancelled?: boolean;
  deadlineUnix?: number | null;
  capturedAt?: number | null;
}): ResearchCitationsView {
  return buildResearchCitations({
    sources: [
      {
        url: args.resolutionUrl,
        trustTier: "primary",
        contentHash: args.evidenceHash,
        excerpt: args.excerpt,
        capturedAt: args.capturedAt,
      },
    ],
    deadlineUnix: args.deadlineUnix,
    cancelled: args.cancelled,
  });
}

/** Whether the citations panel should render source rows (vs status-only). */
export function researchCitationsShowsRows(view: ResearchCitationsView): boolean {
  return view.displayable.length > 0;
}
