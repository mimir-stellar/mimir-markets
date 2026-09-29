import type { BasketAgentWeight, BasketSnapshot } from "@/lib/baskets";
import { basketExposure } from "@/lib/baskets";

export type VirtualBasketCardProps = {
  weights: BasketAgentWeight[];
  snapshots: BasketSnapshot[];
  /** Page size for the agent list. Defaults to 6 and is clamped to [1, 50]. */
  pageSize?: number;
  /** Current zero-based page index for the agent list. Defaults to 0. */
  page?: number;
  /** Optional error message from the data loader (dependency failure). */
  error?: string | null;
  /** Optional loading flag from the data loader. */
  isLoading?: boolean;
  /** Optional disconnected flag (wallet not connected). */
  isDisconnected?: boolean;
  /** Optional stale flag for the latest snapshot (cache aged out). */
  isStale?: boolean;
};

const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 6;

function clampPageSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_PAGE_SIZE;
  const integer = Math.floor(value as number);
  return Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, integer));
}

function clampPageIndex(value: number | undefined, totalPages: number): number {
  if (!Number.isFinite(value)) return 0;
  const integer = Math.floor(value as number);
  if (integer < 0) return 0;
  const maxIndex = Math.max(0, totalPages - 1);
  return Math.min(integer, maxIndex);
}

export function VirtualBasketCard({
  weights,
  snapshots,
  pageSize,
  page,
  error,
  isLoading,
  isDisconnected,
  isStale,
}: VirtualBasketCardProps) {
  const safeWeights = Array.isArray(weights) ? weights : [];
  const safeSnapshots = Array.isArray(snapshots) ? snapshots : [];

  const resolvedPageSize = clampPageSize(pageSize);
  const totalAgents = safeWeights.length;
  const totalPages = Math.max(1, Math.ceil(totalAgents / resolvedPageSize));
  const resolvedPage = clampPageIndex(page, totalPages);
  const pageStart = resolvedPage * resolvedPageSize;
  const pageEnd = Math.min(pageStart + resolvedPageSize, totalAgents);
  const visibleWeights = safeWeights.slice(pageStart, pageEnd);

  const exposure = basketExposure(safeWeights);
  const latest = safeSnapshots.at(-1);
  const maxDrawdown = safeSnapshots.reduce((max, point) => Math.max(max, point.drawdownBps), 0);

  const hasError = Boolean(error);
  const showEmpty = !loading && !error && totalAngens === 0;
  const navDisplay = latest ? `${(Number(latest.navAtomic) / 1_000_000).toFixed(2)} USDC` : "—";

  return (
    <section
      className="rounded-2xl border border-pv-ink/10 p-4"
      aria-label="Virtual agent basket"
      aria-busy={isLoading ? true : undefined}
      data-stale={isStale ? true : undefined}
      data-disconnected={isDisconnected ? true : undefined}
    >
      <div className="flex justify-between">
        <div>
          <h3 className="font-semibold">Virtual agent basket</h3>
          <p className="text-xs text-pv-ink/60">Simulation only — idle capital remains USDC; no yield or real funds.</p>
          {isDisconnected ? (
            <p className="text-xs text-amber-600" role="status">
              Wallet disconnected — viewing cached simulation data.
            </p>
          ) : null}
          {isStale ? (
            <p className="text-xs text-amber-600" role="status">
              Stale data — latest snapshot is older than expected.
            </p>
          ) : null}
        </div>
        <div className="text-right">
          <div>{navDisplay}</div>
          <div className="text-xs text-pv-ink/60">Max drawdown {(maxDrawdown / 100).toFixed(2)}%</div>
        </div>
      </div>

      {hasError ? (
        <p className="mt-4 text-sm text-red-600" role="alert">
          Unable to load basket data: {error}
        </p>
      ) : null}

      {isLoading ? (
        <p className="mt-4 text-sm text-pv-ink/60" role="status">
          Loading basket positions…
        </p>
      ) : null}

      {showEmpty ? (
        <p className="mt-4 text-sm text-pv-ink/60" role="status">
          No agent weights available for this basket.
        </p>
      ) : null}

      {!showEmpty && !hasError ? (
        <div className="mt-4 grid gap-3 sm:grid-cols=2">
          <div>
            <div className="flex items-baseline justify-between">
              <h4 className="text-xs uppercase text-pv-ink/50">Agents</h4>
              {totalAgents > 0 ? (
                <span className="text-xs text-pv-ink/60" aria-live="polite">
                  {pageStart + 1}– {pageEnd} of {totalAgents}
                </span>
              ) : null}
            </div>
            <ul className="mt-1 space-y-1">
              {visibleWeights.map((item) => (
                <li key={item.agentId} className="flex justify-between text-sm">
                  <span>
                    {item.agentId}{item.paused || item.stale ? " (idle)" : ""}
                  </span>
                  <span>{(item.weightBps / 100).toFixed(2)}%</span>
                </li>
              ))}
            </ul>
            {totalPages > 1 ? (
              <div className="mt-2 flex items-center justify-between text-xs">
                <span className="text-pv-ink/60">
                  Page {resolvedPage + 1} of {totalPages}
                </span>
              </div>
            ) : null}
          </div>
          <div>
            <h4 className="text-xs uppercase text-pv-ink/50">Category / mode exposure</h4>
            {Object.entries({
              ...exposure.categories,
              ...Object.fromEntries(
                Object.entries(exposure.modes).map(([key, value]) => [`modg:${key}`, value]),
              ),
            }).map(([key, value]) => (
              <div key={key} className="flex justify-between text-sm">
                <span>{key}</span>
                <span>{(value / 100).toFixed(2)}%</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
