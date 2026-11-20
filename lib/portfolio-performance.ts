import type {
  AgentTradeResult,
  AgentTradeRole,
  PerformanceWindow,
  PnlPoint,
  TradeOutcome,
} from "@/lib/agents/performance";
import { isHash32Hex, sha256Hex } from "@/lib/content-hash";
import { USDC_DECIMALS, USDC_SYMBOL, USDC_UNIT, formatAtomicUsdc } from "@/lib/usdc";
import type { VSCacheFreshness } from "@/lib/vs-freshness";

export const PORTFOLIO_STATEMENT_SCHEMA_VERSION = 1 as const;
export const PORTFOLIO_STATEMENT_DIGEST_ALGORITHM = "sha256" as const;

export const PORTFOLIO_STATEMENT_PRICE_CONVENTIONS = {
  asset: USDC_SYMBOL,
  decimals: USDC_DECIMALS,
  unit: "atomic",
  realizedPnlBasis: "settled_only",
  rounding: "exact_integer",
} as const;

export interface PortfolioStatementPriceConventions {
  asset: typeof USDC_SYMBOL;
  decimals: typeof USDC_DECIMALS;
  unit: "atomic";
  realizedPnlBasis: "settled_only";
  rounding: "exact_integer";
}

export interface PortfolioStatementPosition {
  claimId: number;
  role: AgentTradeRole;
  outcome: TradeOutcome;
  /** Milliseconds; 0 or update time for open positions, settlement time for settled positions. */
  settledAt: number;
  /** Non-negative integer atomic USDC (7 decimals), serialized as a decimal string. */
  stakeAtomic: string;
  /** Signed integer atomic USDC (7 decimals), serialized as a decimal string. */
  realizedPnlAtomic: string;
}

export interface PortfolioStatementCoverage {
  source: VSCacheFreshness["source"];
  status: VSCacheFreshness["status"];
  lastUpdatedAt: string | null;
  freshnessWindowMs: number;
  windowSinceMs: number | null;
  earliestSettledAt: number | null;
  latestSettledAt: number | null;
  totalPositions: number;
  settledPositions: number;
  openPositions: number;
}

export interface PortfolioStatementTotals {
  /** Exact sum of realizedPnlAtomic across settled positions in the window (atomic USDC). */
  realizedPnlAtomic: string;
  /** Exact sum of stakeAtomic across open positions (atomic USDC). */
  openExposureAtomic: string;
  /** Exact sum of stakeAtomic across all positions in the statement (atomic USDC). */
  volumeAtomic: string;
  settled: number;
  wins: number;
  losses: number;
  refunds: number;
}

export interface PortfolioPerformanceStatementManifest {
  schemaVersion: typeof PORTFOLIO_STATEMENT_SCHEMA_VERSION;
  address: string;
  priceConventions: PortfolioStatementPriceConventions;
  coverage: PortfolioStatementCoverage;
  totals: PortfolioStatementTotals;
  positions: PortfolioStatementPosition[];
  digestAlgorithm: typeof PORTFOLIO_STATEMENT_DIGEST_ALGORITHM;
  /** 64-character lowercase SHA-256 hex digest over canonical statement payload. */
  digest: string;
}

export type PortfolioPerformanceStatementPayload = Omit<
  PortfolioPerformanceStatementManifest,
  "digest" | "digestAlgorithm"
>;

export interface PortfolioPerformanceManifestVerification {
  ok: boolean;
  expectedDigest: string;
  computedDigest: string;
  recomputedTotals: {
    realizedPnlAtomic: bigint;
    openExposureAtomic: bigint;
    volumeAtomic: bigint;
    settled: number;
    wins: number;
    losses: number;
    refunds: number;
    open: number;
  };
  errors: string[];
}

export interface BuildPortfolioPerformanceManifestInput {
  address: string;
  results: readonly AgentTradeResult[];
  cache: VSCacheFreshness;
  window?: PerformanceWindow;
}

export interface PortfolioPerformanceResponse {
  points: PnlPoint[];
  settled: number;
  cache: VSCacheFreshness;
  /** Reproducible statement manifest binding positions, price conventions, and coverage to a digest. */
  manifest?: PortfolioPerformanceStatementManifest;
}

const SIGNED_INTEGER_RE = /^-?\d+$/;
const UNSIGNED_INTEGER_RE = /^\d+$/;

function isValidRole(value: unknown): value is AgentTradeRole {
  return value === "creator" || value === "challenger";
}

function isValidOutcome(value: unknown): value is TradeOutcome {
  return value === "won" || value === "lost" || value === "refunded" || value === "open";
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isCanonicalJsonValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => isCanonicalJsonValue(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${isCanonicalJsonValue(entryValue)}`)
    .join(",")}}`;
}

/**
 * Compute the deterministic SHA-256 hex digest over a statement payload.
 * Keys are sorted recursively so equivalent objects always hash identically.
 */
export function computePortfolioPerformanceManifestDigest(
  payload: PortfolioPerformanceStatementPayload,
): string {
  return sha256Hex(isCanonicalJsonValue(payload));
}

function comparePositions(
  a: PortfolioStatementPosition,
  b: PortfolioStatementPosition,
): number {
  if (a.settledAt !== b.settledAt) return a.settledAt - b.settledAt;
  if (a.claimId !== b.claimId) return a.claimId - b.claimId;
  if (a.role !== b.role) return a.role < b.role ? -1 : 1;
  if (a.outcome !== b.outcome) return a.outcome < b.outcome ? -1 : 1;
  if (a.stakeAtomic !== b.stakeAtomic) return a.stakeAtomic < b.stakeAtomic ? -1 : 1;
  return a.realizedPnlAtomic < b.realizedPnlAtomic
    ? -1
    : a.realizedPnlAtomic > b.realizedPnlAtomic
      ? 1
      : 0;
}

/**
 * Build a reproducible portfolio performance statement manifest from classified
 * trade results and observation freshness metadata.
 *
 * All monetary accounting stays in exact integer atomic USDC (7 decimals).
 */
export function buildPortfolioPerformanceManifest({
  address,
  results,
  cache,
  window = {},
}: BuildPortfolioPerformanceManifestInput): PortfolioPerformanceStatementManifest {
  const since = window.sinceMs;
  const windowSinceMs =
    typeof since === "number" && Number.isFinite(since) && since >= 0 ? since : null;

  const positions: PortfolioStatementPosition[] = [];
  let realizedPnlAtomic = 0n;
  let openExposureAtomic = 0n;
  let volumeAtomic = 0n;
  let settled = 0;
  let wins = 0;
  let losses = 0;
  let refunds = 0;
  let openPositions = 0;
  let earliestSettledAt: number | null = null;
  let latestSettledAt: number | null = null;

  for (const result of results) {
    if (result.outcome !== "open" && windowSinceMs !== null && result.settledAt < windowSinceMs) {
      continue;
    }

    const realized = result.outcome === "open" ? 0n : result.pnlAtomic;
    positions.push({
      claimId: result.claimId,
      role: result.role,
      outcome: result.outcome,
      settledAt: result.settledAt,
      stakeAtomic: result.stakeAtomic.toString(),
      realizedPnlAtomic: realized.toString(),
    });

    volumeAtomic += result.stakeAtomic;

    if (result.outcome === "open") {
      openPositions += 1;
      openExposureAtomic += result.stakeAtomic;
      continue;
    }

    settled += 1;
    realizedPnlAtomic += realized;
    if (result.outcome === "won") wins += 1;
    else if (result.outcome === "lost") losses += 1;
    else refunds += 1;

    if (earliestSettledAt === null || result.settledAt < earliestSettledAt) {
      earliestSettledAt = result.settledAt;
    }
    if (latestSettledAt === null || result.settledAt > latestSettledAt) {
      latestSettledAt = result.settledAt;
    }
  }

  positions.sort(comparePositions);

  const payload: PortfolioPerformanceStatementPayload = {
    schemaVersion: PORTFOLIO_STATEMENT_SCHEMA_VERSION,
    address,
    priceConventions: { ...PORTFOLIO_STATEMENT_PRICE_CONVENTIONS },
    coverage: {
      source: cache.source,
      status: cache.status,
      lastUpdatedAt: cache.lastUpdatedAt,
      freshnessWindowMs: cache.freshnessWindowMs,
      windowSinceMs,
      earliestSettledAt,
      latestSettledAt,
      totalPositions: positions.length,
      settledPositions: settled,
      openPositions,
    },
    totals: {
      realizedPnlAtomic: realizedPnlAtomic.toString(),
      openExposureAtomic: openExposureAtomic.toString(),
      volumeAtomic: volumeAtomic.toString(),
      settled,
      wins,
      losses,
      refunds,
    },
    positions,
  };

  return {
    ...payload,
    digestAlgorithm: PORTFOLIO_STATEMENT_DIGEST_ALGORITHM,
    digest: computePortfolioPerformanceManifestDigest(payload),
  };
}

/**
 * Independently verify a portfolio performance statement manifest without
 * relying on chart rendering or floating-point display series.
 */
export function verifyPortfolioPerformanceManifest(
  manifest: PortfolioPerformanceStatementManifest,
  options: { points?: readonly PnlPoint[] } = {},
): PortfolioPerformanceManifestVerification {
  const errors: string[] = [];

  if (manifest.schemaVersion !== PORTFOLIO_STATEMENT_SCHEMA_VERSION) {
    errors.push(`Unsupported schemaVersion: ${String(manifest.schemaVersion)}`);
  }
  if (typeof manifest.address !== "string" || manifest.address.trim().length === 0) {
    errors.push("Manifest address must be a non-empty string");
  }
  if (manifest.digestAlgorithm !== PORTFOLIO_STATEMENT_DIGEST_ALGORITHM) {
    errors.push(`Unsupported digestAlgorithm: ${String(manifest.digestAlgorithm)}`);
  }
  if (!isHash32Hex(manifest.digest) || manifest.digest !== manifest.digest.toLowerCase()) {
    errors.push("Manifest digest must be a 64-character lowercase hex SHA-256 string");
  }

  const pc = manifest.priceConventions;
  if (
    !pc ||
    pc.asset !== PORTFOLIO_STATEMENT_PRICE_CONVENTIONS.asset ||
    pc.decimals !== PORTFOLIO_STATEMENT_PRICE_CONVENTIONS.decimals ||
    pc.unit !== PORTFOLIO_STATEMENT_PRICE_CONVENTIONS.unit ||
    pc.realizedPnlBasis !== PORTFOLIO_STATEMENT_PRICE_CONVENTIONS.realizedPnlBasis ||
    pc.rounding !== PORTFOLIO_STATEMENT_PRICE_CONVENTIONS.rounding
  ) {
    errors.push("Manifest priceConventions do not match atomic 7-decimal USDC settled-only rules");
  }

  let realizedPnlAtomic = 0n;
  let openExposureAtomic = 0n;
  let volumeAtomic = 0n;
  let settled = 0;
  let wins = 0;
  let losses = 0;
  let refunds = 0;
  let open = 0;
  let earliestSettledAt: number | null = null;
  let latestSettledAt: number | null = null;

  for (let i = 0; i < manifest.positions.length; i += 1) {
    const pos = manifest.positions[i];
    if (!UNSIGNED_INTEGER_RE.test(pos.stakeAtomic)) {
      errors.push(`Position ${i} has invalid stakeAtomic: ${String(pos.stakeAtomic)}`);
      continue;
    }
    if (!SIGNED_INTEGER_RE.test(pos.realizedPnlAtomic)) {
      errors.push(`Position ${i} has invalid realizedPnlAtomic: ${String(pos.realizedPnlAtomic)}`);
      continue;
    }

    const stake = BigInt(pos.stakeAtomic);
    const realized = BigInt(pos.realizedPnlAtomic);
    volumeAtomic += stake;

    if (pos.outcome === "open") {
      open += 1;
      openExposureAtomic += stake;
      if (realized !== 0n) {
        errors.push(`Open position ${pos.claimId} must have realizedPnlAtomic of 0`);
      }
      continue;
    }

    if (
      manifest.coverage.windowSinceMs !== null &&
      pos.settledAt < manifest.coverage.windowSinceMs
    ) {
      errors.push(
        `Settled position ${pos.claimId} settledAt ${pos.settledAt} precedes windowSinceMs ${manifest.coverage.windowSinceMs}`,
      );
    }

    settled += 1;
    realizedPnlAtomic += realized;
    if (pos.outcome === "won") wins += 1;
    else if (pos.outcome === "lost") losses += 1;
    else {
      refunds += 1;
      if (realized !== 0n) {
        errors.push(`Refunded position ${pos.claimId} must have realizedPnlAtomic of 0`);
      }
    }

    if (earliestSettledAt === null || pos.settledAt < earliestSettledAt) {
      earliestSettledAt = pos.settledAt;
    }
    if (latestSettledAt === null || pos.settledAt > latestSettledAt) {
      latestSettledAt = pos.settledAt;
    }
  }

  if (manifest.totals.realizedPnlAtomic !== realizedPnlAtomic.toString()) {
    errors.push(
      `realizedPnlAtomic mismatch: manifest=${manifest.totals.realizedPnlAtomic}, recomputed=${realizedPnlAtomic.toString()}`,
    );
  }
  if (manifest.totals.openExposureAtomic !== openExposureAtomic.toString()) {
    errors.push(
      `openExposureAtomic mismatch: manifest=${manifest.totals.openExposureAtomic}, recomputed=${openExposureAtomic.toString()}`,
    );
  }
  if (manifest.totals.volumeAtomic !== volumeAtomic.toString()) {
    errors.push(
      `volumeAtomic mismatch: manifest=${manifest.totals.volumeAtomic}, recomputed=${volumeAtomic.toString()}`,
    );
  }
  if (manifest.totals.settled !== settled) {
    errors.push(`settled count mismatch: manifest=${manifest.totals.settled}, recomputed=${settled}`);
  }
  if (manifest.totals.wins !== wins) {
    errors.push(`wins count mismatch: manifest=${manifest.totals.wins}, recomputed=${wins}`);
  }
  if (manifest.totals.losses !== losses) {
    errors.push(`losses count mismatch: manifest=${manifest.totals.losses}, recomputed=${losses}`);
  }
  if (manifest.totals.refunds !== refunds) {
    errors.push(`refunds count mismatch: manifest=${manifest.totals.refunds}, recomputed=${refunds}`);
  }

  if (manifest.coverage.totalPositions !== manifest.positions.length) {
    errors.push(
      `coverage.totalPositions mismatch: manifest=${manifest.coverage.totalPositions}, actual=${manifest.positions.length}`,
    );
  }
  if (manifest.coverage.settledPositions !== settled) {
    errors.push(
      `coverage.settledPositions mismatch: manifest=${manifest.coverage.settledPositions}, actual=${settled}`,
    );
  }
  if (manifest.coverage.openPositions !== open) {
    errors.push(
      `coverage.openPositions mismatch: manifest=${manifest.coverage.openPositions}, actual=${open}`,
    );
  }
  if (manifest.coverage.earliestSettledAt !== earliestSettledAt) {
    errors.push(
      `coverage.earliestSettledAt mismatch: manifest=${String(manifest.coverage.earliestSettledAt)}, actual=${String(earliestSettledAt)}`,
    );
  }
  if (manifest.coverage.latestSettledAt !== latestSettledAt) {
    errors.push(
      `coverage.latestSettledAt mismatch: manifest=${String(manifest.coverage.latestSettledAt)}, actual=${String(latestSettledAt)}`,
    );
  }

  if (options.points) {
    if (options.points.length !== settled) {
      errors.push(
        `points length (${options.points.length}) does not match settled positions (${settled})`,
      );
    } else if (options.points.length > 0) {
      const lastPointValue = options.points[options.points.length - 1].value;
      const expectedDisplay = Number(realizedPnlAtomic) / Number(USDC_UNIT);
      if (Math.abs(lastPointValue - expectedDisplay) > 1e-7) {
        errors.push(
          `final chart point (${lastPointValue}) diverges from exact realized total (${formatAtomicUsdc(realizedPnlAtomic)} USDC)`,
        );
      }
    }
  }

  const payload: PortfolioPerformanceStatementPayload = {
    schemaVersion: manifest.schemaVersion,
    address: manifest.address,
    priceConventions: manifest.priceConventions,
    coverage: manifest.coverage,
    totals: manifest.totals,
    positions: manifest.positions,
  };
  const computedDigest = computePortfolioPerformanceManifestDigest(payload);
  if (computedDigest !== manifest.digest) {
    errors.push(
      `digest mismatch: manifest=${manifest.digest}, computed=${computedDigest}`,
    );
  }

  return {
    ok: errors.length === 0,
    expectedDigest: manifest.digest,
    computedDigest,
    recomputedTotals: {
      realizedPnlAtomic,
      openExposureAtomic,
      volumeAtomic,
      settled,
      wins,
      losses,
      refunds,
      open,
    },
    errors,
  };
}

export function isPortfolioPerformanceStatementManifest(
  value: unknown,
): value is PortfolioPerformanceStatementManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Record<string, unknown>;

  if (manifest.schemaVersion !== PORTFOLIO_STATEMENT_SCHEMA_VERSION) return false;
  if (typeof manifest.address !== "string" || manifest.address.trim().length === 0) return false;
  if (manifest.digestAlgorithm !== PORTFOLIO_STATEMENT_DIGEST_ALGORITHM) return false;
  if (
    typeof manifest.digest !== "string" ||
    !isHash32Hex(manifest.digest) ||
    manifest.digest !== manifest.digest.toLowerCase()
  ) {
    return false;
  }

  if (!manifest.priceConventions || typeof manifest.priceConventions !== "object") return false;
  const pc = manifest.priceConventions as Record<string, unknown>;
  if (
    pc.asset !== PORTFOLIO_STATEMENT_PRICE_CONVENTIONS.asset ||
    pc.decimals !== PORTFOLIO_STATEMENT_PRICE_CONVENTIONS.decimals ||
    pc.unit !== PORTFOLIO_STATEMENT_PRICE_CONVENTIONS.unit ||
    pc.realizedPnlBasis !== PORTFOLIO_STATEMENT_PRICE_CONVENTIONS.realizedPnlBasis ||
    pc.rounding !== PORTFOLIO_STATEMENT_PRICE_CONVENTIONS.rounding
  ) {
    return false;
  }

  if (!manifest.coverage || typeof manifest.coverage !== "object") return false;
  const cov = manifest.coverage as Record<string, unknown>;
  if (
    (cov.source !== "index" && cov.source !== "contract") ||
    (cov.status !== "live" && cov.status !== "cached" && cov.status !== "stale") ||
    (cov.lastUpdatedAt !== null && typeof cov.lastUpdatedAt !== "string") ||
    typeof cov.freshnessWindowMs !== "number" ||
    !Number.isFinite(cov.freshnessWindowMs) ||
    cov.freshnessWindowMs <= 0 ||
    (cov.windowSinceMs !== null && !isNonNegativeInt(cov.windowSinceMs)) ||
    (cov.earliestSettledAt !== null && !isNonNegativeInt(cov.earliestSettledAt)) ||
    (cov.latestSettledAt !== null && !isNonNegativeInt(cov.latestSettledAt)) ||
    !isNonNegativeInt(cov.totalPositions) ||
    !isNonNegativeInt(cov.settledPositions) ||
    !isNonNegativeInt(cov.openPositions)
  ) {
    return false;
  }

  if (!manifest.totals || typeof manifest.totals !== "object") return false;
  const totals = manifest.totals as Record<string, unknown>;
  if (
    typeof totals.realizedPnlAtomic !== "string" ||
    !SIGNED_INTEGER_RE.test(totals.realizedPnlAtomic) ||
    typeof totals.openExposureAtomic !== "string" ||
    !UNSIGNED_INTEGER_RE.test(totals.openExposureAtomic) ||
    typeof totals.volumeAtomic !== "string" ||
    !UNSIGNED_INTEGER_RE.test(totals.volumeAtomic) ||
    !isNonNegativeInt(totals.settled) ||
    !isNonNegativeInt(totals.wins) ||
    !isNonNegativeInt(totals.losses) ||
    !isNonNegativeInt(totals.refunds)
  ) {
    return false;
  }

  if (!Array.isArray(manifest.positions)) return false;
  return manifest.positions.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const pos = entry as Record<string, unknown>;
    return (
      isNonNegativeInt(pos.claimId) &&
      isValidRole(pos.role) &&
      isValidOutcome(pos.outcome) &&
      isNonNegativeInt(pos.settledAt) &&
      typeof pos.stakeAtomic === "string" &&
      UNSIGNED_INTEGER_RE.test(pos.stakeAtomic) &&
      typeof pos.realizedPnlAtomic === "string" &&
      SIGNED_INTEGER_RE.test(pos.realizedPnlAtomic)
    );
  });
}

function isCacheFreshness(value: unknown): value is VSCacheFreshness {
  if (!value || typeof value !== "object") return false;
  const cache = value as Record<string, unknown>;
  return (
    (cache.source === "index" || cache.source === "contract") &&
    (cache.status === "live" || cache.status === "cached" || cache.status === "stale") &&
    (cache.lastUpdatedAt === null || typeof cache.lastUpdatedAt === "string") &&
    (cache.ageMs === null ||
      (typeof cache.ageMs === "number" && Number.isFinite(cache.ageMs) && cache.ageMs >= 0)) &&
    typeof cache.freshnessWindowMs === "number" &&
    Number.isFinite(cache.freshnessWindowMs) &&
    cache.freshnessWindowMs > 0
  );
}

/**
 * Browser boundary guard for the portfolio performance endpoint.
 *
 * A malformed monetary point must fail closed rather than become an SVG NaN or
 * look like a legitimate zero. The server still performs all accounting in
 * atomic USDC; only the display series crosses this boundary as numbers.
 */
export function isPortfolioPerformanceResponse(
  value: unknown,
): value is PortfolioPerformanceResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  if (
    typeof response.settled !== "number" ||
    !Number.isInteger(response.settled) ||
    response.settled < 0
  ) return false;
  if (!Array.isArray(response.points) || !isCacheFreshness(response.cache)) return false;

  const pointsValid = response.points.every((point) => {
    if (!point || typeof point !== "object") return false;
    const item = point as Record<string, unknown>;
    return (
      typeof item.timestamp === "number" &&
      Number.isFinite(item.timestamp) &&
      item.timestamp > 0 &&
      typeof item.value === "number" &&
      Number.isFinite(item.value)
    );
  });
  if (!pointsValid) return false;

  if (response.manifest !== undefined) {
    if (!isPortfolioPerformanceStatementManifest(response.manifest)) return false;
    const verification = verifyPortfolioPerformanceManifest(response.manifest, {
      points: response.points as PnlPoint[],
    });
    if (!verification.ok) return false;
  }

  return true;
}
