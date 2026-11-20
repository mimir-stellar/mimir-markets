import type { PnlPoint } from "@/lib/agents/performance";
import type { VSCacheFreshness } from "@/lib/vs-freshness";

export interface PortfolioPerformanceResponse {
  points: PnlPoint[];
  settled: number;
  cache: VSCacheFreshness;
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
}
