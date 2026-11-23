/**
 * Freshness window for owner-signed authorisations (copy-trading grants and
 * revocations, basket subscriptions) and effective proposal expiry resolution
 * for market-creator proposal review responses.
 *
 * A signature over a message without a nonce or an expiry is a bearer token
 * that never dies: anyone who ever saw the request body can replay it. Every
 * owner-signed message therefore carries a client-generated nonce, consumed
 * server-side on first use, and an `expiresAt` the server bounds to a short
 * window. The window must stay at or below the durable nonce store's TTL
 * (`NONCE_TTL_MS`, ten minutes) so a nonce cannot be forgotten while the
 * message that carries it is still acceptable.
 *
 * Market-creator proposals in the review queue carry both a review window
 * (`queued_at ?? created_at` + review TTL) and an on-chain market `deadline`.
 * Their effective expiry is the earlier of those bounds, formatted in
 * canonical UTC ISO-8601 time alongside the active policy revision, and
 * evaluations explicitly distinguish an absent proposal from an expired one.
 *
 * Pure and client-safe: the browser builds the same message it signs.
 */

/** Longest an owner-signed authorisation may remain acceptable. */
export const SIGNED_ACTION_MAX_TTL_MS = 5 * 60_000;

/** Default review window lifetime for queued market proposals (24 hours). */
export const DEFAULT_PROPOSAL_REVIEW_TTL_MS = 24 * 60 * 60 * 1_000;

/** Hard ceiling for proposal review window lifetime (7 days). */
export const MAX_PROPOSAL_REVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/** Canonical policy revision identifier for proposal expiry evaluation. */
export const PROPOSAL_EXPIRY_POLICY_REVISION = "proposal-expiry:v1";

const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Canonical digest input for a market draft that an owner approves. Approval
 * is bound to these exact fields (wording, source commitment, stake, deadline);
 * any later change to one of them must invalidate the approval.
 */
export interface MarketDraftCommitment {
  wording: string;
  sourceCommitment: string;
  stake: number;
  deadline: number;
}

/**
 * Deterministic JSON serialisation of the approved draft fields with sorted
 * keys, so equivalent drafts always produce the same canonical string.
 */
export function canonicalMarketDraft(draft: MarketDraftCommitment): string {
  return JSON.stringify({
    deadline: draft.deadline,
    sourceCommitment: draft.sourceCommitment,
    stake: draft.stake,
    wording: draft.wording,
  });
}

/** Non-cryptographic FNV-1a digest hex of the canonical draft, for binding checks. */
export function marketDraftDigest(draft: MarketDraftCommitment): string {
  const input = canonicalMarketDraft(draft);
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Returns true only when the draft currently matches the digest that was
 * approved. Any change to wording, source commitment, stake or deadline
 * yields a different digest and must reject execution.
 */
export function isApprovedDraftCurrent(
  draft: MarketDraftCommitment,
  approvedDigest: string,
): boolean {
  return marketDraftDigest(draft) === approvedDigest;
}

export type SignedWindowResult =
  | { ok: true; nonce: string; expiresAt: number }
  | { ok: false; code: "invalid_request" | "request_expired"; message: string; field: "nonce" | "expiresAt" };

/**
 * Validate the nonce shape and that `expiresAt` is in (now, now + max TTL].
 * Nonce whitespace is normalized for compatibility; timestamps must already be
 * safe-integer millisecond numbers. Arrays are refused rather than selecting a
 * value from a repeated parameter list.
 */
export function validateSignedWindow(
  rawNonce: unknown,
  rawExpiresAt: unknown,
  optionsOrNow: SignedWindowOptions | number = Date.now(),
  maybeCurrentRevision?: number,
): SignedWindowResult {
  if (Array.isArray(rawNonce)) {
    return { ok: false, code: "invalid_request", message: "nonce must be provided exactly once", field: "nonce" };
  }
  const nonce = typeof rawNonce === "string" ? rawNonce.trim() : "";
  if (!NONCE_PATTERN.test(nonce)) {
    return {
      ok: false,
      code: "invalid_request",
      message: "nonce must be 16-128 characters of [A-Za-z0-9_-]",
      field: "nonce",
    };
  }
  if (Array.isArray(rawExpiresAt)) {
    return { ok: false, code: "invalid_request", message: "expiresAt must be provided exactly once", field: "expiresAt" };
  }
  const expiresAt = typeof rawExpiresAt === "number" ? rawExpiresAt : Number.NaN;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    return { ok: false, code: "request_expired", message: "expiresAt is missing or already past", field: "expiresAt" };
  }
  if (expiresAt > now + SIGNED_ACTION_MAX_TTL_MS) {
    return {
      ok: false,
      code: "invalid_request",
      message: `expiresAt may not be more than ${SIGNED_ACTION_MAX_TTL_MS / 1000}s in the future`,
      field: "expiresAt",
    };
  }

  if (options.expectedRevision !== undefined) {
    const revisionCheck = validateReviewRevision(options.expectedRevision, currentRevision);
    if (!revisionCheck.ok) {
      return {
        ok: false,
        code: revisionCheck.code,
        message: revisionCheck.message,
        field: revisionCheck.field,
      };
    }
    return { ok: true, nonce, expiresAt, expectedRevision: revisionCheck.expectedRevision };
  }

  return { ok: true, nonce, expiresAt };
}

/** Format an epoch-millisecond timestamp into canonical UTC ISO-8601 (`YYYY-MM-DDTHH:mm:ss.sssZ`). */
export function toCanonicalUtc(epochMs: number): string {
  if (!Number.isFinite(epochMs)) {
    throw new RangeError("timestamp must be a finite number");
  }
  return new Date(Math.trunc(epochMs)).toISOString();
}

/**
 * Resolve the proposal review window TTL from an operator-supplied or option value.
 * Malformed, non-integer, or non-positive values fall back to {@link DEFAULT_PROPOSAL_REVIEW_TTL_MS};
 * values above {@link MAX_PROPOSAL_REVIEW_TTL_MS} are clamped.
 */
export function resolveProposalReviewTtlMs(raw?: unknown): number {
  const value = typeof raw === "string" ? raw.trim() : raw;
  if (typeof value !== "string" && typeof value !== "number") {
    return DEFAULT_PROPOSAL_REVIEW_TTL_MS;
  }
  if (value === "") return DEFAULT_PROPOSAL_REVIEW_TTL_MS;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return DEFAULT_PROPOSAL_REVIEW_TTL_MS;
  }
  return Math.min(n, MAX_PROPOSAL_REVIEW_TTL_MS);
}

/**
 * Resolve the active proposal expiry policy revision.
 * Blank or non-string values fall back to {@link PROPOSAL_EXPIRY_POLICY_REVISION}.
 */
export function resolveProposalExpiryPolicyRevision(raw?: unknown): string {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return PROPOSAL_EXPIRY_POLICY_REVISION;
}

export type ProposalExpirySource = "market_deadline" | "review_window" | "explicit_expiry";
export type ProposalExpiryState = "absent" | "expired" | "active";

export interface ProposalExpiryInput {
  proposal_id?: string | null;
  proposalId?: string | null;
  created_at?: number | string | bigint | null;
  createdAt?: number | string | bigint | null;
  queued_at?: number | string | bigint | null;
  queuedAt?: number | string | bigint | null;
  deadline?: number | string | bigint | null;
  expires_at?: number | string | bigint | null;
  expiresAt?: number | string | bigint | null;
  review_status?: string | null;
  reviewStatus?: string | null;
}

export interface ProposalExpiryOptions {
  now?: number;
  reviewTtlMs?: unknown;
  policyRevision?: unknown;
}

export interface ProposalExpiryResolution {
  /** Lifecycle classification distinguishing an absent proposal from an expired or active one. */
  status: ProposalExpiryState;
  state: ProposalExpiryState;
  exists: boolean;
  expired: boolean;
  isExpired: boolean;
  code: "proposal_not_found" | "proposal_expired" | null;
  proposalId: string | null;
  /** Effective expiry in epoch milliseconds (`null` when absent or unbounded). */
  effectiveExpiresAt: number | null;
  /** Canonical UTC ISO-8601 timestamp for the effective expiry (`null` when absent or unbounded). */
  effectiveExpiresAtUtc: string | null;
  /** Alias for `effectiveExpiresAtUtc`. */
  effectiveExpiry: string | null;
  /** Canonical UTC ISO-8601 timestamp of the market deadline when set. */
  deadlineAtUtc: string | null;
  /** Review window expiry in epoch milliseconds when anchored by `queued_at` / `created_at`. */
  reviewWindowExpiresAt: number | null;
  /** Canonical UTC ISO-8601 timestamp for the review window expiry. */
  reviewWindowExpiresAtUtc: string | null;
  /** Which bound determined the effective expiry. */
  expirySource: ProposalExpirySource | null;
  /** Milliseconds remaining until effective expiry (`0` when expired, `null` when absent). */
  remainingMs: number | null;
  /** Effective review window TTL in milliseconds applied under this policy. */
  reviewTtlMs: number;
  /** Policy revision identifier that governed the expiry calculation. */
  policyRevision: string;
  /** Evaluation timestamp in epoch milliseconds. */
  evaluatedAt: number;
  /** Canonical UTC ISO-8601 evaluation timestamp. */
  evaluatedAtUtc: string;
}

function normalizeEpochMs(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "bigint") {
    if (raw <= 0n) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e11 ? Math.trunc(n * 1_000) : Math.trunc(n);
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n <= 0) return null;
      return n < 1e11 ? Math.trunc(n * 1_000) : Math.trunc(n);
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return raw < 1e11 ? Math.trunc(raw * 1_000) : Math.trunc(raw);
  }
  return null;
}

/**
 * Compute the effective expiry of a market proposal and classify whether it is
 * absent, expired, or active using canonical UTC time and the policy revision.
 */
export function resolveProposalExpiry(
  proposal: ProposalExpiryInput | null | undefined,
  options: ProposalExpiryOptions = {},
): ProposalExpiryResolution {
  const nowMs =
    typeof options.now === "number" && Number.isFinite(options.now)
      ? Math.trunc(options.now)
      : Date.now();
  const evaluatedAtUtc = toCanonicalUtc(nowMs);
  const env = typeof process !== "undefined" && process.env ? process.env : {};
  const reviewTtlMs = resolveProposalReviewTtlMs(
    options.reviewTtlMs !== undefined ? options.reviewTtlMs : env.PROPOSAL_REVIEW_TTL_MS,
  );
  const policyRevision = resolveProposalExpiryPolicyRevision(
    options.policyRevision !== undefined ? options.policyRevision : env.PROPOSAL_EXPIRY_POLICY_REVISION,
  );

  if (proposal === null || proposal === undefined || typeof proposal !== "object") {
    return {
      status: "absent",
      state: "absent",
      exists: false,
      expired: false,
      isExpired: false,
      code: "proposal_not_found",
      proposalId: null,
      effectiveExpiresAt: null,
      effectiveExpiresAtUtc: null,
      effectiveExpiry: null,
      deadlineAtUtc: null,
      reviewWindowExpiresAt: null,
      reviewWindowExpiresAtUtc: null,
      expirySource: null,
      remainingMs: null,
      reviewTtlMs,
      policyRevision,
      evaluatedAt: nowMs,
      evaluatedAtUtc,
    };
  }

  const rawId = proposal.proposal_id ?? proposal.proposalId;
  const proposalId = typeof rawId === "string" && rawId.trim().length > 0 ? rawId.trim() : null;
  const createdAtMs = normalizeEpochMs(proposal.created_at ?? proposal.createdAt);
  const queuedAtMs = normalizeEpochMs(proposal.queued_at ?? proposal.queuedAt);
  const deadlineMs = normalizeEpochMs(proposal.deadline);
  const explicitExpiresAtMs = normalizeEpochMs(proposal.expires_at ?? proposal.expiresAt);
  const reviewStatusRaw = proposal.review_status ?? proposal.reviewStatus;
  const reviewStatus = typeof reviewStatusRaw === "string" ? reviewStatusRaw.trim() : null;

  // An empty record with no proposal identity and no lifecycle timestamps is treated as absent.
  if (
    proposalId === null &&
    createdAtMs === null &&
    queuedAtMs === null &&
    deadlineMs === null &&
    explicitExpiresAtMs === null &&
    reviewStatus === null
  ) {
    return {
      status: "absent",
      state: "absent",
      exists: false,
      expired: false,
      isExpired: false,
      code: "proposal_not_found",
      proposalId: null,
      effectiveExpiresAt: null,
      effectiveExpiresAtUtc: null,
      effectiveExpiry: null,
      deadlineAtUtc: null,
      reviewWindowExpiresAt: null,
      reviewWindowExpiresAtUtc: null,
      expirySource: null,
      remainingMs: null,
      reviewTtlMs,
      policyRevision,
      evaluatedAt: nowMs,
      evaluatedAtUtc,
    };
  }

  const anchorMs = queuedAtMs ?? createdAtMs;
  const reviewWindowExpiresAt = anchorMs !== null ? anchorMs + reviewTtlMs : null;

  const candidates: Array<{ ms: number; source: ProposalExpirySource }> = [];
  if (explicitExpiresAtMs !== null) {
    candidates.push({ ms: explicitExpiresAtMs, source: "explicit_expiry" });
  }
  if (deadlineMs !== null) {
    candidates.push({ ms: deadlineMs, source: "market_deadline" });
  }
  if (reviewWindowExpiresAt !== null) {
    candidates.push({ ms: reviewWindowExpiresAt, source: "review_window" });
  }

  let effectiveExpiresAt: number | null = null;
  let expirySource: ProposalExpirySource | null = null;
  for (const candidate of candidates) {
    if (effectiveExpiresAt === null || candidate.ms < effectiveExpiresAt) {
      effectiveExpiresAt = candidate.ms;
      expirySource = candidate.source;
    }
  }

  const effectiveExpiresAtUtc = effectiveExpiresAt !== null ? toCanonicalUtc(effectiveExpiresAt) : null;
  const deadlineAtUtc = deadlineMs !== null ? toCanonicalUtc(deadlineMs) : null;
  const reviewWindowExpiresAtUtc =
    reviewWindowExpiresAt !== null ? toCanonicalUtc(reviewWindowExpiresAt) : null;

  const isExpired =
    reviewStatus === "stale" ||
    (effectiveExpiresAt !== null && effectiveExpiresAt <= nowMs);
  const status: ProposalExpiryState = isExpired ? "expired" : "active";
  const remainingMs =
    effectiveExpiresAt === null
      ? null
      : isExpired
        ? 0
        : Math.max(0, effectiveExpiresAt - nowMs);

  return {
    status,
    state: status,
    exists: true,
    expired: isExpired,
    isExpired,
    code: isExpired ? "proposal_expired" : null,
    proposalId,
    effectiveExpiresAt,
    effectiveExpiresAtUtc,
    effectiveExpiry: effectiveExpiresAtUtc,
    deadlineAtUtc,
    reviewWindowExpiresAt,
    reviewWindowExpiresAtUtc,
    expirySource,
    remainingMs,
    reviewTtlMs,
    policyRevision,
    evaluatedAt: nowMs,
    evaluatedAtUtc,
  };
}

export type EnrichedProposalRow<T extends Record<string, unknown>> = T & {
  effective_expires_at: number | null;
  effective_expires_at_utc: string | null;
  effectiveExpiresAt: number | null;
  effectiveExpiresAtUtc: string | null;
  effectiveExpiry: string | null;
  deadline_at_utc: string | null;
  deadlineAtUtc: string | null;
  review_window_expires_at: number | null;
  review_window_expires_at_utc: string | null;
  reviewWindowExpiresAt: number | null;
  reviewWindowExpiresAtUtc: string | null;
  expiry_source: ProposalExpirySource | null;
  expirySource: ProposalExpirySource | null;
  expiry_status: "active" | "expired";
  expiryStatus: "active" | "expired";
  is_expired: boolean;
  isExpired: boolean;
  expired: boolean;
  remaining_ms: number | null;
  remainingMs: number | null;
  policy_revision: string;
  policyRevision: string;
  evaluated_at_utc: string;
  evaluatedAtUtc: string;
};

/**
 * Attach effective proposal expiry metadata (canonical UTC timestamps and policy revision)
 * to a proposal record without mutating its stored columns.
 */
export function enrichProposalWithExpiry<T extends Record<string, unknown>>(
  row: T,
  options: ProposalExpiryOptions = {},
): EnrichedProposalRow<T> {
  const expiry = resolveProposalExpiry(row as ProposalExpiryInput, options);
  const expiryStatus: "active" | "expired" = expiry.expired ? "expired" : "active";
  return {
    ...row,
    effective_expires_at: expiry.effectiveExpiresAt,
    effective_expires_at_utc: expiry.effectiveExpiresAtUtc,
    effectiveExpiresAt: expiry.effectiveExpiresAt,
    effectiveExpiresAtUtc: expiry.effectiveExpiresAtUtc,
    effectiveExpiry: expiry.effectiveExpiresAtUtc,
    deadline_at_utc: expiry.deadlineAtUtc,
    deadlineAtUtc: expiry.deadlineAtUtc,
    review_window_expires_at: expiry.reviewWindowExpiresAt,
    review_window_expires_at_utc: expiry.reviewWindowExpiresAtUtc,
    reviewWindowExpiresAt: expiry.reviewWindowExpiresAt,
    reviewWindowExpiresAtUtc: expiry.reviewWindowExpiresAtUtc,
    expiry_source: expiry.expirySource,
    expirySource: expiry.expirySource,
    expiry_status: expiryStatus,
    expiryStatus,
    is_expired: expiry.expired,
    isExpired: expiry.isExpired,
    expired: expiry.expired,
    remaining_ms: expiry.remainingMs,
    remainingMs: expiry.remainingMs,
    policy_revision: expiry.policyRevision,
    policyRevision: expiry.policyRevision,
    evaluated_at_utc: expiry.evaluatedAtUtc,
    evaluatedAtUtc: expiry.evaluatedAtUtc,
  };
}

