import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useClockStore } from '@/features/clock/clockStore';

const toolState = vi.hoisted(() => ({
  tools: [],
  importMany: vi.fn(() => 0),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
const runActionMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock('./toolStore', () => ({
  useToolStore: (selector: (state: typeof toolState) => unknown) => selector(toolState),
  slugify: (value: string) => value.toLowerCase().replace(/\s+/gu, '-'),
  parseToolStepsJson: vi.fn(() => []),
}));
vi.mock('@/lib/actions', () => ({
  getBuiltinActions: vi.fn(() => []),
  runAction: runActionMock,
}));
vi.mock('./open-in-terminal/OpenInTerminalDialog', () => ({
  OpenInTerminalDialog: () => null,
}));

import { ToolsPage } from './ToolsPage';

describe('ToolsPage Clock integration', () => {
  beforeEach(() => {
    runActionMock.mockClear();
    useClockStore.setState({ entries: [] });
  });
  afterEach(() => {
    cleanup();
    useClockStore.setState({ entries: [] });
  });

  it('lets a user start and clear a local timer without exposing the removed AI action', async () => {
    render(<ToolsPage />);
    expect(screen.getByRole('heading', { name: 'Clock' })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Timer label'), {
      target: { value: 'QA local clock' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Timer minutes' }), {
      target: { value: '0.2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start timer' }));

    await waitFor(() => {
      expect(useClockStore.getState().scheduled()).toHaveLength(1);
    });
    expect(useClockStore.getState().scheduled()[0]).toMatchObject({
      label: 'QA local clock',
      durationMs: 12_000,
      status: 'scheduled',
    });
    expect(runActionMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel QA local clock' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel QA local clock' }));
    expect(useClockStore.getState().scheduled()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Clear done' }));
    expect(useClockStore.getState().entries).toHaveLength(0);
  });
});
