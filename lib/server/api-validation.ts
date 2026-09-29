import { StrKey } from "@stellar/stellar-sdk";

export const INVITE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Agent API schema version negotiation.
 *
 * Mimir exposes a contract-first agent API. Agents advertise the schema
 * versions they can speak via the `x-mimir-api-version` request header.
 * The server picks the highest version both sides support and echoes it back
 * on the response. This keeps callers that do not negotiate working while
 * giving explicit market semantics to agents that do.
 */
export const AGENT_API_VERSION_HEADER = "x-mmir-api-version";

export const AGENT_API_VERSION_RESPONSE_HEADER = "x-mmir-api-version";

export const AGENT_API_SUPPORTED_VERSIONS = ["1"] as const;

export type AgentApiVersion = (typeof AGENT_API_SUPPORTED_VERSIONS)[number];

export const AGENT_API_DEFAULT_VERSION: AgentApiVersion = "1";

export type AgentApiVersionNegotiation =
  | { ok: true; version: AgentApiVersion; requested: AgentApiVersion | null }
  | { ok: false; code: string; message: string; requested: AgentApiVersion | null };

function isSupportedVersion(value: string): value is AgentApiVersion {
  return (AGENT_API_SUPPORTED_VERSIONS as readonly string[]).includes(value);
}

/**
 * Parse the client's advertised schema version.
 *
 * The header may carry a comma-separated list of versions (content
 * negotiation style). We trim each token, drop empty entries, and ignore
 * malformed tokens rather than failing the request -- a malformed
 * version must not be able to block a funded user flow. Returns null when
 * the header is absent or contains no usable tokens.
 */
export function parseAgentApiVersionHeader(
  value: string | null | undefined,
): AgentApiVersion | null {
  if (value == null) return null;
  if (typeof value !== "string") return null;

  const tokens = value
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) return null;

  // Pick the highest supported version the client advertised.
  // Supported versions are numeric strings, so numeric ordering is safe.
  const supported = tokens.filter(isSupportedVersion);
  if (supported.length === 0) return null;

  supported.sort((a, b) => Number(b) - Number(a));
  return supported[0] as AgentApiVersion;
}

/**
 * Negotiate the agent API schema version for a request.
 *
 * Behavior:
 *   - No header: fall back to the default version (success).
 *   - Header with a supported version: pick the highest mutually
 *     supported version (success).
 *   - Header with only unsupported versions: fail closed with
 *     `UNSUPPORTED_API_VERSIOn` so the caller knows to downgrade.
 *   - Malformed header tokens are ignored; if nothing remains, we fall
 *     back to the default version rather than blocking a funded flow.
 */
export function negotiateAgentApiVersion(
  value: string | null | undefined,
): AgentApiVersionNegotiation {
  if (value == null || (typeof value === "string" && value.trim().length === 0)) {
    return { ok: true, version: AGENT_API_DEFAULT_VERSION, requested: null };
  }

  const requested = parseAgentApiVersionHeader(value);
  if (requested !== null) {
    return { ok: true, version: requested, requested };
  }

  // The header was present but no supported version was advertised.
  // Fail closed with a stable code so the client can downgrade.
  const tokens = (typeof value === "string" ? value : "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const first = tokens.length > 0 ? tokens[0] : null;

  return {
    ok: false,
    code: "UNSUPPORTED_API_VERSION",
    message: `Unsupported agent API version. Supported: ${AGENT_API_SUPPORTED_VERSIONS.join(
      ", ",
    )}.`,
    requested: first as AgentApiVersion | null,
  };
}

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
 * Accepts both strkey forms a Mimir participant can be: a `GȠ account and a
 * `C…` contract, because a claim's creator or challenger may be a smart-contract
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
