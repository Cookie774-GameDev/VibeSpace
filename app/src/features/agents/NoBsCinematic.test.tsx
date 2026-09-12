import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NoBsCinematic } from './NoBsCinematic';

describe('NoBsCinematic', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the exact owner-supplied NO BS sequence and completes once', () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    render(<NoBsCinematic open onComplete={onComplete} />);

    expect(screen.getByRole('dialog', { name: 'NO BS activation' })).toBeTruthy();
    expect(
      screen.getByText(
        (_, element) => element?.classList.contains('no-bs-cinematic__sequence-label') === true,
      ).textContent,
    ).toBe('VIBESPACE / NO BS PROTOCOL / LIVE CORRECTION');
    expect(screen.getByText('AI RESPONSE')).toBeTruthy();
    expect(screen.getByText('ERRRM ACTUALLY…')).toBeTruthy();
    expect(screen.getByLabelText('Shut yo focking mouth')).toBeTruthy();
    expect(screen.getByText('PEDANTIC RESPONSE TERMINATED')).toBeTruthy();
    expect(screen.getByText('NO BS // ENABLED')).toBeTruthy();
    expect(screen.getByText('ESC TO SKIP')).toBeTruthy();
    expect(screen.queryByText('RESPONSE PROTOCOL UPDATED')).toBeNull();
    expect(screen.queryByText('DIRECT ANSWERS ACTIVE')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(7_500);
    });
    expect(onComplete).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('applies the cumulative cinematic timing and final composition offset', () => {
    const source = readFileSync(join(__dirname, 'NoBsCinematic.tsx'), 'utf8');
    expect(source).toContain('NO_BS_TIME_SCALE');
    expect(source).toContain('delay * NO_BS_TIME_SCALE');

    const stylesheet = readFileSync(join(__dirname, 'no-bs-cinematic.css'), 'utf8');
    expect(stylesheet).toContain('--no-bs-time-scale: 1.5625');
    expect(stylesheet).toMatch(
      /\.no-bs-cinematic__final-inner\s*\{[^}]*transform:\s*translateY\(35%\);/s,
    );
  });

  it('lets Escape skip safely and reports completion once', () => {
    const onComplete = vi.fn();
    render(<NoBsCinematic open onComplete={onComplete} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('does not mount when closed', () => {
    const { container } = render(<NoBsCinematic open={false} onComplete={() => undefined} />);
    expect(container.innerHTML).toBe('');
  });
});
