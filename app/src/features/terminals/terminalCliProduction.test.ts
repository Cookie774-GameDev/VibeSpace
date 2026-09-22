import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackendTerminalInfo } from './restoreSession';
import type { ContextMapRecord } from '@/features/context';
import {
  readCaoTerminalExecutionIdentity,
  resetCaoTerminalExecutionIdentityForTests,
} from '@/features/cao/terminalExecutionIdentity';
import {
  createProductionTerminalCliRuntimeDependencies,
  resolvePersistedTerminalContextEntity,
  searchPersistedTerminalContext,
} from './terminalCliProduction';
import { createTerminalCliRuntime, parseTerminalCliFrontendRequest } from './terminalCliRuntime';
import { productionContextGateway } from '@/features/context/gateway/productionContextGateway';
import {
  mintTerminalContextBridgeIdentity,
  resetTerminalContextBridgeIdentitiesForTests,
  revokeTerminalContextBridgeIdentity,
} from './terminalContextBridgeIdentity';

const nativeMocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: nativeMocks.invoke }));

afterEach(() => {
  vi.restoreAllMocks();
  nativeMocks.invoke.mockReset();
  resetCaoTerminalExecutionIdentityForTests();
  resetTerminalContextBridgeIdentitiesForTests();
});

function nativeTerminal(overrides: Partial<BackendTerminalInfo> = {}): BackendTerminalInfo {
  return {
    sessionId: 'tty-a',
    command: 'opencode.exe',
    cwd: 'C:\\VibeSpace',
    rows: 24,
    cols: 80,
    startedAt: 1_780_000_000_000,
    projectId: 'project-a',
    processInstanceId: 'ptyproc-a',
    pid: 42,
    processStartedAt: 1_780_000_000_000,
    runtimeGeneration: 'runtime-a',
    ...overrides,
  };
}

function map(
  id: string,
  nodes: ContextMapRecord['tree']['nodes'],
  status: ContextMapRecord['status'] = 'active',
): ContextMapRecord {
  return {
    id,
    projectId: 'project-a',
    rootDir: 'C:\\VibeSpace',
    name: id,
    status,
    createdAt: 1,
    updatedAt: 2,
    sourceType: 'local_folder',
    tree: {
      version: 1,
      projectId: 'project-a',
      rootDir: 'C:\\VibeSpace',
      generatedAt: 2,
      model: 'local-fallback',
      fileCount: 1,
      totalBytes: 10,
      summary: 'Map summary',
      nodes,
    },
  };
}

describe('terminal CLI production Context projection', () => {
  const maps = [
    map('map-a', [
      {
        id: 'root-a',
        title: 'Application',
        kind: 'area',
        summary: 'Frontend entry points',
        children: [
          {
            id: 'file-app',
            title: 'App.tsx',
            kind: 'file',
            path: 'src/App.tsx',
            summary: 'Application bootstrap and terminal runtime host',
            importance: 5,
          },
        ],
      },
    ]),
    map('map-b', [
      {
        id: 'file-other',
        title: 'Other App',
        kind: 'file',
        path: 'src/App.tsx',
        summary: 'A duplicate path in another map',
      },
    ]),
    map(
      'deleted-map',
      [
        {
          id: 'deleted-secret',
          title: 'Deleted secret',
          kind: 'file',
          path: 'secret.txt',
          summary: 'must not be searched',
        },
      ],
      'deleted',
    ),
  ];

  it('searches only selected active maps and ranks title, path, summary, and importance', () => {
    expect(searchPersistedTerminalContext(maps, ['map-a'], 'app runtime')).toEqual([
      {
        id: 'file-app',
        label: 'App.tsx',
        path: 'src/App.tsx',
        mapId: 'map-a',
      },
    ]);
    expect(searchPersistedTerminalContext(maps, ['deleted-map'], 'secret')).toEqual([]);
  });

  it('resolves an exact id but fails closed when a normalized path is ambiguous', () => {
    expect(resolvePersistedTerminalContextEntity(maps, 'file-app')).toEqual({
      id: 'file-app',
      label: 'App.tsx',
      path: 'src/App.tsx',
      mapId: 'map-a',
    });
    expect(resolvePersistedTerminalContextEntity(maps, 'SRC\\APP.TSX')).toBeNull();
  });

  it('cancels an in-flight Gateway ask when its terminal identity is revoked', async () => {
    const identity = mintTerminalContextBridgeIdentity(
      {
        accountId: 'account-1',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        paneId: 'pane-1',
        access: 'read',
      },
      { now: () => 100, createId: () => 'terminal-run-1' },
    );
    let rejectAsk!: (error: DOMException) => void;
    const ask = vi.spyOn(productionContextGateway, 'ask').mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectAsk = reject;
        }),
    );
    const cancel = vi.spyOn(productionContextGateway, 'cancel').mockImplementation(() => {
      rejectAsk(new DOMException('cancelled', 'AbortError'));
    });
    const pending = createProductionTerminalCliRuntimeDependencies().askContext({
      requestId: 'request-1',
      question: 'Find the prior decision.',
      identity,
    });
    await vi.waitFor(() => expect(ask).toHaveBeenCalledOnce());

    revokeTerminalContextBridgeIdentity(identity.identityId);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledWith('request-1');
  });

  it('records a structured OpenCode receipt only after the exact native process is verified', async () => {
    const dependencies = createProductionTerminalCliRuntimeDependencies({
      readAccountId: () => 'account-a',
      authorizeProject: async (accountId, projectId) =>
        accountId === 'account-a' && projectId === 'project-a',
      listNativeTerminals: async () => [nativeTerminal()],
    });

    await dependencies.recordCaoTerminalIdentity({
      terminalSessionId: 'tty-a',
      paneId: 'pane-a',
      projectId: 'project-a',
      identity: {
        opencodeSessionId: 'ses-opencode-a',
        providerId: 'openrouter',
        modelId: 'deepseek/deepseek-v4-flash',
        variant: 'high',
        processInstanceId: 'ptyproc-a',
      },
    });

    expect(
      readCaoTerminalExecutionIdentity({
        accountId: 'account-a',
        projectId: 'project-a',
        paneId: 'pane-a',
        sessionId: 'tty-a',
        process: {
          projectId: 'project-a',
          processInstanceId: 'ptyproc-a',
          pid: 42,
          processStartedAt: 1_780_000_000_000,
          runtimeGeneration: 'runtime-a',
        },
      }),
    ).toMatchObject({
      openCodeSessionId: 'ses-opencode-a',
      observedProviderId: 'openrouter',
      observedModelId: 'deepseek/deepseek-v4-flash',
      variant: 'high',
    });
  });

  it('routes an authenticated CLI request through production verification into the registry', async () => {
    const project = { id: 'project-a', name: 'VibeSpace', workspaceId: 'workspace-a' } as const;
    const runtime = createTerminalCliRuntime({
      ...createProductionTerminalCliRuntimeDependencies({
        readAccountId: () => 'account-a',
        authorizeProject: async (accountId, projectId) =>
          accountId === 'account-a' && projectId === 'project-a',
        listNativeTerminals: async () => [nativeTerminal()],
      }),
      currentProject: () => project,
      resolveProject: async (projectId) => (projectId === project.id ? project : null),
    });

    await expect(
      runtime.execute(
        parseTerminalCliFrontendRequest({
          protocolVersion: 1,
          requestId: 'request-cao-identity',
          terminalSessionId: 'tty-a',
          paneId: 'pane-a',
          projectId: 'project-a',
          runIdentity: null,
          method: 'cao.identity.publish',
          params: {
            opencodeSessionId: 'ses-opencode-a',
            providerId: 'openrouter',
            modelId: 'deepseek/deepseek-v4-flash',
            variant: 'high',
            processInstanceId: 'ptyproc-a',
          },
        }),
      ),
    ).resolves.toMatchObject({ ok: true, code: 'ok' });

    expect(
      readCaoTerminalExecutionIdentity({
        accountId: 'account-a',
        projectId: 'project-a',
        paneId: 'pane-a',
        sessionId: 'tty-a',
        process: {
          projectId: 'project-a',
          processInstanceId: 'ptyproc-a',
          pid: 42,
          processStartedAt: 1_780_000_000_000,
          runtimeGeneration: 'runtime-a',
        },
      }),
    ).toMatchObject({ openCodeSessionId: 'ses-opencode-a' });
  });

  it.each([
    ['wrong terminal session', { sessionId: 'tty-other' }],
    ['wrong process instance', { processInstanceId: 'ptyproc-other' }],
    ['malformed native runtime generation', { runtimeGeneration: '' }],
  ])('rejects %s before the registry can record a receipt', async (_label, mismatch) => {
    const dependencies = createProductionTerminalCliRuntimeDependencies({
      readAccountId: () => 'account-a',
      authorizeProject: async () => true,
      listNativeTerminals: async () => [nativeTerminal(mismatch)],
    });

    await expect(
      dependencies.recordCaoTerminalIdentity({
        terminalSessionId: 'tty-a',
        paneId: 'pane-a',
        projectId: 'project-a',
        identity: {
          opencodeSessionId: 'ses-opencode-a',
          providerId: 'openai',
          modelId: 'gpt-5.6-luna',
          variant: 'high',
          processInstanceId: 'ptyproc-a',
        },
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    expect(
      readCaoTerminalExecutionIdentity({
        accountId: 'account-a',
        projectId: 'project-a',
        paneId: 'pane-a',
        sessionId: 'tty-a',
        process: {
          projectId: 'project-a',
          processInstanceId: 'ptyproc-a',
          pid: 42,
          processStartedAt: 1_780_000_000_000,
          runtimeGeneration: 'runtime-a',
        },
      }),
    ).toBeUndefined();
  });

  it('rejects a foreign account before reading terminal identity into the registry', async () => {
    const dependencies = createProductionTerminalCliRuntimeDependencies({
      readAccountId: () => 'account-foreign',
      authorizeProject: async (accountId) => accountId === 'account-owner',
      listNativeTerminals: async () => [nativeTerminal()],
    });

    await expect(
      dependencies.recordCaoTerminalIdentity({
        terminalSessionId: 'tty-a',
        paneId: 'pane-a',
        projectId: 'project-a',
        identity: {
          opencodeSessionId: 'ses-opencode-a',
          providerId: 'openai',
          modelId: 'gpt-5.6-luna',
          variant: 'high',
          processInstanceId: 'ptyproc-a',
        },
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});
