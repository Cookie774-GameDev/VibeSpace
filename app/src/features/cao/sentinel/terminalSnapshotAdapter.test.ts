import { describe, expect, it, vi } from 'vitest';
import type { JarvisDexie } from '@/lib/db/database';
import type { CaoExecutionIdentity } from '../executionProfile';
import type { CaoTerminalExecutionIdentityReceipt } from '../terminalExecutionIdentity';
import { createCaoTerminalSnapshotAdapter } from './terminalSnapshotAdapter';

const identity: CaoExecutionIdentity = {
  backend: 'opencode',
  providerId: 'openai',
  connectionId: 'opencode-cli',
  modelId: 'openai/gpt-5.6-luna',
  reasoningEffort: 'high',
};

const binding = {
  accountId: 'account-1',
  projectId: 'project-1',
  paneId: 'pane-1',
  sessionId: 'terminal-1',
  process: {
    projectId: 'project-1',
    processInstanceId: 'process-1',
    pid: 123,
    processStartedAt: 100,
    runtimeGeneration: 'runtime-1',
  },
};

const receipt: CaoTerminalExecutionIdentityReceipt = {
  source: 'opencode-cli-event',
  observedAt: 100,
  binding,
  identity,
  openCodeSessionId: 'opencode-session-1',
  observedProviderId: 'openai',
  observedModelId: 'gpt-5.6-luna',
  variant: 'high',
};

function databaseFor(status: 'running' | 'detached' | 'exited' = 'running'): JarvisDexie {
  return {
    terminal_sessions: {
      get: vi.fn(async () => ({
        id: 'terminal-1',
        workspace_id: 'workspace-1',
        project_id: 'project-1',
        title: 'Target',
        shell_command: 'opencode',
        shell_args: [],
        status,
        cols: 80,
        rows: 24,
        last_active_at: 100,
        created_at: 1,
        one_shot: false,
      })),
    },
    workspaces: { get: vi.fn(async () => ({ id: 'workspace-1', owner_id: 'account-1' })) },
  } as unknown as JarvisDexie;
}

const request = {
  missionId: 'mission-1',
  accountId: 'account-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  targetId: 'terminal-1',
  assignment: 'Observe the target',
  ownedPaths: ['src'],
};

describe('CAO terminal snapshot identity', () => {
  it('uses the current authenticated terminal receipt identity', async () => {
    const readSnapshot = createCaoTerminalSnapshotAdapter({
      database: databaseFor(),
      identity,
      readExecutionIdentity: () => receipt,
      now: () => 100,
    });

    await expect(readSnapshot(request)).resolves.toMatchObject({
      backend: identity.backend,
      providerId: identity.providerId,
      modelId: identity.modelId,
      reasoningEffort: identity.reasoningEffort,
    });
  });

  it('fails closed when the native receipt is unavailable after process replacement', async () => {
    let current: CaoTerminalExecutionIdentityReceipt | undefined = receipt;
    const readSnapshot = createCaoTerminalSnapshotAdapter({
      database: databaseFor(),
      identity,
      readExecutionIdentity: () => current,
    });

    await expect(readSnapshot(request)).resolves.toMatchObject({
      backend: identity.backend,
      providerId: identity.providerId,
      modelId: identity.modelId,
      reasoningEffort: identity.reasoningEffort,
    });
    current = undefined;
    await expect(readSnapshot(request)).rejects.toThrow(
      'cao_terminal_snapshot_identity_unavailable',
    );
  });

  it.each([
    ['foreign account', { ...receipt, binding: { ...binding, accountId: 'account-2' } }],
    ['foreign project', { ...receipt, binding: { ...binding, projectId: 'project-2' } }],
    ['foreign session', { ...receipt, binding: { ...binding, sessionId: 'terminal-2' } }],
    ['foreign model', { ...receipt, identity: { ...identity, modelId: 'openai/gpt-5.6-sol' } }],
  ])('rejects %s receipt identity', async (_label, foreignReceipt) => {
    const readSnapshot = createCaoTerminalSnapshotAdapter({
      database: databaseFor(),
      identity,
      readExecutionIdentity: () => foreignReceipt,
    });

    await expect(readSnapshot(request)).rejects.toThrow(
      /cao_terminal_snapshot_identity_(mismatch|unavailable)/,
    );
  });

  it('fails closed when no receipt reader is wired', async () => {
    const readSnapshot = createCaoTerminalSnapshotAdapter({
      database: databaseFor(),
      identity,
    });

    await expect(readSnapshot(request)).rejects.toThrow(
      'cao_terminal_snapshot_identity_unavailable',
    );
  });
});
