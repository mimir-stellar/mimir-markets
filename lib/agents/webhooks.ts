/**
 * Signed webhooks for claim lifecycle events.
 *
 * Lets registered BYOA agents receive push notifications instead of polling
 * `/api/vs` for new, challenged and resolved claims:
 *
 *   1. **Owner-signed registration** (`POST /api/agents/v1/registerWebhook`):
 *      Only the agent's owner wallet can register or rotate a webhook URL.
 *      The URL must be `https:` and pass the SSRF guard (`lib/research/ssrf.ts`),
 *      including DNS resolution checks against private/loopback/metadata space.
 *   2. **HMAC-SHA256 signing**:
 *      Every delivery is signed over `<timestampSeconds>.<rawBody>` using the
 *      agent's webhook secret (`whsec_...`) and sent in
 *      `x-mimir-webhook-signature: t=<timestampSeconds>,v1=<hex_hmac_sha256>`.
 *   3. **Bounded queue, backoff & non-blocking delivery**:
 *      Events are enqueued per subscribed agent up to `MAX_PENDING_WEBHOOK_EVENTS_PER_AGENT`
 *      (default 50). Failed deliveries retry with exponential backoff from
 *      `lib/ops/backoff-policies.ts` (`WEBHOOK_BACKOFF`) up to `MAX_WEBHOOK_DELIVERY_ATTEMPTS`.
 *      Failures are isolated and never block the sync loop.
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { ClaimData } from "@/lib/contract";
import {
  DependencyFailureError,
  WEBHOOK_BACKOFF,
  computeBackoff,
  recordDependencySuccess,
  resetFailureCounters,
  type BackoffPolicy,
} from "@/lib/ops/backoff-policies";
import {
  checkResolvedAddresses,
  checkUrl,
  type SsrfReason,
  type UrlVerdict,
} from "@/lib/research/ssrf";

export const WEBHOOK_EVENTS = [
  "claim.created",
  "claim.challenged",
  "claim.resolved",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_SIGNATURE_HEADER = "x-mimir-webhook-signature";
export const WEBHOOK_TIMESTAMP_HEADER = "x-mimir-webhook-timestamp";
export const WEBHOOK_EVENT_HEADER = "x-mimir-webhook-event";
export const WEBHOOK_DELIVERY_HEADER = "x-mimir-webhook-delivery";
export const WEBHOOK_SIGNATURE_VERSION = "v1";

/** Default tolerance for webhook signature verification: 5 minutes (300 seconds). */
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

/** Per-agent ceiling on pending webhook deliveries so a dead endpoint cannot grow unboundedly. */
export const MAX_PENDING_WEBHOOK_EVENTS_PER_AGENT = 50;

/** Maximum total delivery attempts (1 initial + 4 retries) before marking an event failed. */
export const MAX_WEBHOOK_DELIVERY_ATTEMPTS = WEBHOOK_BACKOFF.maxConsecutiveDependencyFailures;

/** Timeout per outbound webhook HTTP request. */
export const WEBHOOK_DELIVERY_TIMEOUT_MS = 5_000;

export const WEBHOOK_SECRET_PREFIX = "whsec_";
export const WEBHOOK_SECRET_PREFIX_LENGTH = 14;

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return typeof value === "string" && (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

// ── Secrets & HMAC Signing ────────────────────────────────────────────────────

export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString("hex")}`;
}

export function webhookSecretPrefix(secret: string): string {
  return secret.trim().slice(0, WEBHOOK_SECRET_PREFIX_LENGTH);
}

/**
 * Canonical string signed by HMAC-SHA256: `<timestampSeconds>.<rawBody>`.
 *
 * Binding the timestamp into the MAC stops an attacker who captures a valid
 * delivery from replaying it later under a fresh timestamp header.
 */
export function webhookSigningPayload(timestampSeconds: number, rawBody: string): string {
  return `${Math.floor(timestampSeconds)}.${rawBody}`;
}

/** Compute the hex-encoded HMAC-SHA256 digest for a webhook payload. */
export function computeWebhookHmac(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  return createHmac("sha256", secret)
    .update(webhookSigningPayload(timestampSeconds, rawBody), "utf8")
    .digest("hex");
}

/**
 * Format the `x-mimir-webhook-signature` header value:
 * `t=<timestampSeconds>,v1=<hex_hmac_sha256>`
 */
export function signWebhookPayload(
  secret: string,
  rawBody: string,
  timestampSeconds = Math.floor(Date.now() / 1000),
): { header: string; timestampSeconds: number; signature: string } {
  const ts = Math.floor(timestampSeconds);
  const signature = computeWebhookHmac(secret, ts, rawBody);
  return {
    header: `t=${ts},${WEBHOOK_SIGNATURE_VERSION}=${signature}`,
    timestampSeconds: ts,
    signature,
  };
}

export type WebhookVerifyFailureReason =
  | "missing_signature"
  | "malformed_header"
  | "invalid_timestamp"
  | "timestamp_expired"
  | "signature_mismatch";

export type WebhookVerifyResult =
  | { ok: true; timestampSeconds: number }
  | { ok: false; reason: WebhookVerifyFailureReason };

/**
 * Verify an `x-mimir-webhook-signature` header against the raw request body.
 *
 * Uses constant-time comparison (`timingSafeEqual`) over the decoded 32-byte
 * HMAC digests and enforces a freshness window around `nowSeconds`.
 */
export function verifyWebhookSignature(args: {
  secret: string;
  rawBody: string;
  signatureHeader: string | null | undefined;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): WebhookVerifyResult {
  const {
    secret,
    rawBody,
    signatureHeader,
    nowSeconds = Math.floor(Date.now() / 1000),
    toleranceSeconds = DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  } = args;

  if (!signatureHeader || typeof signatureHeader !== "string" || !signatureHeader.trim()) {
    return { ok: false, reason: "missing_signature" };
  }

  let timestampStr: string | undefined;
  const signatures: string[] = [];

  for (const part of signatureHeader.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key === "t") {
      timestampStr = val;
    } else if (key === WEBHOOK_SIGNATURE_VERSION && val) {
      signatures.push(val);
    }
  }

  if (!timestampStr || signatures.length === 0) {
    return { ok: false, reason: "malformed_header" };
  }

  if (!/^\d+$/.test(timestampStr)) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  const timestampSeconds = Number(timestampStr);
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds <= 0) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  if (toleranceSeconds >= 0 && Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) {
    return { ok: false, reason: "timestamp_expired" };
  }

  const expectedHex = computeWebhookHmac(secret, timestampSeconds, rawBody);
  const expectedBuf = Buffer.from(expectedHex, "hex");

  for (const candidate of signatures) {
    if (!/^[0-9a-fA-F]{64}$/.test(candidate)) continue;
    const candidateBuf = Buffer.from(candidate.toLowerCase(), "hex");
    if (
      candidateBuf.length === expectedBuf.length &&
      timingSafeEqual(candidateBuf, expectedBuf)
    ) {
      return { ok: true, timestampSeconds };
    }
  }

  return { ok: false, reason: "signature_mismatch" };
}

// ── SSRF & HTTPS URL Validation ───────────────────────────────────────────────

async function defaultResolve(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

export interface ValidateWebhookUrlOptions {
  /**
   * Custom DNS resolver (returns IP strings). When provided or when `resolveDns`
   * is true, resolved addresses are checked via `checkResolvedAddresses` from
   * `lib/research/ssrf.ts`.
   */
  resolve?: (host: string) => Promise<string[]>;
  /**
   * Whether to perform live DNS resolution during this check. Defaults to false
   * for synchronous/offline registration when no custom `resolve` is passed, and
   * true at delivery time so DNS rebinding is always caught before connecting.
   */
  resolveDns?: boolean;
}

/**
 * Validate a webhook target URL:
 *   1. Must parse as a valid URL and use `https:` (HTTP and other schemes are refused).
 *   2. Must pass `checkUrl(raw)` from `lib/research/ssrf.ts` (rejects credentials,
 *      disallowed ports, localhost, `.local`/`.internal`, and private IPv4/IPv6 literals).
 *   3. When `resolve` is provided or `resolveDns` is true, resolves the hostname
 *      and validates every A/AAAA record with `checkResolvedAddresses` from `lib/research/ssrf.ts`.
 */
export async function validateWebhookUrl(
  raw: string,
  opts: ValidateWebhookUrlOptions = {},
): Promise<UrlVerdict> {
  if (typeof raw !== "string" || !raw.trim()) {
    return { allowed: false, reason: "malformed", detail: "webhook URL is required" };
  }

  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { allowed: false, reason: "malformed", detail: "not a parseable URL" };
  }

  if (parsed.protocol !== "https:") {
    return {
      allowed: false,
      reason: "protocol",
      detail: `webhook URL must use https: (got '${parsed.protocol}')`,
    };
  }

  const staticVerdict = checkUrl(trimmed);
  if (!staticVerdict.allowed) {
    return staticVerdict;
  }

  if (opts.resolve || opts.resolveDns) {
    const resolver = opts.resolve ?? defaultResolve;
    let addresses: string[];
    try {
      addresses = await resolver(parsed.hostname);
    } catch {
      return { allowed: false, reason: "malformed", detail: "host did not resolve" };
    }
    const dnsVerdict = checkResolvedAddresses(addresses);
    if (!dnsVerdict.allowed) {
      return dnsVerdict;
    }
  }

  return { allowed: true };
}

// ── Retry Schedule (Backoff Integration) ──────────────────────────────────────

export interface WebhookRetryScheduleStep {
  attempt: number;
  ceilingMs: number;
  delayMs: number;
  reason: string;
}

const WEBHOOK_BASE_DELAY_MS = 1_000;
const WEBHOOK_CAP_DELAY_MS = 60_000;

/**
 * Deterministic ceiling for a 1-indexed failure attempt (`attempt = 1` is the
 * delay after the first failed delivery).
 */
export function webhookRetryCeilingMs(attempt: number): number {
  const consecutive = Math.max(1, Math.floor(attempt));
  const exp = Math.min(consecutive, 10);
  return Math.min(WEBHOOK_BASE_DELAY_MS * Math.pow(2, exp), WEBHOOK_CAP_DELAY_MS);
}

/**
 * Compute the retry delay after a failed webhook delivery using
 * `lib/ops/backoff-policies.ts` (`WEBHOOK_BACKOFF` and `computeBackoff`).
 *
 * When `deterministic: true` is passed (for predictable schedule inspection or
 * tests), returns the exact exponential ceiling instead of random jitter.
 */
export function computeWebhookRetryDelay(
  agentId: string,
  attempt: number,
  opts: {
    policy?: BackoffPolicy;
    deterministic?: boolean;
  } = {},
): { delayMs: number; ceilingMs: number; reason: string; exhausted: boolean } {
  const policy = opts.policy ?? WEBHOOK_BACKOFF;
  const maxAttempts = policy.maxConsecutiveDependencyFailures;
  if (attempt >= maxAttempts) {
    return {
      delayMs: 0,
      ceilingMs: webhookRetryCeilingMs(attempt),
      reason: `exhausted(attempt=${attempt}, max=${maxAttempts})`,
      exhausted: true,
    };
  }

  const workerKey = `webhook:${agentId}`;
  const err = new DependencyFailureError(
    `webhook delivery failed on attempt ${attempt}`,
    "webhook",
    true,
    attempt - 1,
  );
  const backoff = computeBackoff(workerKey, err, policy);
  const ceilingMs = webhookRetryCeilingMs(attempt);

  if (opts.deterministic) {
    return {
      delayMs: ceilingMs,
      ceilingMs,
      reason: `exponential_ceiling(attempt=${attempt}, ceiling=${ceilingMs}ms)`,
      exhausted: false,
    };
  }

  return {
    delayMs: backoff.ms,
    ceilingMs,
    reason: backoff.reason,
    exhausted: false,
  };
}

/**
 * Build the full retry schedule across all allowed attempts for documentation
 * and testing.
 */
export function buildWebhookRetrySchedule(opts: {
  agentId?: string;
  deterministic?: boolean;
  policy?: BackoffPolicy;
} = {}): WebhookRetryScheduleStep[] {
  const agentId = opts.agentId ?? "schedule-probe";
  const policy = opts.policy ?? WEBHOOK_BACKOFF;
  resetFailureCounters(`webhook:${agentId}`);
  const steps: WebhookRetryScheduleStep[] = [];
  for (let attempt = 1; attempt < policy.maxConsecutiveDependencyFailures; attempt += 1) {
    const res = computeWebhookRetryDelay(agentId, attempt, {
      policy,
      deterministic: opts.deterministic,
    });
    steps.push({
      attempt,
      ceilingMs: res.ceilingMs,
      delayMs: res.delayMs,
      reason: res.reason,
    });
  }
  resetFailureCounters(`webhook:${agentId}`);
  return steps;
}

// ── Data Types & Payload Construction ─────────────────────────────────────────

export interface AgentWebhookRecord {
  webhookId: string;
  agentId: string;
  url: string;
  /** Shared HMAC secret (`whsec_...`). Stored so the sync worker can sign outbound payloads. */
  secret: string;
  secretPrefix: string;
  events: WebhookEventType[];
  active: boolean;
  createdAt: number;
  updatedAt: number;
  revokedAt?: number;
}

export interface WebhookClaimSnapshot {
  id: number;
  creator: string;
  question: string;
  creatorPosition: string;
  counterPosition: string;
  category: string;
  creatorStake: number;
  totalChallengerStake: number;
  challengerCount: number;
  totalPot: number;
  deadline: number;
  state: string;
  winnerSide: string;
  resolutionSummary: string;
  confidence: number;
  marketType: string;
  oddsMode: string;
  visibility: string;
}

export interface WebhookEventPayload {
  schemaVersion: 1;
  deliveryId: string;
  event: WebhookEventType;
  occurredAt: number;
  claim: WebhookClaimSnapshot;
  transition?: {
    previousState: string;
    currentState: string;
    previousChallengerCount: number;
    currentChallengerCount: number;
    previousChallengerStake: number;
    currentChallengerStake: number;
  };
}

export type WebhookDeliveryStatus = "pending" | "delivered" | "failed";

export interface WebhookDeliveryRecord {
  deliveryId: string;
  webhookId: string;
  agentId: string;
  eventType: WebhookEventType;
  claimId: number;
  payload: WebhookEventPayload;
  status: WebhookDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number;
  lastError?: string;
  lastStatus?: number;
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
}

function isPrivateClaim(claim: Pick<ClaimData, "visibility" | "is_private">): boolean {
  return claim.visibility === "private" || Boolean(claim.is_private);
}

/**
 * Build a privacy-safe claim snapshot for webhook payloads.
 * Private claims have their text fields redacted just like `/api/vs`.
 */
export function buildWebhookClaimSnapshot(claim: ClaimData): WebhookClaimSnapshot {
  const priv = isPrivateClaim(claim);
  return {
    id: claim.id,
    creator: claim.creator,
    question: priv ? "" : (claim.question ?? ""),
    creatorPosition: priv ? "" : (claim.creator_position ?? ""),
    counterPosition: priv ? "" : (claim.counter_position ?? ""),
    category: claim.category ?? "custom",
    creatorStake: Number(claim.creator_stake ?? 0),
    totalChallengerStake: Number(claim.total_challenger_stake ?? 0),
    challengerCount: Number(claim.challenger_count ?? 0),
    totalPot: Number(claim.total_pot ?? Number(claim.creator_stake ?? 0) + Number(claim.total_challenger_stake ?? 0)),
    deadline: Number(claim.deadline ?? 0),
    state: claim.state ?? "open",
    winnerSide: claim.winner_side ?? "",
    resolutionSummary: priv ? "" : (claim.resolution_summary ?? ""),
    confidence: Number(claim.confidence ?? 0),
    marketType: claim.market_type ?? "binary",
    oddsMode: claim.odds_mode ?? "pool",
    visibility: claim.visibility ?? "public",
  };
}

/**
 * Classify lifecycle events from a newly indexed claim or a refreshed claim state transition.
 *
 * - A brand-new claim emits `claim.created`. If it was already challenged or resolved
 *   before the first index pass, it also emits `claim.challenged` / `claim.resolved`.
 * - A refreshed claim whose challenger count or challenger stake grew (or transitioned
 *   from `open` to `active`) emits `claim.challenged`.
 * - A refreshed claim that transitioned to `resolved` or `cancelled` emits `claim.resolved`.
 */
export function detectClaimLifecycleEvents(args: {
  previous: {
    state: string;
    challenger_count: number;
    total_challenger_stake: number;
  } | null;
  current: ClaimData;
}): WebhookEventType[] {
  const { previous, current } = args;
  const events: WebhookEventType[] = [];

  if (!previous) {
    events.push("claim.created");
    if (current.challenger_count > 0 || current.total_challenger_stake > 0 || current.state === "active") {
      events.push("claim.challenged");
    }
    if (current.state === "resolved" || current.state === "cancelled") {
      events.push("claim.resolved");
    }
    return events;
  }

  const challengedNow =
    current.challenger_count > previous.challenger_count ||
    current.total_challenger_stake > previous.total_challenger_stake ||
    (previous.state === "open" && current.state === "active");

  if (challengedNow) {
    events.push("claim.challenged");
  }

  const wasFinal = previous.state === "resolved" || previous.state === "cancelled";
  const isFinal = current.state === "resolved" || current.state === "cancelled";
  if (!wasFinal && isFinal) {
    events.push("claim.resolved");
  }

  return events;
}

// ── Persistence & In-Memory Store ─────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __mimirAgentWebhooks: Map<string, AgentWebhookRecord> | undefined;
  // eslint-disable-next-line no-var
  var __mimirWebhookDeliveries: Map<string, WebhookDeliveryRecord> | undefined;
}

const webhooksByAgent = (globalThis.__mimirAgentWebhooks ??= new Map<string, AgentWebhookRecord>());
const deliveriesById = (globalThis.__mimirWebhookDeliveries ??= new Map<string, WebhookDeliveryRecord>());

/** Test helper to reset in-memory webhook registrations and delivery queue. */
export function resetWebhooksForTest(): void {
  webhooksByAgent.clear();
  deliveriesById.clear();
}

export async function registerAgentWebhook(args: {
  agentId: string;
  url: string;
  events?: readonly WebhookEventType[];
  secret?: string;
  now?: number;
  resolve?: (host: string) => Promise<string[]>;
  resolveDns?: boolean;
}): Promise<
  | { ok: true; webhook: AgentWebhookRecord; secret: string }
  | { ok: false; reason: SsrfReason | "invalid_events"; detail: string }
> {
  const verdict = await validateWebhookUrl(args.url, {
    resolve: args.resolve,
    resolveDns: args.resolveDns,
  });
  if (!verdict.allowed) {
    return {
      ok: false,
      reason: verdict.reason ?? "malformed",
      detail: verdict.detail ?? "invalid webhook URL",
    };
  }

  const rawEvents = args.events && args.events.length > 0 ? args.events : WEBHOOK_EVENTS;
  const validEvents: WebhookEventType[] = [];
  for (const ev of rawEvents) {
    if (!isWebhookEventType(ev)) {
      return {
        ok: false,
        reason: "invalid_events",
        detail: `unsupported webhook event '${String(ev)}'; allowed: ${WEBHOOK_EVENTS.join(", ")}`,
      };
    }
    if (!validEvents.includes(ev)) validEvents.push(ev);
  }

  const now = args.now ?? Date.now();
  const secret = args.secret && args.secret.trim().length >= 16
    ? args.secret.trim()
    : generateWebhookSecret();
  const existing = webhooksByAgent.get(args.agentId);

  const record: AgentWebhookRecord = {
    webhookId: existing?.webhookId ?? randomUUID(),
    agentId: args.agentId,
    url: args.url.trim(),
    secret,
    secretPrefix: webhookSecretPrefix(secret),
    events: validEvents,
    active: true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  webhooksByAgent.set(args.agentId, record);
  resetFailureCounters(`webhook:${args.agentId}`);

  try {
    const { upsertAgentWebhook } = await import("@/lib/db");
    await upsertAgentWebhook(record);
  } catch {
    // Degrade gracefully when DATABASE_URL is unset or unreachable.
  }

  return { ok: true, webhook: record, secret };
}

export async function getAgentWebhook(agentId: string): Promise<AgentWebhookRecord | null> {
  try {
    const { getAgentWebhookByAgentId } = await import("@/lib/db");
    const durable = await getAgentWebhookByAgentId(agentId);
    if (durable) {
      webhooksByAgent.set(agentId, durable);
      return durable.active ? durable : null;
    }
  } catch {
    // Fall back to in-memory map.
  }
  const mem = webhooksByAgent.get(agentId);
  return mem && mem.active ? mem : null;
}

export async function listActiveWebhooks(): Promise<AgentWebhookRecord[]> {
  try {
    const { listActiveAgentWebhooks } = await import("@/lib/db");
    const durable = await listActiveAgentWebhooks();
    for (const item of durable) {
      webhooksByAgent.set(item.agentId, item);
    }
  } catch {
    // Fall back to in-memory map.
  }
  return [...webhooksByAgent.values()].filter((w) => w.active && !w.revokedAt);
}

// ── Queue & Per-Agent Cap ─────────────────────────────────────────────────────

export interface EnqueueWebhookResult {
  enqueued: number;
  droppedByCap: number;
  deliveries: WebhookDeliveryRecord[];
}

/**
 * Enqueue a claim lifecycle event for every active webhook subscribed to `eventType`.
 *
 * Enforces a per-agent pending queue cap (`maxPendingPerAgent`, default
 * `MAX_PENDING_WEBHOOK_EVENTS_PER_AGENT`). When an agent's pending queue is full,
 * the oldest pending delivery for that agent is evicted so newer lifecycle state
 * transitions are not lost and memory/storage remains strictly bounded.
 */
export async function enqueueClaimLifecycleEvent(args: {
  event: WebhookEventType;
  claim: ClaimData;
  previous?: {
    state: string;
    challenger_count: number;
    total_challenger_stake: number;
  } | null;
  now?: number;
  maxPendingPerAgent?: number;
}): Promise<EnqueueWebhookResult> {
  const now = args.now ?? Date.now();
  const maxPending = args.maxPendingPerAgent ?? MAX_PENDING_WEBHOOK_EVENTS_PER_AGENT;
  const activeWebhooks = await listActiveWebhooks();
  const matching = activeWebhooks.filter((w) => w.events.includes(args.event));

  let enqueued = 0;
  let droppedByCap = 0;
  const createdDeliveries: WebhookDeliveryRecord[] = [];

  const snapshot = buildWebhookClaimSnapshot(args.claim);
  const transition = args.previous
    ? {
        previousState: args.previous.state,
        currentState: args.claim.state,
        previousChallengerCount: Number(args.previous.challenger_count ?? 0),
        currentChallengerCount: Number(args.claim.challenger_count ?? 0),
        previousChallengerStake: Number(args.previous.total_challenger_stake ?? 0),
        currentChallengerStake: Number(args.claim.total_challenger_stake ?? 0),
      }
    : undefined;

  for (const webhook of matching) {
    // Enforce per-agent pending delivery cap.
    const agentPending = [...deliveriesById.values()]
      .filter((d) => d.agentId === webhook.agentId && d.status === "pending")
      .sort((a, b) => a.createdAt - b.createdAt);

    while (agentPending.length >= maxPending && maxPending > 0) {
      const oldest = agentPending.shift()!;
      deliveriesById.delete(oldest.deliveryId);
      droppedByCap += 1;
    }

    if (maxPending <= 0) {
      droppedByCap += 1;
      continue;
    }

    const deliveryId = randomUUID();
    const payload: WebhookEventPayload = {
      schemaVersion: 1,
      deliveryId,
      event: args.event,
      occurredAt: now,
      claim: snapshot,
      ...(transition ? { transition } : {}),
    };

    const delivery: WebhookDeliveryRecord = {
      deliveryId,
      webhookId: webhook.webhookId,
      agentId: webhook.agentId,
      eventType: args.event,
      claimId: args.claim.id,
      payload,
      status: "pending",
      attempts: 0,
      maxAttempts: MAX_WEBHOOK_DELIVERY_ATTEMPTS,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    };

    deliveriesById.set(deliveryId, delivery);
    createdDeliveries.push(delivery);
    enqueued += 1;
  }

  return { enqueued, droppedByCap, deliveries: createdDeliveries };
}

/** Return pending deliveries for an agent (or all agents when omitted). */
export function getPendingWebhookDeliveries(agentId?: string): WebhookDeliveryRecord[] {
  return [...deliveriesById.values()]
    .filter((d) => d.status === "pending" && (!agentId || d.agentId === agentId))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Return a delivery record by ID (for inspection and tests). */
export function getWebhookDelivery(deliveryId: string): WebhookDeliveryRecord | undefined {
  return deliveriesById.get(deliveryId);
}

// ── Delivery Worker ───────────────────────────────────────────────────────────

export interface DeliverWebhookOptions {
  now?: number;
  fetchImpl?: typeof globalThis.fetch;
  resolve?: (host: string) => Promise<string[]>;
  timeoutMs?: number;
  deterministicBackoff?: boolean;
  policy?: BackoffPolicy;
  /**
   * Test-only seam allowing delivery to a local `http://127.0.0.1` server in
   * integration tests without weakening `validateWebhookUrl` in production.
   */
  allowInsecureLocalHttpForTest?: boolean;
}

export interface DeliverSingleWebhookResult {
  deliveryId: string;
  agentId: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  httpStatus?: number;
  nextAttemptAt?: number;
  error?: string;
}

/**
 * Attempt delivery of a single queued webhook event.
 *
 * Re-validates the destination URL and DNS resolution before connecting so DNS
 * rebinding or redirects to internal addresses are refused at delivery time.
 * Uses `redirect: "error"` so a 3xx redirect to an internal metadata service is
 * never followed.
 */
export async function deliverWebhookEvent(
  delivery: WebhookDeliveryRecord,
  webhook: AgentWebhookRecord,
  opts: DeliverWebhookOptions = {},
): Promise<DeliverSingleWebhookResult> {
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? WEBHOOK_DELIVERY_TIMEOUT_MS;

  // Re-verify SSRF + DNS before connecting unless explicitly bypassed in a local HTTP integration test.
  if (!opts.allowInsecureLocalHttpForTest) {
    const urlCheck = await validateWebhookUrl(webhook.url, {
      resolve: opts.resolve,
      resolveDns: true,
    });
    if (!urlCheck.allowed) {
      delivery.attempts += 1;
      delivery.status = "failed";
      delivery.lastError = `ssrf_blocked:${urlCheck.reason ?? "malformed"}:${urlCheck.detail ?? ""}`;
      delivery.updatedAt = now;
      return {
        deliveryId: delivery.deliveryId,
        agentId: delivery.agentId,
        status: "failed",
        attempts: delivery.attempts,
        error: delivery.lastError,
      };
    }
  }

  const rawBody = JSON.stringify(delivery.payload);
  const timestampSeconds = Math.floor(now / 1000);
  const signed = signWebhookPayload(webhook.secret, rawBody, timestampSeconds);

  delivery.attempts += 1;
  delivery.updatedAt = now;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(webhook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        [WEBHOOK_SIGNATURE_HEADER]: signed.header,
        [WEBHOOK_TIMESTAMP_HEADER]: String(signed.timestampSeconds),
        [WEBHOOK_EVENT_HEADER]: delivery.eventType,
        [WEBHOOK_DELIVERY_HEADER]: delivery.deliveryId,
      },
      body: rawBody,
      redirect: "error",
      signal: controller.signal,
    });

    delivery.lastStatus = response.status;

    if (response.status >= 200 && response.status < 300) {
      delivery.status = "delivered";
      delivery.deliveredAt = now;
      delivery.lastError = undefined;
      recordDependencySuccess(`webhook:${delivery.agentId}`, "webhook");
      return {
        deliveryId: delivery.deliveryId,
        agentId: delivery.agentId,
        status: "delivered",
        attempts: delivery.attempts,
        httpStatus: response.status,
      };
    }

    const retry = computeWebhookRetryDelay(delivery.agentId, delivery.attempts, {
      policy: opts.policy,
      deterministic: opts.deterministicBackoff,
    });

    delivery.lastError = `http_${response.status}`;
    if (retry.exhausted) {
      delivery.status = "failed";
    } else {
      delivery.status = "pending";
      delivery.nextAttemptAt = now + retry.delayMs;
    }

    return {
      deliveryId: delivery.deliveryId,
      agentId: delivery.agentId,
      status: delivery.status,
      attempts: delivery.attempts,
      httpStatus: response.status,
      nextAttemptAt: delivery.status === "pending" ? delivery.nextAttemptAt : undefined,
      error: delivery.lastError,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retry = computeWebhookRetryDelay(delivery.agentId, delivery.attempts, {
      policy: opts.policy,
      deterministic: opts.deterministicBackoff,
    });

    delivery.lastError = `transport:${message}`;
    if (retry.exhausted) {
      delivery.status = "failed";
    } else {
      delivery.status = "pending";
      delivery.nextAttemptAt = now + retry.delayMs;
    }

    return {
      deliveryId: delivery.deliveryId,
      agentId: delivery.agentId,
      status: delivery.status,
      attempts: delivery.attempts,
      nextAttemptAt: delivery.status === "pending" ? delivery.nextAttemptAt : undefined,
      error: delivery.lastError,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface FlushWebhookQueueSummary {
  processed: number;
  delivered: number;
  retried: number;
  failed: number;
  results: DeliverSingleWebhookResult[];
}

/**
 * Process all due webhook deliveries (`status === "pending"` and `nextAttemptAt <= now`).
 *
 * Never throws: every delivery error is caught and converted into a retry or
 * terminal failure state so the sync loop is never blocked.
 */
export async function flushWebhookQueue(
  opts: DeliverWebhookOptions = {},
): Promise<FlushWebhookQueueSummary> {
  const now = opts.now ?? Date.now();
  const due = [...deliveriesById.values()]
    .filter((d) => d.status === "pending" && d.nextAttemptAt <= now)
    .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);

  let processed = 0;
  let delivered = 0;
  let retried = 0;
  let failed = 0;
  const results: DeliverSingleWebhookResult[] = [];

  for (const delivery of due) {
    try {
      const webhook = webhooksByAgent.get(delivery.agentId) ?? (await getAgentWebhook(delivery.agentId));
      if (!webhook || !webhook.active) {
        delivery.status = "failed";
        delivery.lastError = "webhook_inactive";
        delivery.updatedAt = now;
        processed += 1;
        failed += 1;
        results.push({
          deliveryId: delivery.deliveryId,
          agentId: delivery.agentId,
          status: "failed",
          attempts: delivery.attempts,
          error: delivery.lastError,
        });
        continue;
      }

      const res = await deliverWebhookEvent(delivery, webhook, opts);
      processed += 1;
      if (res.status === "delivered") delivered += 1;
      else if (res.status === "pending") retried += 1;
      else failed += 1;
      results.push(res);
    } catch (err) {
      // Defensive catch: never allow an unexpected error to escape into the sync loop.
      delivery.status = "failed";
      delivery.lastError = err instanceof Error ? err.message : String(err);
      delivery.updatedAt = now;
      processed += 1;
      failed += 1;
    }
  }

  return { processed, delivered, retried, failed, results };
}
