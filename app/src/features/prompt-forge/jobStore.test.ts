import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import { createJarvisDb } from '@/lib/db';
import { DB_VERSION, STORES_V6 } from '@/lib/db/schema';
import { createPromptForgeJob, transitionPromptForgeJob } from './contracts';
import { PromptForgeJobStoreError, createPromptForgeJobStore } from './jobStore';

const databaseNames: string[] = [];

function databaseName(label: string): string {
  const name = uniqueTestDbName(`prompt-forge-${label}`);
  databaseNames.push(name);
  return name;
}

function job(id = 'forge-job-1', accountId = 'account-1') {
  return createPromptForgeJob({
    id,
    accountId,
    chatId: 'chat-1',
    projectId: 'project-1',
    originalDraft: 'Do not lose this original.',
    originalAttachments: [],
    modelSelection: { mode: 'prefer_local' },
    privacyMode: 'local_only',
    allowPublicResearch: false,
    now: 100,
  });
}

afterEach(async () => {
  for (const name of databaseNames.splice(0)) {
    await new Dexie(name, TEST_INDEXED_DB).delete();
  }
});

describe('Prompt Forge persistent job store', () => {
  it('preserves a V6 row while upgrading through the current job table', async () => {
    expect(DB_VERSION).toBeGreaterThanOrEqual(9);
    const name = databaseName('v6-upgrade');
    const legacy = new Dexie(name, TEST_INDEXED_DB);
    legacy.version(6).stores(STORES_V6);
    await legacy.open();
    await legacy.table('settings').put({
      key: 'preserved-setting',
      value: { exact: true },
      updated_at: 42,
    });
    legacy.close();

    const database = createJarvisDb(name, TEST_INDEXED_DB);
    await database.open();
    expect(database.tables.map((table) => table.name)).toContain('prompt_forge_jobs');
    await expect(database.settings.get('preserved-setting')).resolves.toEqual({
      key: 'preserved-setting',
      value: { exact: true },
      updated_at: 42,
    });
    database.close();
  });

  it('persists exact jobs and enforces account and optimistic revision authority', async () => {
    const database = createJarvisDb(databaseName('authority'), TEST_INDEXED_DB);
    await database.open();
    const store = createPromptForgeJobStore(database);
    const initial = job();
    await expect(store.create(initial)).resolves.toEqual(initial);
    await expect(store.get('account-1', initial.id)).resolves.toEqual(initial);
    await expect(store.get('account-2', initial.id)).resolves.toBeNull();

    const collecting = transitionPromptForgeJob(initial, {
      expectedRevision: 1,
      status: 'collecting_context',
      now: 110,
    });
    await expect(store.save(collecting, 1)).resolves.toEqual(collecting);
    await expect(store.save(collecting, 1)).rejects.toMatchObject({
      code: 'revision_conflict',
    });
    await expect(store.create(job(initial.id, 'account-2'))).rejects.toMatchObject({
      code: 'id_conflict',
    });
    database.close();
  });

  it('lists bounded recoverable jobs newest-first and deletes only in scope', async () => {
    const database = createJarvisDb(databaseName('recovery'), TEST_INDEXED_DB);
    await database.open();
    const store = createPromptForgeJobStore(database);
    const first = job('forge-job-1');
    const second = createPromptForgeJob({
      ...job('forge-job-2'),
      id: 'forge-job-2',
      now: 200,
    });
    const cancelled = transitionPromptForgeJob(job('forge-job-3'), {
      expectedRevision: 1,
      status: 'cancelled',
      now: 300,
    });
    await store.create(first);
    await store.create(second);
    await store.create(cancelled);

    const otherChat = createPromptForgeJob({
      ...job('forge-job-other-chat'),
      id: 'forge-job-other-chat',
      chatId: 'chat-2',
      now: 250,
    });
    await store.create(otherChat);

    await expect(
      store.listRecoverable(
        { accountId: 'account-1', chatId: 'chat-1', projectId: 'project-1' },
        10,
      ),
    ).resolves.toEqual([second, first]);
    await expect(store.remove('account-2', first.id)).resolves.toBe(false);
    await expect(store.remove('account-1', first.id)).resolves.toBe(true);
    await expect(store.get('account-1', first.id)).resolves.toBeNull();
    database.close();
  });

  it('fails closed when a persisted job row is malformed', async () => {
    const database = createJarvisDb(databaseName('corrupt'), TEST_INDEXED_DB);
    await database.open();
    await database.table('prompt_forge_jobs').put({
      ...job(),
      originalDraft: 42,
    });
    const store = createPromptForgeJobStore(database);
    await expect(store.get('account-1', 'forge-job-1')).rejects.toBeInstanceOf(
      PromptForgeJobStoreError,
    );
    database.close();
  });
});
