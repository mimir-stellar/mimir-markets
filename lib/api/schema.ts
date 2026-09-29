/**
 * Request and response schema versioning (§11).
 *
 * No Zod. The repo has no validation dependency and does not need one for this: a
 * field-shape check is about forty lines, and a dependency in the request path is
 * a supply-chain surface for the sake of syntax. What was actually missing is the
 * *versioning* — a client and a server disagreeing about a payload shape should
 * fail loudly at the boundary rather than produce a confusing 500 three layers in.
 *
 * The rules:
 *
 *  - **An unknown or newer client version is refused, not coerced.** A client
 *    speaking v2 to a v1 server is asking for behaviour that does not exist.
 *  - **A missing version is accepted for reads and refused for writes.** Existing
 *    read clients must keep working; a payment whose shape nobody pinned is not
 *    something to guess at.
 *  - **An unexpected extra field is reported, never silently ignored.** Silently
 *    dropping a field is how a caller believes it set a cap that never applied.
 *  - **Every response carries its version**, so a cached body can be identified
 *    later rather than guessed at from its keys.
 *
 *  - **Negotiation is explicit.** A client may advertise the set of versions it
 *    accepts; the server picks the highest mutually supported version, or fails
 *    closed with a machine-readable reason rather than guessing.
 */

export const API_SCHEMA_VERSION = 1;

/** Header a client uses to state the schema version it speaks. */
export const SCHEMA_VERSION_HEADER = "x-mimir-schema-version";

/** Header a client uses to advertise the versions it accepts, comma-separated. */
export const SCHEMA_ACCEPT_HEADER = "x-mimir-schema-accept";

/** Versions this server can speak, newest first. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [API_SCHEMA_VERSION];

export interface VersionVerdict {
  ok: boolean;
  /** The version to apply. Present when ok. */
  version?: number;
  reason?: "unsupported_version" | "version_required" | "malformed_version";
  detail?: string;
}

export interface NegotiatedVersion extends VersionVerdict {
  /** Versions the client advertised, when negotiation was used. */
  clientVersions?: number[];
}

/**
 * Decide which schema version a request is speaking.
 *
 * `mutating` requests must state it; reads may omit it and get the current
 * version, so existing clients keep working.
 */
export function resolveRequestVersion(
  raw: string | null | undefined,
  opts: { mutating?: boolean } = {},
): VersionVerdict {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) {
    if (opts.mutating) {
      return {
        ok: false,
        reason: "version_required",
        detail: `${SCHEMA_VERSION_HEADER} is required for this operation`,
      };
    }
    return { ok: true, version: API_SCHEMA_VERSION };
  }
  // Digits only: "1.0", "v1" and "1 " with junk are all a client that has not
  // agreed on the format, and parseInt would silently accept "1abc" as 1.
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, reason: "malformed_version", detail: trimmed };
  }
  const version = Number(trimmed);
  if (version !== API_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: "unsupported_version",
      detail: `server speaks ${API_SCHEMA_VERSION}, client sent ${version}`,
    };
  }
  return { ok: true, version };
}

/**
 * Negotiate a schema version from an `Accept`-style list.
 *
 * The client advertises the versions it can speak; the server picks the highest
 * one it also supports. An empty or absent list falls back to the single-version
 * behaviour of `resolveRequestVersion`, so existing callers keep working.
 *
 * Fail-closed rules:
 *  - A malformed entry (non-digits) refuses the whole negotiation rather than
 *    silently skipping it; a client that cannot format its own version list is
 *    not a client whose payload should be guessed at.
 *  - A list with no overlap with `SUPPORTED_SCHEMA_VERSIONS` is refused with
 *    `unsupported_version`, never coerced down to the server's current version.
 *  - Duplicates are collapsed; order in the header does not imply preference.
 */
export function negotiateRequestVersion(
  acceptRaw: string | null | undefined,
  opts: { mutating?: boolean; explicitRaw?: string | null } = {},
): NegotiatedVersion {
  const explicit = (opts.explicitRaw ?? "").trim();
  if (explicit.length > 0) {
    const verdict = resolveRequestVersion(explicit, { mutating: opts.mutating });
    return verdict;
  }

  const accept = (acceptRaw ?? "").trim();
  if (accept.length === 0) {
    return resolveRequestVersion(null, { mutating: opts.mutating });
  }

  const parts = accept.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) {
    return resolveRequestVersion(null, { mutating: opts.mutating });
  }

  const clientVersions: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return { ok: false, reason: "malformed_version", detail: part };
    }
    const n = Number(part);
    if (!clientVersions.includes(n)) clientVersions.push(n);
  }

  const overlap = clientVersions.filter((v) => SUPPORTED_SCHEMA_VERSIONS.includes(v));
  if (overlap.length === 0) {
    return {
      ok: false,
      reason: "unsupported_version",
      detail: `server speaks ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}, client accepts ${clientVersions.join(", ")}`,
      clientVersions,
    };
  }

  const chosen = Math.max(...overlap);
  return { ok: true, version: chosen, clientVersions };
}

// ── Minimal shape checking ────────────────────────────────────────────────────

export type FieldType = "string" | "number" | "integer" | "boolean" | "array" | "object";

export interface FieldSpec {
  type: FieldType;
  required?: boolean;
  /** Strings: maximum length. Numbers: maximum value. */
  max?: number;
  /** Strings: minimum length. Numbers: minimum value. */
  min?: number;
  /** Strings: allowed values. */
  oneOf?: readonly string[];
}

export type ShapeSpec = Record<string, FieldSpec>;

export interface ShapeResult {
  ok: boolean;
  errors: string[];
  /** Fields present in the payload that the spec does not declare. */
  unexpected: string[];
}

function typeOk(value: unknown, type: FieldType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      // Arrays are objects in JS and almost never what an "object" field means.
      return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

export function checkShape(payload: unknown, spec: ShapeSpec): ShapeResult {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, errors: ["payload must be a JSON object"], unexpected: [] };
  }
  const record = payload as Record<string, unknown>;
  const errors: string[] = [];

  for (const [field, rule] of Object.entries(spec)) {
    const value = record[field];
    const present = value !== undefined && value !== null;
    if (!present) {
      if (rule.required) errors.push(`${field} is required`);
      continue;
    }
    if (!typeOk(value, rule.type)) {
      errors.push(`${field} must be a ${rule.type}`);
      continue;
    }
    if (typeof value === "string") {
      if (rule.min !== undefined && value.length < rule.min) {
        errors.push(`${field} must be at least ${rule.min} characters`);
      }
      if (rule.max !== undefined && value.length > rule.max) {
        errors.push(`${field} must be at most ${rule.max} characters`);
      }
      if (rule.oneOf && !rule.oneOf.includes(value)) {
        errors.push(`${field} must be one of: ${rule.oneOf.join(", ")}`);
      }
    }
    if (typeof value === "number") {
      if (rule.min !== undefined && value < rule.min) errors.push(`${field} must be >= ${rule.min}`);
      if (rule.max !== undefined && value > rule.max) errors.push(`${field} must be <= ${rule.max}`);
    }
  }

  // Reported, not an error by itself: an extra field is usually a client on a
  // newer shape, and the version check is the right place to refuse that. But
  // silently dropping it is how a caller believes it set a cap that never applied.
  const unexpected = Object.keys(record).filter((key) => !(key in spec));

  return { ok: errors.length === 0, errors, unexpected };
}

// ── Responses ─────────────────────────────────────────────────────────────────

export interface VersionedResponse<T> {
  schemaVersion: number;
  data: T;
}

/** Wrap a payload with the version that produced it. */
export function versioned<T>(data: T): VersionedResponse<T> {
  return { schemaVersion: API_SCHEMA_VERSION, data };
}

/** Header set on every response, so a cached body can be identified later. */
export function schemaVersionHeaders(): Record<string, string> {
  return {
    [SCHEMA_VERSION_HEADER]: String(API_SCHEMA_VERSION),
    [SCHEMA_ACCEPT_HEADER]: SUPPORTED_SCHEMA_VERSIONS.join(","),
  };
}
