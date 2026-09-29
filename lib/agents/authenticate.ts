/**
 * One place that answers "who is calling the agent API, and may they?".
 *
 * Two credentials are accepted and they are not interchangeable:
 *
 *   API key    — a bearer token. Convenient (plain HTTP, no signing), so it is what
 *                third-party agents use for everything they do repeatedly. What it
 *                can *spend* is bounded by the owner-signed spend permission, not by
 *                the key, which is what makes a leaked key survivable.
 *   Signature  — an owner-signed envelope. Required for the actions that change
 *                authority itself (register, revoke), because those must not be
 *                reachable by a credential the owner cannot see being used.
 *
 * Rate limiting happens here too, so no route can forget it.
 *
 * Schema negotiation (acceptance criteria):
 *   The agent API is contract-first. Callers may pin a schema version via the
 *   `x-mimir-agent-schema-version` header. We negotiate the requested version
 *   against the versions this deployment speaks. A missing header means "use
 *   the current version". An unknown or malformed version fails closed before
 *   any credential check, so a caller never gets authorized against a schema
 *   we cannot account for. The negotiated version is returned on the result so
 *   routes can echo it back and workers can record it.
 */

import { apiError, type ApiErrorResult } from "@/lib/api/errors";
import { authorizeRequest } from "@/lib/api/policy";
import { getAgentApiKeyByHash, touchAgentApiKey } from "@/lib/db";
import {
  checkApiKeyRecord, hashApiKey, parseApiKeyHeader,
} from "./api-keys";
import type { AgentApiAction } from "./api";

/**
 * Actions that establish or withdraw authority, so a bearer token is not enough.
 *
 * A key must not be able to mint another key or widen its own budget — that would
 * turn one leaked credential into permanent, self-renewing access.
 *
 * `rotateKey` is included for the same reason as `issueKey`: issuing a new key
 * and scheduling an expiry on the old one is a privileged authority action that
 * must be initiated by the owner, not by whatever credential is being replaced.
 */
export const OWNER_SIGNED_ACTIONS: readonly AgentApiAction[] = [
  "register", "revoke", "issueKey", "revokeKey", "rotateKey", "grantSpend", "revokeSpend",
];

export function requiresOwnerSignature(action: AgentApiAction): boolean {
  return OWNER_SIGNED_ACTIONS.includes(action);
}

/**
 * Schema versions this deployment can speak. The last entry is the current
 * version and the default when a caller does not negotiate.
 */
export const AGENT_API_SCHEMA_VERSIONS = ["2024-01-01", "2025-01-01"] as const;

export type AgentApiSchemaVersion = (typeof AGENT_API_SCHEMA_VERSIONS)[number];

export const CURRENT_AGENT_API_SCHEMA_VERSION: AgentApiSchemaVersion =
  AGENT_API_SCHEMA_VERSIONS[AGENT_API_SCHEMA_VERSIONS.length - 1];

export const AGENT_API_SCHEMA_VERSION_HEADER = "x-mimir-agent-schema-version";

export interface SchemaVersionNegotiation {
  /** The version the caller asked for, or the current version if none was sent. */
  requested: AgentApiSchemaVersion;
  /** The version the response will use. */
  negotiated: AgentApiSchemaVersion;
  /** True when the caller pinned a version and we can serve it. */
  pinedExactly: boolean;
  /** True when the caller pinned a version we do not speak. */
  unsupported: boolean;
}

/**
 * Negotiate the requested schema version against the versions this deployment
 * speaks. Malformed values are treated as unsupported rather than being silently
 * coerced, so a typo in a header fails close instead of accidentally authorizing
 * against the wrong contract.
 */
export function negotiateSchemaVersion(
  headerValue: string | null | undefined,
): SchemaVersionNegotiation {
  if (headerValue === null || headerValue === undefined || headerValue.trim() === "") {
    return {
      requested: CURRENT_AGENT_API_SCHEMA_VERSION,
      negotiated: CURRENT_AGENT_API_SCHEMA_VERSION,
      pinedExactly: false,
      unsupported: false,
    };
  }

  const raw = headerValue.trim();
  const known = (AGENT_API_SCHEMA_VERSIONS as readonly string[]).includes(raw);
  if (!known) {
    return {
      requested: CURRENT_AGENT_API_SCHEMA_VERSION,
      negotiated: CURRENT_AGENT_API_SCHEMA_VERSION,
      pinedExactly: false,
      unsupported: true,
    };
  }

  const requested = raw as AgentApiSchemaVersion;
  return {
    requested,
    negotiated: requested,
    pinedExactly: true,
    unsupported: false,
  };
}

export type AgentAuth =
  | { kind: "api_key"; agentId: string; keyId: string; scopes?: readonly string[] }
  | { kind: "signature" };

export interface AuthenticateResult {
  auth?: AgentAuth;
  error?: ApiErrorResult;
  /** The negotiated schema version, present on both success and failure. */
  schemaVersion?: AgentApiSchemaVersion;
}

/**
 * Resolve the credential on a request.
 *
 * A present-but-bad key is an error rather than a silent fall-through to signature
 * checking: telling a developer "your key is revoked" is the difference between
 * a one-minute fix and an afternoon.
 */
export async function authenticateAgentRequest(args: {
  action: AgentApiAction;
  authorization: string | null;
  ip?: string;
  /** Agent id claimed by the request body, checked against the key's own agent. */
  claimedAgentId?: string;
  /** Schema version negotiated by the caller, if any. */
  schemaVersionHeader?: string | null;
}): Promise<AuthenticateResult> {
  const negotiation = negotiateSchemaVersion(args.schemaVersionHeader);
  if (negotiation.unsupported) {
    // Fail closed before any credential work: a caller pinning a schema we do
    // not speak must not be authorized against a contract we cannot account for.
    return {
      error: apiError(
        "bad_request",
        `unsupported agent API schema version: ${args.schemaVersionHeader}`,
      ),
      schemaVersion: negotiation.negotiated,
    };
  }

  const presented = parseApiKeyHeader(args.authorization);
  const route = `/api/agents/v1/${args.action}`;

  if (!presented) {
    // No key: the caller must be signing. Still rate-limited, by IP and route.
    const gate = authorizeRequest("public_read", { route, ip: args.ip });
    if (!gate.allowed && gate.error) {
      return { error: gate.error, schemaVersion: negotiation.negotiated };
    }
    return { auth: { kind: "signature" }, schemaVersion: negotiation.negotiated };
  }

  const record = await getAgentApiKeyByHash(hashApiKey(presented)).catch(() => null);
  const checked = checkApiKeyRecord(record, Date.now());
  if (!checked.ok) {
    return {
      error: apiError(
        "unauthenticated",
        checked.reason === "revoked"
          ? "API key revoked"
          : checked.reason === "expired"
            ? "API key expired"
            : "unknown API key",
      ),
      schemaVersion: negotiation.negotiated,
    };
  }

  if (args.claimedAgentId && args.claimedAgentId !== checked.record.agentId) {
    // A key acting for another agent would let one developer spend another's
    // permission, which is the whole boundary this API exists to hold.
    return {
      error: apiError("forbidden", "key does not belong to this agent"),
      schemaVersion: negotiation.negotiated,
    };
  }

  if (checked.record.scopes && !checked.record.scopes.includes(args.action)) {
    return {
      error: apiError("forbidden", `API key is not scoped for action: ${args.action}`),
      schemaVersion: negotiation.negotiated,
    };
  }

  if (requiresOwnerSignature(args.action)) {
    return {
      error: apiError(
        "forbidden",
        `${args.action} requires an owner signature, not an API key`,
      ),
      schemaVersion: negotiation.negotiated,
    };
  }

  const gate = authorizeRequest("api_key_agent", {
    route, ip: args.ip, agentId: checked.record.agentId,
  });
  if (!gate.allowed && gate.error) {
    return { error: gate.error, schemaVersion: negotiation.negotiated };
  }

  // Not awaited: a failed stamp is a reporting loss, not a reason to refuse a
  // request that was otherwise authorised.
  void touchAgentApiKey(checked.record.keyId, Date.now()).catch(() => undefined);

  return {
    auth: {
      kind: "api_key",
      agentId: checked.record.agentId,
      keyId: checked.record.keyId,
      scopes: checked.record.scopes,
    },
    schemaVersion: negotiation.negotiated,
  };
}
