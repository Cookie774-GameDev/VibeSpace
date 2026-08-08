/**
 * Focused MonoChrome closure regressions for the BarChart tooltip used on
 * route:benchmarks.
 *
 * The chart itself is flat SVG strokes, but its hover tooltip renders a
 * severity pill (`.sev-pill.low`/`.sev-pill.high`), whose severity variants
 * carry a linear-gradient background in globals.css that the shared
 * MonoChrome closure does not flatten. The route must gate that gradient
 * component-locally while keeping the tooltip, labels, and scores intact.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { BenchmarkRow } from './benchmarkData';
import { BarChart } from './BarChart';

const FETCHED_AT = Date.parse('2026-07-11T12:00:00Z');

function makeRow(overrides: Partial<BenchmarkRow>): BenchmarkRow {
  return {
    model: 'Fixture Model',
    provider: 'OpenAI',
    arena_score: 1500,
    ci_low: 1480,
    ci_high: 1520,
    open_source: false,
    source: 'snapshot',
    fetched_at: FETCHED_AT,
    ...overrides,
  };
}

const ROWS: BenchmarkRow[] = [
  makeRow({ model: 'Closed Fixture', arena_score: 1500, open_source: false }),
  makeRow({ model: 'Open Fixture', arena_score: 1450, open_source: true, license: 'MIT' }),
];

const MONO_PILL_GATES = [
  '[html[data-theme=monochrome]_&]:bg-none',
  '[html[data-theme=monochrome]_&]:bg-border-mid',
];

describe('BarChart MonoChrome appearance', () => {
  afterEach(cleanup);

  it('preserves chart role, labels, and scores', () => {
    const { container } = render(<BarChart rows={ROWS} />);
    const svg = container.querySelector<SVGSVGElement>('svg[role="img"]');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('aria-label')).toBe('Bar chart of top 2 models by arena score');
    expect(container.textContent).toContain('Closed Fixture');
    expect(container.textContent).toContain('Open Fixture');
    expect(container.textContent).toContain('1500');
    expect(container.textContent).toContain('1450');
    expect(svg!.style.minWidth).toBe('800px');
    expect(svg!.parentElement?.className).toContain('overflow-x-auto');
  });

  it('renders the empty-state message without a chart', () => {
    render(<BarChart rows={[]} />);
    expect(screen.getByText('No models match the current filters.')).toBeTruthy();
  });

  it('gates the hover tooltip severity-pill gradient while keeping the tooltip', () => {
    const { container } = render(<BarChart rows={ROWS} />);
    const rowGroup = container.querySelector<SVGGElement>('g[style*="cursor"]');
    expect(rowGroup).not.toBeNull();

    fireEvent.mouseMove(rowGroup!, { clientX: 320, clientY: 40 });

    const pill = container.querySelector<HTMLElement>('.sev-pill');
    expect(pill).not.toBeNull();
    for (const gate of MONO_PILL_GATES) {
      expect(pill!.className).toContain(gate);
    }
    expect(pill!.className).toMatch(/(?:^|\s)(?:low|high)(?:\s|$)/u);
    expect(container.querySelector('.cozy-card')).not.toBeNull();

    fireEvent.mouseLeave(rowGroup!);
    expect(container.querySelector('.sev-pill')).toBeNull();
  });
});
