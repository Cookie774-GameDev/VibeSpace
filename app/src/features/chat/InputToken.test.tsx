import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InputToken } from './InputToken';

describe('InputToken visual variants', () => {
  it('renders confirmed command tokens with a warm animated treatment', () => {
    render(<InputToken type="command" label="/agents: Agents page/editor" />);

    const token = screen.getByText('/agents: Agents page/editor').closest('div');
    expect(token?.className).toContain('jarvis-confirmed-token');
    expect(token?.className).toContain('from-amber');
    expect(token?.className).toMatch(/ring-amber|shadow-/);
    expect(screen.getByText('ok')).toBeTruthy();
  });

  it('renders selected agent mentions as distinct colored tokens', () => {
    render(<InputToken type="agent" label="@builder" />);

    const token = screen.getByText('@builder').closest('div');
    expect(token?.className).toContain('jarvis-agent-token');
    expect(token?.className).toContain('from-cyan');
  });

  it('exposes an accessible activation target without making the remove button trigger it', () => {
    const onActivate = vi.fn();
    const onRemove = vi.fn();
    render(
      <InputToken type="file" label="notes.txt" onActivate={onActivate} onRemove={onRemove} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Preview notes.txt' }));
    expect(onActivate).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});
