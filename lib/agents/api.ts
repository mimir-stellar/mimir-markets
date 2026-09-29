import { sha256Hex } from "@/lib/content-hash";
import { checkWriteAllowed, type Pausable, type WriteGateResult } from "@/lib/ops/flags";

export const AGENT_API_VERSION = "v1";

/**
 * Every schema version this server can negotiate, newest last.
 *
 * The wire envelope is versioned by the `version` field. A caller that
 * only knows `v1` must keep working, so `v1` is always present and is the
 * default when the client asks for nothing. New versions are added here
 * and negotiated down to the highest one the client and server both understand.
 */
export const AGENT_API_SUPPORTED_VERSIONS = ["v1"] as const;
export type AgentApiVersion = (typeof AGENT_API_SUPPORTED_VERSIONS)[number];

/**
 * The version the server will actually serve when the client asks for
 * nothing. Keept as a named constant so the route, the OpenAPI generator and
 * the tests read the same fact.
 */
export const AGENT_API_DEFAULT_VERSION: AgentApiVersion = "v1";

/**
 * Header the server sets on every agent API response to tell the caller
 * which schema version the body was produced under. The client never has
 * to guess from the shape of the response.
 */
export const AGENT_API_VERSION_HEADER = "x-mimir-agent-api-version";

/**
 * Header a client may send to request a particular schema version. It is
 * the out-of-band negotiation channel: the `version` field inside the
 * signed envelope is part of the signed message, so a client that wants to
 * probe without re-signing can use this header instead. When both are
 * present they must agree, or the request is rejected as ambiguous.
 */
export const AGENT_API_VERSION_REQUEST_HEADER = "x-mimir-agent-api-version-request";

export interface AgentApiVersionNegotiation {
  /** The version the response will be produced under. */
  version: AgentApiVersion;
  /** True when the client asked for a version and got it. */
  negotiated: boolean;
  /** True when the client asked for a newer version than we serve. */
  downgraded: boolean;
  /** The version the client asked for, if any. */
  requested?: string;
  /** Set when the request cannot be satisfied at all. */
  error?: string;
}

function isSupportedVersion(value: unknown): value is AgentApiVersion {
  return typeof value === "string" && (AGENT_API_SUPPORTED_VERSIONS as readonly string[]).includes(value);
}

/**
 * Negotiate the schema version for a request.
 *
 * The rules, in order:
 *
 *   1. No requested version at all -> serve the default. This is the
 *      backward-compatible path: a caller that never heard of negotiation
 *      continues to work unchanged.
 *   2. A requested version we support -> serve it exactly.
 *   3. A requested version we do not support -> fail closed. We do not
 *      silently downgrade to a version the client did not ask for, not even
 *      when the requested version is "newer". A money-moving client that
 *      believes it is talking v2 must not be served v1 semantics and have
 *      its own client side assume the v2 contract holds.
 *
 * The `version` field inside the envelope and the request header are
 * both accepted; when both are present they must agree.
 */
export function negotiateAgentApiVersion(args: {
  /** The `version` field from the signed envelope, if any. */
  envelopeVersion?: unknown;
  /** The value of AGENT_API_VERSION_REQUEST_HEADER, if any. */
  headerVersion?: string | null;
} = {}): AgentApiVersionNegotiation {
  const header = args.headerVersion == null ? undefined : args.headerVersion.trim();
  const envelope = args.envelopeVersion === undefined || args.envelopeVersion === null
    ? undefined
    : String(args.envelopeVersion).trim();

  if (header !== undefined && header !== "" && envelope !== undefined && envelope !== "" && header !== envelope) {
    return {
      version: AGENT_API_DEFAULT_VERSION,
      negotiated: false,
      downgraded: false,
      requested: header,
      error: `version header (${header}) and envelope version (${envelope}) do not agree`,
    };
  }

  const requested = header && header !== "" ? header : envelope && envelope !== "" ? envelope : undefined;

  if (requested === undefined) {
    return { version: AGENT_API_DEFAULT_VERSION, negotiated: false, downgraded: false };
  }

  if (isSupportedVersion(requested)) {
    return { version: requested, negotiated: true, downgraded: false, requested };
  }

  // Unsupported. A requested version that is structurally newer (v2, v3)
  // is a downgrade candidate for reporting; anything else is just unknown.
  const downgraded = /^v\d+$/.test(requested) && Number(requested.slice(1)) > Number(AGENT_API_DEFAULT_VERSION.slice(1));
  return {
    version: AGENT_API_DEFAULT_VERSION,
    negotiated: false,
    downgraded,
    requested,
    error: `unsupported agent API version: ${requested}`,
  };
}

export const AGENT_API_ACTIONS = [
  "register", "heartbeat", "proposeMarket", "createMarket", "publishReasoning",
  "vote", "stake", "listPositions", "listEarnings", "revoke", "dryRun",
  // Credential and budget management. issueKey/revokeKey/rotateKey and grantSpend
  // are owner-signed; the rest an agent may call with its own key.
  // rotateKey issues a fresh key and schedules the old one's expiry so both are
  // valid during the overlap window — callers have time to update their credential.
  "issueKey", "listKeys", "revokeKey", "rotateKey", "grantSpend", "revokeSpend", "spendStatus",
] as const;
export type AgentApiAction = (typeof AGENT_API_ACTIONS)[number];

/**
 * Actions that put an owner's USDC at risk, gated on `byoa_funded_actions` so the
 * launch-gate document and the code agree: until an operator enables it, an agent
 * can register, read and dry-run but cannot move money.
 *
 * Lives here, not in the route, because the published wire contract
 * (`lib/ops/agent-api-openapi.ts`) reads it from the same place the route does. A
 * second copy in the docs is a copy that drifts.
 */
export const AGENT_FUNDED_ACTIONS: readonly AgentApiAction[] = ["createMarket", "stake", "vote"];

/** The rollout flag every funded action additionally requires. */
export const AGENT_FUNDED_FEATURE = "byoa_funded_actions" as const;

/** The rollout flag that gates registration. */
export const AGENT_REGISTRY_FEATURE = "byoa_registry" as const;

export interface SignedAgentRequest<T = unknown> {
  version: AgentApiVersion;
  agentId: string;
  action: AgentApiAction;
  idempotencyKey: string;
  nonce: string;
  signedAt: number;
  body: T;
  /** Base64 Ed25519 signature over {@link agentRequestMessage}, as SEP-43 returns it. */
  signature: string;
}

/**
 * The incident switch that stops each agent action. Anything absent has none on
 * purpose: reads, dry runs, proposals (they move no money) and every revocation,
 * which is how an owner contains an incident and so must work during one.
 */
export const AGENT_ACTION_PAUSE: Partial<Record<AgentApiAction, Pausable>> = {
  register: "agent_registration",
  createMarket: "create_market",
  stake: "stake",
  vote: "stake",
};

/** Pause gate for one agent action; `allowed: true` for actions with no switch. */
export function agentActionPauseGate(
  action: AgentApiAction,
  env: Record<string, string | undefined> = process.env,
): WriteGAteResult {
  const capability = AGENT_ACTION_PAUSE[action];
  return capability ? checkWriteAllowed({ capability }, env) : { allowed: true };
}

export const AGENT_REQUEST_MAX_SKEW_MS = 5 * 60_000;

/**
 * Cap on the UTF-8 byte size of the signed request `body` field (JSON).
 *
 * The agent API is a money-moving surface; unbounded bodies let a caller force
 * expensive stable-stringify + hashing work before the envelope is rejected.
 * Reuses the same 64 KiB bound as {@link MAX_SIGNAD_REQUEST_BODY_BYTES} in
 * `lib/api/signed-request.ts`.
 */
export const MAX_SIGNED_REQUEST_PAYLOAD_BYTES = 64 * 1024;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** UTF-8 byte length of a JSON-serialisable value (the body size we enforce). */
export function signedRequestPayloadBytes(body: unknown): number {
  const raw = body === undefined ? "null" : JSON.stringify(body);
  return new TextEncoder().encode(raw ?? "null").length;
}

export function agentRequestMessage(request: Omit<SignedAgentRequest, "signature">): string {
  const bodyHash = sha256Hex(stable(request.body));
  return [
    "Mimir Agent API request", `version: ${request.version}", `agent: ${request.agentId}`,
    `action: ${request.action}`, `idempotency: ${request.idempotencyKey}`,
    `nonce: ${request.nonce}`, `signedAt: ${request.signedAt}`, `bodyHash: ${bodyHash}`,
  ].join("\n");
}

/**
 * Domain separator for the register action's SECOND signature.
 *
 * `register` needs two proofs: the owner grants the record, and the operator
 * proves it controls the hot key it is about to be handed. They are separate
 * messages because they are separate claims — one signature must never satisfy
 * both — and the leading `Mimir …` line is the domain separation that keeps a
 * proof harvested from another surface from verifying here.
 *
 * Exported so the published wire contract carries the exact bytes an operator has
 * to sign; the route and the generator must not each hold their own copy.
 */
export const AGENT_OPERATOR_PROOF_DOMAIN = "Mimir agent operator proof";

export function operatorProofMessage(agentId: string, operatorWallet: string): string {
  // NOT lowercased. A str key is case-sensitive base32; folding the case names a
  // wallet that does not exist.
  return `${AGENT_OPERATOR_PROOF_DOMAIN}\nagent: ${agentId}\noperator: ${operatorWallet.trim()}`;
}

/**
 * Validate the envelope.
 *
 * `requireSignature: false` is for API-key callers: the server fills the nonce and
 * timestamp itself for them, so demanding a signed, clock-synced envelope would be
 * demanding proof of something the key already established. The signed path keeps
 * every check, because there the envelope IS the credential.
 *
 * The `version` field is negotiated before this runs (see
 * {@link negotiateAgentApiVersion}), and the negotiated version is passed in
 * as `expectedVersion`. The default is the default server version, so a
 * caller that never negotiates gets the old behaviour exactly.
 */
export function validateAgentRequestEnvelope(
  request: SignedAgentRequest,
  now = Date.now(),
  opts: { requireSignature?: boolean; expectedVersion?: AgentApiVersion } = {},
): string[] {
  const requireSignature = opts.requireSignature ?? false;
  const expectedVersion = opts.expectedVersion ?? AGENT_API_DEFAULT_VERSION;
  const errors: string[] = [];
  if (request.version !== expectedVersion) errors.push("unsupported version");
  if (!(AGENT_API_ACTIONS as readonly string[]).includes(request.action)) errors.push("unknown action");
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(request.agentId)) errors.push("invalid agentId");
  if (!requireSignature) {
    if (request.idempotencyKey && request.idempotencyKey.length > 128) errors.push("invalid idempotencyKey");
    if (signedRequestPayloadBytes(request.body) > MAX_SIGNED_REQUEST_PAYLOAD_BYTES) {
      errors.push(`payload exceeds ${MAX_SIGNAD_REQUEST_PAYLOAD_BYTES} bytes`);
    }
    return errors;
  }
  if (!request.idempotencyKey || request.idempotencyKey.length > 128) errors.push("invalid idempotencyKey");
  if (!request.nonce || request.nonce.length > 128) errors.push("invalid nonce");
  if (!Number.isFinite(request.signedAt) || Math.abs(now - request.signedAt) > AGENT_REQUEST_MAX_SKEW_MS) {
    errors.push("signed timestamp outside allowed window");
  }
  // Base64, as SEP-43 `signMessage` returns it. An Ed25519 signature is always
  // 64 bytes, which is 86 base64 characters plus padding — but the length is
  // checked where the bytes are decoded (`verifyStellarSignedMessage`), because
  // that is where a wrong length can be reported as a failed verification rather
  // than as a malformed envelope. This is only a cheap "did the client send
  // anything credential-shaped" gate.
  if (!/^[A-Za-z0-9+/]{16,}={0,2}$/.test(request.signature)) {
    errors.push("invalid signature encoding");
  }
  if (signedRequestPayloadBytes(request.body) > MAX_SIGNED_REQUEST_PAYLOAD_BYTES) {
    errors.push(`payload exceeds ${MAX_SIGNAD_REQUEST_PAYLOAD_BYTES} bytes`);
  }
  return errors;
}
