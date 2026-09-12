import * as React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import type { ChatId, ProjectId, WorkspaceId } from '@/types/common';
import { browserChatStore } from './browserChatStore';
import { BrowserChatBindingHost } from './BrowserChatBindingHost';
import type {
  BrowserChatBinding,
  BrowserChatBindingRepository,
} from './browserChatBindings';

function fakeRepository(
  overrides: Partial<BrowserChatBindingRepository> = {},
): BrowserChatBindingRepository {
  return {
    list: vi.fn(async () => []),
    get: vi.fn(async () => undefined),
    upsert: vi.fn(async (_accountId, binding) => ({
      ...binding,
      createdAt: binding.createdAt ?? 1,
      updatedAt: binding.updatedAt ?? 2,
    })),
    patch: vi.fn(async () => {
      throw new Error('not used');
    }),
    remove: vi.fn(async () => undefined),
    clearAccount: vi.fn(async () => undefined),
    ...overrides,
  };
}

const chat = {
  id: 'chat-a' as ChatId,
  workspace_id: 'workspace-a' as WorkspaceId,
  project_id: 'project-a' as ProjectId,
  title: 'PR31 Browser Chat',
  pinned: true,
  created_at: 10,
  updated_at: 20,
};

const restoredBinding: BrowserChatBinding = {
  id: 'chat-a',
  accountId: 'account-a',
  workspaceId: 'workspace-a',
  projectId: 'project-a',
  nativeChatId: 'chat-a',
  provider: 'chatgpt',
  providerProfileKey: 'vibespace-account:account-a',
  title: 'PR31 Browser Chat',
  pinned: true,
  state: 'bound',
  createdAt: 10,
  updatedAt: 20,
};

describe('BrowserChatBindingHost', () => {
  beforeEach(() => {
    useAuthStore.setState({
      localUserId: 'local-a',
      workspaceId: 'workspace-a' as WorkspaceId,
      projectId: 'project-a' as ProjectId,
      cloudSession: {
        user_id: 'account-a',
        email: 'owner@example.test',
        expires_at: 9_999_999_999,
      },
    });
    useUIStore.setState({ activeChatId: null });
    browserChatStore.setState({
      engine: 'native',
      providerId: 'chatgpt',
      chatPreferences: {},
      providerRuntime: {},
      preferManagedSurface: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('restores durable account bindings into the existing Browser Chat preferences', async () => {
    const repository = fakeRepository({
      list: vi.fn(async () => [restoredBinding]),
    });

    render(
      <BrowserChatBindingHost
        repository={repository}
        loadChat={async () => undefined}
        loadChats={async () => []}
      />,
    );

    await waitFor(() =>
      expect(browserChatStore.getState().chatPreferences['chat-a']).toEqual({
        engine: 'browser',
        providerId: 'chatgpt',
      }),
    );
    expect(repository.list).toHaveBeenCalledWith('account-a', 'workspace-a');
  });

  it('migrates existing Browser Chat preferences into durable VibeSpace metadata', async () => {
    const repository = fakeRepository();
    browserChatStore.getState().setEngine('browser', 'chat-a');
    browserChatStore.getState().setProvider('chatgpt', 'chat-a');

    render(
      <BrowserChatBindingHost
        repository={repository}
        loadChat={async () => chat}
        loadChats={async () => [chat]}
        clock={() => 30}
      />,
    );

    await waitFor(() => expect(repository.upsert).toHaveBeenCalled());
    expect(repository.upsert).toHaveBeenCalledWith(
      'account-a',
      expect.objectContaining({
        id: 'chat-a',
        accountId: 'account-a',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        nativeChatId: 'chat-a',
        provider: 'chatgpt',
        providerProfileKey: 'vibespace-account:account-a',
        title: 'PR31 Browser Chat',
        pinned: true,
        state: 'bound',
      }),
    );
  });

  it('records last-opened metadata only for the active Browser Chat engine', async () => {
    const repository = fakeRepository();
    browserChatStore.getState().setEngine('browser', 'chat-a');
    browserChatStore.getState().setProvider('chatgpt', 'chat-a');
    useUIStore.setState({ activeChatId: 'chat-a' as ChatId });

    render(
      <BrowserChatBindingHost
        repository={repository}
        loadChat={async () => chat}
        loadChats={async () => [chat]}
        clock={() => 42}
      />,
    );

    await waitFor(() =>
      expect(repository.upsert).toHaveBeenCalledWith(
        'account-a',
        expect.objectContaining({
          nativeChatId: 'chat-a',
          lastOpenedAt: 42,
        }),
      ),
    );
  });
});
