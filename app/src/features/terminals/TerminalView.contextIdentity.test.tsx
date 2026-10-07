import 'fake-indexeddb/auto';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProjectId, WorkspaceId } from '@/types';
import { db, createJarvisDb } from '@/lib/db';
import Dexie from 'dexie';
import { projectRepo, workspaceRepo } from '@/lib/db/repositories';
const fake = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(async () => () => {}),
  briefing: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: fake.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: fake.listen }));
vi.mock('./terminalClipboard', () => ({
  installTerminalPaste: () => () => {},
  formatTerminalClipboard: () => '',
}));
vi.mock('./TerminalCommandPalette', () => ({ TerminalCommandPalette: () => null }));
vi.mock('./terminalWarmIdleScene', () => ({ TerminalWarmIdleScene: () => null }));
vi.mock('./agentPromptDelivery', async (original) => ({
  ...(await original<typeof import('./agentPromptDelivery')>()),
  deliverAgentTerminalContext: fake.briefing,
}));
vi.mock('./agentCoordinationClient', () => ({
  heartbeatCoordinatedTerminal: async () => {},
  inferAgentProvider: () => null,
  loadCoordinationSummary: async () => '',
  registerCoordinatedTerminal: async () => {},
}));
vi.mock('xterm', () => ({
  Terminal: class {
    rows = 30;
    cols = 100;
    options: Record<string, unknown> = { fontFamily: 'monospace' };
    buffer = {
      active: {
        baseY: 0,
        cursorY: 0,
        cursorX: 0,
        viewportY: 0,
        length: 0,
        getLine: () => undefined,
      },
    };
    loadAddon() {}
    open() {}
    onScroll() {
      return { dispose() {} };
    }
    onData() {}
    write(_data: string, done?: () => void) {
      done?.();
    }
    dispose() {}
    scrollToTop() {}
    scrollToBottom() {}
    refresh() {}
    focus() {}
    getSelection() {
      return '';
    }
  },
}));
vi.mock('xterm-addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock('xterm-addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('xterm-addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}));
import { TileGrid } from './TileGrid';
import { newLeaf } from './paneTree';
import {
  authorizeTerminalContextBridgeIdentity,
  resetTerminalContextBridgeIdentitiesForTests,
} from './terminalContextBridgeIdentity';
import { useAuthStore } from '@/stores/auth';
import {
  setStoredProjectRoot,
  projectStorageKey,
  ROOT_PREFIX,
} from '@/features/files/projectFiles';
const projectId = 'n14-owned-project',
  workspaceId = 'n14-owned-workspace',
  root = 'C:/n14-owned-project';
beforeEach(async () => {
  localStorage.clear();
  resetTerminalContextBridgeIdentitiesForTests();
  fake.invoke.mockReset();
  fake.briefing.mockClear();
  await db.projects.clear();
  await db.workspaces.clear();
  await db.workspaces.put({
    id: workspaceId as WorkspaceId,
    name: 'Synthetic owned workspace',
    owner_id: 'n14-owned-account',
    created_at: 1,
    updated_at: 1,
  });
  await db.projects.put({
    id: projectId as ProjectId,
    workspace_id: workspaceId as WorkspaceId,
    name: 'Synthetic owned project',
    color_hue: 120,
    created_at: 1,
    updated_at: 1,
  });
  useAuthStore.setState({
    localUserId: 'n14-owned-account',
    cloudSession: null,
    projectId: projectId as ProjectId,
    workspaceId: workspaceId as WorkspaceId,
  });
  setStoredProjectRoot(projectId, root);
  fake.invoke.mockImplementation(async (command: string, args?: { cwd?: string }) => {
    if (command === 'terminal_list') return [];
    if (command === 'terminal_snapshot_load') return null;
    if (command === 'terminal_spawn')
      return {
        sessionId: 'tty_n14_owned',
        processInstanceId: 'ptyproc_n14_owned',
        pid: 1234,
        processStartedAt: 1,
        runtimeGeneration: 'runtime_n14_owned',
        cwd: args?.cwd ?? root,
        rows: 30,
        cols: 100,
        startupCommandConsumed: false,
      };
    if (
      [
        'terminal_snapshot_save',
        'terminal_resize',
        'terminal_kill',
        'terminal_snapshot_delete',
      ].includes(command)
    )
      return;
    throw new Error(`Unexpected synthetic native call: ${command}`);
  });
});
afterEach(() => {
  cleanup();
  resetTerminalContextBridgeIdentitiesForTests();
  localStorage.clear();
  vi.restoreAllMocks();
});
it.each([true, false])(
  'ordinary TileGrid spawn has a checked Context identity with explicit cwd=%s',
  async (explicitCwd) => {
    const leaf = newLeaf({ command: 'powershell', ...(explicitCwd ? { cwd: root } : {}) });
    render(
      <TileGrid
        tree={leaf}
        onChange={() => {}}
        defaultCommand="powershell"
        projectId={projectId}
        projectName="Owned synthetic project"
      />,
    );
    await waitFor(() =>
      expect(fake.invoke.mock.calls.some(([command]) => command === 'terminal_spawn')).toBe(true),
    );
    const spawn = fake.invoke.mock.calls.find(([command]) => command === 'terminal_spawn')?.[1];
    expect(spawn.projectId).toBe(projectId);
    await waitFor(() => expect(fake.briefing).toHaveBeenCalled());
    expect(spawn.env?.VIBESPACE_CONTEXT_RUN_IDENTITY).toEqual(expect.any(String));
    expect(
      authorizeTerminalContextBridgeIdentity({
        identityId: spawn.env.VIBESPACE_CONTEXT_RUN_IDENTITY,
        terminalSessionId: 'tty_n14_owned',
        paneId: leaf.id,
        projectId,
      }),
    ).toMatchObject({
      accountId: 'n14-owned-account',
      workspaceId,
      projectId,
      worktreeId: root,
      access: 'read',
    });
    expect(fake.invoke.mock.calls.some(([command]) => command === 'terminal_write')).toBe(false);
  },
);

function spawnCall() {
  return fake.invoke.mock.calls.find(([command]) => command === 'terminal_spawn')?.[1];
}
function mountLeaf(cwd?: string) {
  const leaf = newLeaf({ command: 'powershell', ...(cwd ? { cwd } : {}) });
  if (leaf.kind !== 'leaf') throw new Error('Expected a terminal leaf fixture');
  const view = render(
    <TileGrid
      tree={leaf}
      onChange={() => {}}
      defaultCommand="powershell"
      projectId={projectId}
      projectName="Owned synthetic project"
    />,
  );
  return { leaf, view };
}
function deferred() {
  let release!: () => void, enter!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
  return {
    release,
    entered,
    wait: async () => {
      enter();
      await held;
    },
  };
}

it('keeps an explicit cwd ahead of the configured project root', async () => {
  const explicit = 'C:/n14-explicit-owned-worktree';
  const { leaf } = mountLeaf(explicit);
  await waitFor(() => expect(spawnCall()).toBeTruthy());
  const args = spawnCall();
  expect(args.cwd).toBe(explicit);
  await waitFor(() =>
    expect(
      authorizeTerminalContextBridgeIdentity({
        identityId: args.env.VIBESPACE_CONTEXT_RUN_IDENTITY,
        terminalSessionId: 'tty_n14_owned',
        paneId: leaf.id,
        projectId,
      }),
    ).toMatchObject({ worktreeId: explicit }),
  );
});

it('preserves an unconfigured ordinary shell without deriving authority from native fallback cwd', async () => {
  setStoredProjectRoot(projectId, '');
  const projectRead = vi.spyOn(projectRepo, 'getById');
  mountLeaf();
  await waitFor(() => expect(spawnCall()).toBeTruthy());
  expect(spawnCall().cwd).toBeUndefined();
  expect(spawnCall().env?.VIBESPACE_CONTEXT_RUN_IDENTITY).toBeUndefined();
  expect(projectRead).not.toHaveBeenCalled();
});

it.each(['workspace owner', 'project workspace'] as const)(
  'refuses a configured root under a foreign %s',
  async (boundary) => {
    if (boundary === 'workspace owner')
      await db.workspaces.update(workspaceId as WorkspaceId, { owner_id: 'other-owner' });
    else
      await db.projects.update(projectId as ProjectId, {
        workspace_id: 'other-workspace' as WorkspaceId,
      });
    mountLeaf();
    await screen.findByText(/terminal_context_project_unavailable/);
    expect(spawnCall()).toBeUndefined();
    expect(fake.briefing).not.toHaveBeenCalled();
  },
);

it.each([
  'current',
  'account-ABA',
  'workspace-ABA',
  'project-ABA',
  'root-ABA',
  'props-ABA',
  'unmount',
] as const)('fences a held project ownership lookup under %s', async (boundary) => {
  const held = deferred(),
    original = projectRepo.getById.bind(projectRepo);
  vi.spyOn(projectRepo, 'getById').mockImplementationOnce(async (id) => {
    const result = await original(id);
    await held.wait();
    return result;
  });
  const workspaceRead = vi.spyOn(workspaceRepo, 'getById');
  const { leaf, view } = mountLeaf();
  await held.entered;
  if (boundary === 'account-ABA') {
    act(() => useAuthStore.setState({ localUserId: 'other-account' }));
    act(() => useAuthStore.setState({ localUserId: 'n14-owned-account' }));
  }
  if (boundary === 'workspace-ABA') {
    act(() => useAuthStore.setState({ workspaceId: 'other-workspace' as WorkspaceId }));
    act(() => useAuthStore.setState({ workspaceId: workspaceId as WorkspaceId }));
  }
  if (boundary === 'project-ABA') {
    act(() => useAuthStore.setState({ projectId: 'other-project' as ProjectId }));
    act(() => useAuthStore.setState({ projectId: projectId as ProjectId }));
  }
  if (boundary === 'root-ABA') {
    setStoredProjectRoot(projectId, 'C:/changed-root');
    setStoredProjectRoot(projectId, root);
  }
  if (boundary === 'props-ABA') {
    view.rerender(
      <TileGrid
        tree={{ ...leaf, cwd: 'C:/new-intent' }}
        onChange={() => {}}
        defaultCommand="powershell"
        projectId={projectId}
      />,
    );
    view.rerender(
      <TileGrid
        tree={leaf}
        onChange={() => {}}
        defaultCommand="powershell"
        projectId={projectId}
      />,
    );
  }
  if (boundary === 'unmount') view.unmount();
  await act(async () => {
    held.release();
  });
  if (boundary === 'current') {
    await waitFor(() => expect(spawnCall()).toBeTruthy());
    expect(spawnCall().cwd).toBe(root);
    expect(workspaceRead).toHaveBeenCalledTimes(3);
  } else {
    if (boundary !== 'unmount') await screen.findByText(/terminal_context_spawn_scope_changed/);
    expect(spawnCall()).toBeUndefined();
    expect(workspaceRead).not.toHaveBeenCalled();
    expect(fake.briefing).not.toHaveBeenCalled();
  }
});

it.each(['account-ABA', 'unmount'] as const)(
  'revokes a minted identity and cleans up only the returned owned process after late spawn %s',
  async (boundary) => {
    const held = deferred(),
      original = fake.invoke.getMockImplementation()!;
    fake.invoke.mockImplementation(async (command: string, ...args: unknown[]) => {
      if (command === 'terminal_spawn') await held.wait();
      return original(command, ...args);
    });
    const { leaf, view } = mountLeaf();
    await held.entered;
    const identityId = spawnCall().env.VIBESPACE_CONTEXT_RUN_IDENTITY;
    expect(identityId).toEqual(expect.any(String));
    if (boundary === 'unmount') view.unmount();
    else {
      act(() => useAuthStore.setState({ localUserId: 'other-owner' }));
      act(() => useAuthStore.setState({ localUserId: 'n14-owned-account' }));
    }
    await act(async () => {
      held.release();
    });
    if (boundary !== 'unmount') await screen.findByText(/terminal_context_spawn_scope_changed/);
    await waitFor(() =>
      expect(fake.invoke.mock.calls.some(([command]) => command === 'terminal_kill')).toBe(true),
    );
    expect(
      authorizeTerminalContextBridgeIdentity({
        identityId,
        terminalSessionId: 'tty_n14_owned',
        paneId: leaf.id,
        projectId,
      }),
    ).toBeNull();
    expect(fake.invoke.mock.calls.filter(([command]) => command === 'terminal_kill')).toEqual([
      ['terminal_kill', { sessionId: 'tty_n14_owned' }],
    ]);
    expect(fake.invoke.mock.calls.some(([command]) => command === 'terminal_write')).toBe(false);
  },
);

it('removes its temporary root-change listener after successful initialization', async () => {
  const target: Window = window;
  const add = vi.spyOn(target, 'addEventListener'),
    remove = vi.spyOn(target, 'removeEventListener');
  mountLeaf();
  await waitFor(() => expect(spawnCall()).toBeTruthy());
  await waitFor(() => {
    const listeners = add.mock.calls
      .filter(([type]) => type === 'jarvis:files:root-changed')
      .map(([, listener]) => listener);
    expect(listeners).toHaveLength(1);
    expect(
      remove.mock.calls
        .filter(([type]) => type === 'jarvis:files:root-changed')
        .map(([, listener]) => listener),
    ).toEqual(listeners);
  });
});

it('fails closed on an unreadable project and permits a fresh ordinary retry after recovery', async () => {
  vi.spyOn(projectRepo, 'getById').mockRejectedValueOnce(
    new Error('synthetic project unavailable'),
  );
  const first = mountLeaf();
  await screen.findByText(/synthetic project unavailable/);
  expect(spawnCall()).toBeUndefined();
  expect(fake.briefing).not.toHaveBeenCalled();
  first.view.unmount();
  const second = mountLeaf();
  await waitFor(() => expect(spawnCall()).toBeTruthy());
  const args = spawnCall();
  await waitFor(() =>
    expect(
      authorizeTerminalContextBridgeIdentity({
        identityId: args.env.VIBESPACE_CONTEXT_RUN_IDENTITY,
        terminalSessionId: 'tty_n14_owned',
        paneId: second.leaf.id,
        projectId,
      }),
    ).toMatchObject({ worktreeId: root, access: 'read' }),
  );
});

it('refuses to bind Context authority if native reports a different directory', async () => {
  const original = fake.invoke.getMockImplementation()!;
  fake.invoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    const result = await original(command, ...args);
    return command === 'terminal_spawn'
      ? { ...result, cwd: 'C:/unrelated-native-directory' }
      : result;
  });
  const { leaf } = mountLeaf();
  await screen.findByText(/terminal_context_spawn_directory_changed/);
  expect(
    authorizeTerminalContextBridgeIdentity({
      identityId: spawnCall().env.VIBESPACE_CONTEXT_RUN_IDENTITY,
      terminalSessionId: 'tty_n14_owned',
      paneId: leaf.id,
      projectId,
    }),
  ).toBeNull();
  expect(fake.invoke.mock.calls.filter(([command]) => command === 'terminal_kill')).toEqual([
    ['terminal_kill', { sessionId: 'tty_n14_owned' }],
  ]);
});

it.each([
  'owner-revoked',
  'owner-ABA',
  'project-workspace-ABA',
  'project-deleted',
  'metadata-only',
  'unrelated-owner',
] as const)('retains only current durable ownership after held briefing: %s', async (change) => {
  await db.workspaces.put({
    id: 'unrelated-workspace' as WorkspaceId,
    name: 'Unrelated synthetic',
    owner_id: 'n14-owned-account',
    created_at: 1,
    updated_at: 1,
  });
  const held = deferred();
  fake.briefing.mockImplementationOnce(async () => {
    await held.wait();
    return { ok: true };
  });
  const { leaf } = mountLeaf();
  await held.entered;
  if (change === 'owner-revoked' || change === 'owner-ABA') {
    await db.workspaces.update(workspaceId as WorkspaceId, { owner_id: 'other-owner' });
    if (change === 'owner-ABA')
      await db.workspaces.update(workspaceId as WorkspaceId, {
        owner_id: 'n14-owned-account',
      });
  }
  if (change === 'project-workspace-ABA') {
    await db.projects.update(projectId as ProjectId, {
      workspace_id: 'unrelated-workspace' as WorkspaceId,
    });
    await db.projects.update(projectId as ProjectId, { workspace_id: workspaceId as WorkspaceId });
  }
  if (change === 'project-deleted') await db.projects.delete(projectId as ProjectId);
  if (change === 'metadata-only')
    await db.workspaces.update(workspaceId as WorkspaceId, { name: 'Renamed owned workspace' });
  if (change === 'unrelated-owner')
    await db.workspaces.update('unrelated-workspace' as WorkspaceId, {
      owner_id: 'other-owner',
    });
  await act(async () => {
    held.release();
  });
  if (change === 'metadata-only' || change === 'unrelated-owner') {
    await waitFor(() => expect(spawnCall()).toBeTruthy());
    await waitFor(() =>
      expect(
        authorizeTerminalContextBridgeIdentity({
          identityId: spawnCall().env.VIBESPACE_CONTEXT_RUN_IDENTITY,
          terminalSessionId: 'tty_n14_owned',
          paneId: leaf.id,
          projectId,
        }),
      ).toMatchObject({ worktreeId: root }),
    );
  } else {
    await screen.findByText(/terminal_context_spawn_scope_changed/);
    expect(spawnCall()).toBeUndefined();
  }
});

it.each(['same connection', 'separate connection'] as const)(
  'refuses late binding after durable owner revocation through %s',
  async (writer) => {
    const held = deferred(),
      original = fake.invoke.getMockImplementation()!;
    fake.invoke.mockImplementation(async (command: string, ...args: unknown[]) => {
      if (command === 'terminal_spawn') await held.wait();
      return original(command, ...args);
    });
    const { leaf } = mountLeaf();
    await held.entered;
    const identityId = spawnCall().env.VIBESPACE_CONTEXT_RUN_IDENTITY;
    const peer = writer === 'separate connection' ? createJarvisDb(db.name) : null;
    try {
      await (peer ?? db).workspaces.update(workspaceId as WorkspaceId, {
        owner_id: 'other-owner',
      });
      await act(async () => {
        held.release();
      });
      await screen.findByText(/terminal_context_(spawn_scope_changed|project_unavailable)/);
      expect(
        authorizeTerminalContextBridgeIdentity({
          identityId,
          terminalSessionId: 'tty_n14_owned',
          paneId: leaf.id,
          projectId,
        }),
      ).toBeNull();
      expect(fake.invoke.mock.calls.filter(([command]) => command === 'terminal_kill')).toEqual([
        ['terminal_kill', { sessionId: 'tty_n14_owned' }],
      ]);
    } finally {
      peer?.close();
    }
  },
);

it('removes its temporary committed-mutation listener after success', async () => {
  const subscribe = vi.spyOn(Dexie.on.storagemutated, 'subscribe');
  const unsubscribe = vi.spyOn(Dexie.on.storagemutated, 'unsubscribe');
  mountLeaf();
  await waitFor(() => expect(spawnCall()).toBeTruthy());
  await waitFor(() => {
    const owned = subscribe.mock.calls.filter(
      ([callback]) => callback.name === 'onCommittedMutation',
    );
    expect(owned).toHaveLength(1);
    expect(unsubscribe).toHaveBeenCalledWith(owned[0]![0]);
  });
});

it.each([
  ['briefing', 'workspace'],
  ['native reply', 'workspace'],
  ['briefing', 'project'],
  ['native reply', 'project'],
] as const)(
  'revokes separate-connection authority ABA during held %s for %s',
  async (phase, entity) => {
    const held = deferred(),
      original = fake.invoke.getMockImplementation()!;
    if (phase === 'briefing')
      fake.briefing.mockImplementationOnce(async () => {
        await held.wait();
        return { ok: true };
      });
    else
      fake.invoke.mockImplementation(async (command: string, ...args: unknown[]) => {
        if (command === 'terminal_spawn') await held.wait();
        return original(command, ...args);
      });
    const { leaf } = mountLeaf();
    await held.entered;
    const identityId = spawnCall()?.env.VIBESPACE_CONTEXT_RUN_IDENTITY;
    const peer = createJarvisDb(db.name);
    try {
      if (entity === 'workspace') {
        await peer.workspaces.update(workspaceId as WorkspaceId, {
          owner_id: 'temporary-foreign-owner',
        });
        await peer.workspaces.update(workspaceId as WorkspaceId, {
          owner_id: 'n14-owned-account',
        });
      } else {
        await peer.projects.update(projectId as ProjectId, {
          workspace_id: 'temporary-other-workspace' as WorkspaceId,
        });
        await peer.projects.update(projectId as ProjectId, {
          workspace_id: workspaceId as WorkspaceId,
        });
      }
      await act(async () => {
        held.release();
      });
      await screen.findByText(/terminal_context_spawn_scope_changed/);
      if (phase === 'briefing') expect(spawnCall()).toBeUndefined();
      else {
        expect(
          authorizeTerminalContextBridgeIdentity({
            identityId,
            terminalSessionId: 'tty_n14_owned',
            paneId: leaf.id,
            projectId,
          }),
        ).toBeNull();
        expect(fake.invoke.mock.calls.filter(([command]) => command === 'terminal_kill')).toEqual([
          ['terminal_kill', { sessionId: 'tty_n14_owned' }],
        ]);
      }
    } finally {
      peer.close();
    }
  },
);

it.each([
  'away-payload',
  'return-payload',
  'clear-payload',
  'idempotent',
  'unrelated-project',
  'session-storage',
] as const)('checks delayed root event identity and payload: %s', async (change) => {
  const held = deferred();
  fake.briefing.mockImplementationOnce(async () => {
    await held.wait();
    return { ok: true };
  });
  const { leaf } = mountLeaf();
  await held.entered;
  const key =
    change === 'clear-payload'
      ? null
      : projectStorageKey(
          ROOT_PREFIX,
          change === 'unrelated-project' ? 'unrelated-project' : projectId,
        );
  window.dispatchEvent(
    new StorageEvent('storage', {
      key,
      storageArea: change === 'session-storage' ? window.sessionStorage : window.localStorage,
      oldValue: change === 'return-payload' ? 'C:/previous-other-root' : root,
      newValue:
        change === 'idempotent' || change === 'return-payload'
          ? root
          : change === 'clear-payload'
            ? null
            : 'C:/other-root',
    }),
  );
  await act(async () => {
    held.release();
  });
  if (['away-payload', 'return-payload', 'clear-payload'].includes(change)) {
    await screen.findByText(/terminal_context_spawn_scope_changed/);
    expect(spawnCall()).toBeUndefined();
  } else {
    await waitFor(() => expect(spawnCall()).toBeTruthy());
    await waitFor(() =>
      expect(
        authorizeTerminalContextBridgeIdentity({
          identityId: spawnCall().env.VIBESPACE_CONTEXT_RUN_IDENTITY,
          terminalSessionId: 'tty_n14_owned',
          paneId: leaf.id,
          projectId,
        }),
      ).toMatchObject({ worktreeId: root }),
    );
  }
});
