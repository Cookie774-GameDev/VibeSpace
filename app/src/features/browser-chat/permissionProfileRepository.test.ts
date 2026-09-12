import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import type { BrowserChatPermissionProfile } from './permissionRegistry';
import { createBrowserChatPermissionProfileRepository } from './permissionProfileRepository';

const SCOPE = {
  accountId: 'account-a',
  workspaceId: 'workspace-a',
  projectId: 'project-a',
} as const;

function profile(
  plan: BrowserChatPermissionProfile['plan'],
  overrides: BrowserChatPermissionProfile['overrides'] = {},
): BrowserChatPermissionProfile {
  return {
    version: 1,
    accountId: SCOPE.accountId,
    workspaceId: SCOPE.workspaceId,
    plan,
    overrides,
    updatedAt: 1,
  };
}

describe('Browser Chat permission profile repository', () => {
  let database: JarvisDexie;
  let now = 100;
  let nextId = 0;

  beforeEach(async () => {
    database = createJarvisDb(uniqueTestDbName('browser-chat-permissions'), TEST_INDEXED_DB);
    await database.open();
  });

  afterEach(async () => {
    database.close();
    await database.delete();
  });

  const repository = () =>
    createBrowserChatPermissionProfileRepository(
      database,
      () => now,
      () => `permission-${++nextId}`,
    );

  it('persists one validated profile per exact account, workspace, and project', async () => {
    const repo = repository();
    await expect(repo.save(SCOPE, profile('read'))).resolves.toMatchObject({
      accountId: SCOPE.accountId,
      workspaceId: SCOPE.workspaceId,
      projectId: SCOPE.projectId,
      plan: 'read',
    });

    await expect(repo.get(SCOPE)).resolves.toMatchObject({
      plan: 'read',
      accountId: SCOPE.accountId,
      workspaceId: SCOPE.workspaceId,
    });
    await expect(repo.get({ ...SCOPE, accountId: 'account-b' })).resolves.toBeUndefined();
    await expect(repo.get({ ...SCOPE, workspaceId: 'workspace-b' })).resolves.toBeUndefined();
    await expect(repo.get({ ...SCOPE, projectId: 'project-b' })).resolves.toBeUndefined();
  });

  it('updates the existing scoped row without creating duplicates', async () => {
    const repo = repository();
    const first = await repo.save(SCOPE, profile('read'));
    now = 200;
    const second = await repo.save(SCOPE, profile('project_developer'));

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe(200);
    expect(second.plan).toBe('project_developer');
    await expect(database.browser_chat_permission_profiles.count()).resolves.toBe(1);
  });

  it('round-trips safe custom modes and rejects malformed or wrong-scope profiles', async () => {
    const repo = repository();
    await repo.save(
      SCOPE,
      profile('custom', {
        'files.read': 'auto',
        'files.modify': 'ask',
        'files.delete': 'always_ask',
      }),
    );
    await expect(repo.get(SCOPE)).resolves.toMatchObject({
      plan: 'custom',
      overrides: {
        'files.read': 'auto',
        'files.modify': 'ask',
        'files.delete': 'always_ask',
      },
    });

    await expect(repo.save(SCOPE, { ...profile('read'), accountId: 'account-b' })).rejects.toThrow(
      'browser_chat_permission_profile_scope_mismatch',
    );
    await expect(
      repo.save(SCOPE, {
        ...profile('custom'),
        overrides: { 'files.delete': 'auto' },
      }),
    ).rejects.toThrow(/critical_override_invalid/);
  });

  it('revokes only the exact persisted profile', async () => {
    const repo = repository();
    await repo.save(SCOPE, profile('read'));
    await repo.save({ ...SCOPE, projectId: 'project-b' }, profile('off'));

    await expect(repo.remove(SCOPE)).resolves.toBe(true);
    await expect(repo.get(SCOPE)).resolves.toBeUndefined();
    await expect(repo.get({ ...SCOPE, projectId: 'project-b' })).resolves.toMatchObject({
      plan: 'off',
    });
  });
});
