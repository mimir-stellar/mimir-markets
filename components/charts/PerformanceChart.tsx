"use client";

/**
 * One line chart for both agent P&L and basket NAV.
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
 * Keyboard and screen-reader users can't hover, so a "Show data" toggle
 * reveals a table of the same points (last MAX_TABLE_ROWS) plus any missing
 * observation intervals.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";

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
  /** The line drawn as "flat": starting NAV, or zero for cumulative P&L. */
  baseline: number;
  label: string;
  valueSuffix?: string;
  emptyMessage?: string;
  invalidMessage?: string;
  height?: number;
  /** Observation coverage metadata (last trusted ledger and missing intervals). */
  coverage?: PerformanceObservationCoverage;
  /** Marks the chart as displaying stale indexed data. */
  stale?: boolean;
}) {
  const gradientId = useId();
  const gapPatternId = useId();
  const tableId = useId();
  const [drawn, setDrawn] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [showData, setShowData] = useState(false);
  const pathRef = useRef<SVGPathElement>(null);

  const allSeries = useMemo<ChartSeries[]>(
    () => (series && series.length > 0 ? series : points ? [{ points }] : []),
    [series, points],
  );
  const missingIntervals = useMemo<PerformanceMissingInterval[]>(
    () => normalizeMissingIntervals(coverage?.missingIntervals),
    [coverage?.missingIntervals],
  );
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

    const timestamps = [
      ...allPoints.map((point) => point.timestamp),
      ...missingIntervals.flatMap((interval) => [interval.startTimestamp, interval.endTimestamp]),
    ];
    const minTs = Math.min(...timestamps);
    const maxTs = Math.max(...timestamps);
    const tsSpan = maxTs - minTs;

    const xForTimestamp = (ts: number, fallbackIndex: number, total: number) => {
      if (tsSpan > 0) {
        return PAD_X + ((ts - minTs) / tsSpan) * (VIEW_WIDTH - PAD_X * 2);
      }
      return PAD_X + (fallbackIndex / Math.max(1, total - 1)) * (VIEW_WIDTH - PAD_X * 2);
    };

    const y = (value: number) =>
      VIEW_HEIGHT - PAD_Y - ((value - min) / span) * (VIEW_HEIGHT - PAD_Y * 2);

    const buildSeriesGeom = (s: ChartSeries) => {
      const pts = s.points;
      if (pts.length === 0) {
        return {
          coords: [] as Array<{ x: number; y: number; timestamp: number; value: number }>,
          segments: [] as Array<{ line: string; area: string }>,
          stroke: s.stroke,
          area: s.area,
        };
      }

      const coords = pts.map((point, index) => ({
        x: xForTimestamp(point.timestamp, index, pts.length),
        y: y(point.value),
        timestamp: point.timestamp,
        value: point.value,
      }));

      // Break the line across missing intervals so a gap is never bridged or
      // mistaken for verified zero performance.
      const observedSegments = splitPointsByMissingIntervals(coords, missingIntervals);
      const segments = observedSegments.map((seg) => {
        if (seg.length === 1) {
          const only = seg[0];
          const stubLeft = Math.max(PAD_X, only.x - 10);
          const stubRight = Math.min(VIEW_WIDTH - PAD_X, only.x + 10);
          const line =
            pts.length === 1 && missingIntervals.length === 0
              ? `M${PAD_X},${only.y.toFixed(1)} L${VIEW_WIDTH - PAD_X},${only.y.toFixed(1)}`
              : `M${stubLeft.toFixed(1)},${only.y.toFixed(1)} L${stubRight.toFixed(1)},${only.y.toFixed(1)}`;
          const areaLeft = pts.length === 1 && missingIntervals.length === 0 ? PAD_X : stubLeft;
          const areaRight =
            pts.length === 1 && missingIntervals.length === 0 ? VIEW_WIDTH - PAD_X : stubRight;
          const area = `${line} L${areaRight.toFixed(1)},${VIEW_HEIGHT - PAD_Y} L${areaLeft.toFixed(1)},${VIEW_HEIGHT - PAD_Y} Z`;
          return { line, area };
        }
        const line = seg
          .map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
          .join(" ");
        const area = `${line} L${seg[seg.length - 1].x.toFixed(1)},${VIEW_HEIGHT - PAD_Y} L${seg[0].x.toFixed(1)},${VIEW_HEIGHT - PAD_Y} Z`;
        return { line, area };
      });

      return { coords, segments, stroke: s.stroke, area: s.area };
    };

    const seriesGeoms = allSeries.map(buildSeriesGeom);
    const gapRects = missingIntervals.map((interval) => {
      const x1 = xForTimestamp(interval.startTimestamp, 0, 2);
      const x2 = xForTimestamp(interval.endTimestamp, 1, 2);
      return {
        x: Math.min(x1, x2),
        width: Math.max(6, Math.abs(x2 - x1)),
        interval,
      };
    });

    return {
      seriesGeoms,
      gapRects,
      baselineY: y(baseline),
      firstTimestamp: minTs,
      lastTimestamp: maxTs,
    };
  }, [allSeries, baseline, invalid, missingIntervals]);

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

  const hasCoverageBanner = Boolean(coverage) || stale;

  if (!geometry) {
    return (
      <div className="border border-pv-ink/[0.1] bg-pv-surface/40 px-4 py-12 text-center text-sm text-pv-muted">
        <p>{emptyMessage}</p>
        {hasCoverageBanner ? (
          <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-pv-muted">
            {coverage ? `Last trusted ledger ${formatTrustedLedger(coverage.lastTrustedLedger)}` : null}
            {coverage && stale ? " · " : null}
            {stale ? "Stale data" : null}
          </p>
        ) : null}
      </div>
    );
  }

  const primary = geometry.seriesGeoms[0];
  const active = hover === null ? primary.coords.length - 1 : hover;
  const activeCoord = primary.coords[active];
  const activePoint = activeCoord ?? primary.coords[primary.coords.length - 1];
  const last = primary.coords[primary.coords.length - 1];
  const up = last.value >= baseline;
  const strokeDefault = up ? "rgb(var(--pv-accent))" : "rgb(var(--pv-danger))";
  const length = pathRef.current?.getTotalLength?.() ?? 2000;
  const table = buildChartTableRows(allSeries[0]?.points ?? [], valueSuffix);

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
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        style={{ height }}
        className="w-full touch-none"
        role="img"
        aria-label={`${label}: ${primary.coords.length} point${primary.coords.length === 1 ? "" : "s"}, ending at ${last.value.toFixed(2)}${valueSuffix}${missingIntervals.length > 0 ? `, ${missingIntervals.length} missing interval${missingIntervals.length === 1 ? "" : "s"}` : ""}${stale ? ", stale data" : ""}`}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={strokeDefault} stopOpacity="0.22" />
            <stop offset="100%" stopColor={strokeDefault} stopOpacity="0" />
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

        {geometry.seriesGeoms.map((seriesGeom, seriesIndex) => {
          const seriesStroke = seriesGeom.stroke ?? strokeDefault;
          const showArea = seriesGeom.area ?? seriesIndex === 0;
          return (
            <g key={`series-${seriesIndex}`}>
              {showArea
                ? seriesGeom.segments.map((seg, segIndex) => (
                    <path
                      key={`area-${seriesIndex}-${segIndex}`}
                      d={seg.area}
                      fill={`url(#${gradientId})`}
                      style={{ opacity: drawn ? 1 : 0, transition: "opacity 600ms ease-out 250ms" }}
                    />
                  ))
                : null}
              {seriesGeom.segments.map((seg, segIndex) => (
                <path
                  key={`line-${seriesIndex}-${segIndex}`}
                  ref={seriesIndex === 0 && segIndex === 0 ? pathRef : undefined}
                  d={seg.line}
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
              ))}
            </g>
          );
        })}

        {/* Hover targets: one invisible column per point, so the pointer never has
            to find a 4px dot. */}
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
        <span>{formatDay(geometry.firstTimestamp)}</span>
        <span className="text-pv-text">
          {formatDay(activePoint.timestamp)} · {activePoint.value.toFixed(2)}{valueSuffix}
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
      </div>
    </figure>
  );
}
