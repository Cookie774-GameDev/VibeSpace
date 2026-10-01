import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import {
  createBrowserChatBindingRepository,
  createProviderProjectLinkRepository,
} from './browserChatRepository';

const ACCOUNT_A = 'account-a';
const ACCOUNT_B = 'account-b';
const WORKSPACE_A = 'workspace-a';
const WORKSPACE_B = 'workspace-b';
const TEST_CONVERSATION_ONE = `conversation-${1}`;

describe('Browser Chat durable repositories', () => {
  let database: JarvisDexie;
  let nextId = 0;
  let now = 1_000;

  beforeEach(async () => {
    database = createJarvisDb(uniqueTestDbName('browser-chat-repository'), TEST_INDEXED_DB);
    await database.open();
  });

  afterEach(async () => {
    database.close();
    await database.delete();
  });

  const bindingRepo = () =>
    createBrowserChatBindingRepository(
      database,
      () => now,
      () => `binding-${++nextId}`,
    );

  const projectLinkRepo = () =>
    createProviderProjectLinkRepository(
      database,
      () => now,
      () => `link-${++nextId}`,
    );

  it('lists bindings only inside the exact account and workspace', async () => {
    const repo = bindingRepo();
    await repo.create({
      accountId: ACCOUNT_A,
      workspaceId: WORKSPACE_A,
      projectId: 'project-a',
      chatId: 'chat-a',
      provider: 'chatgpt',
      providerProfileKey: 'profile-a',
      localTitle: 'Architecture notes',
    });
    await repo.create({
      accountId: ACCOUNT_B,
      workspaceId: WORKSPACE_A,
      chatId: 'chat-b',
      provider: 'chatgpt',
      providerProfileKey: 'profile-b',
      localTitle: 'Other account',
    });
    await repo.create({
      accountId: ACCOUNT_A,
      workspaceId: WORKSPACE_B,
      chatId: 'chat-c',
      provider: 'claude',
      providerProfileKey: 'profile-c',
      localTitle: 'Other workspace',
    });

    await expect(repo.list({ accountId: ACCOUNT_A, workspaceId: WORKSPACE_A })).resolves.toEqual([
      expect.objectContaining({
        accountId: ACCOUNT_A,
        workspaceId: WORKSPACE_A,
        chatId: 'chat-a',
        localTitle: 'Architecture notes',
      }),
    ]);
  });

  it('prevents two active bindings for the same scoped VibeSpace chat', async () => {
    const repo = bindingRepo();
    const input = {
      accountId: ACCOUNT_A,
      workspaceId: WORKSPACE_A,
      chatId: 'chat-a',
      provider: 'chatgpt' as const,
      providerProfileKey: 'profile-a',
      localTitle: 'First',
    };

    await repo.create(input);

    await expect(repo.create({ ...input, localTitle: 'Duplicate' })).rejects.toThrow(
      'browser_chat_binding_chat_conflict',
    );
  });

  it('prevents duplicate provider conversations within a scoped provider profile', async () => {
    const repo = bindingRepo();
    await repo.create({
      accountId: ACCOUNT_A,
      workspaceId: WORKSPACE_A,
      chatId: 'chat-a',
      provider: 'chatgpt',
      providerProfileKey: 'profile-a',
      providerConversationKey: TEST_CONVERSATION_ONE,
      resumeUrl: 'https://chatgpt.com/c/conversation-1',
      localTitle: 'First',
    });

    await expect(
      repo.create({
        accountId: ACCOUNT_A,
        workspaceId: WORKSPACE_A,
        chatId: 'chat-b',
        provider: 'chatgpt',
        providerProfileKey: 'profile-a',
        providerConversationKey: TEST_CONVERSATION_ONE,
        resumeUrl: 'https://chatgpt.com/c/conversation-1',
        localTitle: 'Duplicate provider conversation',
      }),
    ).rejects.toThrow('browser_chat_binding_provider_conversation_conflict');
  });

  it('finds an existing binding by scoped chat or provider conversation identity', async () => {
    const repo = bindingRepo();
    const row = await repo.create({
      accountId: ACCOUNT_A,
      workspaceId: WORKSPACE_A,
      chatId: 'chat-a',
      provider: 'chatgpt',
      providerProfileKey: 'profile-a',
      providerConversationKey: TEST_CONVERSATION_ONE,
      resumeUrl: 'https://chatgpt.com/c/conversation-1',
      localTitle: 'Mapped',
    });

    await expect(
      repo.findByChat({ accountId: ACCOUNT_A, workspaceId: WORKSPACE_A }, 'chat-a'),
    ).resolves.toEqual(row);
    await expect(
      repo.findByProviderConversation(
        { accountId: ACCOUNT_A, workspaceId: WORKSPACE_A },
        {
          provider: 'chatgpt',
          providerProfileKey: 'profile-a',
          providerConversationKey: TEST_CONVERSATION_ONE,
        },
      ),
    ).resolves.toEqual(row);
    await expect(
      repo.findByChat({ accountId: ACCOUNT_B, workspaceId: WORKSPACE_A }, 'chat-a'),
    ).resolves.toBeUndefined();
  });

  it('rejects provider resume URLs outside the provider HTTPS allowlist', async () => {
    const repo = bindingRepo();

    await expect(
      repo.create({
        accountId: ACCOUNT_A,
        workspaceId: WORKSPACE_A,
        chatId: 'chat-a',
        provider: 'chatgpt',
        providerProfileKey: 'profile-a',
        providerConversationKey: TEST_CONVERSATION_ONE,
        resumeUrl: 'https://attacker.example/c/conversation-1',
        localTitle: 'Spoofed',
      }),
    ).rejects.toThrow('browser_chat_resume_url_invalid');
  });

  it('updates mutable workspace metadata without allowing cross-account mutation', async () => {
    const repo = bindingRepo();
    const row = await repo.create({
      accountId: ACCOUNT_A,
      workspaceId: WORKSPACE_A,
      chatId: 'chat-a',
      provider: 'chatgpt',
      providerProfileKey: 'profile-a',
      localTitle: 'Draft title',
    });

    now = 2_000;
    await expect(
      repo.update({ accountId: ACCOUNT_A, workspaceId: WORKSPACE_A }, row.id, {
        localTitle: 'Renamed',
        pinned: true,
        projectId: 'project-b',
        lastOpenedAt: 1_900,
        viewMode: 'provider',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        localTitle: 'Renamed',
        pinned: true,
        projectId: 'project-b',
        lastOpenedAt: 1_900,
        viewMode: 'provider',
        updatedAt: 2_000,
      }),
    );

    await expect(
      repo.update({ accountId: ACCOUNT_B, workspaceId: WORKSPACE_A }, row.id, {
        localTitle: 'Stolen',
      }),
    ).rejects.toThrow('browser_chat_binding_not_found');

    await expect(
      repo.get({ accountId: ACCOUNT_A, workspaceId: WORKSPACE_A }, row.id),
    ).resolves.toEqual(expect.objectContaining({ localTitle: 'Renamed' }));
  });

  it('merges concurrent independent patches from the latest transactional row', async () => {
    const repo = bindingRepo();
    const row = await repo.create({
      accountId: ACCOUNT_A,
      workspaceId: WORKSPACE_A,
      chatId: 'chat-concurrent',
      provider: 'chatgpt',
      providerProfileKey: 'profile-a',
      localTitle: 'Original',
    });

    await Promise.all([
      repo.update({ accountId: ACCOUNT_A, workspaceId: WORKSPACE_A }, row.id, {
        localTitle: 'Renamed concurrently',
      }),
      repo.update({ accountId: ACCOUNT_A, workspaceId: WORKSPACE_A }, row.id, {
        pinned: true,
      }),
    ]);

    await expect(
      repo.get({ accountId: ACCOUNT_A, workspaceId: WORKSPACE_A }, row.id),
    ).resolves.toMatchObject({
      localTitle: 'Renamed concurrently',
      pinned: true,
    });
  });

  it('removes only a binding owned by the exact account and workspace', async () => {
    const repo = bindingRepo();
    const row = await repo.create({
      accountId: ACCOUNT_A,
      workspaceId: WORKSPACE_A,
      chatId: 'chat-a',
      provider: 'gemini',
      providerProfileKey: 'profile-a',
      localTitle: 'Gemini',
    });

    await expect(
      repo.remove({ accountId: ACCOUNT_A, workspaceId: WORKSPACE_B }, row.id),
    ).rejects.toThrow('browser_chat_binding_not_found');
    await expect(
      repo.remove({ accountId: ACCOUNT_A, workspaceId: WORKSPACE_A }, row.id),
    ).resolves.toBeUndefined();
    await expect(
      repo.get({ accountId: ACCOUNT_A, workspaceId: WORKSPACE_A }, row.id),
    ).resolves.toBe(undefined);
  });

  it('stores one provider-project link per scoped project and provider', async () => {
    const repo = projectLinkRepo();
    const input = {
      accountId: ACCOUNT_A,
      workspaceId: WORKSPACE_A,
      projectId: 'project-a',
      provider: 'chatgpt' as const,
      providerProjectKey: 'project-key-a',
      providerProjectUrl: 'https://chatgpt.com/g/g-p-project-a/project',
    };

    await repo.create(input);

    await expect(repo.create(input)).rejects.toThrow('provider_project_link_conflict');
    await expect(repo.list({ accountId: ACCOUNT_A, workspaceId: WORKSPACE_A })).resolves.toEqual([
      expect.objectContaining({
        projectId: 'project-a',
        provider: 'chatgpt',
        state: 'linked',
      }),
    ]);
    await expect(repo.list({ accountId: ACCOUNT_B, workspaceId: WORKSPACE_A })).resolves.toEqual(
      [],
    );
  });

  it('rejects spoofed provider-project URLs and stale-account updates', async () => {
    const repo = projectLinkRepo();
    await expect(
      repo.create({
        accountId: ACCOUNT_A,
        workspaceId: WORKSPACE_A,
        projectId: 'project-a',
        provider: 'claude',
        providerProjectUrl: 'https://attacker.example/project/project-a',
      }),
    ).rejects.toThrow('provider_project_url_invalid');

    const row = await repo.create({
      accountId: ACCOUNT_A,
      workspaceId: WORKSPACE_A,
      projectId: 'project-a',
      provider: 'claude',
      state: 'unsupported',
    });

    await expect(
      repo.update({ accountId: ACCOUNT_B, workspaceId: WORKSPACE_A }, row.id, { state: 'linked' }),
    ).rejects.toThrow('provider_project_link_not_found');
  });

  it('gets and unlinks a provider project only inside the exact scope', async () => {
    const repo = projectLinkRepo();
    const row = await repo.create({
      accountId: ACCOUNT_A,
      workspaceId: WORKSPACE_A,
      projectId: 'project-a',
      provider: 'gemini',
      state: 'unsupported',
    });

    await expect(
      repo.getForProject({ accountId: ACCOUNT_A, workspaceId: WORKSPACE_A }, 'project-a', 'gemini'),
    ).resolves.toEqual(row);
    await expect(
      repo.remove({ accountId: ACCOUNT_B, workspaceId: WORKSPACE_A }, row.id),
    ).rejects.toThrow('provider_project_link_not_found');
    await expect(
      repo.remove({ accountId: ACCOUNT_A, workspaceId: WORKSPACE_A }, row.id),
    ).resolves.toBeUndefined();
    await expect(
      repo.getForProject({ accountId: ACCOUNT_A, workspaceId: WORKSPACE_A }, 'project-a', 'gemini'),
    ).resolves.toBeUndefined();
  });
});
