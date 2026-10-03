import * as React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalViewProps } from '@/features/terminals';
import { TerminalPanel } from './TerminalPanel';
import type { WorkbenchPanel } from './types';
import { deliverWorkbenchTerminalCommand } from './workbenchTerminalCommands';

const terminalView = vi.fn((props: TerminalViewProps) => (
  <output data-testid="terminal-scope">
    {JSON.stringify({
      paneId: props.paneId,
      projectId: props.projectId,
      cwd: props.cwd,
    })}
  </output>
));

vi.mock('@/features/terminals/TerminalView', () => ({
  TerminalView: (props: TerminalViewProps) => terminalView(props),
}));

vi.mock('@/features/files/projectFiles', () => ({
  getStoredProjectRoot: (projectId: string | null) =>
    projectId === 'project-9' ? 'C:\\Users\\viper\\VibeSpace-UnifiedChungus-Final' : '',
}));

vi.mock('@/stores/auth', () => ({
  useAuthStore: (selector: (state: { projectId: string | null; workspaceId: string; localUserId: string; cloudSession: null }) => unknown) =>
    selector({ projectId: 'project-9', workspaceId: 'workspace-9', localUserId: 'account-9', cloudSession: null }),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => [
  { sessionId: 'live', projectId: 'project-9' },
  { sessionId: 'replacement', projectId: 'project-9' },
] }));
vi.mock('@/lib/db/repositories', () => ({
  workspaceRepo: { getById: async () => ({ owner_id: 'account-9' }) },
  projectRepo: { getById: async () => ({ workspace_id: 'workspace-9' }) },
}));
const settled = async () => { await act(async () => {
  for (let step = 0; step < 8; step++) await Promise.resolve();
}); };

function panel(overrides: Partial<WorkbenchPanel> = {}): WorkbenchPanel {
  return {
    id: 'terminal-panel-9',
    kind: 'terminal',
    title: 'Terminal',
    x: 0,
    y: 0,
    width: 520,
    height: 300,
    z: 1,
    minimized: false,
    status: 'ready',
    settings: {},
    ...overrides,
  };
}

describe('Workbench TerminalPanel scope', () => {
  afterEach(cleanup);
  it('uses the existing pending-command handler and never replays onto a replacement session', async () => {
    const { rerender } = render(
      <TerminalPanel panel={panel({ settings: { resourceId: 'live' } })} onUpdate={vi.fn()} />,
    );
    await settled();
    act(() => {
      expect(
        deliverWorkbenchTerminalCommand('FASTER', [
          { paneId: 'terminal-panel-9', sessionId: 'live', projectId: 'project-9' },
        ]),
      ).toBe(1);
    });
    expect(terminalView.mock.lastCall?.[0].pendingCommand).toBe('FASTER');
    expect(terminalView.mock.lastCall?.[0].pendingCommandId).toEqual(expect.any(Number));
    rerender(
      <TerminalPanel
        panel={panel({ settings: { resourceId: 'replacement' } })}
        onUpdate={vi.fn()}
      />,
    );
    await settled();
    expect(terminalView.mock.lastCall?.[0].pendingCommand).toBeUndefined();
  });
  it('binds the stable panel and active project identity into TerminalView', async () => {
    render(<TerminalPanel panel={panel()} onUpdate={vi.fn()} />);
    await settled();
    expect(terminalView.mock.lastCall?.[0].preserveExisting).toBe(true);

    expect(screen.getByTestId('terminal-scope').textContent).toBe(
      JSON.stringify({
        paneId: 'terminal-panel-9',
        projectId: 'project-9',
        cwd: 'C:\\Users\\viper\\VibeSpace-UnifiedChungus-Final',
      }),
    );
  });

  it('keeps an explicit panel working directory authoritative', async () => {
    render(
      <TerminalPanel
        panel={panel({ settings: { cwd: 'C:\\Users\\viper\\Desktop\\scratch' } })}
        onUpdate={vi.fn()}
      />,
    );
    await settled();

    expect(screen.getByTestId('terminal-scope').textContent).toBe(
      JSON.stringify({
        paneId: 'terminal-panel-9',
        projectId: 'project-9',
        cwd: 'C:\\Users\\viper\\Desktop\\scratch',
      }),
    );
  });
});
