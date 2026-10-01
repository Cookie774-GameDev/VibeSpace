import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { Plans } from './Plans';

describe('Plans MonoChrome appearance', () => {
  beforeEach(() => {
    useAuthStore.setState({ plan: 'free', cloudSession: null });
  });

  afterEach(cleanup);

  it('neutralizes gradient, shadow, blur, and motion under exact monochrome only', () => {
    render(<Plans />);

    const root = document.querySelector<HTMLElement>('.mc7f-settings-plans');
    expect(root).not.toBeNull();
    const className = root?.className ?? '';

    // Descendant gates neutralize radius, background-image (gradients),
    // box-shadow (glow), filter blur, and animation across every card.
    expect(className).toContain('[html[data-theme=monochrome]_&_*]:rounded-none');
    expect(className).toContain('[html[data-theme=monochrome]_&_*]:bg-none');
    expect(className).toContain('[html[data-theme=monochrome]_&_*]:shadow-none');
    expect(className).toContain('[html[data-theme=monochrome]_&_*]:!blur-none');
    expect(className).toContain('[html[data-theme=monochrome]_&_*]:!animate-none');
    expect(className).toContain('[html[data-theme=monochrome]_&_*]:!shadow-none');

    // The root's own page gradient is gated off under monochrome but kept for
    // ordinary themes.
    expect(className).toContain('[html[data-theme=monochrome]_&]:bg-none');
    expect(className).toContain('bg-[radial-gradient');

    // Website-parity product copy is preserved.
    expect(screen.getByText('Access first. Features when you want them.')).toBeTruthy();
    expect(screen.getByText(/Two separate ledgers/)).toBeTruthy();
  });

  it('neutralizes the current-plan ring under exact monochrome only', () => {
    render(<Plans />);

    const root = document.querySelector<HTMLElement>('.mc7f-settings-plans');
    expect(root).not.toBeNull();
    const className = root?.className ?? '';

    // The current-plan affordance is a Tailwind ring, which is a box-shadow
    // layer. shadow-none only zeroes --tw-shadow, so the descendant gate must
    // explicitly collapse the ring under exact monochrome to keep the browser
    // zero-shadow invariant.
    expect(className).toContain('[html[data-theme=monochrome]_&_*]:ring-0');

    // Ordinary themes keep the Spark current-plan ring affordance intact.
    const spark = document.querySelector<HTMLElement>('article[aria-label="Spark plan, free"]');
    expect(spark).not.toBeNull();
    expect(spark?.className ?? '').toContain('ring-1 ring-cyan-500/30');
  });
});
