/**
 * Versioned public API capability discovery document builder, validator, and
 * privacy-enforcing allowlist serializer.
 *
 * Exposes strictly non-secret, deterministic metadata describing:
 *  - Supported capability document `schemaVersion` (`mimir.capabilities.v1`)
 *  - Stellar network identity (CAIP-2, network slug, passphrase, XLM fee decimals)
 *  - Public USDC asset metadata (code, issuer, canonical asset id, 7 decimals)
 *  - x402 v2 payment protocol constants and paid endpoint quotes
 *  - Reviewed public read, x402 paid, and registered agent endpoint capabilities
 *
 * Security & redaction invariants:
 *  - Never reads secret, database, RPC, Horizon, or admin-toggle env vars.
 *  - Enforces an explicit allowlist serializer AND recursive key/value denylist
 *    guards so secrets, internal URLs, admin routes, or private config can never
 *    enter the serialized public document.
 */

import { createHash } from "node:crypto";
import { StrKey } from "@stellar/stellar-sdk";

import {
  API_SCHEMA_VERSION,
  CAPABILITY_DOCUMENT_SPEC,
  CAPABILITY_SCHEMA_VERSION,
  SCHEMA_VERSION_HEADER,
  SUPPORTED_CAPABILITY_SCHEMA_VERSIONS,
  checkShape,
  type CapabilitySchemaVersion,
} from "./schema";
import { TIER_POLICIES, type AccessTier } from "./policy";
import { DEFAULT_RULES, type LimitDimension } from "./rate-limit";
import { NETWORK_PASSPHRASE, STELLAR_NETWORK } from "../stellar";
import {
  MIN_STAKE_USDC,
  USDC_CODE,
  USDC_DECIMALS,
  USDC_ISSUER,
  USDC_SYMBOL,
} from "../usdc";
import {
  PRICES,
  X402_NETWORK,
  X402_PAYMENT_MAX_AGE_MS,
  X402_SCHEME,
  priceToUsdcUnits,
} from "../x402/config";
import { VS_CACHE_HEADERS } from "../server/vs-cache";

export const CAPABILITIES_ROUTE = "/api/capabilities" as const;

export const CAPABILITIES_CACHE_CONTROL =
  "public, s-maxage=300, stale-while-revalidate=600" as const;

export type PublicCapabilityTier = Exclude<AccessTier, "internal_worker">;

export type CapabilityHttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type CapabilityEndpointCategory =
  | "discovery"
  | "public_read"
  | "paid_x402"
  | "agent_api";

export type CapabilityAuthKind =
  | "none"
  | "none_or_invite"
  | "x402"
  | "x402_or_pass"
  | "signed_envelope_or_api_key";

export interface CapabilityServiceInfo {
  name: "Mimir";
  domain: "prediction-market";
  agentApiVersion: "v1";
  schemaVersionHeader: string;
}

export interface CapabilityNetworkInfo {
  caip2: string;
  network: string;
  passphrase: string;
  addressKinds: readonly ("G" | "C")[];
  nativeFeeAsset: {
    code: "XLM";
    decimals: 7;
  };
}

export interface CapabilityAssetInfo {
  code: string;
  symbol: string;
  issuer: string;
  asset: string;
  decimals: number;
  minStakeUsdc: number;
}

export interface CapabilityPaymentProtocolInfo {
  protocol: "x402";
  version: 2;
  scheme: "exact";
  network: string;
  asset: string;
  proofKind: "stellar-payment-v1";
  maxAgeMs: number;
  headers: {
    paymentRequired: "PAYMENT-REQUIRED";
    paymentSignature: "PAYMENT-SIGNATURE";
    paymentResponse: "PAYMENT-RESPONSE";
  };
}

export interface CapabilityRateLimitRuleSummary {
  dimension: LimitDimension;
  limit: number;
  windowMs: number;
}

export interface CapabilityRateLimitTierSummary {
  tier: PublicCapabilityTier;
  dimensions: readonly LimitDimension[];
  rules: readonly CapabilityRateLimitRuleSummary[];
}

export interface CapabilityRateLimitsSummary {
  publicRead: CapabilityRateLimitTierSummary;
  authenticatedUser: CapabilityRateLimitTierSummary;
  registeredAgent: CapabilityRateLimitTierSummary;
  apiKeyAgent: CapabilityRateLimitTierSummary;
}

export interface CapabilityEndpointPayment {
  protocol: "x402-v2";
  scheme: "exact";
  network: string;
  asset: string;
  priceUsd: string;
  priceAtomic: string;
  recipientMode: "platform" | "persona";
  passPlan?: "council";
}

export interface CapabilityEndpointRateLimit {
  tier: PublicCapabilityTier;
  dimensions: readonly LimitDimension[];
  routeKey: string;
}

export interface CapabilityEndpoint {
  id: string;
  path: string;
  methods: readonly CapabilityHttpMethod[];
  category: CapabilityEndpointCategory;
  summary: string;
  auth: CapabilityAuthKind;
  paymentRequired: boolean;
  payment?: CapabilityEndpointPayment;
  rateLimit: CapabilityEndpointRateLimit;
  schemaVersion: string | number;
  cacheControl: string;
}

export interface CapabilityDocument {
  schemaVersion: CapabilitySchemaVersion;
  apiSchemaVersion: number;
  supportedSchemaVersions: readonly CapabilitySchemaVersion[];
  discoveryPath: typeof CAPABILITIES_ROUTE;
  service: CapabilityServiceInfo;
  network: CapabilityNetworkInfo;
  asset: CapabilityAssetInfo;
  paymentProtocol: CapabilityPaymentProtocolInfo;
  rateLimits: CapabilityRateLimitsSummary;
  endpoints: readonly CapabilityEndpoint[];
}

export interface BuildCapabilityDocumentOptions {
  schemaVersion?: CapabilitySchemaVersion;
  /**
   * Optional public issuer override strictly for deterministic synthetic
   * OpenAPI examples (`lib/ops/public-api-openapi.ts`). Must be a valid
   * Stellar `G…` public key.
   */
  usdcIssuer?: string;
}

export interface CapabilityValidationResult {
  ok: boolean;
  errors: string[];
}

export class CapabilityRedactionError extends Error {
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(`Capability document failed redaction check: ${violations[0] ?? "forbidden content"}`);
    this.name = "CapabilityRedactionError";
    this.violations = violations;
  }
}

// ── Security & redaction rules ────────────────────────────────────────────────

const FORBIDDEN_KEY_PATTERN =
  /^(?:env|admin.*|.*secret.*|.*password.*|.*passwd.*|.*apikey.*|.*api_key.*|.*privatekey.*|.*private_key.*|.*seed.*|.*databaseurl.*|.*database_url.*|.*rpcurl.*|.*rpc_url.*|.*rpckey.*|.*rpc_key.*|.*horizonurl.*|.*horizon_url.*|.*internalurl.*|.*internal_url.*|.*pause.*|.*killswitch.*|.*kill_switch.*|.*featureflag.*|.*feature_flag.*|.*processenv.*|.*process_env.*|.*credentials.*|.*bearer.*|.*authorization.*|.*cookie.*|.*signingkey.*|.*signing_key.*|.*selleraddress.*|.*seller_address.*|.*webhook.*|.*token.*)$/i;

const FORBIDDEN_ENDPOINT_PATH_PREFIXES = [
  "/api/cron",
  "/api/admin",
  "/api/internal",
  "/api/proposals",
  "/_next",
] as const;

const SECRET_VALUE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bS[A-Z2-7]{55}\b/, "stellar_secret_seed"],
  [/\b(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\//i, "database_connection_string"],
  [/https?:\/\/[^/\s:@]+:[^/\s@]+@/i, "credentialed_url"],
  [/https?:\/\//i, "external_or_internal_url"],
  [/\bsk_(?:live|test)_[A-Za-z0-9]{6,}/, "provider_secret_key"],
  [/\brk_(?:live|test)_[A-Za-z0-9]{6,}/, "restricted_secret_key"],
  [/\bsk-ant-[A-Za-z0-9_-]{6,}/, "anthropic_api_key"],
  [/\bgsk_[A-Za-z0-9_-]{6,}/, "groq_api_key"],
  [/\bgh[ps]_[A-Za-z0-9]{6,}/, "github_token"],
  [/\bAIza[A-Za-z0-9_-]{10,}/, "google_api_key"],
  [/\bphc_[A-Za-z0-9_-]{10,}/, "posthog_api_key"],
  [/\bAKIA[A-Z0-9]{16}\b/, "aws_access_key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "pem_private_key"],
  [
    /\b(?:DATABASE_URL|TURSO_DATABASE_URL|CRON_SECRET|PASS_SECRET|ORACLE_SECRET_SEED|STELLAR_ORACLE_SECRET|CREATOR_SECRET|STELLAR_DEPLOYER_SECRET|COINGECKO_API_KEY|GROQ_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|SELLER_ADDRESS|MIMIR_PAUSE_[A-Z0-9_]+)\b/,
    "sensitive_env_identifier",
  ],
];

const SENSITIVE_ENV_KEY_PATTERN =
  /(?:SECRET|SEED|PASSWORD|PASSWD|DATABASE_URL|TURSO_DATABASE_URL|API_KEY|PRIVATE_KEY|SIGNING_KEY|RPC_URL|HORIZON_URL|INTERNAL_URL|AUTH_TOKEN|ACCESS_TOKEN|WEBHOOK|SELLER_ADDRESS)/i;

const EXPLICIT_SENSITIVE_ENV_KEYS = [
  "DATABASE_URL",
  "TURSO_DATABASE_URL",
  "CRON_SECRET",
  "PASS_SECRET",
  "ORACLE_SECRET_SEED",
  "STELLAR_ORACLE_SECRET",
  "CREATOR_SECRET",
  "STELLAR_DEPLOYER_SECRET",
  "COINGECKO_API_KEY",
  "GROQ_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "STELLAR_RPC_URL",
  "NEXT_PUBLIC_STELLAR_RPC_URL",
  "STELLAR_HORIZON_URL",
  "NEXT_PUBLIC_STELLAR_HORIZON_URL",
  "SELLER_ADDRESS",
] as const;

const NETWORK_SLUG_RE = /^[a-z0-9-]+$/;
const CAIP2_STELLAR_RE = /^stellar:[a-z0-9-]+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectRedactionViolations(
  value: unknown,
  path: string,
  violations: string[],
): void {
  if (typeof value === "string") {
    for (const [pattern, label] of SECRET_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        violations.push(`${path}: contains forbidden ${label}`);
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectRedactionViolations(item, `${path}[${index}]`, violations),
    );
    return;
  }

  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (childPath !== "$.rateLimits.apiKeyAgent" && FORBIDDEN_KEY_PATTERN.test(key)) {
        violations.push(`${childPath}: forbidden key name "${key}"`);
      }
      collectRedactionViolations(entry, childPath, violations);
    }
  }
}

/**
 * Scan serialized capability JSON against active process environment secret
 * values (when >= 6 characters) as a defense-in-depth runtime leakage guard.
 */
export function assertCapabilityJsonSafe(
  jsonText: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): void {
  const violations: string[] = [];

  for (const [pattern, label] of SECRET_VALUE_PATTERNS) {
    if (pattern.test(jsonText)) {
      violations.push(`$: serialized output contains forbidden ${label}`);
    }
  }

  const candidateKeys = new Set<string>(EXPLICIT_SENSITIVE_ENV_KEYS);
  for (const key of Object.keys(env)) {
    if (SENSITIVE_ENV_KEY_PATTERN.test(key)) {
      candidateKeys.add(key);
    }
  }

  for (const key of candidateKeys) {
    const raw = env[key];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length < 6) continue;
    if (jsonText.includes(trimmed)) {
      violations.push(`$: serialized output contains value of sensitive env var ${key}`);
    }
  }

  if (violations.length > 0) {
    throw new CapabilityRedactionError(violations);
  }
}

// ── Rate limit summary builder ────────────────────────────────────────────────

function rateLimitTierSummary(tier: PublicCapabilityTier): CapabilityRateLimitTierSummary {
  const policy = TIER_POLICIES[tier];
  const rules = DEFAULT_RULES.filter((rule) =>
    policy.limitDimensions.includes(rule.dimension),
  ).map((rule) => ({
    dimension: rule.dimension,
    limit: rule.limit,
    windowMs: rule.windowMs,
  }));

  return {
    tier,
    dimensions: [...policy.limitDimensions],
    rules,
  };
}

function buildRateLimitsSummary(): CapabilityRateLimitsSummary {
  return {
    publicRead: rateLimitTierSummary("public_read"),
    authenticatedUser: rateLimitTierSummary("authenticated_user"),
    registeredAgent: rateLimitTierSummary("registered_agent"),
    apiKeyAgent: rateLimitTierSummary("api_key_agent"),
  };
}

// ── Endpoint catalogue ────────────────────────────────────────────────────────

function makePublicReadEndpoint(input: {
  id: string;
  path: string;
  summary: string;
  cacheControl: string;
  auth?: "none" | "none_or_invite";
  routeKey?: string;
}): CapabilityEndpoint {
  const policy = TIER_POLICIES.public_read;
  return {
    id: input.id,
    path: input.path,
    methods: ["GET"],
    category: "public_read",
    summary: input.summary,
    auth: input.auth ?? "none",
    paymentRequired: false,
    rateLimit: {
      tier: "public_read",
      dimensions: [...policy.limitDimensions],
      routeKey: input.routeKey ?? input.path,
    },
    schemaVersion: API_SCHEMA_VERSION,
    cacheControl: input.cacheControl,
  };
}

function makePaidEndpoint(input: {
  id: string;
  path: string;
  methods: readonly CapabilityHttpMethod[];
  summary: string;
  priceKey: keyof typeof PRICES;
  recipientMode: "platform" | "persona";
  network: string;
  asset: string;
  passPlan?: "council";
}): CapabilityEndpoint {
  const policy = TIER_POLICIES.public_read;
  const priceUsd = PRICES[input.priceKey];
  const priceAtomic = priceToUsdcUnits(priceUsd).toString();

  return {
    id: input.id,
    path: input.path,
    methods: [...input.methods],
    category: "paid_x402",
    summary: input.summary,
    auth: input.passPlan ? "x402_or_pass" : "x402",
    paymentRequired: true,
    payment: {
      protocol: "x402-v2",
      scheme: X402_SCHEME,
      network: input.network,
      asset: input.asset,
      priceUsd,
      priceAtomic,
      recipientMode: input.recipientMode,
      ...(input.passPlan ? { passPlan: input.passPlan } : {}),
    },
    rateLimit: {
      tier: "public_read",
      dimensions: [...policy.limitDimensions],
      routeKey: input.path,
    },
    schemaVersion: API_SCHEMA_VERSION,
    cacheControl: "no-store",
  };
}

function resolveNetworkMetadata(): CapabilityNetworkInfo {
  const network = NETWORK_SLUG_RE.test(STELLAR_NETWORK) ? STELLAR_NETWORK : "testnet";
  const caip2 = CAIP2_STELLAR_RE.test(X402_NETWORK)
    ? X402_NETWORK
    : `stellar:${network}`;
  const passphrase = NETWORK_PASSPHRASE.trim();
  if (!passphrase) {
    throw new Error("NETWORK_PASSPHRASE must be configured");
  }

  return {
    caip2,
    network,
    passphrase,
    addressKinds: ["G", "C"],
    nativeFeeAsset: {
      code: "XLM",
      decimals: 7,
    },
  };
}

function resolveAssetMetadata(overrideIssuer?: string): CapabilityAssetInfo {
  const issuer = (overrideIssuer ?? USDC_ISSUER).trim();
  if (!StrKey.isValidEd25519PublicKey(issuer)) {
    throw new Error("USDC issuer must be a valid Stellar public key");
  }

  return {
    code: USDC_CODE,
    symbol: USDC_SYMBOL,
    issuer,
    asset: `${USDC_CODE}:${issuer}`,
    decimals: USDC_DECIMALS,
    minStakeUsdc: MIN_STAKE_USDC,
  };
}

/**
 * Construct the deterministic public capability discovery document from live,
 * non-secret module constants and policy declarations.
 */
export function buildCapabilityDocument(
  options: BuildCapabilityDocumentOptions = {},
): CapabilityDocument {
  const schemaVersion = options.schemaVersion ?? CAPABILITY_SCHEMA_VERSION;
  if (
    !(SUPPORTED_CAPABILITY_SCHEMA_VERSIONS as readonly string[]).includes(schemaVersion)
  ) {
    throw new Error(`Unsupported capability schemaVersion: ${String(schemaVersion)}`);
  }

  const network = resolveNetworkMetadata();
  const asset = resolveAssetMetadata(options.usdcIssuer);
  const vsCacheControl = VS_CACHE_HEADERS["Cache-Control"];

  const endpoints: CapabilityEndpoint[] = [
    {
      id: "capabilities.get",
      path: CAPABILITIES_ROUTE,
      methods: ["GET"],
      category: "discovery",
      summary: "Versioned public API capability discovery document.",
      auth: "none",
      paymentRequired: false,
      rateLimit: {
        tier: "public_read",
        dimensions: [...TIER_POLICIES.public_read.limitDimensions],
        routeKey: CAPABILITIES_ROUTE,
      },
      schemaVersion,
      cacheControl: CAPABILITIES_CACHE_CONTROL,
    },
    makePublicReadEndpoint({
      id: "vs.list",
      path: "/api/vs",
      summary: "List public VS claims from the read index with cursor pagination.",
      cacheControl: vsCacheControl,
    }),
    makePublicReadEndpoint({
      id: "vs.get",
      path: "/api/vs/{id}",
      summary: "Fetch a single VS claim by ID, or unlock a private claim with an invite key.",
      cacheControl: vsCacheControl,
      auth: "none_or_invite",
      routeKey: "/api/vs/[id]?invite",
    }),
    makePublicReadEndpoint({
      id: "vs.reasoning.list",
      path: "/api/vs/{id}/reasoning",
      summary: "List the public agent reasoning timeline for a claim.",
      cacheControl: "s-maxage=15, stale-while-revalidate=60",
    }),
    makePublicReadEndpoint({
      id: "vs.council.get",
      path: "/api/vs/{id}/council",
      summary: "Fetch the AI council staking record and event proofs for a claim.",
      cacheControl: "public, s-maxage=20, stale-while-revalidate=60",
    }),
    makePublicReadEndpoint({
      id: "vs.events.stream",
      path: "/api/vs/{id}/events",
      summary: "Stream claim index update events over Server-Sent Events.",
      cacheControl: "no-cache, no-transform",
    }),
    makePublicReadEndpoint({
      id: "vs.user.list",
      path: "/api/vs/user/{address}",
      summary: "List public VS claims where a Stellar address is creator or challenger.",
      cacheControl: vsCacheControl,
    }),
    makePublicReadEndpoint({
      id: "challenge_opportunities.list",
      path: "/api/challenge-opportunities",
      summary: "List source-backed challenge and claim creation opportunities.",
      cacheControl: "s-maxage=600, stale-while-revalidate=300",
    }),
    makePublicReadEndpoint({
      id: "performance.get",
      path: "/api/performance/{address}",
      summary: "Cumulative realised P&L series and settled count for a Stellar address.",
      cacheControl: "s-maxage=30, stale-while-revalidate=120",
    }),
    makePublicReadEndpoint({
      id: "baskets.list",
      path: "/api/baskets",
      summary: "List user-composed agent baskets with active subscriber counts.",
      cacheControl: "no-store",
    }),
    makePublicReadEndpoint({
      id: "baskets.mirrors.list",
      path: "/api/baskets/mirrors",
      summary: "List pending copy-trade mirror positions for a subscriber address.",
      cacheControl: "no-store",
    }),
    makePublicReadEndpoint({
      id: "payments.revenue.get",
      path: "/api/payments/revenue",
      summary: "Live x402 payment revenue summary across paid endpoints.",
      cacheControl: "s-maxage=10, stale-while-revalidate=30",
    }),
    makePublicReadEndpoint({
      id: "research.manifest.get",
      path: "/api/research/manifest",
      summary: "Supported public research adapters and category policies.",
      cacheControl: "no-store",
    }),
    makePublicReadEndpoint({
      id: "share.card.get",
      path: "/api/share/{id}",
      summary: "Render a privacy-guarded SVG share card for a claim.",
      cacheControl: "public, s-maxage=60, stale-while-revalidate=300",
    }),
    makePublicReadEndpoint({
      id: "health.get",
      path: "/api/health",
      summary: "Operational health probe reporting worker heartbeats, sync age, backlog, and alarms.",
      cacheControl: "no-store",
    }),
    makePublicReadEndpoint({
      id: "health.status.get",
      path: "/api/health/status",
      summary: "Privacy-safe public operational status and deployment provenance summary.",
      cacheControl: "no-store",
    }),
    makePaidEndpoint({
      id: "x402.premium_price",
      path: "/api/premium/price",
      methods: ["GET"],
      summary: "Premium price oracle returning a reference price and timestamp over x402.",
      priceKey: "premiumPrice",
      recipientMode: "platform",
      network: network.caip2,
      asset: asset.asset,
    }),
    makePaidEndpoint({
      id: "x402.oracle",
      path: "/api/oracle",
      methods: ["POST"],
      summary: "Oracle-as-a-service verdict with confidence and SHA-256 evidence commitment.",
      priceKey: "oracle",
      recipientMode: "platform",
      network: network.caip2,
      asset: asset.asset,
    }),
    makePaidEndpoint({
      id: "x402.council_preflight",
      path: "/api/council/preflight",
      methods: ["POST"],
      summary: "Single-persona preflight review and quality score on a draft market.",
      priceKey: "councilPreflight",
      recipientMode: "persona",
      network: network.caip2,
      asset: asset.asset,
    }),
    makePaidEndpoint({
      id: "x402.council_reasoning",
      path: "/api/council/reasoning",
      methods: ["GET"],
      summary: "Single-persona reasoning read on an open claim (x402 or council pass).",
      priceKey: "councilReasoning",
      recipientMode: "persona",
      network: network.caip2,
      asset: asset.asset,
      passPlan: "council",
    }),
    makePaidEndpoint({
      id: "x402.council_vote",
      path: "/api/council/vote",
      methods: ["GET"],
      summary: "Single-persona structured verdict vote for settlement.",
      priceKey: "councilVote",
      recipientMode: "persona",
      network: network.caip2,
      asset: asset.asset,
    }),
    makePaidEndpoint({
      id: "x402.council_subscribe",
      path: "/api/council/subscribe",
      methods: ["POST"],
      summary: "Issue a short-lived signed council pass for reasoning reads.",
      priceKey: "councilSubscribe",
      recipientMode: "platform",
      network: network.caip2,
      asset: asset.asset,
    }),
    {
      id: "agents.v1.action",
      path: "/api/agents/v1/{action}",
      methods: ["POST"],
      category: "agent_api",
      summary: "Signed, replay-protected, idempotent BYOA agent API actions.",
      auth: "signed_envelope_or_api_key",
      paymentRequired: false,
      rateLimit: {
        tier: "registered_agent",
        dimensions: [...TIER_POLICIES.registered_agent.limitDimensions],
        routeKey: "/api/agents/v1/[action]",
      },
      schemaVersion: "v1",
      cacheControl: "no-store",
    },
  ];

  const doc: CapabilityDocument = {
    schemaVersion,
    apiSchemaVersion: API_SCHEMA_VERSION,
    supportedSchemaVersions: [...SUPPORTED_CAPABILITY_SCHEMA_VERSIONS],
    discoveryPath: CAPABILITIES_ROUTE,
    service: {
      name: "Mimir",
      domain: "prediction-market",
      agentApiVersion: "v1",
      schemaVersionHeader: SCHEMA_VERSION_HEADER,
    },
    network,
    asset,
    paymentProtocol: {
      protocol: "x402",
      version: 2,
      scheme: X402_SCHEME,
      network: network.caip2,
      asset: asset.asset,
      proofKind: "stellar-payment-v1",
      maxAgeMs: X402_PAYMENT_MAX_AGE_MS,
      headers: {
        paymentRequired: "PAYMENT-REQUIRED",
        paymentSignature: "PAYMENT-SIGNATURE",
        paymentResponse: "PAYMENT-RESPONSE",
      },
    },
    rateLimits: buildRateLimitsSummary(),
    endpoints,
  };

  return serializeCapabilityDocument(doc);
}

// ── Allowlist serializer & validator ──────────────────────────────────────────

function allowlistRateLimitTier(
  raw: CapabilityRateLimitTierSummary,
): CapabilityRateLimitTierSummary {
  return {
    tier: raw.tier,
    dimensions: [...raw.dimensions],
    rules: raw.rules.map((r) => ({
      dimension: r.dimension,
      limit: r.limit,
      windowMs: r.windowMs,
    })),
  };
}

function allowlistEndpoint(raw: CapabilityEndpoint): CapabilityEndpoint {
  const base: CapabilityEndpoint = {
    id: raw.id,
    path: raw.path,
    methods: [...raw.methods],
    category: raw.category,
    summary: raw.summary,
    auth: raw.auth,
    paymentRequired: raw.paymentRequired,
    rateLimit: {
      tier: raw.rateLimit.tier,
      dimensions: [...raw.rateLimit.dimensions],
      routeKey: raw.rateLimit.routeKey,
    },
    schemaVersion: raw.schemaVersion,
    cacheControl: raw.cacheControl,
  };

  if (raw.payment !== undefined) {
    base.payment = {
      protocol: raw.payment.protocol,
      scheme: raw.payment.scheme,
      network: raw.payment.network,
      asset: raw.payment.asset,
      priceUsd: raw.payment.priceUsd,
      priceAtomic: raw.payment.priceAtomic,
      recipientMode: raw.payment.recipientMode,
      ...(raw.payment.passPlan !== undefined ? { passPlan: raw.payment.passPlan } : {}),
    };
  }

  return base;
}

/**
 * Allowlist serializer + fail-closed redaction guard.
 *
 * Rejects any input containing denylisted keys, secret-shaped values, or
 * internal/admin routes before projecting ONLY explicitly allowlisted fields
 * into a fresh object and running {@link validateCapabilityDocument}.
 */
export function serializeCapabilityDocument(raw: unknown): CapabilityDocument {
  const redactionViolations: string[] = [];
  collectRedactionViolations(raw, "$", redactionViolations);
  if (redactionViolations.length > 0) {
    throw new CapabilityRedactionError(redactionViolations);
  }

  if (!isPlainObject(raw)) {
    throw new Error("Capability document must be an object");
  }

  const verdict = validateCapabilityDocument(raw);
  if (!verdict.ok) {
    throw new Error(`Invalid capability document: ${verdict.errors[0] ?? "validation failed"}`);
  }

  const doc = raw as unknown as CapabilityDocument;

  const serialized: CapabilityDocument = {
    schemaVersion: doc.schemaVersion,
    apiSchemaVersion: doc.apiSchemaVersion,
    supportedSchemaVersions: [...doc.supportedSchemaVersions],
    discoveryPath: doc.discoveryPath,
    service: {
      name: doc.service.name,
      domain: doc.service.domain,
      agentApiVersion: doc.service.agentApiVersion,
      schemaVersionHeader: doc.service.schemaVersionHeader,
    },
    network: {
      caip2: doc.network.caip2,
      network: doc.network.network,
      passphrase: doc.network.passphrase,
      addressKinds: [...doc.network.addressKinds],
      nativeFeeAsset: {
        code: doc.network.nativeFeeAsset.code,
        decimals: doc.network.nativeFeeAsset.decimals,
      },
    },
    asset: {
      code: doc.asset.code,
      symbol: doc.asset.symbol,
      issuer: doc.asset.issuer,
      asset: doc.asset.asset,
      decimals: doc.asset.decimals,
      minStakeUsdc: doc.asset.minStakeUsdc,
    },
    paymentProtocol: {
      protocol: doc.paymentProtocol.protocol,
      version: doc.paymentProtocol.version,
      scheme: doc.paymentProtocol.scheme,
      network: doc.paymentProtocol.network,
      asset: doc.paymentProtocol.asset,
      proofKind: doc.paymentProtocol.proofKind,
      maxAgeMs: doc.paymentProtocol.maxAgeMs,
      headers: {
        paymentRequired: doc.paymentProtocol.headers.paymentRequired,
        paymentSignature: doc.paymentProtocol.headers.paymentSignature,
        paymentResponse: doc.paymentProtocol.headers.paymentResponse,
      },
    },
    rateLimits: {
      publicRead: allowlistRateLimitTier(doc.rateLimits.publicRead),
      authenticatedUser: allowlistRateLimitTier(doc.rateLimits.authenticatedUser),
      registeredAgent: allowlistRateLimitTier(doc.rateLimits.registeredAgent),
      apiKeyAgent: allowlistRateLimitTier(doc.rateLimits.apiKeyAgent),
    },
    endpoints: doc.endpoints.map(allowlistEndpoint),
  };

  const postCheck = validateCapabilityDocument(serialized);
  if (!postCheck.ok) {
    throw new Error(`Serialized capability document invalid: ${postCheck.errors[0]}`);
  }

  return serialized;
}

const VALID_METHODS = new Set<string>(["GET", "POST", "PATCH", "DELETE"]);
const VALID_CATEGORIES = new Set<string>([
  "discovery",
  "public_read",
  "paid_x402",
  "agent_api",
]);
const VALID_AUTH = new Set<string>([
  "none",
  "none_or_invite",
  "x402",
  "x402_or_pass",
  "signed_envelope_or_api_key",
]);
const VALID_PUBLIC_TIERS = new Set<string>([
  "public_read",
  "authenticated_user",
  "registered_agent",
  "api_key_agent",
]);

/**
 * Pure structural, invariant, and privacy/redaction validator for a capability
 * discovery document. Returns all errors without throwing.
 */
export function validateCapabilityDocument(doc: unknown): CapabilityValidationResult {
  const errors: string[] = [];

  const shape = checkShape(doc, CAPABILITY_DOCUMENT_SPEC);
  errors.push(...shape.errors);
  for (const extra of shape.unexpected) {
    errors.push(`unexpected property "${extra}"`);
  }

  collectRedactionViolations(doc, "$", errors);

  if (!isPlainObject(doc)) {
    return { ok: false, errors };
  }

  if (
    !Array.isArray(doc.supportedSchemaVersions) ||
    doc.supportedSchemaVersions.length === 0 ||
    !doc.supportedSchemaVersions.every((v) => typeof v === "string")
  ) {
    errors.push("supportedSchemaVersions must be a non-empty array of strings");
  } else if (
    typeof doc.schemaVersion === "string" &&
    !doc.supportedSchemaVersions.includes(doc.schemaVersion)
  ) {
    errors.push("supportedSchemaVersions must include schemaVersion");
  }

  if (isPlainObject(doc.service)) {
    const svc = checkShape(doc.service, {
      name: { type: "string", required: true, oneOf: ["Mimir"] },
      domain: { type: "string", required: true, oneOf: ["prediction-market"] },
      agentApiVersion: { type: "string", required: true, oneOf: ["v1"] },
      schemaVersionHeader: { type: "string", required: true, oneOf: [SCHEMA_VERSION_HEADER] },
    });
    errors.push(...svc.errors.map((e) => `service.${e}`));
    svc.unexpected.forEach((k) => errors.push(`service: unexpected property "${k}"`));
  }

  if (isPlainObject(doc.network)) {
    const net = checkShape(doc.network, {
      caip2: { type: "string", required: true, min: 9, max: 64 },
      network: { type: "string", required: true, min: 1, max: 32 },
      passphrase: { type: "string", required: true, min: 1, max: 128 },
      addressKinds: { type: "array", required: true },
      nativeFeeAsset: { type: "object", required: true },
    });
    errors.push(...net.errors.map((e) => `network.${e}`));
    net.unexpected.forEach((k) => errors.push(`network: unexpected property "${k}"`));

    if (typeof doc.network.caip2 === "string" && !CAIP2_STELLAR_RE.test(doc.network.caip2)) {
      errors.push("network.caip2 must match stellar:<network>");
    }
    if (typeof doc.network.network === "string" && !NETWORK_SLUG_RE.test(doc.network.network)) {
      errors.push("network.network must be a lowercase alphanumeric/hyphen slug");
    }
    if (
      !Array.isArray(doc.network.addressKinds) ||
      doc.network.addressKinds.length === 0 ||
      !doc.network.addressKinds.every((k) => k === "G" || k === "C")
    ) {
      errors.push('network.addressKinds must contain only "G" and/or "C"');
    }
    if (isPlainObject(doc.network.nativeFeeAsset)) {
      const fee = checkShape(doc.network.nativeFeeAsset, {
        code: { type: "string", required: true, oneOf: ["XLM"] },
        decimals: { type: "integer", required: true, min: 7, max: 7 },
      });
      errors.push(...fee.errors.map((e) => `network.nativeFeeAsset.${e}`));
      fee.unexpected.forEach((k) =>
        errors.push(`network.nativeFeeAsset: unexpected property "${k}"`),
      );
    }
  }

  if (isPlainObject(doc.asset)) {
    const asset = checkShape(doc.asset, {
      code: { type: "string", required: true, oneOf: ["USDC"] },
      symbol: { type: "string", required: true, oneOf: ["USDC"] },
      issuer: { type: "string", required: true, min: 56, max: 56 },
      asset: { type: "string", required: true, min: 61, max: 61 },
      decimals: { type: "integer", required: true, min: 7, max: 7 },
      minStakeUsdc: { type: "number", required: true, min: 1 },
    });
    errors.push(...asset.errors.map((e) => `asset.${e}`));
    asset.unexpected.forEach((k) => errors.push(`asset: unexpected property "${k}"`));

    if (typeof doc.asset.issuer === "string" && !StrKey.isValidEd25519PublicKey(doc.asset.issuer)) {
      errors.push("asset.issuer must be a valid Stellar public key");
    }
    if (
      typeof doc.asset.code === "string" &&
      typeof doc.asset.issuer === "string" &&
      doc.asset.asset !== `${doc.asset.code}:${doc.asset.issuer}`
    ) {
      errors.push("asset.asset must equal <code>:<issuer>");
    }
  }

  if (isPlainObject(doc.paymentProtocol)) {
    const pp = checkShape(doc.paymentProtocol, {
      protocol: { type: "string", required: true, oneOf: ["x402"] },
      version: { type: "integer", required: true, min: 2, max: 2 },
      scheme: { type: "string", required: true, oneOf: ["exact"] },
      network: { type: "string", required: true, min: 9, max: 64 },
      asset: { type: "string", required: true, min: 61, max: 61 },
      proofKind: { type: "string", required: true, oneOf: ["stellar-payment-v1"] },
      maxAgeMs: { type: "integer", required: true, min: 1 },
      headers: { type: "object", required: true },
    });
    errors.push(...pp.errors.map((e) => `paymentProtocol.${e}`));
    pp.unexpected.forEach((k) => errors.push(`paymentProtocol: unexpected property "${k}"`));

    if (isPlainObject(doc.paymentProtocol.headers)) {
      const hdr = checkShape(doc.paymentProtocol.headers, {
        paymentRequired: { type: "string", required: true, oneOf: ["PAYMENT-REQUIRED"] },
        paymentSignature: { type: "string", required: true, oneOf: ["PAYMENT-SIGNATURE"] },
        paymentResponse: { type: "string", required: true, oneOf: ["PAYMENT-RESPONSE"] },
      });
      errors.push(...hdr.errors.map((e) => `paymentProtocol.headers.${e}`));
      hdr.unexpected.forEach((k) =>
        errors.push(`paymentProtocol.headers: unexpected property "${k}"`),
      );
    }
  }

  if (isPlainObject(doc.rateLimits)) {
    const rl = checkShape(doc.rateLimits, {
      publicRead: { type: "object", required: true },
      authenticatedUser: { type: "object", required: true },
      registeredAgent: { type: "object", required: true },
      apiKeyAgent: { type: "object", required: true },
    });
    errors.push(...rl.errors.map((e) => `rateLimits.${e}`));
    rl.unexpected.forEach((k) => errors.push(`rateLimits: unexpected property "${k}"`));

    const expectedTiers: Record<string, PublicCapabilityTier> = {
      publicRead: "public_read",
      authenticatedUser: "authenticated_user",
      registeredAgent: "registered_agent",
      apiKeyAgent: "api_key_agent",
    };
    for (const [key, expectedTier] of Object.entries(expectedTiers)) {
      const tierObj = doc.rateLimits[key];
      if (!isPlainObject(tierObj)) continue;
      const tierShape = checkShape(tierObj, {
        tier: { type: "string", required: true, oneOf: [expectedTier] },
        dimensions: { type: "array", required: true },
        rules: { type: "array", required: true },
      });
      errors.push(...tierShape.errors.map((e) => `rateLimits.${key}.${e}`));
      tierShape.unexpected.forEach((k) =>
        errors.push(`rateLimits.${key}: unexpected property "${k}"`),
      );
      if (
        !Array.isArray(tierObj.dimensions) ||
        tierObj.dimensions.length === 0 ||
        !tierObj.dimensions.every(
          (d) => typeof d === "string" && ["ip", "wallet", "agent", "route"].includes(d),
        )
      ) {
        errors.push(`rateLimits.${key}.dimensions must be a non-empty array of valid limit dimensions`);
      }
      if (!Array.isArray(tierObj.rules)) {
        errors.push(`rateLimits.${key}.rules must be an array`);
      } else {
        tierObj.rules.forEach((ruleItem, ruleIndex) => {
          const ruleShape = checkShape(ruleItem, {
            dimension: { type: "string", required: true, oneOf: ["ip", "wallet", "agent", "route"] },
            limit: { type: "integer", required: true, min: 1 },
            windowMs: { type: "integer", required: true, min: 1 },
          });
          errors.push(
            ...ruleShape.errors.map((e) => `rateLimits.${key}.rules[${ruleIndex}].${e}`),
          );
          ruleShape.unexpected.forEach((k) =>
            errors.push(`rateLimits.${key}.rules[${ruleIndex}]: unexpected property "${k}"`),
          );
        });
      }
    }
  }

  if (Array.isArray(doc.endpoints)) {
    if (doc.endpoints.length === 0) {
      errors.push("endpoints must not be empty");
    }
    const seenIds = new Set<string>();
    doc.endpoints.forEach((ep, idx) => {
      const prefix = `endpoints[${idx}]`;
      if (!isPlainObject(ep)) {
        errors.push(`${prefix} must be an object`);
        return;
      }
      const epShape = checkShape(ep, {
        id: { type: "string", required: true, min: 1, max: 100 },
        path: { type: "string", required: true, min: 1, max: 200 },
        methods: { type: "array", required: true },
        category: { type: "string", required: true, oneOf: [...VALID_CATEGORIES] },
        summary: { type: "string", required: true, min: 1, max: 300 },
        auth: { type: "string", required: true, oneOf: [...VALID_AUTH] },
        paymentRequired: { type: "boolean", required: true },
        payment: { type: "object", required: false },
        rateLimit: { type: "object", required: true },
        schemaVersion: {
          type: typeof ep.schemaVersion === "number" ? "integer" : "string",
          required: true,
          min: 1,
        },
        cacheControl: { type: "string", required: true, min: 1, max: 120 },
      });
      errors.push(...epShape.errors.map((e) => `${prefix}.${e}`));
      epShape.unexpected.forEach((k) => errors.push(`${prefix}: unexpected property "${k}"`));

      if (typeof ep.id === "string") {
        if (seenIds.has(ep.id)) errors.push(`${prefix}.id "${ep.id}" is duplicated`);
        seenIds.add(ep.id);
      }

      if (typeof ep.path === "string") {
        const epPath = ep.path;
        if (!epPath.startsWith("/api/")) {
          errors.push(`${prefix}.path must start with /api/`);
        }
        if (FORBIDDEN_ENDPOINT_PATH_PREFIXES.some((banned) => epPath === banned || epPath.startsWith(`${banned}/`))) {
          errors.push(`${prefix}.path "${epPath}" exposes a private/admin route`);
        }
      }

      if (!Array.isArray(ep.methods) || ep.methods.length === 0 || !ep.methods.every((m) => typeof m === "string" && VALID_METHODS.has(m))) {
        errors.push(`${prefix}.methods must be a non-empty array of HTTP methods`);
      }

      if (isPlainObject(ep.rateLimit)) {
        const rlShape = checkShape(ep.rateLimit, {
          tier: { type: "string", required: true, oneOf: [...VALID_PUBLIC_TIERS] },
          dimensions: { type: "array", required: true },
          routeKey: { type: "string", required: true, min: 1, max: 200 },
        });
        errors.push(...rlShape.errors.map((e) => `${prefix}.rateLimit.${e}`));
        rlShape.unexpected.forEach((k) =>
          errors.push(`${prefix}.rateLimit: unexpected property "${k}"`),
        );
      }

      if (ep.paymentRequired === true) {
        if (!isPlainObject(ep.payment)) {
          errors.push(`${prefix}.payment is required when paymentRequired is true`);
        } else {
          const payShape = checkShape(ep.payment, {
            protocol: { type: "string", required: true, oneOf: ["x402-v2"] },
            scheme: { type: "string", required: true, oneOf: ["exact"] },
            network: { type: "string", required: true, min: 9, max: 64 },
            asset: { type: "string", required: true, min: 61, max: 61 },
            priceUsd: { type: "string", required: true, min: 2, max: 32 },
            priceAtomic: { type: "string", required: true, min: 1, max: 32 },
            recipientMode: { type: "string", required: true, oneOf: ["platform", "persona"] },
            passPlan: { type: "string", required: false, oneOf: ["council"] },
          });
          errors.push(...payShape.errors.map((e) => `${prefix}.payment.${e}`));
          payShape.unexpected.forEach((k) =>
            errors.push(`${prefix}.payment: unexpected property "${k}"`),
          );
          if (typeof ep.payment.priceAtomic === "string" && !/^[1-9]\d*$/.test(ep.payment.priceAtomic)) {
            errors.push(`${prefix}.payment.priceAtomic must be a positive decimal integer string`);
          }
        }
      } else if (ep.payment !== undefined) {
        errors.push(`${prefix}.payment must be omitted when paymentRequired is false`);
      }
    });
  }

  return { ok: errors.length === 0, errors };
}

export function computeCapabilityEtag(serializedJson: string, schemaVersion: string): string {
  const digest = createHash("sha256").update(serializedJson).digest("hex").slice(0, 16);
  return `W/"${schemaVersion}-${digest}"`;
}
