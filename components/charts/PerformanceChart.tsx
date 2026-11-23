"use client";

/**
 * One line chart for both agent P&amp;L and basket NAV.
 *
 * Inline SVG rather than a charting library: this is a path, a baseline,
 * observation-coverage overlays, and a hover readout — a chart dependency would
 * ship more JavaScript than the rest of the page. Colours come from theme tokens
 * so it inverts with the palette.
 *
 * Missing observation intervals are rendered as hatched gap bands and break the
 * series line so unobserved periods are visually distinct from verified zero
 * performance.
 *
 * Keyboard and screen-reader users can't hover, so the chart is also focusable:
 * ArrowLeft/ArrowRight move between observations (Home/End jump to the ends),
 * and each observation's date, value and coverage are exposed as text. A
 * "Show data" toggle reveals a table of the same points (last MAX_TABLE_ROWS).
 *
 * When live data appends a newer point, the focused index is preserved by
 * timestamp rather than by array position, so keyboard focus stays on the same
 * observation instead of jumping as the series grows.
 */

import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from "react";

import {
  formatTrustedLedger,
  normalizeMissingIntervals,
  splitPointsByMissingIntervals,
  type PerformanceMissingInterval,
  type PerformanceObservationCoverage,
} from "@/lib/portfolio-performance";

export interface ChartPoint {
  timestamp: number;
  /** Display units — USDC for both NAV and cumulative P&L. */
  value: number;
  /** Optional coverage/completeness indicator for the observation (0..1 or a label). */
  coverage?: number | string;
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
const MAX_TABLE_ROWS = 50;

function formatDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function buildChartTableRows(points: readonly ChartPoint[], valueSuffix: string) {
  const total = points.length;
  const sliced = total > MAX_TABLE_ROWS ? points.slice(total - MAX_TABLE_ROWS) : points;
  return {
    rows: sliced.map((point) => ({
      date: formatDay(point.timestamp),
      value: `${point.value.toFixed(2)}${valueSuffix}`,
    })),
    total,
    truncated: total > MAX_TABLE_ROWS,
  };
}

function formatCoverage(coverage: ChartPoint["coverage"]): string {
  if (coverage === undefined || coverage === null || coverage === "") return "coverage unknown";
  if (typeof coverage === "number") {
    return `coverage ${Math.round(Math.max(0, Math.min(1, coverage)) * 100)}%`;
  }
  return `coverage ${coverage}`;
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
  coverage,
  stale = false,
}: {
  points?: ChartPoint[];
  series?: ChartSeries[];
  /** The line drawn as "flat": starting NAV, or zero for cumulative P&amp;L. */
  baseline: number;
  label: string;
  valueSuffix?: string;
  emptyMessage?: string;
  invalidMessage?: string;
  height?: number;
  series?: ChartSeries[];
}) {
  const gradientId = useId();
  const gapPatternId = useId();
  const tableId = useId();
  const [drawn, setDrawn] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [focusTimestamp, setFocusTimestamp] = useState<number | null>(null);
  const [showData, setShowData] = useState(false);
  const pathRef = useRef<SVGPathElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const allSeries: ChartSeries[] =
    series && series.length > 0
      ? series
      : points
        ? [{ points }]
        : [];
  const primaryCount = allSeries[0]?.points.length ?? 0;
  const invalid =
    !Number.isFinite(baseline) ||
    allSeries.some((s) =>
      s.points.some(
        (point) =>
          !Number.isFinite(point.timestamp) ||
          point.timestamp <= 0 ||
          !Number.isFinite(point.value),
      ),
    );

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setDrawn(true);
      return;
    }
    // Next frame, so the dashoffset transition has an initial value to move from.
    const frame = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(frame);
  }, [primaryCount]);

  // Preserve keyboard focus across live updates by timestamp, not array index:
  // when a newer point is appended, the focused observation keeps its position
  // in the data rather than silently shifting to a different date.
  useEffect(() => {
    const primaryPoints = allSeries[0]?.points ?? [];
    if (focusTimestamp === null) return;
    const idx = primaryPoints.findIndex((p) => p.timestamp === focusTimestamp);
    if (idx >= 0 && idx !== focusIndex) setFocusIndex(idx);
    // If the focused observation disappeared, fall back to the newest point.
    if (idx < 0) {
      setFocusIndex(primaryPoints.length > 0 ? primaryPoints.length - 1 : null);
      setFocusTimestamp(primaryPoints.length > 0 ? primaryPoints[primaryPoints.length - 1].timestamp : null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryCount]);

  const geometry = useMemo(() => {
    if (effectiveState !== "available" || allSeries.length === 0) return null;
    const allPoints = allSeries.flatMap((s) => s.points);
    if (allPoints.length === 0) return null;

    const values = allPoints.map((point) => point.value);
    const min = Math.min(baseline, ...values);
    const max = Math.max(baseline, ...values);
    // A flat series would divide by zero; give it a nominal band so it centres.
    const span = max - min || Math.max(1, Math.abs(max) * 0.02);

    const y = (value: number) =>
      VIEW_HEIGHT - PAD_Y - ((value - min) / span) * (VIEW_HEIGHT - PAD_Y * 2);

    const buildSeriesGeom = (s: ChartSeries) => {
      const pts = s.points;
      if (pts.length === 0) {
        return {
          coords: [] as Array<{
            x: number;
            y: number;
            timestamp: number;
            value: number;
          }>,
          line: "",
          area: "",
        };
      }
      const x = (index: number) =>
        PAD_X + (index / Math.max(1, pts.length - 1)) * (VIEW_WIDTH - PAD_X * 2);
      const coords = pts.map((point, index) => ({
        x: x(index),
        y: y(point.value),
        timestamp: point.timestamp,
        value: point.value,
      }));
      const line =
        pts.length === 1
          ? `M${PAD_X},${coords[0].y} L${VIEW_WIDTH - PAD_X},${coords[0].y}`
          : coords
              .map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
              .join(" ");
      const area = `${line} L${(pts.length === 1 ? VIEW_WIDTH - PAD_X : coords.at(-1)!.x).toFixed(1)},${VIEW_HEIGHT - PAD_Y} L${PAD_X},${VIEW_HEIGHT - PAD_Y} Z`;
      return { coords, line, area };
    };

    const seriesGeoms = allSeries.map(buildSeriesGeom);
    const firstTimestamp = Math.min(...allPoints.map((p) => p.timestamp));
    const lastTimestamp = Math.max(...allPoints.map((p) => p.timestamp));
    return {
      seriesGeoms,
      baselineY: y(baseline),
      firstTimestamp,
      lastTimestamp,
    };
  }, [allSeries, baseline, invalid]);

    const primaryCoords = seriesGeoms[0]?.coords ?? [];
    const firstTimestamp = primaryCoords[0]?.timestamp ?? allPoints[0]?.timestamp ?? 0;
    const lastTimestamp =
      primaryCoords.at(-1)?.timestamp ?? allPoints.at(-1)?.timestamp ?? 0;

    return {
      seriesGeoms,
      line: seriesGeoms[0]?.line ?? "",
      area: seriesGeoms[0]?.area ?? "",
      baselineY: y(baseline),
      firstTimestamp,
      lastTimestamp,
    };
  }, [allSeries, baseline, invalid]);

  if (invalid) {
    return (
      <div
        role="alert"
        data-state="unavailable"
        className="border border-pv-danger/30 bg-pv-danger/[0.06] px-4 py-12 text-center text-sm text-pv-muted"
      >
        {invalidMessage}
      </div>
    );
  }

  const hasCoverageBanner = Boolean(coverage) || stale;

  if (!geometry) {
    return (
      <div className="border border-pv-ink/[0.1] bg-pv-surface/40 px-4 py-12 text-center text-sm text-pv-muted">
        {emptyMessage}
      </div>
    );
  }

  const primary = geometry.seriesGeoms[0];
  const count = primary.coords.length;
  const defaultIndex = count - 1;
  const active = hover !== null ? hover : focusIndex !== null ? focusIndex : defaultIndex;
  const activeCoord = primary.coords[active];
  const activePoint = activeCoord ?? primary.coords[count - 1];
  const last = primary.coords[count - 1];
  const up = last.value >= baseline;
  const stroke = allSeries[0].stroke ?? (up ? "rgb(var(--pv-accent))" : "rgb(var(--pv-danger))");
  const length = pathRef.current?.getTotalLength?.() ?? 2000;
  const table = buildChartTableRows(allSeries[0]?.points ?? [], valueSuffix);

  const moveFocus = (next: number) => {
    const clamped = Math.max(0, Math.min(count - 1, next));
    setFocusIndex(clamped);
    setFocusTimestamp(primary.coords[clamped].timestamp);
  };

  const onKeyDown = (event: React.KeyboardEvent<SVGSVGElement>) => {
    const current = focusIndex ?? defaultIndex;
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        moveFocus(current - 1);
        break;
      case "ArrowRight":
        event.preventDefault();
        moveFocus(current + 1);
        break;
      case "Home":
        event.preventDefault();
        moveFocus(0);
        break;
      case "End":
        event.preventDefault();
        moveFocus(count - 1);
        break;
      default:
        break;
    }
  };

  const activeDescription = `${formatDay(activePoint.timestamp)}, value ${activePoint.value.toFixed(2)}${valueSuffix}, ${formatCoverage(activePoint.coverage)}, observation ${active + 1} of ${count}`;

  return (
    <figure className="border border-pv-ink/[0.1] bg-pv-surface/40 p-3">
      {hasCoverageBanner ? (
        <div
          data-performance-coverage="true"
          className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-pv-ink/[0.08] pb-2 font-mono text-[10px] uppercase tracking-wider text-pv-muted"
        >
          <span>
            {coverage
              ? `Last trusted ledger ${formatTrustedLedger(coverage.lastTrustedLedger)}`
              : "Observation coverage"}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {missingIntervals.length > 0 ? (
              <span
                data-missing-intervals={missingIntervals.length}
                className="rounded-sm border border-pv-ink/[0.18] bg-pv-ink/[0.05] px-1.5 py-0.5 text-pv-text"
              >
                {missingIntervals.length} missing interval{missingIntervals.length === 1 ? "" : "s"} (gap ≠ 0.00{valueSuffix})
              </span>
            ) : null}
            {stale ? (
              <span
                data-stale-data="true"
                className="rounded-sm border border-pv-danger/40 bg-pv-danger/[0.08] px-1.5 py-0.5 text-pv-danger"
              >
                Stale data
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        style={{ height }}
        className="w-full touch-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-pv-accent"
        role="img"
        tabIndex={0}
        aria-roledescription="chart"
        aria-label={`${label}: ${count} point${count === 1 ? "" : "s"}, ending at ${last.value.toFixed(2)}${valueSuffix}. Use left and right arrow keys to move between observations. Currently ${activeDescription}.`}
        aria-valuetext={activeDescription}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (focusIndex === null) {
            setFocusIndex(defaultIndex);
            setFocusTimestamp(primary.coords[defaultIndex].timestamp);
          }
        }}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
          <pattern
            id={gapPatternId}
            width="8"
            height="8"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line
              x1="0"
              y1="0"
              x2="0"
              y2="8"
              stroke="rgb(var(--pv-ink) / 0.22)"
              strokeWidth="2"
            />
          </pattern>
        </defs>

        {/* Missing-interval bands: hatched shading distinct from a verified zero line */}
        {geometry.gapRects.map((gap, index) => (
          <g key={`gap-${gap.interval.startTimestamp}-${gap.interval.endTimestamp}-${index}`} data-performance-gap="true">
            <rect
              x={gap.x}
              y={PAD_Y}
              width={gap.width}
              height={VIEW_HEIGHT - PAD_Y * 2}
              fill={`url(#${gapPatternId})`}
              stroke="rgb(var(--pv-ink) / 0.24)"
              strokeWidth="1"
              strokeDasharray="2 2"
            >
              <title>
                {`Missing observation interval: ${formatDay(gap.interval.startTimestamp)} to ${formatDay(gap.interval.endTimestamp)}${gap.interval.reason ? ` (${gap.interval.reason})` : ""}`}
              </title>
            </rect>
          </g>
        ))}

        <line
          x1={PAD_X}
          x2={VIEW_WIDTH - PAD_X}
          y1={geometry.baselineY}
          y2={geometry.baselineY}
          stroke="rgb(var(--pv-ink) / 0.18)"
          strokeWidth="1"
          strokeDasharray="3 4"
        />

        {/* Primary series area fill */}
        {(allSeries[0]?.area ?? true) && (
          <path
            d={geometry.seriesGeoms[0].area}
            fill={`url(#${gradientId})`}
            style={{
              opacity: drawn ? 1 : 0,
              transition: "opacity 600ms ease-out 250ms",
            }}
          />
        )}

        {/* Render lines for all series in comparison or single mode */}
        {geometry.seriesGeoms.map((sg, index) => {
          const s = allSeries[index];
          const isPrimary = index === 0;
          const seriesStroke = s?.stroke ?? (isPrimary ? strokeDefault : "rgb(var(--pv-ink) / 0.5)");
          return (
            <path
              key={s?.label ?? index}
              ref={isPrimary ? pathRef : undefined}
              d={sg.line}
              fill="none"
              stroke={seriesStroke}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                strokeDasharray: length,
                strokeDashoffset: drawn ? 0 : length,
                transition: "stroke-dasharray 900ms cubic-bezier(0.22, 1, 0.36, 1)",
              }}
            />
          );
        })}

        {/* Hover targets: one invisible column per primary point */}
        {primary.coords.map((coord, index) => (
          <rect
            key={`${coord.timestamp}-${index}`}
            x={index === 0 ? 0 : (primary.coords[index - 1].x + coord.x) / 2}
            y={0}
            width={
              index === primary.coords.length - 1
                ? VIEW_WIDTH
                : (primary.coords[index + 1].x - coord.x) / 2 +
                  (index === 0 ? coord.x : (coord.x - primary.coords[index - 1].x) / 2)
            }
            height={VIEW_HEIGHT}
            fill="transparent"
            onMouseEnter={() => setHover(index)}
          />
        ))}

        {(hover !== null || focusIndex !== null) && activeCoord && (
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
          fill={allSeries[0]?.stroke ?? strokeDefault}
          style={{
            opacity: drawn ? 1 : 0,
            transition: "opacity 300ms ease-out 700ms",
          }}
        />
      </svg>

      <p aria-live="polite" className="sr-only">
        {activeDescription}
      </p>

      <figcaption className="mt-2 flex items-center justify-between gap-3 font-mono text-[10px] uppercase tracking-wider text-pv-muted">
        <span>{formatDay(geometry.firstTimestamp)}</span>
        <span className="text-pv-text">
          {formatDay(activePoint.timestamp)} · {activePoint.value.toFixed(2)}
          {valueSuffix}
        </span>
        <span>{formatDay(geometry.lastTimestamp)}</span>
      </figcaption>

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
              <caption className="py-1 text-left text-pv-muted">{label}</caption>
              <thead>
                <tr className="text-pv-muted">
                  <th scope="col" className="py-1 pr-3 font-semibold">
                    Date
                  </th>
                  <th scope="col" className="py-1 font-semibold">
                    Value
                  </th>
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, index) => (
                  <tr key={`${row.date}-${index}`}>
                    <td className="py-0.5 pr-3">{row.date}</td>
                    <td className="py-0.5 pr-3">{row.value}</td>
                    <td className="py-0.5">{formatCoverage(points[index]?.coverage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {missingIntervals.length > 0 && (
              <div className="mt-2 border-t border-pv-ink/[0.1] pt-2 font-mono text-xs text-pv-muted">
                <p className="font-semibold text-pv-text">Missing observation intervals (not zero):</p>
                <ul className="mt-1 list-disc pl-4">
                  {missingIntervals.map((interval, index) => (
                    <li key={`table-gap-${interval.startTimestamp}-${index}`}>
                      {formatDay(interval.startTimestamp)} to {formatDay(interval.endTimestamp)}
                      {interval.reason ? ` — ${interval.reason}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {table.truncated && (
              <p className="mt-1 text-xs text-pv-muted">
                Showing the last {table.rows.length} of {table.total} points.
              </p>
            )}
          </div>
        )}
        {statementManifest && manifestVerification && (
          <div
            data-testid="statement-manifest-summary"
            className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-pv-muted"
          >
            <span className={manifestVerification.ok ? "text-pv-accent" : "text-pv-danger"}>
              {manifestVerification.ok ? "Statement verified" : "Statement mismatch"}
            </span>
            <span>
              Realized: {formatAtomicUsdc(manifestVerification.recomputedTotals.realizedPnlAtomic)} {statementManifest.priceConventions.asset}
            </span>
            <span>
              Coverage: {statementManifest.coverage.settledPositions} settled / {statementManifest.coverage.totalPositions} total
            </span>
            <span title={statementManifest.digest}>
              Digest: {statementManifest.digest.slice(0, 12)}…
            </span>
          </div>
        )}
      </div>
    </figure>
  );
}