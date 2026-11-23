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

import { TRACE_HEADER } from "../ops/trace-http";
import { currentTraceId } from "../ops/trace";
import { isTraceId } from "../ops/trace-id";
import { createApiError, type ApiErrorShape } from "../server/api-validation";
import {
  buildFeedSourceMetadata,
  schemaVersionHeaders,
  staleFeedSourceMetadata,
  unavailableFeedSourceMetadata,
  versionedMarketFeed,
  type FeedSourceFailureReason,
  type FeedSourceKind,
  type FeedSourceMetadata,
  type VersionedMarketFeedResponse,
} from "./schema";

export type ApiErrorCode =
  // ── 400: the caller must change the request ──
  | "invalid_request"
  | "invalid_signature"
  | "unsupported_version"
  | "payload_too_large"
  | "idempotency_conflict"
  // Cursor was issued for a different sort/filter selection, or is malformed.
  | "invalid_cursor"
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
  // ── 412/304: conditional request outcomes ──
  | "precondition_failed"
  // ── 429: slow down ──
  | "rate_limited"
  | "budget_exhausted"
  // ── 5xx and upstream ──
  | "upstream_unavailable"
  | "internal_error";

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
  // A cursor bound to another query shape can never become valid for this one:
  // the caller must restart pagination from the first page.
  invalid_cursor: { status: 400, retryable: false },

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

  // A failed If-Match / If-None-Match precondition means the caller's view of the
  // resource is stale; re-reading and retrying with the new validator can succeed.
  precondition_failed: { status: 412, retryable: true, retryAfterSeconds: 0 },

  rate_limited: { status: 429, retryable: true, retryAfterSeconds: 60 },
  // A budget refills on a window boundary, so it is retryable but not soon.
  budget_exhausted: { status: 429, retryable: true, retryAfterSeconds: 3_600 },

  upstream_unavailable: { status: 503, retryable: true, retryAfterSeconds: 30 },
  internal_error: { status: 500, retryable: true, retryAfterSeconds: 5 },
};

export interface ApiError extends ApiErrorShape {
  error: ApiErrorShape["error"] & {
    retryable: boolean;
    retryAfterSeconds?: number;
    /** Field that caused a validation failure, when there is one. */
    field?: string;
    /**
     * The trace this failure happened under, when the route ran inside a traced
     * request.
     *
     * An agent reading only its own logs would otherwise have to guess which of
     * its many in-flight calls produced a 429. One field, additive, and
     * meaningless to an agent that ignores it.
     */
    trace_id?: string;
    /**
     * Structured source availability metadata attached when an upstream or
     * read-index read fails, so callers can distinguish an unavailable source
     * from an empty dataset.
     */
    sourceMeta?: FeedSourceMetadata;
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
  opts: {
    field?: string;
    retryAfterSeconds?: number;
    requestId?: string;
    sourceMeta?: FeedSourceMetadata;
  } = {},
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
      ...(opts.requestId ? { requestId: opts.requestId } : {}),
      ...(opts.sourceMeta ? { sourceMeta: opts.sourceMeta } : {}),
    },
  };
  const headers: Record<string, string> = {};
  if (spec.retryable && retryAfter !== undefined && retryAfter > 0) {
    headers["retry-after"] = String(Math.ceil(retryAfter));
  }
  // Reuse the ambient trace; never mint one here. A trace id invented at the moment
  // of failure would be echoed back to the caller and match nothing in the logs,
  // which is worse than no id at all — it looks like correlation and is not. The
  // route's `tracedRoute` wrapper is what supplies it, and an untraced caller
  // simply gets a body without the field.
  const traceId = currentTraceId();
  if (isTraceId(traceId)) {
    body.error.trace_id = traceId;
    headers[TRACE_HEADER] = traceId;
  }
  return { status: spec.status, body, headers };
}

/**
 * Build a 503 `upstream_unavailable` error carrying deterministic
 * unavailable-source metadata. Used when a read-index or upstream contract read
 * fails and no verified fallback snapshot exists, so the failure never turns
 * into a misleading `200` empty data response.
 */
export function upstreamUnavailableError(
  message = "Market read-index is unavailable; retry later",
  opts: {
    source?: FeedSourceKind;
    reason?: FeedSourceFailureReason;
    updatedAtMs?: number | null;
    freshnessWindowMs?: number;
    nowMs?: number;
    retryAfterSeconds?: number;
    requestId?: string;
  } = {},
): ApiErrorResult {
  const sourceMeta = unavailableFeedSourceMetadata({
    source: opts.source,
    reason: opts.reason ?? "read_index_unavailable",
    updatedAtMs: opts.updatedAtMs,
    freshnessWindowMs: opts.freshnessWindowMs,
    nowMs: opts.nowMs,
  });
  return apiError("upstream_unavailable", message, {
    retryAfterSeconds: opts.retryAfterSeconds,
    requestId: opts.requestId,
    sourceMeta,
  });
}

export type ReadIndexQueryInput<T> =
  | {
      ok: true;
      items: readonly T[];
      updatedAtMs?: number | null;
      nextCursor?: number | null;
      source?: FeedSourceKind;
      freshnessWindowMs?: number;
      nowMs?: number;
    }
  | {
      ok: false;
      message?: string;
      reason?: FeedSourceFailureReason;
      source?: FeedSourceKind;
      freshnessWindowMs?: number;
      nowMs?: number;
      retryAfterSeconds?: number;
      requestId?: string;
      /**
       * Optional previously-verified snapshot to serve in degraded/stale mode.
       * When omitted (or when `updatedAtMs` is null and `items` is empty),
       * the failed read-index query refuses with `503 upstream_unavailable`
       * rather than fabricating a `200` empty feed.
       */
      fallback?: {
        items: readonly T[];
        updatedAtMs: number | null;
        nextCursor?: number | null;
      } | null;
    };

export type ReadIndexFeedBoundaryResult<T> =
  | {
      ok: true;
      status: 200;
      degraded: boolean;
      body: VersionedMarketFeedResponse<T>;
      headers: Record<string, string>;
    }
  | {
      ok: false;
      status: number;
      degraded: true;
      body: ApiError;
      headers: Record<string, string>;
      error: ApiErrorResult;
    };

/**
 * Resolve a read-index query at the API boundary without turning a failed query
 * into misleading successful empty data:
 *
 *  - **Healthy query (`ok: true`)**: returns 200 with `items` (including a
 *    legitimately empty `[]` when no markets exist yet) and `live` or `cached`
 *    (or `stale` if the index timestamp exceeded the stale threshold) source
 *    metadata.
 *  - **Failed query with a verified fallback snapshot**: returns 200 with the
 *    fallback items and explicit `status: "stale"`, `stale: true`,
 *    `degraded: true`, and `reason` metadata so callers know the feed is a stale
 *    fallback rather than a live read.
 *  - **Failed query without a verified fallback snapshot**: returns 503
 *    `upstream_unavailable` with `sourceMeta.status === "unavailable"` instead of
 *    a misleading 200 `{ items: [] }`.
 */
export function resolveReadIndexFeed<T>(
  input: ReadIndexQueryInput<T>,
): ReadIndexFeedBoundaryResult<T> {
  if (input.ok) {
    const cache = buildFeedSourceMetadata({
      source: input.source ?? "index",
      updatedAtMs: input.updatedAtMs ?? (input.nowMs ?? Date.now()),
      freshnessWindowMs: input.freshnessWindowMs,
      nowMs: input.nowMs,
    });
    const body = versionedMarketFeed({
      items: input.items,
      cache,
      nextCursor: input.nextCursor,
    });
    return {
      ok: true,
      status: 200,
      degraded: cache.degraded,
      body,
      headers: schemaVersionHeaders(),
    };
  }

  const fallback = input.fallback;
  const hasVerifiedFallback =
    fallback !== null &&
    fallback !== undefined &&
    (fallback.items.length > 0 ||
      (typeof fallback.updatedAtMs === "number" &&
        Number.isFinite(fallback.updatedAtMs) &&
        fallback.updatedAtMs > 0));

  if (hasVerifiedFallback && fallback) {
    const cache = staleFeedSourceMetadata({
      source: input.source ?? "index",
      updatedAtMs: fallback.updatedAtMs,
      freshnessWindowMs: input.freshnessWindowMs,
      nowMs: input.nowMs,
      reason: input.reason ?? "read_index_query_failed",
    });
    const body = versionedMarketFeed({
      items: fallback.items,
      cache,
      nextCursor: fallback.nextCursor,
    });
    return {
      ok: true,
      status: 200,
      degraded: true,
      body,
      headers: schemaVersionHeaders(),
    };
  }

  const error = upstreamUnavailableError(
    input.message ?? "Market read-index is unavailable; retry later",
    {
      source: input.source ?? "index",
      reason: input.reason ?? "read_index_unavailable",
      updatedAtMs: fallback?.updatedAtMs ?? null,
      freshnessWindowMs: input.freshnessWindowMs,
      nowMs: input.nowMs,
      retryAfterSeconds: input.retryAfterSeconds,
      requestId: input.requestId,
    },
  );

  return {
    ok: false,
    status: error.status,
    degraded: true,
    body: error.body,
    headers: {
      ...schemaVersionHeaders(),
      ...error.headers,
    },
    error,
  };
}

export function withRequestId(result: ApiErrorResult, requestId: string): ApiErrorResult {
  return {
    ...result,
    body: {
      ...result.body,
      error: {
        ...result.body.error,
        requestId,
      },
    },
  };
}

export function isRetryable(code: ApiErrorCode): boolean {
  return SPECS[code].retryable;
}

export function statusFor(code: ApiErrorCode): number {
  return SPECS[code].status;
}

export interface ApiErrorSpec {
  code: ApiErrorCode;
  status: number;
  retryable: boolean;
  retryAfterSeconds?: number;
}

/**
 * The whole catalogue, in declaration order.
 *
 * Published for documentation consumers: the agent API wire contract
 * (`lib/ops/agent-api-openapi.ts`) derives its error examples from these rows, so
 * a status, a retry hint or a `retryable` flag cannot be published as something
 * the server does not actually send. `SPECS` is a `Record<ApiErrorCode, …>`, so
 * adding a code without a spec is a type error, and this list can only be wrong by
 * omission — which the contract's own audit turns into a failed check.
 */
export function apiErrorCatalogue(): ApiErrorSpec[] {
  return (Object.keys(SPECS) as ApiErrorCode[]).map((code) => {
    const spec = SPECS[code];
    return {
      code,
      status: spec.status,
      retryable: spec.retryable,
      ...(spec.retryAfterSeconds !== undefined ? { retryAfterSeconds: spec.retryAfterSeconds } : {}),
    };
  });
}
