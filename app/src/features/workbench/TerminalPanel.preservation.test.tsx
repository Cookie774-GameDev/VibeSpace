// @vitest-environment jsdom
import * as React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalPanel } from './TerminalPanel';
import { resolveTerminalRestoreSession, type BackendTerminalInfo } from '@/features/terminals/restoreSession';
import type { TerminalViewProps } from '@/features/terminals/types';
import type { WorkbenchPanel } from './types';
import { deliverWorkbenchTerminalCommand } from './workbenchTerminalCommands';

const fixture = vi.hoisted(() => ({
  projectId: 'S61B1-A' as string | null, workspaceId: 'S61B1-workspace', localUserId: 'S61B1-account',
  owner: 'S61B1-account', projectWorkspace: 'S61B1-workspace',
  sessions: [] as BackendTerminalInfo[], invoke: vi.fn(), view: vi.fn(), spawn: vi.fn(),
  mounted: vi.fn(), unmounted: vi.fn(), updates: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: fixture.invoke }));
vi.mock('@/stores/auth', () => ({ useAuthStore: (select: (state: unknown) => unknown) => select({
  projectId: fixture.projectId, workspaceId: fixture.workspaceId,
  localUserId: fixture.localUserId, cloudSession: null,
}) }));
vi.mock('@/lib/db/repositories', () => ({
  workspaceRepo: { getById: async () => ({ owner_id: fixture.owner }) },
  projectRepo: { getById: async () => ({ workspace_id: fixture.projectWorkspace }) },
}));
vi.mock('@/features/files/projectFiles', () => ({ getStoredProjectRoot: () => String.raw`C:\S61B1-project` }));
// These are ordinary PowerShell sessions, not interactive agent TUIs. Keep the
// actual project/session restore resolver without loading unrelated agent repos.
vi.mock('@/features/terminals/agentPromptDelivery', () => ({ detectInteractiveAgentCli: () => null }));
vi.mock('@/features/terminals/TerminalView', () => ({ TerminalView: (props: TerminalViewProps) => {
  fixture.view(props);
  React.useEffect(() => {
    fixture.mounted(props.sessionId);
    // Exercise the actual restore decision: rendering the old A resource with
    // B's project causes the production resolver to classify it as a new spawn.
    const decision = resolveTerminalRestoreSession({ existingSessionId: props.sessionId,
      paneId: props.paneId, projectId: props.projectId, activeSessions: fixture.sessions,
      transcripts: {}, readActiveScreenSnapshot: () => '' });
    if (decision.kind === 'spawn') {
      const sessionId = fixture.spawn();
      fixture.sessions.push(session(sessionId, props.projectId ?? null));
      props.onReady?.(sessionId);
    } else props.onReady?.(decision.sessionId);
    return () => { fixture.unmounted(props.sessionId); };
    // Match TerminalView's mount-only restoration boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <output data-testid="S61B1-terminal">{props.sessionId ?? 'fresh'}</output>;
} }));

function session(sessionId: string, projectId: string | null): BackendTerminalInfo {
  return { sessionId, projectId, command: 'powershell', cwd: String.raw`C:\S61B1-project`,
    rows: 24, cols: 92, startedAt: 1, pid: 991, processInstanceId: `instance-${sessionId}`,
    processStartedAt: 1, runtimeGeneration: 'S61B1-generation' };
}
function panel(resourceId: string | null = 'S61B1-live-A'): WorkbenchPanel {
  return { id: 'S61B1-pane', kind: 'terminal', title: 'Terminal', x: 0, y: 0,
    width: 520, height: 300, z: 1, minimized: false, status: 'ready',
    settings: { resourceId: resourceId ?? undefined, note: 'S61B1 unsaved note', cwd: String.raw`C:\S61B1-project` } };
}
function Harness({ initial }: { initial: WorkbenchPanel }) {
  const [current, setCurrent] = React.useState(initial);
  return <><output data-testid="S61B1-panel">{JSON.stringify(current.settings)}</output>
    <TerminalPanel panel={current} onUpdate={patch => {
      fixture.updates(patch); setCurrent(previous => ({ ...previous, ...patch,
        settings: { ...previous.settings, ...patch.settings } }));
    }} /></>;
}
const settle = async () => { await act(async () => {
  for (let step = 0; step < 8; step++) await Promise.resolve();
}); };
const saved = () => JSON.parse(screen.getByTestId('S61B1-panel').textContent!);

describe('Workbench terminal remount preservation', () => {
  beforeEach(() => {
    fixture.projectId = 'S61B1-A'; fixture.workspaceId = 'S61B1-workspace';
    fixture.localUserId = fixture.owner = 'S61B1-account';
    fixture.projectWorkspace = 'S61B1-workspace';
    fixture.sessions = [session('S61B1-live-A', 'S61B1-A')];
    fixture.invoke.mockReset(); fixture.invoke.mockImplementation(async command => {
      expect(command).toBe('terminal_list'); return fixture.sessions;
    });
    fixture.view.mockClear(); fixture.mounted.mockClear(); fixture.unmounted.mockClear();
    fixture.updates.mockClear(); fixture.spawn.mockReset(); fixture.spawn.mockReturnValue('S61B1-new');
  });
  afterEach(cleanup);
  it('preserves the exact live A resource when remounted under project B', async () => {
    const original = panel(); const first = render(<Harness initial={original} />); await settle();
    expect(fixture.view.mock.lastCall?.[0].projectId).toBe('S61B1-A');
    first.unmount(); fixture.projectId = 'S61B1-B';
    render(<Harness initial={original} />); await settle();
    expect(screen.queryByTestId('S61B1-terminal')).toBeNull();
    expect(saved()).toEqual(original.settings);
    expect(fixture.spawn).not.toHaveBeenCalled(); expect(fixture.updates).not.toHaveBeenCalled();
    expect(fixture.sessions.map(row => row.sessionId)).toEqual(['S61B1-live-A']);
  });
  it('reconnects when returning to A and never replays an old pending command', async () => {
    const original = panel(); const view = render(<Harness initial={original} />); await settle();
    act(() => { expect(deliverWorkbenchTerminalCommand('S61B1 marker', [{
      paneId: original.id, sessionId: 'S61B1-live-A', projectId: 'S61B1-A',
    }])).toBe(1); });
    expect(fixture.view.mock.lastCall?.[0].pendingCommand).toBe('S61B1 marker');
    fixture.projectId = 'S61B1-B'; view.rerender(<Harness initial={original} />); await settle();
    expect(screen.queryByTestId('S61B1-terminal')).toBeNull();
    fixture.projectId = 'S61B1-A'; view.rerender(<Harness initial={original} />); await settle();
    expect(fixture.view.mock.lastCall?.[0].sessionId).toBe('S61B1-live-A');
    expect(fixture.view.mock.lastCall?.[0].pendingCommand).toBeUndefined();
    expect(fixture.spawn).not.toHaveBeenCalled(); expect(saved()).toEqual(original.settings);
  });
  it('preserves a legacy session whose native project is unknown', async () => {
    fixture.sessions[0] = session('S61B1-live-A', null);
    const original = panel(); render(<Harness initial={original} />); await settle();
    expect(fixture.view).not.toHaveBeenCalled(); expect(fixture.spawn).not.toHaveBeenCalled();
    expect(saved()).toEqual(original.settings); expect(fixture.updates).not.toHaveBeenCalled();
  });
  it('does not turn missing native metadata into a replacement session', async () => {
    fixture.sessions = []; const original = panel(); render(<Harness initial={original} />); await settle();
    expect(fixture.view).not.toHaveBeenCalled(); expect(saved()).toEqual(original.settings);
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
  it('rejects a foreign workspace owner despite matching native project metadata', async () => {
    fixture.owner = 'S61B1-foreign'; render(<Harness initial={panel()} />); await settle();
    expect(fixture.invoke).not.toHaveBeenCalled(); expect(fixture.view).not.toHaveBeenCalled();
    expect(fixture.updates).not.toHaveBeenCalled(); expect(fixture.spawn).not.toHaveBeenCalled();
  });
  it('rejects a project outside the active workspace', async () => {
    fixture.projectWorkspace = 'S61B1-foreign-workspace';
    render(<Harness initial={panel()} />); await settle();
    expect(fixture.invoke).not.toHaveBeenCalled(); expect(fixture.view).not.toHaveBeenCalled();
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
  it('ignores late A admission after switching to B', async () => {
    let finish!: (rows: BackendTerminalInfo[]) => void;
    fixture.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const original = panel(); const view = render(<Harness initial={original} />); await settle();
    fixture.projectId = 'S61B1-B'; view.rerender(<Harness initial={original} />); await settle();
    await act(async () => { finish(fixture.sessions); }); await settle();
    expect(fixture.view).not.toHaveBeenCalled(); expect(saved()).toEqual(original.settings);
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
  it('creates a genuinely fresh terminal once without remounting it when onReady publishes its ID', async () => {
    render(<Harness initial={panel(null)} />); await settle();
    expect(fixture.spawn).toHaveBeenCalledTimes(1); expect(fixture.mounted).toHaveBeenCalledTimes(1);
    expect(fixture.unmounted).not.toHaveBeenCalled(); expect(saved().resourceId).toBe('S61B1-new');
    expect(saved().note).toBe('S61B1 unsaved note');
    expect(fixture.invoke).not.toHaveBeenCalled();
  });
  it('refuses a replacement onReady ID for an existing resource', async () => {
    const original = panel(); render(<Harness initial={original} />); await settle();
    act(() => { fixture.view.mock.lastCall?.[0].onReady('S61B1-wrong'); });
    expect(saved()).toEqual(original.settings); expect(fixture.updates).not.toHaveBeenCalled();
  });
  it('fails closed when the native metadata read fails', async () => {
    fixture.invoke.mockRejectedValue(new Error('S61B1 backend unavailable'));
    const original = panel(); render(<Harness initial={original} />); await settle();
    expect(fixture.view).not.toHaveBeenCalled(); expect(fixture.spawn).not.toHaveBeenCalled();
    expect(saved()).toEqual(original.settings); expect(fixture.updates).not.toHaveBeenCalled();
  });
  it('disconnects the view on account transition without rebinding or replacing its resource', async () => {
    const original = panel(); const view = render(<Harness initial={original} />); await settle();
    fixture.localUserId = 'S61B1-other-account';
    view.rerender(<Harness initial={original} />); await settle();
    expect(screen.queryByTestId('S61B1-terminal')).toBeNull();
    expect(saved()).toEqual(original.settings); expect(fixture.spawn).not.toHaveBeenCalled();
  });
  it('ignores stale onReady from A after its scope changed to B', async () => {
    const original = panel(); const view = render(<Harness initial={original} />); await settle();
    const ready = fixture.view.mock.lastCall?.[0].onReady;
    fixture.projectId = 'S61B1-B'; view.rerender(<Harness initial={original} />); await settle();
    act(() => { ready('S61B1-wrong'); });
    expect(saved()).toEqual(original.settings); expect(fixture.updates).not.toHaveBeenCalled();
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
  it('retains genuine fresh workspace-only terminal creation before a project is selected', async () => {
    fixture.projectId = null;
    render(<Harness initial={panel(null)} />); await settle();
    expect(fixture.spawn).toHaveBeenCalledTimes(1); expect(saved().resourceId).toBe('S61B1-new');
    expect(fixture.mounted).toHaveBeenCalledTimes(1); expect(fixture.unmounted).not.toHaveBeenCalled();
    expect(fixture.sessions.find(row => row.sessionId === 'S61B1-new')?.projectId).toBeNull();
    expect(fixture.invoke).not.toHaveBeenCalled();
  });
});
