import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModeIndicator } from './ModeIndicator';

describe('ModeIndicator', () => {
  it('shows Agent Mode and opens a selectable Agent/Plan/Ask panel', () => {
    const onSelectMode = vi.fn();
    render(<ModeIndicator mode="agent" onSelectMode={onSelectMode} />);

    expect(screen.getByRole('button', { name: /Agent Mode/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Agent Mode/i }));

    expect(screen.getByRole('listbox', { name: /Chat modes/i })).toBeTruthy();
    expect(screen.getByText('Plan Mode')).toBeTruthy();
    expect(screen.getByText('Ask Mode')).toBeTruthy();

    fireEvent.click(screen.getByRole('option', { name: /Plan Mode/i }));
    expect(onSelectMode).toHaveBeenCalledWith('plan');
    expect(screen.getByRole('listbox', { name: /Access and Approve All/i })).toBeTruthy();
    expect(screen.getByText('Read Only')).toBeTruthy();
    expect(screen.getByText('Full Access')).toBeTruthy();
    expect(screen.queryByRole('listbox', { name: /Chat modes/i })).toBeNull();
  });

  it('highlights Ask Mode when that mode is active', () => {
    render(<ModeIndicator mode="ask" onSelectMode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Ask Mode/i }));
    const askOption = screen.getByRole('option', { name: /Ask Mode/i });
    expect(askOption.getAttribute('aria-selected')).toBe('true');
  });
});
