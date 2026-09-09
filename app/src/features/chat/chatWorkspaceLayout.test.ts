import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addChatPane,
  chatWorkspaceStorageKey,
  closeChatPane,
  focusChatPane,
  layoutClassForPaneCount,
  loadChatWorkspaceLayout,
  pruneChatWorkspaceLayout,
  replacePrimaryChatPane,
  saveChatWorkspaceLayout,
  subscribeChatWorkspaceLayout,
  type ChatWorkspaceLayoutV1,
  type ChatWorkspaceScope,
} from './chatWorkspaceLayout';

const scope: ChatWorkspaceScope = {
  accountId: 'account-a',
  workspaceId: 'workspace-a',
  projectId: 'project-a',
  primaryChatId: 'chat-1',
};

const onePane: ChatWorkspaceLayoutV1 = {
  version: 1,
  chatIds: ['chat-1'],
  focusedChatId: 'chat-1',
};

describe('chatWorkspaceLayout', () => {
  beforeEach(() => localStorage.clear());

  it('adds a unique pane in order and focuses it', () => {
    expect(addChatPane(onePane, 'chat-2')).toEqual({
      version: 1,
      chatIds: ['chat-1', 'chat-2'],
      focusedChatId: 'chat-2',
    });
  });

  it('focuses an existing pane without duplicating it', () => {
    expect(
      addChatPane({ version: 1, chatIds: ['chat-1', 'chat-2'], focusedChatId: 'chat-2' }, 'chat-1'),
    ).toEqual({ version: 1, chatIds: ['chat-1', 'chat-2'], focusedChatId: 'chat-1' });
  });

  it('rejects a fifth unique pane without changing the current layout', () => {
    expect(
      addChatPane(
        {
          version: 1,
          chatIds: ['chat-1', 'chat-2', 'chat-3', 'chat-4'],
          focusedChatId: 'chat-4',
        },
        'chat-5',
      ),
    ).toEqual({ ok: false, reason: 'pane_limit' });
  });

  it('moves focus to the next pane, then the previous pane, when closing', () => {
    expect(
      closeChatPane({ version: 1, chatIds: ['a', 'b', 'c'], focusedChatId: 'b' }, 'b'),
    ).toEqual({ version: 1, chatIds: ['a', 'c'], focusedChatId: 'c' });
    expect(
      closeChatPane({ version: 1, chatIds: ['a', 'b', 'c'], focusedChatId: 'c' }, 'c'),
    ).toEqual({ version: 1, chatIds: ['a', 'b'], focusedChatId: 'b' });
  });

  it('preserves the only pane and focuses an explicitly selected pane', () => {
    expect(closeChatPane(onePane, 'chat-1')).toEqual(onePane);
    expect(
      focusChatPane(
        { version: 1, chatIds: ['chat-1', 'chat-2'], focusedChatId: 'chat-1' },
        'chat-2',
      ),
    ).toEqual({ version: 1, chatIds: ['chat-1', 'chat-2'], focusedChatId: 'chat-2' });
  });

  it('uses one full cell, equal columns for two, and a two-row grid for three or four', () => {
    expect(layoutClassForPaneCount(1)).toContain('grid-cols-1');
    expect(layoutClassForPaneCount(2)).toContain('grid-cols-2');
    expect(layoutClassForPaneCount(2)).toContain('grid-rows-1');
    expect(layoutClassForPaneCount(3)).toContain('grid-cols-2');
    expect(layoutClassForPaneCount(3)).toContain('grid-rows-2');
    expect(layoutClassForPaneCount(4)).toContain('grid-rows-2');
  });

  it('persists versioned layout independently per account, workspace, and project', () => {
    const secondScope = { ...scope, projectId: 'project-b', primaryChatId: 'chat-b' };
    const saved = {
      version: 1 as const,
      chatIds: ['chat-1', 'chat-2'],
      focusedChatId: 'chat-2',
    };

    saveChatWorkspaceLayout(scope, saved);

    expect(JSON.parse(localStorage.getItem(chatWorkspaceStorageKey(scope))!)).toEqual(saved);
    expect(loadChatWorkspaceLayout(scope)).toEqual(saved);
    expect(loadChatWorkspaceLayout(secondScope)).toEqual({
      version: 1,
      chatIds: ['chat-b'],
      focusedChatId: 'chat-b',
    });
    expect(chatWorkspaceStorageKey({ ...scope, accountId: 'account-b' })).not.toBe(
      chatWorkspaceStorageKey(scope),
    );
    expect(chatWorkspaceStorageKey({ ...scope, workspaceId: 'workspace-b' })).not.toBe(
      chatWorkspaceStorageKey(scope),
    );
  });

  it('uses collision-free tagged scope segments for null, sentinels, and delimiters', () => {
    const variants: ChatWorkspaceScope[] = [
      { ...scope, projectId: null },
      { ...scope, projectId: '~' },
      { ...scope, projectId: 'null:' },
      { ...scope, projectId: 'value:project:a:b' },
      { ...scope, accountId: 'account:a', projectId: null },
      { ...scope, workspaceId: 'workspace:a', projectId: null },
    ];
    const keys = variants.map(chatWorkspaceStorageKey);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('recovers corrupt, unsupported, duplicate, and empty persisted state to the primary pane', () => {
    const key = chatWorkspaceStorageKey(scope);
    for (const stored of [
      '{broken',
      JSON.stringify({ version: 2, chatIds: ['chat-2'], focusedChatId: 'chat-2' }),
      JSON.stringify({ version: 1, chatIds: ['chat-2', 'chat-2'], focusedChatId: 'chat-2' }),
      JSON.stringify({ version: 1, chatIds: [], focusedChatId: '' }),
    ]) {
      localStorage.setItem(key, stored);
      expect(loadChatWorkspaceLayout(scope)).toEqual(onePane);
    }
  });

  it('prunes inaccessible chats, repairs focus, and preserves an accessible primary pane', () => {
    const layout = {
      version: 1 as const,
      chatIds: ['deleted', 'chat-2', 'chat-1'],
      focusedChatId: 'deleted',
    };

    expect(pruneChatWorkspaceLayout(layout, ['chat-1', 'chat-2'], 'chat-1')).toEqual({
      version: 1,
      chatIds: ['chat-2', 'chat-1'],
      focusedChatId: 'chat-1',
    });
    expect(pruneChatWorkspaceLayout(layout, ['chat-1'], 'chat-1')).toEqual(onePane);
    expect(pruneChatWorkspaceLayout(layout, [], 'chat-1')).toBeNull();
  });

  it('treats throwing storage as unavailable without breaking the in-memory layout', () => {
    const throwingStorage = {
      getItem: vi.fn(() => {
        throw new Error('disabled');
      }),
      setItem: vi.fn(() => {
        throw new Error('quota');
      }),
      removeItem: vi.fn(() => {
        throw new Error('disabled');
      }),
    };

    expect(loadChatWorkspaceLayout(scope, throwingStorage)).toEqual(onePane);
    expect(saveChatWorkspaceLayout(scope, onePane, throwingStorage)).toEqual({
      ok: false,
      reason: 'storage_unavailable',
    });
  });

  it('treats a throwing native localStorage getter as unavailable during startup', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    expect(descriptor?.configurable).toBe(true);
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('Storage is blocked', 'SecurityError');
      },
    });

    try {
      expect(loadChatWorkspaceLayout(scope)).toEqual(onePane);
      expect(saveChatWorkspaceLayout(scope, onePane)).toEqual({
        ok: false,
        reason: 'storage_unavailable',
      });
    } finally {
      Object.defineProperty(window, 'localStorage', descriptor!);
    }
  });

  it('fills the next free pane for global navigation without disturbing existing bindings', () => {
    expect(
      replacePrimaryChatPane(
        { version: 1, chatIds: ['chat-1', 'chat-2', 'chat-3'], focusedChatId: 'chat-2' },
        'chat-4',
      ),
    ).toEqual({
      version: 1,
      chatIds: ['chat-1', 'chat-2', 'chat-3', 'chat-4'],
      focusedChatId: 'chat-4',
    });
    expect(
      replacePrimaryChatPane(
        { version: 1, chatIds: ['chat-1', 'chat-2'], focusedChatId: 'chat-1' },
        'chat-2',
      ),
    ).toEqual({ version: 1, chatIds: ['chat-1', 'chat-2'], focusedChatId: 'chat-2' });
  });

  it('notifies same-document subscribers exactly once after saving their scope', () => {
    const listener = vi.fn();
    const otherListener = vi.fn();
    const unsubscribe = subscribeChatWorkspaceLayout(scope, listener);
    const unsubscribeOther = subscribeChatWorkspaceLayout(
      { ...scope, projectId: 'project-b' },
      otherListener,
    );

    saveChatWorkspaceLayout(scope, onePane);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(onePane);
    expect(otherListener).not.toHaveBeenCalled();
    unsubscribe();
    unsubscribeOther();
  });
});
