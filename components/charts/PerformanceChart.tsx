"use client";

/**
 * One line chart for both agent P&amp;L and basket NAV.
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
 * reveals a table of the same points (last MAX_TABLE_ROWS). Missing performance
 * samples are explicitly explained without inventing zero returns.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";

import {
  buildPerformanceChartRows,
  formatChartDay,
  MAX_TABLE_ROWS,
} from "@/lib/performance-chart-rows";
import type { PerformanceState } from "@/lib/portfolio-performance";

export interface ChartPoint {
  timestamp: number;
  /** Display units — USDC for both NAV and cumulative P&amp;L. Missing samples are null. */
  value?: number | null;
  state?: PerformanceState;
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

function formatDay(timestamp: number): string {
  return formatChartDay(timestamp);
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
  state: explicitState,
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
  state?: PerformanceState;
}) {
  const gradientId = useId();
  const tableId = useId();
  const [drawn, setDrawn] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [showData, setShowData] = useState(false);
  const pathRef = useRef<SVGPathElement>(null);

  const allSeries = series && series.length > 0 ? series : points ? [{ points }] : [];
  const primaryPoints = points ?? allSeries[0]?.points ?? [];
  const primaryCount = primaryPoints.length;

  const invalid =
    !Number.isFinite(baseline) ||
    allSeries.some((s) =>
      s.points.some(
        (point) =>
          !point ||
          typeof point.timestamp !== "number" ||
          !Number.isFinite(point.timestamp) ||
          point.timestamp <= 0 ||
          (point.value !== null && point.value !== undefined && !Number.isFinite(point.value)),
      ),
    );

  const effectiveState: PerformanceState = explicitState ?? (
    invalid
      ? "unavailable"
      : allSeries.length === 0 || allSeries.every((s) => s.points.length === 0)
        ? "insufficient-history"
        : "available"
  );

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return setDrawn(true);
    // Next frame, so the dashoffset transition has an initial value to move from.
    const frame = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(frame);
  }, [primaryCount]);

  const geometry = useMemo(() => {
    if (effectiveState !== "available" || allSeries.length === 0) return null;
    const allPoints = allSeries.flatMap((s) => s.points);
    const validNumericValues = allPoints
      .map((p) => p.value)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

    if (validNumericValues.length === 0) return null;

    const min = Math.min(baseline, ...validNumericValues);
    const max = Math.max(baseline, ...validNumericValues);
    // A flat series would divide by zero; give it a nominal band so it centres.
    const span = max - min || Math.max(1, Math.abs(max) * 0.02);

    const buildSeriesGeom = (s: ChartSeries) => {
      const pts = s.points;
      if (pts.length === 0) {
        return {
          coords: [] as Array<{ x: number; y: number; timestamp: number; value: number | null }>,
          line: "",
          area: "",
        };
      }
      const x = (index: number) =>
        PAD_X + (index / Math.max(1, pts.length - 1)) * (VIEW_WIDTH - PAD_X * 2);
      const y = (value: number) =>
        VIEW_HEIGHT - PAD_Y - ((value - min) / span) * (VIEW_HEIGHT - PAD_Y * 2);

      const coords = pts.map((point, index) => ({
        x: x(index),
        y: typeof point.value === "number" && Number.isFinite(point.value) ? y(point.value) : y(baseline),
        timestamp: point.timestamp,
        value: point.value ?? null,
      }));

      const numericCoords = coords.filter((c): c is typeof c & { value: number } => c.value !== null);
      const line =
        numericCoords.length === 1
          ? `M${PAD_X},${numericCoords[0].y} L${VIEW_WIDTH - PAD_X},${numericCoords[0].y}`
          : numericCoords
              .map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
              .join(" ");

      const area =
        numericCoords.length > 0
          ? `${line} L${(numericCoords.length === 1 ? VIEW_WIDTH - PAD_X : numericCoords.at(-1)!.x).toFixed(1)},${VIEW_HEIGHT - PAD_Y} L${PAD_X},${VIEW_HEIGHT - PAD_Y} Z`
          : "";

      return { coords, line, area };
    };

    const seriesGeoms = allSeries.map(buildSeriesGeom);
    const y = (value: number) =>
      VIEW_HEIGHT - PAD_Y - ((value - min) / span) * (VIEW_HEIGHT - PAD_Y * 2);

    return {
      seriesGeoms,
      baselineY: y(baseline),
      firstTimestamp: allPoints[0].timestamp,
      lastTimestamp: allPoints[allPoints.length - 1].timestamp,
    };
  }, [allSeries, baseline, effectiveState]);

  if (effectiveState === "unavailable") {
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

  if (effectiveState === "insufficient-history" || !geometry) {
    return (
      <div
        data-state="insufficient-history"
        className="border border-pv-ink/[0.1] bg-pv-surface/40 px-4 py-12 text-center text-sm text-pv-muted"
      >
        {emptyMessage}
      </div>
    );
  }

  const primary = geometry.seriesGeoms[0];
  const active = hover === null ? primary.coords.length - 1 : hover;
  const activeCoord = primary.coords[active] ?? primary.coords[primary.coords.length - 1];
  const activePoint = activeCoord ?? { timestamp: 0, value: null };
  const last = primary.coords[primary.coords.length - 1];
  const lastValue = last?.value ?? baseline;
  const up = lastValue >= baseline;
  const strokeDefault = up ? "rgb(var(--pv-accent))" : "rgb(var(--pv-danger))";
  const length = pathRef.current?.getTotalLength?.() ?? 2000;
  const table = buildPerformanceChartRows(primaryPoints, valueSuffix, { state: effectiveState });

  return (
    <figure data-state="available" className="border border-pv-ink/[0.1] bg-pv-surface/40 p-3">
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        style={{ height }}
        className="w-full touch-none"
        role="img"
        aria-label={`${label}: ${primary.coords.length} point${primary.coords.length === 1 ? "" : "s"}, ending at ${typeof lastValue === "number" ? lastValue.toFixed(2) : "unavailable"}${valueSuffix}`}
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

        <path
          d={geometry.area}
          fill={`url(#${gradientId})`}
          style={{ opacity: drawn ? 1 : 0, transition: "opacity 600ms ease-out 250ms" }}
        />
        <path
          ref={pathRef}
          d={geometry.line}
          fill="none"
          stroke={allSeries[0]?.stroke ?? strokeDefault}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            strokeDasharray: length,
            strokeDashoffset: drawn ? 0 : length,
            transition: "stroke-dasharray 900ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        />

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
          {formatDay(activePoint.timestamp)} ·{" "}
          {activePoint.value !== null && Number.isFinite(activePoint.value)
            ? `${activePoint.value.toFixed(2)}${valueSuffix}`
            : "Unavailable"}
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
