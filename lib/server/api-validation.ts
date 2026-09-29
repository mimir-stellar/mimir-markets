import { StrKey } from "@stellar/stellar-sdk";

export const INVITE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Supported agent API schema versions.
 *
 * The agent API is contract-first: the Soroban contract state is the
 * source of truth, and the HTTP schema version negotiated here only
 * describes the wire shape of requests and responses. Negotiation must
 * never change accounting meaning or invent contract state.
 *
 * Version 1 is the original, implicit contract and is always accepted when
 * the client sends no version indication. Version 2 is opted-into explicitly
 * and adds structured negotiation metadata without breaking v1 callers.
 */
export const AGENT_API_SCHEMA_VERSIONS = [1, 2] as const;

export type AgentApiSchemaVersion = (typeof AGENT_API_SCHEMA_VERSIONS)[number];

export const DEFAULT_AGENT_API_SCHEMA_VERSION: AgentApiSchemaVersion = 1;

export const AGENT_API_VERSION_HEADER = "x-mimir-api-version";

export type ApiErrorShape = {
  error: {
    code: string;
    message: string;
  };
};

export function createApiError(code: string, message: string): ApiErrorShape {
  return {
    error: {
      code,
      message,
    },
  };
}

export function parsePositiveIntegerParam(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

/**
 * Parse a Stellar address out of a route parameter.
 *
 * Accepts both strkey forms a Mimir participant can be: a `G… account and a
 * `C… `contract, because a claim's creator or challenger may be a smart-contract
 * account rather than a person's keypair.
 *
 * Returned VERBATIM, never normalised. Strkeys are case-sensitive base32, so the
 * `toLowerCase()` this function's EVM predecessor could safely apply would turn a
 * valid address into an invalid one here.
 */
export function parseAddressParam(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (!StrKey.isValidEd25519PublicKey(trimmed) && !StrKey.isValidContract(trimmed)) {
    return null;
  }
  return trimmed;
}

export function parseInviteKey(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }

  if (!INVITE_KEY_PATTERN.test(trimmed)) {
    return null;
  }

  return trimmed;
}

export type AgentApiVersionNegotiation = {
  /** The version the response will be serialised as. */
  version: AgentApiSchemaVersion;
  /** Whether the client explicitly asked for a version. */
  explicit: boolean;
  /** Whether the client requested a version we do not support. */
  negotiationFailed: boolean;
};

export type AgentApiVersionNegotiationResult =
  | { ok: true; negotiation: AgentApiVersionNegotiation }
  | { ok: false; error: ApiErrorShape };

function isSupportedAgentApiVersion(
  value: number,
): value is AgentApiSchemaVersion {
  return (AGENT_API_SCHEMA_VERSIONS as readonly number[]).includes(value);
}

/**
 * Parse an explicit version token from a header or query value.
 *
 * Only canonical base-10 integers are accepted: `"latest"`, `"v2"`, `'2.0"`,
 * whitespace, comma-lists, and negative values are rejected so a malformed
 * negotiation never silently downgrades to a different contract meaning.
 */
export function parseAgentApiVersion(value: string | null | undefined): AgentApiSchemaVersion | null {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (!/^[0-9]+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    return null;
  }

  if (!isSupportedAgentApiVersion(parsed)) {
    return null;
  }

  return parsed;
}

/**
 * Negotiate the agent API schema version for a request.
 *
 * Precedence is deterministic and fail-closed:
 *   1. An explicit `x-mimir-api-version` header is authoritative.
 *   2. Otherwise an explicit `?version=` query param is used.
 *   3. Otherwise the request is treated as v1 (compatible callers).
 *
 * A present-but-malformed or unsupported version is a hard error: we do
 * not guess and do not silently downgrade, because that could change the
 * accounting semantics of a funded flow.
 */
export function negotiateAgentApiVersion(
  headers: Headers | Record<string, string | undefined>,
  searchParams?: URLSearchParams | null,
): AgentApiVersionNegotiationResult {
  const headerValue = readHeader(headers, AGENT_API_VERSION_HEADER);
  const queryValue = searchParams?.get("version") ?? null;

  const explicitRaw = headerValue ?? queryValue;
  if (explicitRaw === null) {
    return {
      ok: true,
      negotiation: {
        version: DEFAULT_AGENT_API_SCHEMA_VERSION,
        explicit: false,
        negotiationFailed: false,
      },
    };
  }

  const parsed = parseAgentApiVersion(explicitRaw);
  if (parsed === null) {
    return {
      ok: false,
      error: createApiError(
        "UNSUPPORTED_API_VERSION",
        `Unsupported agent API schema version. Supported versions: ${AGENT_API_SCHEMA_VERSIONS.join(
          ", ",
        )}.`,
      ),
    };
  }

  return {
    ok: true,
    negotiation: {
      version: parsed,
      explicit: true,
      negotiationFailed: false,
    },
  };
}

function readHeader(
  headers: Headers | Record<string, string | undefined>,
  name: string,
): string | null {
  if (typeof (headers as Headers).get === "function") {
    const value = (headers as Headers).get(name);
    return value === null ? null : value;
  }

  const record = headers as Record<string, string | undefined>;
  const direct = record[name];
  if (typeof direct === "string") {
    return direct;
  }

  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === lower && typeof value === "string") {
      return value;
    }
  }

  return null;
}
