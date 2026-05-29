/**
 * BarChart — pure-SVG horizontal bars for the Benchmarks page.
 *
 * Implementation notes:
 *   - No chart library. Just `<svg>` + `<line>` + `<text>`.
 *   - Width is responsive (`width="100%"`); the viewBox dictates aspect
 *     ratio so the chart scales cleanly.
 *   - Each bar is drawn as a thick `<line>` with `stroke-linecap="round"`,
 *     which visually equals a rounded rectangle. Using a line lets us
 *     animate the reveal via `stroke-dashoffset` cleanly, exactly as the
 *     slice spec calls out.
 *   - `prefers-reduced-motion` short-circuits the animation: bars render
 *     fully extended on first paint with no transition.
 *   - Confidence interval is drawn as a thin white-ish whisker (line +
 *     two caps) on top of the bar, so it stays legible against the fill.
 *   - Hover: a `<g>` per row catches mouse events; the tooltip itself is
 *     a `position: fixed` div outside the SVG so it can use real DOM
 *     styling (cozy-card) and overflow above other elements.
 */
import * as React from 'react';
import type { BenchmarkRow } from './benchmarkData';
import { cn, formatCost, formatTokenCount } from '@/lib/utils';

export interface BarChartProps {
  rows: BenchmarkRow[];
  /** Optional pixel height. If omitted, the chart auto-sizes via viewBox. */
  height?: number;
  className?: string;
}

const VB_WIDTH = 1000;
const ROW_HEIGHT = 28;
const ROW_PADDING = 6;
const ROW_TOTAL = ROW_HEIGHT + ROW_PADDING;
const BAR_THICKNESS = 18;
const LABEL_COL_WIDTH = 200;
const SCORE_COL_WIDTH = 80;
const CHART_X_START = LABEL_COL_WIDTH;
const CHART_X_END = VB_WIDTH - SCORE_COL_WIDTH;
const CHART_WIDTH = CHART_X_END - CHART_X_START;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '\u2026';
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState<boolean>(false);
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return reduced;
}

interface HoverState {
  row: BenchmarkRow;
  clientX: number;
  clientY: number;
}

export function BarChart({ rows, height, className }: BarChartProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [revealed, setRevealed] = React.useState(false);
  const [hover, setHover] = React.useState<HoverState | null>(null);

  React.useEffect(() => {
    // Trigger the entry animation on next frame so the initial
    // dashoffset paints before we transition to zero.
    const id = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(id);
  }, []);

  if (rows.length === 0) {
    return (
      <div className="text-secondary text-muted-foreground py-8 text-center">
        No models match the current filters.
      </div>
    );
  }

  // Pick a baseline a bit below the lowest CI so even the smallest bar
  // has something visible to draw, and round the bounds to nicer ticks.
  const allScores = rows.flatMap((r) => [r.ci_low, r.arena_score, r.ci_high]);
  const rawMin = Math.min(...allScores);
  const rawMax = Math.max(...allScores);
  const minScore = Math.floor((rawMin - 25) / 10) * 10;
  const maxScore = Math.ceil((rawMax + 15) / 10) * 10;
  const range = Math.max(1, maxScore - minScore);

  const totalHeight = rows.length * ROW_TOTAL;

  const scoreToX = (s: number) =>
    CHART_X_START + ((s - minScore) / range) * CHART_WIDTH;

  return (
    <div className={cn('relative w-full', className)}>
      <svg
        viewBox={`0 0 ${VB_WIDTH} ${totalHeight}`}
        width="100%"
        preserveAspectRatio="xMinYMin meet"
        style={{ height: height ?? 'auto', display: 'block' }}
        role="img"
        aria-label={`Bar chart of top ${rows.length} models by arena score`}
      >
        {/* Vertical gridlines at quarter intervals for visual reference */}
        <g aria-hidden="true">
          {[0.25, 0.5, 0.75].map((frac) => {
            const x = CHART_X_START + frac * CHART_WIDTH;
            return (
              <line
                key={frac}
                x1={x}
                x2={x}
                y1={0}
                y2={totalHeight}
                stroke="hsl(var(--border))"
                strokeOpacity={0.4}
                strokeDasharray="2 4"
              />
            );
          })}
        </g>

        {rows.map((row, i) => {
          const rowMid = i * ROW_TOTAL + ROW_HEIGHT / 2 + ROW_PADDING / 2;
          const barEndX = scoreToX(row.arena_score);
          const barLength = barEndX - CHART_X_START;
          const ciLowX = scoreToX(row.ci_low);
          const ciHighX = scoreToX(row.ci_high);
          const fill = row.open_source
            ? 'hsl(var(--sage))'
            : 'hsl(var(--terracotta))';

          // Use length as both stroke-dasharray and initial offset so the
          // bar reveals from x1 outward.
          const dashLen = Math.max(barLength, 1);
          const offset = reducedMotion || revealed ? 0 : dashLen;

          return (
            <g
              key={row.model}
              onMouseEnter={(e) =>
                setHover({ row, clientX: e.clientX, clientY: e.clientY })
              }
              onMouseMove={(e) =>
                setHover({ row, clientX: e.clientX, clientY: e.clientY })
              }
              onMouseLeave={() => setHover(null)}
              style={{ cursor: 'pointer' }}
            >
              {/* Hit-target rect (transparent) over the entire row so hover
                  works in the gaps too. */}
              <rect
                x={0}
                y={i * ROW_TOTAL}
                width={VB_WIDTH}
                height={ROW_TOTAL}
                fill="transparent"
              />

              {/* Label on the left */}
              <text
                x={LABEL_COL_WIDTH - 10}
                y={rowMid}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={13}
                fontFamily="Plus Jakarta Sans, system-ui, sans-serif"
                fill="hsl(var(--foreground))"
              >
                {truncate(row.model, 18)}
              </text>

              {/* Bar */}
              <line
                x1={CHART_X_START}
                y1={rowMid}
                x2={barEndX}
                y2={rowMid}
                stroke={fill}
                strokeWidth={BAR_THICKNESS}
                strokeLinecap="round"
                strokeDasharray={dashLen}
                strokeDashoffset={offset}
                style={{
                  transition: reducedMotion
                    ? 'none'
                    : `stroke-dashoffset 700ms cubic-bezier(0.16, 1, 0.3, 1) ${i * 40}ms`,
                }}
              />

              {/* Confidence interval whisker (drawn after the bar so it
                  paints on top). Only render if there's enough horizontal
                  room for it. */}
              {ciHighX - ciLowX > 4 && (
                <g pointerEvents="none" opacity={reducedMotion || revealed ? 1 : 0}
                   style={{
                     transition: reducedMotion
                       ? 'none'
                       : `opacity 300ms ease-out ${i * 40 + 500}ms`,
                   }}
                >
                  <line
                    x1={ciLowX}
                    x2={ciHighX}
                    y1={rowMid}
                    y2={rowMid}
                    stroke="hsl(var(--cream))"
                    strokeOpacity={0.85}
                    strokeWidth={1.5}
                  />
                  <line
                    x1={ciLowX}
                    x2={ciLowX}
                    y1={rowMid - 5}
                    y2={rowMid + 5}
                    stroke="hsl(var(--cream))"
                    strokeOpacity={0.85}
                    strokeWidth={1.5}
                  />
                  <line
                    x1={ciHighX}
                    x2={ciHighX}
                    y1={rowMid - 5}
                    y2={rowMid + 5}
                    stroke="hsl(var(--cream))"
                    strokeOpacity={0.85}
                    strokeWidth={1.5}
                  />
                </g>
              )}

              {/* Score on the right */}
              <text
                x={CHART_X_END + 10}
                y={rowMid}
                textAnchor="start"
                dominantBaseline="middle"
                fontSize={13}
                fontFamily="JetBrains Mono, ui-monospace, monospace"
                fontWeight={600}
                fill="hsl(var(--foreground))"
              >
                {row.arena_score}
              </text>
            </g>
          );
        })}
      </svg>

      {hover && (
        <div
          className="pointer-events-none fixed z-50"
          style={{
            left: hover.clientX + 14,
            top: hover.clientY + 14,
            maxWidth: 320,
          }}
        >
          <div className="cozy-card !p-3 !py-2.5 text-secondary">
            <div className="flex items-center justify-between gap-3">
              <span className="text-ui-strong text-foreground">
                {hover.row.model}
              </span>
              <span
                className={cn(
                  'sev-pill',
                  hover.row.open_source ? 'low' : 'high',
                )}
              >
                {hover.row.open_source ? 'open' : 'closed'}
              </span>
            </div>
            <div className="mt-1 text-metadata text-muted-foreground font-mono">
              {hover.row.provider}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-metadata">
              <span className="text-muted-foreground">Arena</span>
              <span className="text-foreground font-mono text-right">
                {hover.row.arena_score}
                <span className="text-muted-foreground">
                  {' '}
                  ({hover.row.ci_low}–{hover.row.ci_high})
                </span>
              </span>
              {hover.row.cost_per_1m_input_usd != null && (
                <>
                  <span className="text-muted-foreground">In / 1M</span>
                  <span className="text-foreground font-mono text-right">
                    {formatCost(hover.row.cost_per_1m_input_usd)}
                  </span>
                </>
              )}
              {hover.row.cost_per_1m_output_usd != null && (
                <>
                  <span className="text-muted-foreground">Out / 1M</span>
                  <span className="text-foreground font-mono text-right">
                    {formatCost(hover.row.cost_per_1m_output_usd)}
                  </span>
                </>
              )}
              {hover.row.context_window != null && (
                <>
                  <span className="text-muted-foreground">Context</span>
                  <span className="text-foreground font-mono text-right">
                    {formatTokenCount(hover.row.context_window)}
                  </span>
                </>
              )}
              {hover.row.votes != null && (
                <>
                  <span className="text-muted-foreground">Votes</span>
                  <span className="text-foreground font-mono text-right">
                    {hover.row.votes.toLocaleString()}
                  </span>
                </>
              )}
              {hover.row.license && (
                <>
                  <span className="text-muted-foreground">License</span>
                  <span className="text-foreground text-right">
                    {hover.row.license}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
