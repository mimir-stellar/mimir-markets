"use client";

/**
 * One line chart for both agent P&L and basket NAV.
 *
 * Inline SVG rather than a charting library: this is a path, a baseline and a
 * hover readout — a chart dependency would ship more JavaScript than the rest of
 * the page. Colours come from theme tokens so it inverts with the palette.
 *
 * The line draws itself on mount via stroke-dasharray, which animates on the
 * compositor rather than by re-rendering React on every frame. Anyone who asked
 * their system not to animate gets the finished line immediately.
 *
 * Keyboard and screen-reader users can't hover, so a "Show data" toggle
 * reveals a table of the same points (last MAX_TABLE_ROWS).
 *
 * Selected chart ranges are preserved in normalized URL state, rejecting invalid
 * or contradictory time bounds and restoring valid ranges across navigation
 * without resetting keyboard focus.
 */

import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from "react";

import {
  PORTFOLIO_CHART_RANGES,
  buildPerformanceChartRows,
  formatChartDay,
  parsePerformanceRangeUrlParams,
  performanceRangeReducer,
  reducePerformancePoints,
  serializePerformanceRangeUrlParams,
  validateTimeBounds,
  type PerformanceRangeState,
  type PortfolioChartRange,
  type TimeBounds,
} from "@/lib/portfolio-performance";

export interface ChartPoint {
  timestamp: number;
  /** Display units — USDC for both NAV and cumulative P&L. */
  value: number;
}

export interface ChartSeries {
  points: ChartPoint[];
  /** CSS colour; defaults to the accent/danger token pair by the series' sign. */
  stroke?: string;
  label?: string;
  /** Area fill under the line. Only the primary series fills by default. */
  area?: boolean;
}

const VIEW_WIDTH = 720;
const VIEW_HEIGHT = 180;
const PAD_X = 10;
const PAD_Y = 14;

const RANGE_LABELS: Record<PortfolioChartRange, string> = {
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  all: "All",
};

export interface PerformanceChartProps {
  points?: ChartPoint[];
  series?: ChartSeries[];
  /** The line drawn as "flat": starting NAV, or zero for cumulative P&L. */
  baseline: number;
  label: string;
  valueSuffix?: string;
  emptyMessage?: string;
  invalidMessage?: string;
  height?: number;
  /** Initial or controlled chart range */
  range?: PortfolioChartRange;
  timeBounds?: TimeBounds;
  /** Callback fired when the user selects a range */
  onRangeChange?: (range: PortfolioChartRange, bounds?: TimeBounds) => void;
  /** Whether to sync selected chart range with normalized URL state (default: true) */
  syncUrl?: boolean;
  /** Show range selection buttons (default: true) */
  showRangeControls?: boolean;
}

export function PerformanceChart({
  points,
  series,
  baseline,
  label,
  valueSuffix = " USDC",
  emptyMessage = "No settled results in this window yet.",
  invalidMessage = "Performance data is unavailable.",
  height = 180,
  range: propRange,
  timeBounds: propBounds,
  onRangeChange,
  syncUrl = true,
  showRangeControls = true,
}: PerformanceChartProps) {
  const gradientId = useId();
  const tableId = useId();
  const [drawn, setDrawn] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [showData, setShowData] = useState(false);
  const pathRef = useRef<SVGPathElement>(null);
  const containerRef = useRef<HTMLElement>(null);

  // Initialize range state from normalized URL or initial props
  const [rangeState, dispatch] = useReducer(performanceRangeReducer, undefined, () => {
    let initial: PerformanceRangeState = { range: propRange ?? "all" };
    if (propBounds) {
      const v = validateTimeBounds(propBounds.from, propBounds.to);
      if (v.valid) {
        initial.from = propBounds.from;
        initial.to = propBounds.to;
      }
    }
    if (syncUrl && typeof window !== "undefined") {
      const parsed = parsePerformanceRangeUrlParams(window.location.search);
      // If URL had explicit parameters, prefer them over default
      if (window.location.search.includes("range=") || window.location.search.includes("window=") || window.location.search.includes("from=")) {
        initial = parsed;
      }
    }
    return initial;
  });

  // Sync state if props change
  useEffect(() => {
    if (propRange) {
      dispatch({ type: "SET_RANGE", range: propRange });
    }
  }, [propRange]);

  useEffect(() => {
    if (propBounds) {
      dispatch({ type: "SET_TIME_BOUNDS", from: propBounds.from, to: propBounds.to });
    }
  }, [propBounds?.from, propBounds?.to]);

  // Synchronize range changes with URL state via history.replaceState
  const commitUrl = useCallback((next: PerformanceRangeState) => {
    if (!syncUrl || typeof window === "undefined") return;
    const currentParams = new URLSearchParams(window.location.search);
    const rangeQs = serializePerformanceRangeUrlParams(next);

    // Remove old range keys
    currentParams.delete("range");
    currentParams.delete("window");
    currentParams.delete("from");
    currentParams.delete("to");

    if (rangeQs) {
      const parsedRange = new URLSearchParams(rangeQs);
      for (const [k, v] of parsedRange.entries()) {
        currentParams.set(k, v);
      }
    }

    const qs = currentParams.toString();
    const search = qs ? `?${qs}` : "";
    const newUrl = `${window.location.pathname}${search}${window.location.hash}`;

    if (window.location.search !== search) {
      window.history.replaceState(window.history.state, "", newUrl);
    }
  }, [syncUrl]);

  const selectRange = useCallback((nextRange: PortfolioChartRange) => {
    dispatch({ type: "SET_RANGE", range: nextRange });
    const nextState: PerformanceRangeState = { range: nextRange };
    commitUrl(nextState);
    onRangeChange?.(nextRange);
  }, [commitUrl, onRangeChange]);

  // Restore range on back/forward navigation without resetting keyboard focus
  useEffect(() => {
    if (!syncUrl || typeof window === "undefined") return;

    const onPopState = () => {
      // Capture currently focused element before applying restoration
      const activeEl = document.activeElement as HTMLElement | null;
      const isFocusedInside = containerRef.current?.contains(activeEl) ?? false;
      const focusedControlAttr = activeEl?.getAttribute("data-range-key");
      const focusedId = activeEl?.id;

      const restored = parsePerformanceRangeUrlParams(window.location.search);
      dispatch({ type: "RESTORE_RANGE", ...restored });
      onRangeChange?.(restored.range, { from: restored.from, to: restored.to });

      // Restore keyboard focus if it was inside this component
      if (isFocusedInside && activeEl) {
        requestAnimationFrame(() => {
          if (focusedControlAttr) {
            const el = containerRef.current?.querySelector<HTMLElement>(`[data-range-key="${focusedControlAttr}"]`);
            el?.focus({ preventScroll: true });
          } else if (focusedId) {
            const el = document.getElementById(focusedId);
            el?.focus({ preventScroll: true });
          } else if (document.contains(activeEl)) {
            activeEl.focus({ preventScroll: true });
          }
        });
      }
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [syncUrl, onRangeChange]);

  // Handle keyboard navigation between range buttons
  const handleRangeKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    let nextIndex = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % PORTFOLIO_CHART_RANGES.length;
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + PORTFOLIO_CHART_RANGES.length) % PORTFOLIO_CHART_RANGES.length;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = PORTFOLIO_CHART_RANGES.length - 1;
    }

    if (nextIndex >= 0) {
      e.preventDefault();
      const nextRange = PORTFOLIO_CHART_RANGES[nextIndex];
      selectRange(nextRange);
      const nextBtn = containerRef.current?.querySelector<HTMLElement>(`[data-range-key="${nextRange}"]`);
      nextBtn?.focus();
    }
  }, [selectRange]);

  // Series / points resolution & range reduction
  const rawSeries = series && series.length > 0 ? series : points ? [{ points }] : [];

  const allSeries = useMemo(() => {
    return rawSeries.map((s) => ({
      ...s,
      points: reducePerformancePoints(s.points, rangeState),
    }));
  }, [rawSeries, rangeState]);

  const primaryCount = allSeries[0]?.points.length ?? 0;
  const invalid = !Number.isFinite(baseline) || allSeries.some((s) =>
    s.points.some((point) =>
      !Number.isFinite(point.timestamp) || point.timestamp <= 0 || !Number.isFinite(point.value)
    )
  );

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return setDrawn(true);
    // Next frame, so the dashoffset transition has an initial value to move from.
    const frame = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(frame);
  }, [primaryCount]);

  const geometry = useMemo(() => {
    if (invalid || allSeries.length === 0) return null;
    const allPoints = allSeries.flatMap((s) => s.points);
    if (allPoints.length === 0) return null;
    const values = allPoints.map((point) => point.value);
    const min = Math.min(baseline, ...values);
    const max = Math.max(baseline, ...values);
    // A flat series would divide by zero; give it a nominal band so it centres.
    const span = max - min || Math.max(1, Math.abs(max) * 0.02);

    const buildSeriesGeom = (s: ChartSeries) => {
      const pts = s.points;
      if (pts.length === 0) return { coords: [] as Array<{ x: number; y: number; timestamp: number; value: number }>, line: "", area: "" };
      const x = (index: number) =>
        PAD_X + (index / Math.max(1, pts.length - 1)) * (VIEW_WIDTH - PAD_X * 2);
      const y = (value: number) =>
        VIEW_HEIGHT - PAD_Y - ((value - min) / span) * (VIEW_HEIGHT - PAD_Y * 2);
      const coords = pts.map((point, index) => ({
        x: x(index), y: y(point.value), timestamp: point.timestamp, value: point.value,
      }));
      const line = pts.length === 1
        ? `M${PAD_X},${coords[0].y} L${VIEW_WIDTH - PAD_X},${coords[0].y}`
        : coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
      const area = `${line} L${(pts.length === 1 ? VIEW_WIDTH - PAD_X : coords.at(-1)!.x).toFixed(1)},${VIEW_HEIGHT - PAD_Y} L${PAD_X},${VIEW_HEIGHT - PAD_Y} Z`;
      return { coords, line, area };
    };

    const seriesGeoms = allSeries.map(buildSeriesGeom);
    const primary = seriesGeoms[0];
    if (!primary || primary.coords.length === 0) return null;

    const y = (value: number) =>
      VIEW_HEIGHT - PAD_Y - ((value - min) / span) * (VIEW_HEIGHT - PAD_Y * 2);

    const firstTimestamp = primary.coords[0].timestamp;
    const lastTimestamp = primary.coords[primary.coords.length - 1].timestamp;

    return {
      seriesGeoms,
      coords: primary.coords,
      line: primary.line,
      area: primary.area,
      baselineY: y(baseline),
      firstTimestamp,
      lastTimestamp,
    };
  }, [allSeries, baseline, invalid]);

  if (invalid) {
    return (
      <div
        role="alert"
        className="border border-pv-danger/30 bg-pv-danger/[0.06] px-4 py-12 text-center text-sm text-pv-muted"
      >
        {invalidMessage}
      </div>
    );
  }

  const primarySeriesPoints = allSeries[0]?.points ?? [];
  const table = buildPerformanceChartRows(primarySeriesPoints, valueSuffix);

  return (
    <figure ref={containerRef} className="border border-pv-ink/[0.1] bg-pv-surface/40 p-3">
      {/* Range controls: keyboard reachable and accessible */}
      {showRangeControls && (
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-pv-muted">
            Range
          </span>
          <div className="flex items-center gap-1" role="group" aria-label="Chart range">
            {PORTFOLIO_CHART_RANGES.map((r, index) => {
              const active = rangeState.range === r && rangeState.from === undefined && rangeState.to === undefined;
              return (
                <button
                  key={r}
                  type="button"
                  data-range-key={r}
                  aria-pressed={active}
                  onClick={() => selectRange(r)}
                  onKeyDown={(e) => handleRangeKeyDown(e, index)}
                  className={`border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-pv-accent ${
                    active
                      ? "border-pv-emerald/45 bg-pv-emerald/[0.1] text-pv-text font-semibold"
                      : "border-pv-ink/[0.12] text-pv-muted hover:border-pv-ink/[0.25] hover:text-pv-text"
                  }`}
                >
                  {RANGE_LABELS[r]}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {!geometry ? (
        <div className="border border-pv-ink/[0.1] bg-pv-surface/40 px-4 py-12 text-center text-sm text-pv-muted">
          {emptyMessage}
        </div>
      ) : (
        <>
          {(() => {
            const primary = geometry.seriesGeoms[0];
            const active = hover === null ? primary.coords.length - 1 : hover;
            const activeCoord = primary.coords[active];
            const activePoint = activeCoord ?? primary.coords[primary.coords.length - 1];
            const last = primary.coords[primary.coords.length - 1];
            const up = last.value >= baseline;
            const strokeDefault = up ? "rgb(var(--pv-accent))" : "rgb(var(--pv-danger))";
            const length = pathRef.current?.getTotalLength?.() ?? 2000;

            return (
              <>
                <svg
                  viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
                  style={{ height }}
                  className="w-full touch-none"
                  role="img"
                  aria-label={`${label}: ${primary.coords.length} point${primary.coords.length === 1 ? "" : "s"}, ending at ${last.value.toFixed(2)}${valueSuffix}`}
                  onMouseLeave={() => setHover(null)}
                >
                  <defs>
                    <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={strokeDefault} stopOpacity="0.22" />
                      <stop offset="100%" stopColor={strokeDefault} stopOpacity="0" />
                    </linearGradient>
                  </defs>

                  <line
                    x1={PAD_X}
                    x2={VIEW_WIDTH - PAD_X}
                    y1={geometry.baselineY}
                    y2={geometry.baselineY}
                    stroke="rgb(var(--pv-ink) / 0.18)"
                    strokeWidth="1"
                    strokeDasharray="3 4"
                  />

                  {geometry.seriesGeoms.map((sGeom, sIndex) => {
                    const sDef = allSeries[sIndex];
                    const sStroke = sDef?.stroke ?? strokeDefault;
                    return (
                      <g key={`series-${sIndex}`}>
                        {(sDef?.area ?? sIndex === 0) && (
                          <path
                            d={sGeom.area}
                            fill={`url(#${gradientId})`}
                            style={{ opacity: drawn ? 1 : 0, transition: "opacity 600ms ease-out 250ms" }}
                          />
                        )}
                        <path
                          ref={sIndex === 0 ? pathRef : undefined}
                          d={sGeom.line}
                          fill="none"
                          stroke={sStroke}
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          style={{
                            strokeDasharray: length,
                            strokeDashoffset: drawn ? 0 : length,
                            transition: "stroke-dasharray 900ms cubic-bezier(0.22, 1, 0.36, 1)",
                          }}
                        />
                      </g>
                    );
                  })}

                  {/* Hover targets */}
                  {primary.coords.map((coord, index) => (
                    <rect
                      key={`${coord.timestamp}-${index}`}
                      x={index === 0 ? 0 : (primary.coords[index - 1].x + coord.x) / 2}
                      y={0}
                      width={
                        index === primary.coords.length - 1
                          ? VIEW_WIDTH
                          : (primary.coords[index + 1].x - coord.x) / 2
                            + (index === 0 ? coord.x : (coord.x - primary.coords[index - 1].x) / 2)
                      }
                      height={VIEW_HEIGHT}
                      fill="transparent"
                      onMouseEnter={() => setHover(index)}
                    />
                  ))}

                  {hover !== null && activeCoord && (
                    <line
                      x1={activeCoord.x}
                      x2={activeCoord.x}
                      y1={PAD_Y}
                      y2={VIEW_HEIGHT - PAD_Y}
                      stroke="rgb(var(--pv-ink) / 0.2)"
                      strokeWidth="1"
                    />
                  )}
                  <circle
                    cx={activePoint.x}
                    cy={activePoint.y}
                    r="4"
                    fill={strokeDefault}
                    style={{ opacity: drawn ? 1 : 0, transition: "opacity 300ms ease-out 700ms" }}
                  />
                </svg>

                <figcaption className="mt-2 flex items-center justify-between gap-3 font-mono text-[10px] uppercase tracking-wider text-pv-muted">
                  <span>{formatChartDay(geometry.firstTimestamp)}</span>
                  <span className="text-pv-text">
                    {formatChartDay(activePoint.timestamp)} · {activePoint.value.toFixed(2)}{valueSuffix}
                  </span>
                  <span>{formatChartDay(geometry.lastTimestamp)}</span>
                </figcaption>
              </>
            );
          })()}
        </>
      )}

      <div className="mt-3 flex flex-col items-start gap-2">
        <button
          type="button"
          aria-expanded={showData}
          aria-controls={tableId}
          onClick={() => setShowData((value) => !value)}
          className="rounded-sm border border-pv-ink/[0.15] px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-pv-muted hover:text-pv-text focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-pv-accent"
        >
          {showData ? "Hide data" : "Show data"}
        </button>
        {showData && (
          <div id={tableId} className="max-h-64 w-full overflow-auto">
            <table className="w-full border-collapse text-left font-mono text-xs text-pv-text">
              <caption className="py-1 text-left text-pv-muted">
                {label}
              </caption>
              <thead>
                <tr className="text-pv-muted">
                  <th scope="col" className="py-1 pr-3 font-semibold">Date</th>
                  <th scope="col" className="py-1 font-semibold">Value</th>
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, index) => (
                  <tr key={`${row.date}-${index}`}>
                    <td className="py-0.5 pr-3">{row.date}</td>
                    <td className="py-0.5">{row.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {table.truncated && (
              <p className="mt-1 text-xs text-pv-muted">
                Showing the last {table.rows.length} of {table.total} points.
              </p>
            )}
          </div>
        )}
      </div>
    </figure>
  );
}
