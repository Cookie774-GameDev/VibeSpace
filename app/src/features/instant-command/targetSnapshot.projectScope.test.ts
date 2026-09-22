import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fromLeaves, newLeaf } from '@/features/terminals/paneTree';

const mocks = vi.hoisted(() => ({
  activeProjectId: 'project-b' as string | null,
  sessions: {} as Record<string, unknown>,
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@/stores/auth', () => ({
  useAuthStore: { getState: () => ({ projectId: mocks.activeProjectId }) },
}));
vi.mock('@/features/terminals/terminalLiveCache', () => ({ getLiveTree: vi.fn() }));
vi.mock('@/features/terminals/terminalProjectMove', () => ({
  loadTerminalTreeForProject: vi.fn(),
}));
vi.mock('@/features/terminals/transcriptStore', () => ({
  useTerminalTranscriptStore: { getState: () => ({ sessions: mocks.sessions }) },
}));

import { readLiveTargetSnapshot } from './targetSnapshot';

function native(sessionId: string, projectId: string) {
  return {
    sessionId,
    command: 'opencode',
    cwd: 'C:\\workspace',
    rows: 30,
    cols: 100,
    startedAt: 1,
    projectId,
    processInstanceId: `process-${sessionId}`,
    pid: 4242,
    processStartedAt: 1_723_456_789_000,
    runtimeGeneration: 'runtime-a',
  };
}

function tree(projectId: string) {
  return fromLeaves([
    {
      ...newLeaf(),
      kind: 'leaf' as const,
      id: `${projectId}-pane`,
      sessionId: `${projectId}-tty`,
      projectId,
      command: 'opencode',
    },
  ]);
}

function transcript(projectId: string) {
  return {
    sessionId: `${projectId}-tty`,
    paneId: `${projectId}-pane`,
    projectId,
    agentSlug: null,
    command: 'opencode',
    text: '',
    lastWriteAt: 1,
    bytesSeen: 0,
  };
}

describe('readLiveTargetSnapshot project scope', () => {
  beforeEach(() => {
    mocks.activeProjectId = 'project-b';
    mocks.sessions = { 'project-a-tty': transcript('project-a') };
  });

  it('reads the mission project when the UI has moved to another project', async () => {
    const readTree = vi.fn((projectId: string | null) => tree(projectId ?? 'none'));

    const snapshot = await readLiveTargetSnapshot({
      projectId: 'project-a',
      readTree,
      listNativeSessions: async () => [native('project-a-tty', 'project-a')],
    });

    expect(readTree).toHaveBeenCalledWith('project-a');
    expect(snapshot.map((target) => target.projectId)).toEqual(['project-a']);
    expect(snapshot.map((target) => target.sessionId)).toEqual(['project-a-tty']);
  });

  it('keeps omitted project scope bound to the active UI project', async () => {
    mocks.sessions = { 'project-b-tty': transcript('project-b') };
    const readTree = vi.fn((projectId: string | null) => tree(projectId ?? 'none'));

    const snapshot = await readLiveTargetSnapshot({
      readTree,
      listNativeSessions: async () => [native('project-b-tty', 'project-b')],
    });

    expect(readTree).toHaveBeenCalledWith('project-b');
    expect(snapshot.map((target) => target.projectId)).toEqual(['project-b']);
  });
});
