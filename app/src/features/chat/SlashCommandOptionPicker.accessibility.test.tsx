import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SlashCommandOptionPicker } from './SlashCommandOptionPicker';

describe('mode option accessibility', () => {
  it('exposes focusable choices, their descriptions, and the selected mode', () => {
    const saver = { id: 'token-saver', label: 'Token Saver', description: 'Use the lightest supported reasoning and a compact response budget.' };
    const select = vi.fn();
    render(<SlashCommandOptionPicker commandLabel="mode" options={[saver, { id: 'normal', label: 'Normal', metadata: 'active' }]} selectedId="token-saver" query="" onSelect={select} />);
    const choice = screen.getByRole('button', { name: /Token Saver.*lightest supported reasoning/ });
    choice.focus();
    expect(document.activeElement).toBe(choice);
    expect(choice.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: /Normal/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(choice);
    expect(select).toHaveBeenCalledWith(saver);
  });
});
