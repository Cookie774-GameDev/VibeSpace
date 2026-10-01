import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () => undefined,
}));

vi.mock('./TileGrid', () => ({
  TileGrid: ({ tree }: { tree: { id: string } }) => (
    <div data-testid="terminal-grid-fixture" data-tree-id={tree.id} />
  ),
}));

vi.mock('./terminalProjectMove', () => ({
  defaultShell: () => 'powershell',
  loadTerminalTreeForProject: () => ({
    kind: 'leaf',
    id: 'persistent-terminal-pane',
    sessionId: 'terminal-session-1',
  }),
  moveTerminalLeafToProject: vi.fn(),
  saveTerminalTree: vi.fn(),
}));

vi.mock('./terminalLiveCache', () => ({
  captureLiveTree: vi.fn(),
  getLiveTree: () => null,
}));

import { TerminalsPage } from './TerminalsPage';

describe('TerminalsPage cached-route visibility', () => {
  it('unmounts the terminal renderer while hidden and remounts the same pane state', () => {
    const view = render(<TerminalsPage routeVisible />);

    expect(screen.getByTestId('terminal-grid-fixture').getAttribute('data-tree-id')).toBe(
      'persistent-terminal-pane',
    );

    view.rerender(<TerminalsPage routeVisible={false} />);
    expect(screen.queryByTestId('terminal-grid-fixture')).toBeNull();

    view.rerender(<TerminalsPage routeVisible />);
    expect(screen.getByTestId('terminal-grid-fixture').getAttribute('data-tree-id')).toBe(
      'persistent-terminal-pane',
    );
  });
});
