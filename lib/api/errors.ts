/**
 * Machine-readable API errors.
 *
 * An autonomous agent cannot read prose. Every failure therefore carries a stable
 * `code`, an HTTP status, and — critically — whether retrying could ever help.
 *
 * The retry hint exists because the alternative is agents hammering endpoints that
 * will never succeed. `retryable: false` on a validation error tells a worker to
 * fix its request instead of backing off and trying the same bad payload forever.
 *
 * Extends the existing ApiErrorShape rather than replacing it, so current routes
 * keep working.
 */

import { createApiError, type ApiErrorShape } from "../server/api-validation";

export type ApiErrorCode =
  // ── 400: the caller must change the request ──
  | "invalid_request"
  | "invalid_signature"
  | "unsupported_version"
  | "payload_too_large"
  | "idempotency_conflict"
  // ── 401/403: identity and permission ──
  | "unauthenticated"
  | "nonce_reused"
  | "request_expired"
  | "forbidden"
  | "capability_missing"
  | "agent_revoked"
  | "agent_paused"
  // ── 404/409 ──
  | "not_found"
  | "conflict"
  // ── 429: slow down ──
  | "rate_limited"
  | "budget_exhausted"
  // ── 5xx and upstream ──
  | "upstream_unavailable"
  | "internal_error"
  // ── Evidence Cache Integrity ──
  | "evidence_cache_integrity_violation"
  | "evidence_cache_stale"
  | "evidence_cache_duplicate"
  | "evidence_cache_cancelled"
  | "evidence_cache_dependency_failure";

interface ErrorSpec {
  status: number;
  /** False when repeating the identical request can never succeed. */
  retryable: boolean;
  /** Suggested wait before a retry, seconds. Only meaningful when retryable. */
  retryAfterSeconds?: number;
}

const SPECS: Record<ApiErrorCode, ErrorSpec> = {
  // A malformed or unauthorised request is not a transient condition. Marking
  // these retryable is how a fleet of agents turns one bug into a DoS.
  invalid_request: { status: 400, retryable: false },
  invalid_signature: { status: 400, retryable: false },
  unsupported_version: { status: 400, retryable: false },
  // Oversized signed payloads are not transient — shrink the body and resend.
  payload_too_large: { status: 413, retryable: false },
  // The same idempotency key arrived with a DIFFERENT body: retrying cannot fix
  // it, the caller must either reuse the original body or pick a new key.
  idempotency_conflict: { status: 409, retryable: false },

  unauthenticated: { status: 401, retryable: false },
  nonce_reused: { status: 401, retryable: false },
  // A fresh request WOULD work, so this one is retryable — with a new timestamp.
  request_expired: { status: 401, retryable: true, retryAfterSeconds: 0 },
  forbidden: { status: 403, retryable: false },
  capability_missing: { status: 403, retryable: false },
  agent_revoked: { status: 403, retryable: false },
  // Paused is an operator action that can be undone, unlike revoked.
  agent_paused: { status: 403, retryable: true, retryAfterSeconds: 300 },

  not_found: { status: 404, retryable: false },
  conflict: { status: 409, retryable: false },

  rate_limited: { status: 429, retryable: true, retryAfterSeconds: 60 },
  // A budget refills on a window boundary, so it is retryable but not soon.
  budget_exhausted: { status: 429, retryable: true, retryAfterSeconds: 3_600 },

  upstream_unavailable: { status: 503, retryable: true, retryAfterSeconds: 30 },
  internal_error: { status: 500, retryable: true, retryAfterSeconds: 5 },

  // Evidence Cache Integrity Checks
  // Integrity violations are critical data consistency errors. Retrying the
  // exact same payload will not fix the underlying state corruption or mismatch.
  evidence_cache_integrity_violation: { status: 400, retryable: false },
  // Stale evidence indicates the cache entry is older than the allowed window.
  // The agent must fetch fresh data. Retrying with the same stale data is useless.
  evidence_cache_stale: { status: 400, retryable: false },
  // Duplicate evidence suggests a replay attack or logic error in the agent.
  // This is a hard failure for the current operation.
  evidence_cache_duplicate: { status: 409, retryable: false },
  // Cancelled evidence means the underlying contract or request was cancelled.
  // No amount of retrying will revive a cancelled operation.
  evidence_cache_cancelled: { status: 400, retryable: false },
  // Dependency failure means a prerequisite check failed (e.g. wallet balance).
  // This is a transient state that might resolve, but usually requires external
  // action. We mark it retryable with a backoff to allow for async resolution.
  evidence_cache_dependency_failure: { status: 400, retryable: true, retryAfterSeconds: 10 },
};

export interface ApiError extends ApiErrorShape {
  error: ApiErrorShape["error"] & {
    retryable: boolean;
    retryAfterSeconds?: number;
    /** Field that caused a validation failure, when there is one. */
    field?: string;
  };
}

export interface ApiErrorResult {
  status: number;
  body: ApiError;
  /** Headers a route should set, e.g. Retry-After. */
  headers: Record<string, string>;
}

/**
 * Build a complete error response: status, body and headers.
 *
 * Returned rather than thrown so a route handler stays a pure function of its
 * input — easier to test than exception plumbing.
 */
export function apiError(
  code: ApiErrorCode,
  message: string,
  opts: { field?: string; retryAfterSeconds?: number } = {},
): ApiErrorResult {
  const spec = SPECS[code];
  const retryAfter = opts.retryAfterSeconds ?? spec.retryAfterSeconds;
  const base = createApiError(code, message);
  const body: ApiError = {
    error: {
      ...base.error,
      retryable: spec.retryable,
      ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
      ...(opts.field ? { field: opts.field } : {}),
    },
  };
  const headers: Record<string, string> = {};
  // Only advertise Retry-After when waiting can actually help; on a 400 it would
  // be an invitation to retry a request that cannot succeed.
  if (spec.retryable && retryAfter !== undefined && retryAfter > 0) {
    headers["retry-after"] = String(Math.ceil(retryAfter));
  }
  return { status: spec.status, body, headers };
}

export function isRetryable(code: ApiErrorCode): boolean {
  return SPECS[code].retryable;
}

export function statusFor(code: ApiErrorCode): number {
  return SPECS[code].status;
}