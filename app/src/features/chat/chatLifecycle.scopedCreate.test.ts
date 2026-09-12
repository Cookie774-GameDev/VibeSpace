import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  createdInput: null as Record<string, unknown> | null,
  activeChatId: null as string | null,
  currentAccountId: 'account-a',
  rowsGate: Promise.resolve(),
  syncEnqueues: 0,
}));

vi.mock('@/lib/db', () => ({
  db: {
    chats: {
      where: vi.fn(() => ({
        equals: () => ({
          toArray: async () => {
            await state.rowsGate;
            return [];
          },
        }),
      })),
    },
  },
  chatRepo: {
    getById: vi.fn(),
    createAuthorized: vi.fn(
      async (
        input: Record<string, unknown>,
        _owner: Record<string, unknown>,
        authorize: () => boolean,
      ) => {
        if (!authorize()) return null;
        state.createdInput = input;
        state.syncEnqueues += 1;
        return { ...input, id: 'chat-scoped' };
      },
    ),
    create: vi.fn(async (input: Record<string, unknown>) => {
      state.createdInput = input;
      state.syncEnqueues += 1;
      return { ...input, id: 'chat-scoped' };
    }),
  },
  messageRepo: {},
}));

vi.mock('@/stores/auth', () => ({
  useAuthStore: {
    getState: () => ({ workspaceId: null, projectId: null }),
  },
}));

vi.mock('@/stores/ui', () => ({
  useUIStore: {
    getState: () => ({
      activeChatId: state.activeChatId,
      setActiveChat: (chatId: string) => {
        state.activeChatId = chatId;
      },
      setRoute: vi.fn(),
      setChatMode: vi.fn(),
    }),
  },
}));

import { createChatInScope } from './chatLifecycle';

describe('createChatInScope', () => {
  beforeEach(() => {
    state.createdInput = null;
    state.activeChatId = 'chat-source';
    state.currentAccountId = 'account-a';
    state.rowsGate = Promise.resolve();
    state.syncEnqueues = 0;
  });

  it('uses the captured workspace/project and refuses activation when the guard fails', async () => {
    const beforeActivate = vi.fn(() => false);

    await expect(
      createChatInScope({
        accountId: 'account-a',
        accountSource: 'local',
        syncOwner: { state: 'unbound', capturedAt: 1 },
        workspaceId: 'workspace-source',
        projectId: 'project-source',
        isScopeCurrent: () => true,
        beforeActivate,
      }),
    ).resolves.toBeNull();

    expect(state.createdInput).toMatchObject({
      workspace_id: 'workspace-source',
      project_id: 'project-source',
    });
    expect(beforeActivate).toHaveBeenCalledWith('chat-scoped');
    expect(state.activeChatId).toBe('chat-source');
  });

  it('does not persist or enqueue when account authority drifts during scoped discovery', async () => {
    let releaseRows: (() => void) | undefined;
    const rowsGate = new Promise<void>((resolve) => {
      releaseRows = resolve;
    });
    state.rowsGate = rowsGate;

    const pending = createChatInScope({
      accountId: 'account-a',
      accountSource: 'local',
      syncOwner: { state: 'unbound', capturedAt: 1 },
      workspaceId: 'workspace-source',
      projectId: 'project-source',
      isScopeCurrent: () => state.currentAccountId === 'account-a',
      beforeActivate: () => true,
    });
    state.currentAccountId = 'account-b';
    releaseRows?.();

    await expect(pending).resolves.toBeNull();
    expect(state.createdInput).toBeNull();
    expect(state.syncEnqueues).toBe(0);
    expect(state.activeChatId).toBe('chat-source');
  });
});
