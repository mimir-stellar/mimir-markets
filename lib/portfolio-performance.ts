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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`)
    .join(",")}}`;
}

/**
 * Compute the deterministic SHA-256 hex digest over a statement payload.
 * Keys are sorted recursively so equivalent objects always hash identically.
 */
export function computePortfolioPerformanceManifestDigest(
  payload: PortfolioPerformanceStatementPayload,
): string {
  return sha256Hex(canonicalJson(payload));
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

/**
 * A reviewed, fixed snapshot of portfolio performance.
 *
 * Used for historical comparison against other snapshots or benchmarks.
 * Because a snapshot is immutable once reviewed, it carries an explicit
 * `id` or label, the frozen timestamp at which it was captured,
 * and the metric definition it was evaluated under.
 */
export interface PortfolioSnapshot {
  id: string;
  label: string;
  capturedAt: number;
  metric: "realised_pnl_usdc" | "cumulative_pnl_usdc";
  points: PnlPoint[];
  settled: number;
  /** When true, live portfolio refetches or polling cannot mutate this snapshot. */
  frozen: boolean;
}

/**
 * A comparison payload containing multiple fixed snapshots evaluated under
 * the identical metric definition.
 */
export interface PortfolioSnapshotComparison {
  metric: "realised_pnl_usdc" | "cumulative_pnl_usdc";
  snapshots: PortfolioSnapshot[];
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

function isValidPnlPoint(point: unknown): point is PnlPoint {
  if (!point || typeof point !== "object") return false;
  const item = point as Record<string, unknown>;
  return (
    typeof item.timestamp === "number" &&
    Number.isFinite(item.timestamp) &&
    item.timestamp > 0 &&
    typeof item.value === "number" &&
    Number.isFinite(item.value)
  );
}

/**
 * Deduce the explicit performance state without inventing zero returns.
 *
 * - "unavailable": malformed data, non-finite values or timestamps.
 * - "insufficient-history": no settled trades or zero points.
 * - "available": at least one valid settled performance sample.
 */
export function resolvePerformanceState(
  points?: Array<{ timestamp?: number; value?: number | null } | null> | null,
  settled?: number | null,
): PerformanceState {
  if (settled !== undefined && settled !== null) {
    if (!Number.isFinite(settled) || settled < 0) return "unavailable";
    if (settled === 0) return "insufficient-history";
  }
  if (!points || !Array.isArray(points) || points.length === 0) {
    return "insufficient-history";
  }
  const hasInvalid = points.some((p) => {
    if (!p || typeof p !== "object") return true;
    if (typeof p.timestamp !== "number" || !Number.isFinite(p.timestamp) || p.timestamp <= 0) {
      return true;
    }
    if (p.value !== null && p.value !== undefined && !Number.isFinite(p.value)) {
      return true;
    }
    return false;
  });
  if (hasInvalid) return "unavailable";

  const hasFiniteValue = points.some(
    (p) => p && typeof p.value === "number" && Number.isFinite(p.value),
  );
  if (!hasFiniteValue) {
    return "insufficient-history";
  }

  return "available";
}

/**
 * Performance reducer that derives an explicit PortfolioPerformanceResponse
 * from settled points without inventing zero returns for missing history.
 */
export function reducePortfolioPerformance({
  points,
  settled,
  cache,
}: {
  points: PnlPoint[];
  settled: number;
  cache: VSCacheFreshness;
}): PortfolioPerformanceResponse {
  const state = resolvePerformanceState(points, settled);
  return {
    points,
    settled,
    cache,
    state,
  };
}

/**
 * Browser boundary guard for the portfolio performance endpoint.
 *
 * A malformed monetary point must fail closed rather than become an SVG NaN or
 * look like a legitimate zero. The server still performs all accounting in
 * atomic USDC; only the display series crosses this boundary as canonical
 * numeric floats.
 *
 * Invariant:
 * Localized display strings are strictly presentation-only and must never be
 * accepted as performance inputs or parsed back into money arithmetic. Canonical
 * numeric values are preserved across locale switches.
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

  return response.points.every(isValidPnlPoint);
}

/**
 * Type guard for a single fixed portfolio snapshot.
 */
export function isPortfolioSnapshot(value: unknown): value is PortfolioSnapshot {
  if (!value || typeof value !== "object") return false;
  const snap = value as Record<string, unknown>;
  if (
    typeof snap.id !== "string" ||
    snap.id.trim().length === 0 ||
    typeof snap.label !== "string" ||
    typeof snap.capturedAt !== "number" ||
    !Number.isFinite(snap.capturedAt) ||
    snap.capturedAt <= 0 ||
    (snap.metric !== "realised_pnl_usdc" && snap.metric !== "cumulative_pnl_usdc") ||
    typeof snap.settled !== "number" ||
    !Number.isInteger(snap.settled) ||
    snap.settled < 0 ||
    typeof snap.frozen !== "boolean" ||
    !Array.isArray(snap.points)
  ) {
    return false;
  }
  return snap.points.every(isValidPnlPoint);
}

/**
 * Type guard for a multi-snapshot portfolio comparison.
 *
 * Verifies that all snapshots share the exact same metric definition and each snapshot
 * is validly structured and frozen.
 */
export function isPortfolioSnapshotComparison(
  value: unknown,
): value is PortfolioSnapshotComparison {
  if (!value || typeof value !== "object") return false;
  const comp = value as Record<string, unknown>;
  if (
    (comp.metric !== "realised_pnl_usdc" && comp.metric !== "cumulative_pnl_usdc") ||
    !Array.isArray(comp.snapshots)
  ) {
    return false;
  }
  return comp.snapshots.every(
    (s) => isPortfolioSnapshot(s) && s.metric === comp.metric,
  );
}

/**
 * Creates an immutable, frozen snapshot from a portfolio performance response or point series.
 */
export function freezePortfolioSnapshot(
  id: string,
  label: string,
  source: { points: PnlPoint[]; settled?: number },
  opts: {
    capturedAt?: number;
    metric?: "realised_pnl_usdc" | "cumulative_pnl_usdc";
  } = {},
): Readonly<PortfolioSnapshot> {
  const metric = opts.metric ?? "cumulative_pnl_usdc";
  const capturedAt = opts.capturedAt ?? Date.now();
  const settled = source.settled ?? source.points.length;

  const points: PnlPoint[] = source.points.map((p) => ({
    timestamp: p.timestamp,
    value: p.value,
  }));

  const snapshot: PortfolioSnapshot = {
    id,
    label,
    capturedAt,
    metric,
    points,
    settled,
    frozen: true,
  };

  if (!isPortfolioSnapshot(snapshot)) {
    throw new Error("Invalid portfolio snapshot creation arguments");
  }

  return Object.freeze({
    ...snapshot,
    points: Object.freeze(points.map((p) => Object.freeze({ ...p }))),
  });
}

/**
 * Build comparison series and metadata from a set of fixed snapshots.
 * Ensures all snapshots use the same metric definition, and prevents mutation by live updates.
 */
export function comparePortfolioSnapshots(
  snapshots: readonly PortfolioSnapshot[],
  expectedMetric: "realised_pnl_usdc" | "cumulative_pnl_usdc" = "cumulative_pnl_usdc",
): PortfolioSnapshotComparison {
  if (snapshots.length === 0) {
    return { metric: expectedMetric, snapshots: [] };
  }

  for (const s of snapshots) {
    if (!isPortfolioSnapshot(s)) {
      throw new Error(`Invalid portfolio snapshot encountered: ${s?.id ?? "unknown"}`);
    }
    if (s.metric !== expectedMetric) {
      throw new Error(
        `Metric mismatch in snapshot comparison: expected ${expectedMetric}, got ${s.metric} on snapshot ${s.id}`,
      );
    }
  }

  return {
    metric: expectedMetric,
    snapshots: snapshots.map((s) => ({
      ...s,
      // Deep freeze guarantee
      points: s.points.map((p) => ({ ...p })),
      frozen: true,
    })),
  };
}

/**
 * Safe update helper that prevents live refreshes from altering reviewed historical snapshots.
 *
 * If a snapshot is marked `frozen`, any incoming live update for that snapshot id is discarded,
 * preserving historical integrity.
 */
export function applyLiveRefreshToSnapshots(
  currentSnapshots: readonly PortfolioSnapshot[],
  incomingUpdate: { id: string; points: PnlPoint[]; settled: number },
): PortfolioSnapshot[] {
  return currentSnapshots.map((snap) => {
    if (snap.id === incomingUpdate.id) {
      if (snap.frozen) {
        // Historical comparison snapshot is frozen against live revalidation.
        return snap;
      }
      return {
        ...snap,
        points: incomingUpdate.points.map((p) => ({ ...p })),
        settled: incomingUpdate.settled,
      };
    }
    return snap;
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

// ── Chart Ranges & Time Bounds ────────────────────────────────────────────────

export const PORTFOLIO_CHART_RANGES = ["24h", "7d", "30d", "all"] as const;
export type PortfolioChartRange = (typeof PORTFOLIO_CHART_RANGES)[number];

export interface TimeBounds {
  from?: number;
  to?: number;
}

export interface PerformanceRangeState {
  range: PortfolioChartRange;
  from?: number;
  to?: number;
}

export const DEFAULT_PERFORMANCE_RANGE: PerformanceRangeState = {
  range: "all",
};

export const MAX_TABLE_ROWS = 50;

export function formatChartDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(5, 10);
}

export function buildPerformanceChartRows(
  points: Array<{ timestamp: number; value: number }> = [],
  valueSuffix: string = " USDC",
) {
  const total = points.length;
  const truncated = total > MAX_TABLE_ROWS;
  const slice = truncated ? points.slice(-MAX_TABLE_ROWS) : points;
  const rows = slice.map((p) => ({
    date: formatChartDay(p.timestamp),
    value: `${p.value.toFixed(2)}${valueSuffix}`,
  }));
  return { rows, total, truncated };
}

/**
 * Checks whether a value is one of the supported preset chart ranges.
 */
export function isPortfolioChartRange(value: unknown): value is PortfolioChartRange {
  return typeof value === "string" && (PORTFOLIO_CHART_RANGES as readonly string[]).includes(value);
}

export interface TimeBoundsValidation {
  valid: boolean;
  reason?: "invalid_type" | "non_finite" | "non_positive" | "contradictory";
  error?: string;
}

/**
 * Reject invalid or contradictory time bounds.
 *
 * Rules:
 * - Timestamps must be finite positive numbers (> 0).
 * - Bounds must not contradict: `from` must be strictly earlier than `to` (from < to).
 * - Single-ended bounds (only `from` or only `to`) are valid if positive and finite.
 * - Missing or undefined bounds are valid (unbounded).
 */
export function validateTimeBounds(
  from?: unknown,
  to?: unknown,
): TimeBoundsValidation {
  const numFrom =
    typeof from === "string" && from.trim() !== ""
      ? Number(from)
      : typeof from === "number"
        ? from
        : undefined;

  const numTo =
    typeof to === "string" && to.trim() !== ""
      ? Number(to)
      : typeof to === "number"
        ? to
        : undefined;

  if (from !== undefined && from !== null && from !== "") {
    if (numFrom === undefined || !Number.isFinite(numFrom)) {
      return { valid: false, reason: "non_finite", error: "Start bound 'from' must be a finite number." };
    }
    if (numFrom <= 0) {
      return { valid: false, reason: "non_positive", error: "Start bound 'from' must be a positive timestamp." };
    }
  }

  if (to !== undefined && to !== null && to !== "") {
    if (numTo === undefined || !Number.isFinite(numTo)) {
      return { valid: false, reason: "non_finite", error: "End bound 'to' must be a finite number." };
    }
    if (numTo <= 0) {
      return { valid: false, reason: "non_positive", error: "End bound 'to' must be a positive timestamp." };
    }
  }

  if (numFrom !== undefined && numTo !== undefined) {
    if (numFrom >= numTo) {
      return {
        valid: false,
        reason: "contradictory",
        error: `Contradictory time bounds: start bound (${numFrom}) must be strictly earlier than end bound (${numTo}).`,
      };
    }
  }

  return { valid: true };
}

export function areTimeBoundsValid(bounds?: TimeBounds | null): boolean {
  if (!bounds) return true;
  return validateTimeBounds(bounds.from, bounds.to).valid;
}

/**
 * Parses and normalizes chart range URL search parameters.
 *
 * Rejects invalid or contradictory time bounds by discarding them and falling back
 * to a valid preset range (or "all").
 */
export function parsePerformanceRangeUrlParams(
  input: URLSearchParams | string | Record<string, string | string[] | undefined> | null | undefined,
): PerformanceRangeState {
  if (!input) return { ...DEFAULT_PERFORMANCE_RANGE };

  let sp: URLSearchParams;
  if (typeof input === "string") {
    const query = input.startsWith("?") ? input.slice(1) : input;
    sp = new URLSearchParams(query);
  } else if (input instanceof URLSearchParams) {
    sp = input;
  } else {
    sp = new URLSearchParams();
    for (const [key, val] of Object.entries(input)) {
      if (val !== undefined && val !== null) {
        if (Array.isArray(val)) {
          if (val.length > 0 && typeof val[0] === "string") sp.set(key, val[0]);
        } else if (typeof val === "string") {
          sp.set(key, val);
        }
      }
    }
  }

  const rawRange = (sp.get("range") ?? sp.get("window") ?? "").trim().toLowerCase();
  const range: PortfolioChartRange = isPortfolioChartRange(rawRange) ? rawRange : "all";

  const rawFrom = sp.get("from");
  const rawTo = sp.get("to");

  if (rawFrom === null && rawTo === null) {
    return { range };
  }

  const validation = validateTimeBounds(rawFrom, rawTo);
  if (!validation.valid) {
    // Contradictory or invalid bounds rejected; return clean preset range
    return { range };
  }

  const from = rawFrom !== null && rawFrom.trim() !== "" ? Number(rawFrom) : undefined;
  const to = rawTo !== null && rawTo.trim() !== "" ? Number(rawTo) : undefined;

  return {
    range,
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  };
}

/**
 * Serializes chart range state into a normalized query string.
 *
 * Preserves selected ranges in canonical form:
 * - Defaults (`range=all` without custom bounds) produce empty string `""`.
 * - Contradictory or invalid bounds are rejected before serialization.
 */
export function serializePerformanceRangeUrlParams(
  state: PerformanceRangeState,
): string {
  const p = new URLSearchParams();

  if (state.from !== undefined || state.to !== undefined) {
    const validation = validateTimeBounds(state.from, state.to);
    if (validation.valid) {
      if (state.from !== undefined) p.set("from", String(Math.floor(state.from)));
      if (state.to !== undefined) p.set("to", String(Math.floor(state.to)));
    }
  }

  if (state.range && state.range !== "all") {
    p.set("range", state.range);
  }

  return p.toString();
}

/**
 * Resolves the effective time window [sinceMs, untilMs] for a range state.
 */
export function resolveRangeTimeWindow(
  state: PerformanceRangeState | PortfolioChartRange,
  nowMs: number = Date.now(),
): { sinceMs?: number; untilMs?: number } {
  const rangeState: PerformanceRangeState =
    typeof state === "string" ? { range: state } : state;

  if (!areTimeBoundsValid(rangeState)) {
    return {};
  }

  let sinceMs = rangeState.from;
  const untilMs = rangeState.to;

  if (sinceMs === undefined && rangeState.range !== "all") {
    const hours =
      rangeState.range === "24h"
        ? 24
        : rangeState.range === "7d"
          ? 24 * 7
          : rangeState.range === "30d"
            ? 24 * 30
            : 0;
    if (hours > 0) {
      sinceMs = nowMs - hours * 3_600_000;
    }
  }

  return { sinceMs, untilMs };
}

/**
 * Pure performance reducer: filters and reduces historical results derived from
 * indexed market observations into the active range.
 *
 * Contradictory or invalid time bounds are rejected, failing closed or falling back
 * to the safe baseline points without injecting NaNs or corrupting SVG coordinates.
 */
export function reducePerformancePoints<T extends { timestamp: number; value: number }>(
  points: readonly T[],
  rangeOrBounds?: PerformanceRangeState | PortfolioChartRange | TimeBounds | null,
  nowMs: number = Date.now(),
): T[] {
  if (!Array.isArray(points) || points.length === 0) return [];

  const state: PerformanceRangeState =
    typeof rangeOrBounds === "string"
      ? { range: rangeOrBounds }
      : rangeOrBounds && "range" in rangeOrBounds
        ? (rangeOrBounds as PerformanceRangeState)
        : rangeOrBounds
          ? { range: "all", from: rangeOrBounds.from, to: rangeOrBounds.to }
          : { range: "all" };

  const validation = validateTimeBounds(state.from, state.to);
  if (!validation.valid) {
    // Contradictory / invalid bounds rejected; preserve safe valid series
    return points.filter(
      (p) => Number.isFinite(p.timestamp) && p.timestamp > 0 && Number.isFinite(p.value),
    );
  }

  const { sinceMs, untilMs } = resolveRangeTimeWindow(state, nowMs);

  return points.filter((point) => {
    if (!Number.isFinite(point.timestamp) || point.timestamp <= 0 || !Number.isFinite(point.value)) {
      return false;
    }
    if (sinceMs !== undefined && point.timestamp < sinceMs) return false;
    if (untilMs !== undefined && point.timestamp > untilMs) return false;
    return true;
  });
}

export type PerformanceRangeAction =
  | { type: "SET_RANGE"; range: PortfolioChartRange }
  | { type: "SET_TIME_BOUNDS"; from?: number; to?: number }
  | { type: "RESTORE_RANGE"; range: PortfolioChartRange; from?: number; to?: number }
  | { type: "RESET" };

/**
 * Performance range state reducer.
 *
 * Transitions are pure and reject contradictory or invalid time bounds.
 */
export function performanceRangeReducer(
  state: PerformanceRangeState,
  action: PerformanceRangeAction,
): PerformanceRangeState {
  switch (action.type) {
    case "SET_RANGE":
      return { range: action.range };

    case "SET_TIME_BOUNDS": {
      const validation = validateTimeBounds(action.from, action.to);
      if (!validation.valid) {
        // Reject invalid or contradictory time bounds: leave state unchanged
        return state;
      }
      return {
        range: "all",
        from: action.from,
        to: action.to,
      };
    }

    case "RESTORE_RANGE": {
      const validation = validateTimeBounds(action.from, action.to);
      if (!validation.valid) {
        // Contradictory bounds in restore action: reject and keep valid range
        return { range: action.range || "all" };
      }
      return {
        range: action.range || "all",
        from: action.from,
        to: action.to,
      };
    }

    case "RESET":
      return { ...DEFAULT_PERFORMANCE_RANGE };

    default:
      return state;
  }
}
