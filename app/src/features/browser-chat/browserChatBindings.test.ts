import { describe, expect, it } from 'vitest';

import {
  createBrowserChatBindingRepository,
  validateBrowserChatResumeUrl,
  type BrowserChatBindingStore,
} from './browserChatBindings';

function memoryStore(): BrowserChatBindingStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    async get<T>(key: string) {
      return structuredClone(values.get(key)) as T | undefined;
    },
    async set(key, value) {
      values.set(key, structuredClone(value));
      return value;
    },
    async delete(key) {
      values.delete(key);
    },
  };
}

describe('Browser Chat binding repository', () => {
  it('persists account-scoped bindings and never returns another account', async () => {
    const store = memoryStore();
    let now = 100;
    const repository = createBrowserChatBindingRepository(store, () => ++now);

    await repository.upsert('account-a', {
      id: 'binding-a',
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      nativeChatId: 'chat-a',
      provider: 'chatgpt',
      providerProfileKey: 'vibespace-account:account-a',
      title: 'PR31 Browser Chat',
      pinned: false,
      state: 'bound',
    });

    expect(await repository.list('account-a')).toMatchObject([
      {
        id: 'binding-a',
        accountId: 'account-a',
        nativeChatId: 'chat-a',
        provider: 'chatgpt',
      },
    ]);
    expect(await repository.list('account-b')).toEqual([]);
    await expect(
      repository.upsert('account-b', {
        id: 'binding-a',
        accountId: 'account-a',
        workspaceId: 'workspace-a',
        nativeChatId: 'chat-a',
        provider: 'chatgpt',
        providerProfileKey: 'vibespace-account:account-a',
        title: 'Wrong account',
        pinned: false,
        state: 'bound',
      }),
    ).rejects.toThrow(/account_mismatch/i);
  });

  it('sorts pinned and recently opened sessions while preserving creation time on patch', async () => {
    const store = memoryStore();
    let now = 1_000;
    const repository = createBrowserChatBindingRepository(store, () => ++now);

    const first = await repository.upsert('account-a', {
      id: 'binding-a',
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      nativeChatId: 'chat-a',
      provider: 'chatgpt',
      providerProfileKey: 'vibespace-account:account-a',
      title: 'First',
      pinned: false,
      state: 'bound',
      lastOpenedAt: 2_000,
    });
    await repository.upsert('account-a', {
      id: 'binding-b',
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      nativeChatId: 'chat-b',
      provider: 'chatgpt',
      providerProfileKey: 'vibespace-account:account-a',
      title: 'Pinned',
      pinned: true,
      state: 'bound',
      lastOpenedAt: 1_000,
    });

    expect((await repository.list('account-a')).map((binding) => binding.id)).toEqual([
      'binding-b',
      'binding-a',
    ]);

    const updated = await repository.patch('account-a', 'binding-a', {
      title: 'Renamed safely',
      pinned: true,
    });
    expect(updated.title).toBe('Renamed safely');
    expect(updated.createdAt).toBe(first.createdAt);
    expect(updated.updatedAt).toBeGreaterThan(first.updatedAt);
  });

  it('accepts only HTTPS resume URLs owned by the selected provider', () => {
    expect(validateBrowserChatResumeUrl('chatgpt', 'https://chatgpt.com/c/abc#latest')).toBe(
      'https://chatgpt.com/c/abc',
    );
    expect(() =>
      validateBrowserChatResumeUrl('chatgpt', 'https://attacker.example/c/abc'),
    ).toThrow(/resume_url_invalid/i);
    expect(() => validateBrowserChatResumeUrl('chatgpt', 'http://chatgpt.com/c/abc')).toThrow(
      /resume_url_invalid/i,
    );
    expect(() =>
      validateBrowserChatResumeUrl('chatgpt', 'https://user:secret@chatgpt.com/c/abc'),
    ).toThrow(/resume_url_invalid/i);
  });

  it('filters malformed persisted records and supports account cleanup', async () => {
    const store = memoryStore();
    store.values.set('vibespace.browser-chat.bindings.v1:account-a', {
      version: 1,
      bindings: [
        { id: 'invalid' },
        {
          id: 'valid',
          accountId: 'account-a',
          workspaceId: 'workspace-a',
          nativeChatId: 'chat-a',
          provider: 'chatgpt',
          providerProfileKey: 'vibespace-account:account-a',
          title: 'Valid',
          pinned: false,
          state: 'bound',
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });
    const repository = createBrowserChatBindingRepository(store, () => 3);

    expect((await repository.list('account-a')).map((binding) => binding.id)).toEqual(['valid']);
    await repository.clearAccount('account-a');
    expect(await repository.list('account-a')).toEqual([]);
  });
});
