import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SlashCommandOptionPicker } from './SlashCommandOptionPicker';

describe('mode option accessibility', () => {
  it('exposes focusable choices, their descriptions, and the selected mode', () => {
    const saver = {
      id: 'token-saver',
      label: 'Token Saver',
      description:
        'Remove exact optional duplicate context while preserving the selected model, effort, and output allowance.',
    };
    const select = vi.fn();
    render(<SlashCommandOptionPicker commandLabel="mode" options={[saver, { id: 'normal', label: 'Normal', metadata: 'active' }]} selectedId="token-saver" query="" onSelect={select} />);
    const choice = screen.getByRole('button', { name: /Token Saver.*exact optional duplicate context/ });
    choice.focus();
    expect(document.activeElement).toBe(choice);
    expect(choice.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: /Normal/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(choice);
    expect(select).toHaveBeenCalledWith(saver);
  });
});
