/**
 * Research Gateway — the only way an agent reaches the outside world.
 *
 * Agents never fetch directly. Every request goes through here so that four
 * things are true at once:
 *
 *   1. SSRF is impossible (see ./ssrf.ts). The resolved IP is checked at EVERY
 *      redirect hop, not just on the first URL, because a public page can 302
 *      into the metadata service.
 *   2. Responses are bounded. Size, time and redirect count all have ceilings, so
 *      a hostile or broken source cannot exhaust the worker.
 *   3. Per-agent budgets are enforced by the gateway, not by the agent asking
 *      politely. An agent that has spent its request budget is refused.
 *   4. Identical fetches are cached, so a source is neither hammered nor paid for
 *      twice within a cycle.
 *
 * Redirects are followed MANUALLY (`redirect: "manual"`) — the whole point is to
 * re-validate each hop, which `fetch`'s automatic following makes impossible.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { sha256Hex } from "@/lib/content-hash";
import { isPaused } from "@/lib/ops/flags";
import {
  checkDomainPolicy,
  checkRedirectHopPolicy,
  checkResolvedAddresses,
  checkUrl,
  composeDomainPolicy,
  domainPolicyDiagnostics,
  domainPolicyFromEnv,
  sanitizeHeadersForRedirect,
  type DomainPolicy,
  type SsrfReason,
} from "./ssrf";
import { recordAllowlistReject, recordSourceFailure } from "./telemetry";
import { getContentValidationPolicyRevision } from "./content-validation";

export const MAX_REDIRECTS = 3;
export const MAX_RESPONSE_BYTES = 512 * 1024;
export const REQUEST_TIMEOUT_MS = 10_000;

/** Text-ish types only: the gateway exists to read sources, not to download files. */
const ALLOWED_CONTENT_TYPES = [
  "text/html",
  "text/plain",
  "application/json",
  "application/xml",
  "text/xml",
  "application/rss+xml",
  "application/atom+xml",
  "application/ld+json",
];

export type FetchFailure =
  | { kind: "paused"; detail: string }
  | { kind: "blocked"; reason: SsrfReason; detail: string }
  | { kind: "budget"; detail: string }
  | { kind: "too_many_redirects"; detail: string }
  | { kind: "redirect_loop"; detail: string }
  | { kind: "invalid_redirect"; detail: string }
  | { kind: "protocol_downgrade"; detail: string }
  | { kind: "cancelled"; detail: string }
  | { kind: "dependency_failure"; detail: string }
  | { kind: "content_type"; detail: string }
  | { kind: "too_large"; detail: string }
  | { kind: "http_error"; status: number; detail: string }
  | { kind: "transport"; detail: string };

export interface FetchSuccess {
  url: string;
  /** The URL actually served, after redirects. */
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  /** SHA-256 of the body, bare hex, so a reader can verify the capture later. */
  contentHash: string;
  /**
   * When the source was actually fetched. A cache hit keeps the original
   * capture time; it is never replaced with the time the cache was read.
   */
  capturedAt: number;
  /** When this result was handed to the caller. Equals `capturedAt` on a fresh fetch. */
  servedAt: number;
  /** `fetched` for a new network fetch, `cache` for a replay of an earlier capture. */
  acquisition: "fetched" | "cache";
  bytes: number;
  /** Same as `acquisition === "cache"`; kept for existing callers. */
  fromCache: boolean;
  redirects: number;
  /** Complete chain of URLs visited during this fetch. */
  redirectChain: string[];
  /**
   * Content-validation policy revision bound to this fetch result. Set on both
   * paths: a cache hit carries the revision of its original capture.
   */
  policyRevision?: string;
}

export type FetchResult =
  | ({ ok: true } & FetchSuccess)
  | ({ ok: false } & FetchFailure);

// ── Per-agent budget & reservations ──────────────────────────────────────────

export interface AgentBudget {
  /** Requests this agent may make in the current window. */
  maxRequests: number;
  /** Bytes this agent may download in the current window. */
  maxBytes: number;
  /** Maximum paid-fetch units (USDC atomic integers) this agent may spend in current window. */
  maxPaidUnits?: number;
  /** Window duration in milliseconds. Defaults to 1 hour (3_600_000 ms). */
  windowMs?: number;
}

export type ReservationStatus = "reserved" | "committed" | "released" | "interrupted";

export interface BudgetReservation {
  id: string;
  agentId: string;
  requests: number;
  paidUnits: number;
  createdAt: number;
  status: ReservationStatus;
  url?: string;
  stateDir?: string;
}

export interface BudgetUsage {
  requests: number;
  bytes: number;
  paidUnits: number;
  windowStartedAt: number;
}

export interface ReserveBudgetArgs {
  agentId: string;
  requests?: number;
  paidUnits?: number;
  budget?: AgentBudget;
  now?: number;
  url?: string;
  stateDir?: string;
}

export type ReserveBudgetResult =
  | { ok: true; reservation: BudgetReservation }
  | { ok: false; kind: "budget"; detail: string };

export interface ReconcileResult {
  reconciledCount: number;
  releasedRequests: number;
  releasedPaidUnits: number;
  interruptedReservations: BudgetReservation[];
}

const BUDGET_WINDOW_MS = 60 * 60 * 1000;
const usage = new Map<string, BudgetUsage>();
const reservations = new Map<string, BudgetReservation>();

export function defaultAgentBudget(): AgentBudget {
  return {
    maxRequests: Number(process.env.RESEARCH_MAX_REQUESTS_PER_AGENT ?? 120),
    maxBytes: Number(process.env.RESEARCH_MAX_BYTES_PER_AGENT ?? 8 * 1024 * 1024),
    maxPaidUnits: Number(process.env.RESEARCH_MAX_PAID_FETCH_UNITS_PER_AGENT ?? 100_000),
  };
}

function getStateFilePath(stateDir?: string): string | null {
  const dir = stateDir?.trim() || process.env.RESEARCH_STATE_DIR?.trim();
  if (!dir) return null;
  return join(dir, "budget-state.json");
}

function loadFromDisk(filePath: string): void {
  try {
    if (!existsSync(filePath)) return;
    const raw = readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") {
      if (data.usage && typeof data.usage === "object") {
        for (const [k, v] of Object.entries(data.usage)) {
          const val = v;
          usage.set(k, {
            requests: Number(val.requests) || 0,
            bytes: Number(val.bytes) || 0,
            paidUnits: Number(val.paidUnits) || 0,
            windowStartedAt: Number(val.windowStartedAt) || 0,
          });
        }
      }
      if (data.reservations && typeof data.reservations === "object") {
        for (const [k, v] of Object.entries(data.reservations)) {
          const val = v;
          reservations.set(k, {
            id: String(val.id || k),
            agentId: String(val.agentId),
            requests: Number(val.requests) || 0,
            paidUnits: Number(val.paidUnits) || 0,
            createdAt: Number(val.createdAt) || 0,
            status: val.status,
            url: val.url ? String(val.url) : undefined,
            stateDir: val.stateDir ? String(val.stateDir) : undefined,
          });
        }
      }
    }
  } catch {
    // If state cannot be read or is corrupted, fail-safe without throwing
  }
}

function saveToDisk(filePath: string): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const payload = {
      version: 1,
      usage: Object.fromEntries(usage.entries()),
      reservations: Object.fromEntries(reservations.entries()),
    };
    writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    // Fail-safe write
  }
}

function currentUsage(
  agentId: string,
  now: number,
  windowMs = BUDGET_WINDOW_MS,
  stateDir?: string,
): BudgetUsage {
  const existing = usage.get(agentId);
  if (!existing || now - existing.windowStartedAt >= windowMs) {
    const fresh: BudgetUsage = { requests: 0, bytes: 0, paidUnits: 0, windowStartedAt: now };
    usage.set(agentId, fresh);
    const statePath = getStateFilePath(stateDir);
    if (statePath) {
      saveToDisk(statePath);
    }
    return fresh;
  }
  return existing;
}

function getPendingReserved(
  agentId: string,
  now: number,
  windowMs = BUDGET_WINDOW_MS,
): { reservedRequests: number; reservedPaidUnits: number } {
  let reservedRequests = 0;
  let reservedPaidUnits = 0;
  for (const res of reservations.values()) {
    if (res.agentId === agentId && res.status === "reserved") {
      if (now - res.createdAt < windowMs) {
        reservedRequests += res.requests;
        reservedPaidUnits += res.paidUnits;
      }
    }
  }
  return { reservedRequests, reservedPaidUnits };
}

/**
 * Reserve bounded request and paid-fetch units before network dispatch.
 */
export function reserveBudget(args: ReserveBudgetArgs): ReserveBudgetResult {
  const now = args.now ?? Date.now();
  const budget = args.budget ?? defaultAgentBudget();
  const windowMs = budget.windowMs ?? BUDGET_WINDOW_MS;
  const requests = args.requests ?? 1;
  const paidUnits = args.paidUnits ?? 0;
  const statePath = getStateFilePath(args.stateDir);

  if (statePath) {
    loadFromDisk(statePath);
  }

  const used = currentUsage(args.agentId, now, windowMs, args.stateDir);
  const pending = getPendingReserved(args.agentId, now, windowMs);

  const totalRequests = used.requests + pending.reservedRequests + requests;
  if (totalRequests > budget.maxRequests) {
    return {
      ok: false,
      kind: "budget",
      detail: `agent '${args.agentId}' has used its ${budget.maxRequests} request budget`,
    };
  }

  const maxPaid = budget.maxPaidUnits ?? defaultAgentBudget().maxPaidUnits ?? 100_000;
  const totalPaid = used.paidUnits + pending.reservedPaidUnits + paidUnits;
  if (totalPaid > maxPaid) {
    return {
      ok: false,
      kind: "budget",
      detail: `agent '${args.agentId}' has used its ${maxPaid} paid-fetch unit budget`,
    };
  }

  const reservation: BudgetReservation = {
    id: randomUUID(),
    agentId: args.agentId,
    requests,
    paidUnits,
    createdAt: now,
    status: "reserved",
    url: args.url,
    stateDir: args.stateDir,
  };

  reservations.set(reservation.id, reservation);

  if (statePath) {
    saveToDisk(statePath);
  }

  return { ok: true, reservation };
}

export function commitReservation(
  id: string,
  opts?: { bytes?: number; paidUnits?: number; stateDir?: string; now?: number },
): void {
  const statePath = getStateFilePath(opts?.stateDir);
  if (statePath) {
    loadFromDisk(statePath);
  }
  const res = reservations.get(id);
  if (!res || res.status !== "reserved") return;
  res.status = "committed";

  const now = opts?.now ?? Date.now();
  const existing = usage.get(res.agentId);
  let used: BudgetUsage;
  if (!existing || now - existing.windowStartedAt >= BUDGET_WINDOW_MS) {
    used = { requests: 0, bytes: 0, paidUnits: 0, windowStartedAt: now };
    usage.set(res.agentId, used);
  } else {
    used = existing;
  }

  used.requests += res.requests;
  used.bytes += opts?.bytes ?? 0;
  used.paidUnits += opts?.paidUnits !== undefined ? opts.paidUnits : res.paidUnits;

  if (statePath) {
    saveToDisk(statePath);
  }
}

export function releaseReservation(id: string, stateDir?: string): void {
  const statePath = getStateFilePath(stateDir);
  if (statePath) {
    loadFromDisk(statePath);
  }
  const res = reservations.get(id);
  if (!res || res.status !== "reserved") return;
  res.status = "released";

  if (statePath) {
    saveToDisk(statePath);
  }
}

/**
 * Reconcile interrupted fetch attempts (e.g. from a worker restart) without
 * resetting the agent's authorized budget or committed usage.
 */
export function reconcileInterruptedAttempts(opts?: {
  stateDir?: string;
  olderThanMs?: number;
  now?: number;
}): ReconcileResult {
  const statePath = getStateFilePath(opts?.stateDir);
  if (statePath) {
    loadFromDisk(statePath);
  }
  const now = opts?.now ?? Date.now();
  const olderThanMs = opts?.olderThanMs ?? 0;
  let reconciledCount = 0;
  let releasedRequests = 0;
  let releasedPaidUnits = 0;
  const interruptedReservations: BudgetReservation[] = [];

  for (const res of reservations.values()) {
    if (res.status === "reserved" && now - res.createdAt >= olderThanMs) {
      res.status = "interrupted";
      reconciledCount += 1;
      releasedRequests += res.requests;
      releasedPaidUnits += res.paidUnits;
      interruptedReservations.push(res);
    }
  }

  if (statePath && reconciledCount > 0) {
    saveToDisk(statePath);
  }

  return {
    reconciledCount,
    releasedRequests,
    releasedPaidUnits,
    interruptedReservations,
  };
}

/** Remaining allowance, for the agent-facing status endpoint. */
export function budgetRemaining(
  agentId: string,
  budget = defaultAgentBudget(),
  now = Date.now(),
  stateDir?: string,
) {
  const statePath = getStateFilePath(stateDir);
  if (statePath) {
    loadFromDisk(statePath);
  }
  const windowMs = budget.windowMs ?? BUDGET_WINDOW_MS;
  const used = currentUsage(agentId, now, windowMs, stateDir);
  const pending = getPendingReserved(agentId, now, windowMs);
  const maxPaid = budget.maxPaidUnits ?? defaultAgentBudget().maxPaidUnits ?? 100_000;

  return {
    requests: Math.max(0, budget.maxRequests - (used.requests + pending.reservedRequests)),
    bytes: Math.max(0, budget.maxBytes - used.bytes),
    paidUnits: Math.max(0, maxPaid - (used.paidUnits + pending.reservedPaidUnits)),
    windowResetsAt: used.windowStartedAt + windowMs,
  };
}

/** Test seam — resets in-memory budgets, and removes persisted state file if stateDir provided. */
export function resetBudgets(stateDir?: string): void {
  usage.clear();
  reservations.clear();
  if (stateDir) {
    try {
      const p = getStateFilePath(stateDir);
      if (p && existsSync(p)) {
        rmSync(p, { force: true });
      }
    } catch {}
  }
}

// ── Response cache ────────────────────────────────────────────────────────────

interface CacheEntry {
  value: FetchSuccess;
  policyRevision: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = Number(process.env.RESEARCH_CACHE_TTL_MS ?? 5 * 60 * 1000);
const MAX_CACHE_ENTRIES = 500;

export function resetResearchCache(): void {
  cache.clear();
}

/**
 * Canonical source identity for cache indexing and deduplication.
 * Preserves scheme, lowercase host, pathname, and search query while stripping
 * hash fragments and standard default ports so identical network requests share entries
 * while distinct normalized source identities remain strictly separated.
 */
export function normalizeSourceIdentity(raw: string): string {
  const trimmed = raw.trim();
  try {
    const u = new URL(trimmed);
    return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname}${u.search}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

/**
 * Invalidate a cached research result by URL / source identity.
 * Handles both raw and normalized identities.
 */
export function invalidateResearchCache(url: string): boolean {
  const normKey = normalizeSourceIdentity(url);
  const deletedNorm = cache.delete(normKey);
  const deletedRaw = cache.delete(url);
  return deletedNorm || deletedRaw;
}

/**
 * Invalidate cached research decisions incompatible with the given policy revision.
 * When called without arguments, purges all entries not matching the active policy revision.
 * Returns the count of invalidated entries.
 */
export function invalidateIncompatibleResearchCache(
  policyRevision: string = getContentValidationPolicyRevision(),
): number {
  let count = 0;
  for (const [key, entry] of cache.entries()) {
    if (entry.policyRevision !== policyRevision) {
      cache.delete(key);
      count++;
    }
  }
  return count;
}

function cacheGet(url: string, now: number, policyRevision: string): FetchSuccess | null {
  const normKey = normalizeSourceIdentity(url);
  const entry = cache.get(normKey) ?? cache.get(url);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    cache.delete(normKey);
    cache.delete(url);
    return null;
  }
  if (entry.policyRevision !== policyRevision) {
    // Invalidate incompatible cached decisions when validation changes
    cache.delete(normKey);
    cache.delete(url);
    return null;
  }
  return entry.value;
}

function cacheSet(url: string, value: FetchSuccess, policyRevision: string, now: number): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  const normKey = normalizeSourceIdentity(url);
  cache.set(normKey, { value, policyRevision, expiresAt: now + CACHE_TTL_MS });
}

// ── Validation of one hop ─────────────────────────────────────────────────────

/**
 * Validate a single URL: static checks, operator domain policy, then DNS. Called
 * for the original URL AND for every redirect target.
 */
export async function validateHop(
  url: string,
  policy: DomainPolicy,
  resolve: (host: string) => Promise<string[]> = defaultResolve,
): Promise<{ allowed: true } | { allowed: false; reason: SsrfReason; detail: string }> {
  const staticCheck = checkUrl(url);
  if (!staticCheck.allowed) {
    return { allowed: false, reason: staticCheck.reason!, detail: staticCheck.detail! };
  }
  const policyCheck = checkDomainPolicy(url, policy);
  if (!policyCheck.allowed) {
    return { allowed: false, reason: policyCheck.reason!, detail: policyCheck.detail! };
  }

  // DNS last: it is the expensive check, and it is the one that catches a public
  // hostname pointing at a private address.
  let addresses: string[];
  try {
    addresses = await resolve(new URL(url).hostname);
  } catch {
    return { allowed: false, reason: "malformed", detail: "host did not resolve" };
  }
  const dnsCheck = checkResolvedAddresses(addresses);
  if (!dnsCheck.allowed) {
    return { allowed: false, reason: dnsCheck.reason!, detail: dnsCheck.detail! };
  }
  return { allowed: true };
}

async function defaultResolve(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

// ── The fetch ─────────────────────────────────────────────────────────────────

export interface GatewayFetchArgs {
  url: string;
  /** Registry id of the requesting agent, for budget accounting. */
  agentId: string;
  policy?: DomainPolicy;
  budget?: AgentBudget;
  paidUnits?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  maxRedirects?: number;
  allowCrossDomainRedirects?: boolean;
  allowProtocolDowngrade?: boolean;
  /** Test seams. */
  resolve?: (host: string) => Promise<string[]>;
  fetchImpl?: typeof globalThis.fetch;
  now?: number;
  /** Content-validation policy revision to bind to this fetch result. */
  policyRevision?: string;
  stateDir?: string;
}

function contentTypeAllowed(contentType: string): boolean {
  const base = contentType.split(";")[0]!.trim().toLowerCase();
  return ALLOWED_CONTENT_TYPES.includes(base);
}

function normalizeUrlForLoopCheck(raw: string): string {
  return normalizeSourceIdentity(raw);
}

/**
 * Read a bounded prefix of the body. Streaming with a running total, so a source
 * that lies in Content-Length (or omits it) still cannot blow the limit.
 */
async function readBounded(response: Response, limit: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    const bytes = Buffer.byteLength(text);
    return bytes > limit
      ? { text: text.slice(0, limit), bytes: limit, truncated: true }
      : { text, bytes, truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      chunks.push(value.slice(0, value.byteLength - (total - limit)));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return { text: buffer.toString("utf8"), bytes: buffer.byteLength, truncated };
}

/**
 * Fetch one source through the gateway.
 *
 * Never throws: an agent asking for a hostile URL gets a typed refusal, which is
 * information it can act on, rather than an exception that kills a settlement.
 */
export async function gatewayFetch(args: GatewayFetchArgs): Promise<FetchResult> {
  const now = args.now ?? Date.now();
  const policyRevision =
    args.policyRevision?.trim() || getContentValidationPolicyRevision();
  const fail = <T extends FetchFailure>(failure: T): { ok: false } & T => {
    recordSourceFailure(failure.kind);
    return { ok: false, ...failure };
  };
  const envPolicy = domainPolicyFromEnv();
  const policyDiagnostics = domainPolicyDiagnostics();
  // The operator's configuration is authoritative: a request-scoped policy may
  // narrow it but never widen it. Before this, `policy: { allow: [] }` on a
  // fetch cleared the operator allowlist and admitted the whole internet.
  const policy: DomainPolicy = composeDomainPolicy(envPolicy, args.policy);
  // Request-level redirect switches may only tighten, never loosen.
  if (args.allowCrossDomainRedirects !== undefined) {
    policy.allowCrossDomainRedirects = (policy.allowCrossDomainRedirects ?? true) && args.allowCrossDomainRedirects;
  }
  if (args.allowProtocolDowngrade !== undefined) {
    policy.disallowProtocolDowngrade = (policy.disallowProtocolDowngrade ?? true) || args.allowProtocolDowngrade === false;
  }
  const budget = args.budget ?? defaultAgentBudget();
  const doFetch = args.fetchImpl ?? fetch;

  if (args.signal?.aborted) {
    return fail({ kind: "cancelled", detail: "request was cancelled" });
  }

  // A configured-but-unusable allowlist is a configuration error, not license to
  // fetch anything. Refuse, and make the reason countable in telemetry.
  if (policyDiagnostics.allowConfigured && envPolicy.allow.length === 0 && !policy.denyAll) {
    recordAllowlistReject("pattern_invalid");
    return fail({
      kind: "blocked",
      reason: "not_allowlisted",
      detail: `RESEARCH_ALLOWED_DOMAINS has no usable entries (${policyDiagnostics.allowInvalid.length} invalid); refusing all research fetches`,
    });
  }
  // Strict mode is the recommended production posture: opt in with
  // RESEARCH_REQUIRE_ALLOWLIST=1 so "no allowlist configured" is a refusal rather
  // than an open gateway. Opt-in, so existing deployments keep working.
  const requireAllowlist = ["1", "true"].includes((process.env.RESEARCH_REQUIRE_ALLOWLIST ?? "").toLowerCase());
  if (requireAllowlist && policy.allow.length === 0 && !policy.denyAll) {
    recordAllowlistReject("allowlist_unconfigured");
    return fail({
      kind: "blocked",
      reason: "not_allowlisted",
      detail: "RESEARCH_REQUIRE_ALLOWLIST=1 but neither RESEARCH_ALLOWED_DOMAINS nor a request allowlist is set",
    });
  }

  const pausedAgents = new Set((process.env.RESEARCH_PAUSED_AGENT_IDS ?? "").split(",").map((id) => id.trim().toLowerCase()).filter(Boolean));
  if (isPaused("research") || pausedAgents.has(args.agentId.trim().toLowerCase())) {
    return fail({ kind: "paused", detail: `research is paused for agent '${args.agentId}'` });
  }

  const cached = cacheGet(args.url, now, policyRevision);
  if (cached) {
    // Replay, not a new acquisition: keep the original capturedAt and policy
    // revision, and report the replay time separately as servedAt.
    return {
      ok: true,
      ...cached,
      redirectChain: [...cached.redirectChain],
      servedAt: now,
      acquisition: "cache",
      fromCache: true,
    };
  }

  // Reserve bounded request and paid-fetch units before dispatch
  const reserved = reserveBudget({
    agentId: args.agentId,
    requests: 1,
    paidUnits: args.paidUnits ?? 0,
    budget,
    now,
    url: args.url,
    stateDir: args.stateDir,
  });
  if (!reserved.ok) {
    return fail({
      kind: "budget",
      detail: reserved.detail,
    });
  }
  const reservationId = reserved.reservation.id;

  const used = currentUsage(args.agentId, now, budget.windowMs ?? BUDGET_WINDOW_MS, args.stateDir);
  if (used.bytes >= budget.maxBytes) {
    releaseReservation(reservationId, args.stateDir);
    return fail({
      kind: "budget",
      detail: `agent '${args.agentId}' has used its ${budget.maxBytes} byte budget`,
    });
  }

  let current = args.url;
  let redirects = 0;
  const redirectChain: string[] = [current];
  const visitedUrls = new Set<string>([normalizeUrlForLoopCheck(current)]);
  let requestHeaders: Record<string, string> = {
    accept: ALLOWED_CONTENT_TYPES.join(", "),
    "user-agent": "Mimir-ResearchGateway/1.0 (+https://mimir.app)",
    ...(args.headers ?? {}),
  };

  // Callers can only lower the redirect ceiling, never raise it past the
  // operator's policy.
  const requestedMaxRedirects = [args.maxRedirects, policy.maxRedirects].filter(
    (value): value is number => typeof value === "number",
  );
  const effectiveMaxRedirects = Math.max(
    0,
    Math.min(
      requestedMaxRedirects.length > 0 ? Math.min(...requestedMaxRedirects) : MAX_REDIRECTS,
      10,
    ),
  );

  for (;;) {
    if (args.signal?.aborted) {
      releaseReservation(reservationId, args.stateDir);
      return fail({ kind: "cancelled", detail: "request was cancelled" });
    }

    const hop = await validateHop(current, policy, args.resolve);
    if (!hop.allowed) {
      releaseReservation(reservationId, args.stateDir);
      if (hop.reason === "protocol_downgrade") {
        return fail({ kind: "protocol_downgrade", detail: hop.detail });
      }
      if (hop.reason === "not_allowlisted") {
        recordAllowlistReject("not_allowlisted");
      }
      return fail({ kind: "blocked", reason: hop.reason, detail: hop.detail });
    }

    let response: Response;
    try {
      const fetchSignal = args.signal
        ? AbortSignal.any([args.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS);

      response = await doFetch(current, {
        // Manual, so every hop is re-validated. Automatic following would let a
        // public page redirect us into the metadata service unchecked.
        redirect: "manual",
        headers: requestHeaders,
        signal: fetchSignal,
        cache: "no-store",
      });
    } catch (err) {
      if (args.signal?.aborted || (err instanceof Error && err.name === "AbortError" && args.signal?.aborted)) {
        releaseReservation(reservationId, args.stateDir);
        return fail({ kind: "cancelled", detail: "request was cancelled" });
      }
      commitReservation(reservationId, {
        bytes: 0,
        paidUnits: 0,
        stateDir: args.stateDir,
        now,
      });
      return fail({
        kind: "transport",
        detail: err instanceof Error ? err.message : "fetch failed",
      });
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || location.trim() === "") {
        commitReservation(reservationId, { bytes: 0, paidUnits: 0, stateDir: args.stateDir, now });
        return fail({ kind: "invalid_redirect", detail: `redirect response (${response.status}) without a location header` });
      }

      let nextUrl: string;
      try {
        nextUrl = new URL(location.trim(), current).toString();
      } catch {
        commitReservation(reservationId, { bytes: 0, paidUnits: 0, stateDir: args.stateDir, now });
        return fail({ kind: "invalid_redirect", detail: `unparseable redirect target '${location}'` });
      }

      // Check redirect hop policy (protocol downgrade, cross-domain rules)
      const redirectHopVerdict = checkRedirectHopPolicy(current, nextUrl, policy);
      if (!redirectHopVerdict.allowed) {
        releaseReservation(reservationId, args.stateDir);
        if (redirectHopVerdict.reason === "protocol_downgrade") {
          return fail({ kind: "protocol_downgrade", detail: redirectHopVerdict.detail ?? "insecure protocol downgrade" });
        }
        if (redirectHopVerdict.reason === "not_allowlisted") {
          recordAllowlistReject("not_allowlisted");
        }
        return fail({ kind: "blocked", reason: redirectHopVerdict.reason!, detail: redirectHopVerdict.detail! });
      }

      // Check for redirect cycles / duplicate targets
      const normNext = normalizeUrlForLoopCheck(nextUrl);
      if (visitedUrls.has(normNext)) {
        commitReservation(reservationId, { bytes: 0, paidUnits: 0, stateDir: args.stateDir, now });
        return fail({ kind: "redirect_loop", detail: `redirect cycle or duplicate target detected for '${nextUrl}'` });
      }

      redirects += 1;
      if (redirects > effectiveMaxRedirects) {
        commitReservation(reservationId, { bytes: 0, paidUnits: 0, stateDir: args.stateDir, now });
        return fail({ kind: "too_many_redirects", detail: `more than ${effectiveMaxRedirects} redirects` });
      }

      visitedUrls.add(normNext);
      redirectChain.push(nextUrl);
      requestHeaders = sanitizeHeadersForRedirect(requestHeaders, current, nextUrl);
      current = nextUrl;
      continue;
    }

    if (!response.ok) {
      commitReservation(reservationId, { bytes: 0, paidUnits: 0, stateDir: args.stateDir, now });
      return fail({ kind: "http_error", status: response.status, detail: `upstream ${response.status}` });
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentTypeAllowed(contentType)) {
      commitReservation(reservationId, { bytes: 0, paidUnits: 0, stateDir: args.stateDir, now });
      return fail({ kind: "content_type", detail: `unsupported content-type '${contentType}'` });
    }

    const { text, bytes, truncated } = await readBounded(response, MAX_RESPONSE_BYTES);
    if (truncated) {
      commitReservation(reservationId, { bytes, paidUnits: 0, stateDir: args.stateDir, now });
      // A truncated source is a silent correctness hazard for settlement, so it
      // is a refusal rather than a partial success.
      return fail({ kind: "too_large", detail: `response exceeds ${MAX_RESPONSE_BYTES} bytes` });
    }

    // Success: commit reservation with actual bytes and paidUnits
    commitReservation(reservationId, {
      bytes,
      paidUnits: args.paidUnits ?? 0,
      stateDir: args.stateDir,
      now,
    });

    const success: FetchSuccess = {
      url: args.url,
      finalUrl: current,
      status: response.status,
      contentType,
      body: text,
      contentHash: sha256Hex(text),
      capturedAt: now,
      servedAt: now,
      acquisition: "fetched",
      bytes,
      fromCache: false,
      redirects,
      redirectChain,
      policyRevision,
    };
    cacheSet(args.url, { ...success, redirectChain: [...redirectChain] }, policyRevision, now);
    return { ok: true, ...success };
  }
}

