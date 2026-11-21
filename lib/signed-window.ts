/**
 * Freshness window for owner-signed authorisations (copy-trading grants and
 * revocations, basket subscriptions, and proposal review decisions).
 *
 * A signature over a message without a nonce or an expiry is a bearer token
 * that never dies: anyone who ever saw the request body can replay it. Every
 * owner-signed message therefore carries a client-generated nonce, consumed
 * server-side on first use, and an `expiresAt` the server bounds to a short
 * window. The window must stay at or below the durable nonce store's TTL
 * (`NONCE_TTL_MS`, ten minutes) so a nonce cannot be forgotten while the
 * message that carries it is still acceptable.
 *
 * Proposal review decisions also support optimistic concurrency via an
 * `expectedRevision`. When the proposal review in the database has advanced past
 * the expected revision, the mutation is rejected with a typed `conflict` error,
 * leaving the newer review decision unchanged.
 *
 * Pure and client-safe: the browser builds the same message it signs.
 */

/** Longest an owner-signed authorisation may remain acceptable. */
export const SIGNED_ACTION_MAX_TTL_MS = 5 * 60_000;

const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export interface SignedWindowOptions {
  now?: number;
  expectedRevision?: unknown;
  currentRevision?: number;
}

export type RevisionValidationResult =
  | { ok: true; expectedRevision?: number }
  | {
      ok: false;
      code: "invalid_request" | "conflict";
      message: string;
      field: "expectedRevision";
    };

export type SignedWindowResult =
  | { ok: true; nonce: string; expiresAt: number; expectedRevision?: number }
  | {
      ok: false;
      code: "invalid_request" | "request_expired" | "conflict";
      message: string;
      field: "nonce" | "expiresAt" | "expectedRevision";
    };

/**
 * Validate that an expected proposal review revision is a non-negative safe
 * integer and not behind the current revision.
 */
export function validateReviewRevision(
  rawExpectedRevision: unknown,
  currentRevision?: number,
): RevisionValidationResult {
  if (rawExpectedRevision === undefined) {
    return { ok: true };
  }
  const rev = typeof rawExpectedRevision === "number" ? rawExpectedRevision : Number.NaN;
  if (!Number.isSafeInteger(rev) || rev < 0) {
    return {
      ok: false,
      code: "invalid_request",
      message: "expectedRevision must be a non-negative safe integer",
      field: "expectedRevision",
    };
  }
  if (typeof currentRevision === "number" && rev < currentRevision) {
    return {
      ok: false,
      code: "conflict",
      message: `proposal review revision is stale: expected revision ${rev} is behind current revision ${currentRevision}`,
      field: "expectedRevision",
    };
  }
  return { ok: true, expectedRevision: rev };
}

/**
 * Validate the nonce shape, that `expiresAt` is in (now, now + max TTL], and
 * optionally that `expectedRevision` is not stale.
 */
export function validateSignedWindow(
  rawNonce: unknown,
  rawExpiresAt: unknown,
  optionsOrNow: SignedWindowOptions | number = Date.now(),
  maybeCurrentRevision?: number,
): SignedWindowResult {
  const options: SignedWindowOptions =
    typeof optionsOrNow === "number"
      ? { now: optionsOrNow, currentRevision: maybeCurrentRevision }
      : optionsOrNow;
  const now = options.now ?? Date.now();
  const currentRevision = options.currentRevision ?? maybeCurrentRevision;

  const nonce = typeof rawNonce === "string" ? rawNonce.trim() : "";
  if (!NONCE_PATTERN.test(nonce)) {
    return {
      ok: false,
      code: "invalid_request",
      message: "nonce must be 16-128 characters of [A-Za-z0-9_-]",
      field: "nonce",
    };
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
