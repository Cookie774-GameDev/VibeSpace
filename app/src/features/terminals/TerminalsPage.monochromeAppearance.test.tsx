import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () => undefined,
}));

vi.mock('./TileGrid', () => ({
  TileGrid: () => <div data-testid="terminal-grid-fixture" />,
}));

vi.mock('./terminalProjectMove', () => ({
  defaultShell: () => 'powershell',
  loadTerminalTreeForProject: () => ({
    kind: 'leaf',
    id: 'terminal-appearance-pane',
    sessionId: null,
  }),
  moveTerminalLeafToProject: vi.fn(),
  saveTerminalTree: vi.fn(),
}));

vi.mock('./terminalLiveCache', () => ({
  captureLiveTree: vi.fn(),
  getLiveTree: () => null,
}));

import { TerminalsPage } from './TerminalsPage';

describe('TerminalsPage MonoChrome appearance', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('replaces the visible Reset hold gradient with a solid MonoChrome progress fill', () => {
    render(<TerminalsPage />);

    const reset = screen.getByRole('button', { name: /Reset/i });
    fireEvent.mouseDown(reset, { button: 0 });
    const fill = reset.querySelector<HTMLElement>('[class*="bg-gradient-to-r"]');

    expect(fill?.className).toContain('w-full');
    expect(fill?.className).toContain('bg-gradient-to-r');
    expect(fill?.className).toContain('[html[data-theme=monochrome]_&]:bg-none');
    expect(fill?.className).toContain('[html[data-theme=monochrome]_&]:bg-accent-copper/30');

    fireEvent.mouseLeave(reset);
  });
});

vi.mock('@/features/tools/terminal-peer-fabric/TerminalFabricOverlay', () => ({ TerminalFabricOverlay: () => null }));
