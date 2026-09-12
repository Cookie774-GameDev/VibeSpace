import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageSyncAge } from './UsageSyncAge';

afterEach(() => {
  vi.useRealTimers();
});

describe('UsageSyncAge', () => {
  it('updates only the relative sync label on the five-second display clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    render(<UsageSyncAge updatedAt={10_000} />);
    expect(screen.getByText('Updated just now')).toBeTruthy();

    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByText('Updated 5s ago')).toBeTruthy();
  });
});
