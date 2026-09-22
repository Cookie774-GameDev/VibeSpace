import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import type { AccountIdentity } from '@/lib/accountIdentity';
import {
  previewWorkspaceRestore,
  recoverMissingPersistedLocalScope,
  readPortableBackupHistory,
  recordPortableBackupHistory,
  restoreWorkspaceBackup,
} from './workspaceRestore';

const TEST_INDEXED_DB = { indexedDB, IDBKeyRange };
const identity: AccountIdentity = { accountId: 'account-a', source: 'supabase' };
const localIdentity: AccountIdentity = { accountId: 'local-account', source: 'local' };

function artifact(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: 'vibespace-workspace-backup',
    version: 1,
    account: { id: 'account-a', source: 'supabase' },
    data: {
      workspaces: [
        {
          id: 'workspace-1',
          name: 'Restored',
          owner_id: 'account-a',
          created_at: 1,
          updated_at: 2,
        },
      ],
      projects: [
        {
          id: 'project-1',
          workspace_id: 'workspace-1',
          name: 'Project',
          created_at: 1,
          updated_at: 2,
        },
      ],
      chats: [
        {
          id: 'chat-1',
          workspace_id: 'workspace-1',
          project_id: 'project-1',
          title: 'Chat',
          mode: 'chat',
          active_agent_ids: [],
          created_at: 1,
          updated_at: 2,
        },
      ],
      messages: [
        {
          id: 'message-1',
          chat_id: 'chat-1',
          role: 'user',
          parts: [],
          created_at: 1,
          updated_at: 2,
        },
      ],
      canvas: {
        documents: [],
        pages: [],
        objects: [],
        spatial: [],
        cameras: [],
      },
    },
    ...overrides,
  });
}

describe('portable workspace restore', () => {
  let database: JarvisDexie;
  let currentIdentity: AccountIdentity | null;

  beforeEach(async () => {
    database = createJarvisDb(`workspace-restore-${crypto.randomUUID()}`, TEST_INDEXED_DB);
    await database.open();
    currentIdentity = identity;
  });

  afterEach(async () => {
    database.close();
    await database.delete();
  });

  it('recovers a missing local scope only when surviving chats prove both IDs', async () => {
    await database.chats.add({
      id: 'chat-1' as never,
      workspace_id: 'workspace-stale' as never,
      project_id: 'project-stale' as never,
      title: 'Surviving chat',
      mode: 'chat',
      active_agent_ids: [],
      created_at: 1,
      updated_at: 2,
    });

    const result = await recoverMissingPersistedLocalScope(
      {
        accountId: 'local-account',
        workspaceId: 'workspace-stale' as never,
        projectId: 'project-stale' as never,
      },
      { database, getAccountIdentity: () => localIdentity, now: () => 42 },
    );

    expect(result).toEqual({
      status: 'recovered',
      accountId: 'local-account',
      workspaceId: 'workspace-stale',
      projectId: 'project-stale',
      createdWorkspace: true,
      createdProject: true,
    });
    expect(await database.workspaces.get('workspace-stale' as never)).toMatchObject({
      owner_id: 'local-account',
      name: 'Recovered workspace',
    });
    expect(await database.projects.get('project-stale' as never)).toMatchObject({
      workspace_id: 'workspace-stale',
      name: 'Recovered project',
    });
    expect(await database.chats.get('chat-1' as never)).toMatchObject({
      workspace_id: 'workspace-stale',
      project_id: 'project-stale',
    });
  });

  it('fails closed without matching chat evidence or for cloud identities', async () => {
    await expect(
      recoverMissingPersistedLocalScope(
        {
          accountId: 'local-account',
          workspaceId: 'workspace-stale' as never,
          projectId: 'project-stale' as never,
        },
        { database, getAccountIdentity: () => localIdentity },
      ),
    ).resolves.toMatchObject({ status: 'not_recoverable', reason: 'missing_chat_evidence' });
    expect(await database.workspaces.count()).toBe(0);
    expect(await database.projects.count()).toBe(0);

    await database.chats.add({
      id: 'chat-other-local' as never,
      workspace_id: 'workspace-other-local' as never,
      project_id: 'project-other-local' as never,
      title: 'Other local account chat',
      mode: 'chat',
      active_agent_ids: [],
      created_at: 1,
      updated_at: 2,
    });
    await expect(
      recoverMissingPersistedLocalScope(
        {
          accountId: 'other-local-account',
          workspaceId: 'workspace-other-local' as never,
          projectId: 'project-other-local' as never,
        },
        { database, getAccountIdentity: () => localIdentity },
      ),
    ).resolves.toMatchObject({ status: 'not_recoverable', reason: 'account_mismatch' });
    expect(await database.workspaces.count()).toBe(0);
    expect(await database.projects.count()).toBe(0);

    await database.chats.add({
      id: 'chat-cloud' as never,
      workspace_id: 'workspace-cloud' as never,
      project_id: 'project-cloud' as never,
      title: 'Cloud chat',
      mode: 'chat',
      active_agent_ids: [],
      created_at: 1,
      updated_at: 2,
    });
    await expect(
      recoverMissingPersistedLocalScope(
        {
          accountId: 'account-a',
          workspaceId: 'workspace-cloud' as never,
          projectId: 'project-cloud' as never,
        },
        { database, getAccountIdentity: () => identity },
      ),
    ).resolves.toMatchObject({ status: 'not_recoverable', reason: 'cloud_identity' });
    expect(await database.workspaces.count()).toBe(0);
    expect(await database.projects.count()).toBe(0);
  });

  it('does not repair an owner conflict or an orphaned partial scope', async () => {
    await database.workspaces.add({
      id: 'workspace-conflict' as never,
      name: 'Other owner',
      owner_id: 'other-account',
      created_at: 1,
      updated_at: 2,
    });
    await database.chats.add({
      id: 'chat-conflict' as never,
      workspace_id: 'workspace-conflict' as never,
      project_id: 'project-conflict' as never,
      title: 'Conflict chat',
      mode: 'chat',
      active_agent_ids: [],
      created_at: 1,
      updated_at: 2,
    });

    await expect(
      recoverMissingPersistedLocalScope(
        {
          accountId: 'local-account',
          workspaceId: 'workspace-conflict' as never,
          projectId: 'project-conflict' as never,
        },
        { database, getAccountIdentity: () => localIdentity },
      ),
    ).resolves.toMatchObject({ status: 'not_recoverable', reason: 'scope_conflict' });
    expect(await database.projects.get('project-conflict' as never)).toBeUndefined();

    await database.projects.add({
      id: 'project-orphan' as never,
      workspace_id: 'workspace-orphan' as never,
      name: 'Orphan project',
      created_at: 1,
      updated_at: 1,
    });
    await database.chats.add({
      id: 'chat-orphan' as never,
      workspace_id: 'workspace-orphan' as never,
      project_id: 'project-orphan' as never,
      title: 'Orphan chat',
      mode: 'chat',
      active_agent_ids: [],
      created_at: 1,
      updated_at: 2,
    });
    await expect(
      recoverMissingPersistedLocalScope(
        {
          accountId: 'local-account',
          workspaceId: 'workspace-new' as never,
          projectId: 'project-new' as never,
        },
        { database, getAccountIdentity: () => localIdentity },
      ),
    ).resolves.toMatchObject({ status: 'not_recoverable', reason: 'scope_conflict' });
  });

  it('previews and restores only missing rows after explicit caller confirmation', async () => {
    const options = { database, getAccountIdentity: () => currentIdentity, now: () => 42 };
    const preview = await previewWorkspaceRestore(artifact(), options);

    expect(preview).toMatchObject({ restorable: 4, preservedLocal: 0, createdAt: 42 });
    expect(await database.workspaces.count()).toBe(0);

    const result = await restoreWorkspaceBackup(preview, options);
    expect(result).toEqual({ restored: 4, preservedLocal: 0 });
    expect(await database.messages.get('message-1' as never)).toMatchObject({ chat_id: 'chat-1' });
  });

  it('never overwrites a local row created or changed after preview', async () => {
    const options = { database, getAccountIdentity: () => currentIdentity };
    const preview = await previewWorkspaceRestore(artifact(), options);
    await database.workspaces.add({
      id: 'workspace-1' as never,
      name: 'Newer local name',
      owner_id: 'account-a',
      created_at: 10,
      updated_at: 20,
    });

    const result = await restoreWorkspaceBackup(preview, options);
    expect(result).toEqual({ restored: 3, preservedLocal: 1 });
    expect((await database.workspaces.get('workspace-1' as never))?.name).toBe('Newer local name');
  });

  it('rejects another account and rolls back if the active account changes', async () => {
    await expect(
      previewWorkspaceRestore(artifact({ account: { id: 'account-b' } }), {
        database,
        getAccountIdentity: () => currentIdentity,
      }),
    ).rejects.toMatchObject({ code: 'artifact_account_mismatch' });

    const preview = await previewWorkspaceRestore(artifact(), {
      database,
      getAccountIdentity: () => currentIdentity,
    });
    currentIdentity = { accountId: 'account-b', source: 'supabase' };
    await expect(
      restoreWorkspaceBackup(preview, { database, getAccountIdentity: () => currentIdentity }),
    ).rejects.toMatchObject({ code: 'account_changed' });
    expect(await database.workspaces.count()).toBe(0);
  });

  it('rejects malformed, orphaned, duplicate, and oversized artifacts', async () => {
    const options = { database, getAccountIdentity: () => currentIdentity };
    await expect(previewWorkspaceRestore('not-json', options)).rejects.toMatchObject({
      code: 'artifact_invalid',
    });
    const parsed = JSON.parse(artifact()) as Record<string, any>;
    parsed.data.messages[0].chat_id = 'missing';
    await expect(previewWorkspaceRestore(JSON.stringify(parsed), options)).rejects.toMatchObject({
      code: 'artifact_invalid',
    });
    parsed.data.messages = [];
    parsed.data.workspaces.push(parsed.data.workspaces[0]);
    await expect(previewWorkspaceRestore(JSON.stringify(parsed), options)).rejects.toMatchObject({
      code: 'artifact_invalid',
    });
    await expect(
      previewWorkspaceRestore(' '.repeat(32 * 1024 * 1024 + 1), options),
    ).rejects.toMatchObject({ code: 'artifact_too_large' });
  });

  it('keeps account-scoped last success and bounded error history locally', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    recordPortableBackupHistory('account-a', 'export', storage, 10);
    recordPortableBackupHistory('account-a', { error: 'x'.repeat(500) }, storage, 20);
    expect(readPortableBackupHistory('account-a', storage)).toMatchObject({
      lastExportAt: 10,
      lastErrorAt: 20,
    });
    expect(readPortableBackupHistory('account-a', storage).lastError).toHaveLength(240);
    expect(readPortableBackupHistory('account-b', storage)).toEqual({});

    recordPortableBackupHistory('account-a', 'restore', storage, 30);
    expect(readPortableBackupHistory('account-a', storage)).toEqual({
      lastExportAt: 10,
      lastRestoreAt: 30,
    });
  });
});
