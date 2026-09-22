import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { createCaoMissionStore, createCaoMissionStoreFromDatabase } from './missionStore';
import type { CaoMission } from './types';

const TEST_INDEXED_DB = { indexedDB, IDBKeyRange };

const mission: CaoMission = {
  id: 'm',
  schemaVersion: 1,
  accountId: 'a',
  workspaceId: 'w',
  projectId: 'p',
  objective: 'Build',
  createdAt: 1,
  updatedAt: 1,
  status: 'planning',
  contextMapId: null,
  workers: [],
  milestones: [],
  latestPlanRevision: 1,
  lastCaoWakeAt: null,
};

describe('CAO mission store', () => {
  it('persists and reloads JSON payloads only within the exact account/workspace scope', async () => {
    const rows = new Map<string, any>();
    const store = createCaoMissionStore({
      async get(id) {
        return rows.get(id);
      },
      async insertIfAbsent(row) {
        if (rows.has(row.id)) return false;
        rows.set(row.id, row);
        return true;
      },
      async put(row) {
        rows.set(row.id, row);
      },
      async compareAndPut(expected, next) {
        const current = rows.get(expected.id);
        if (!current || JSON.stringify(current) !== JSON.stringify(expected)) return false;
        rows.set(next.id, next);
        return true;
      },
      async list(accountId, workspaceId) {
        return [...rows.values()].filter(
          (row) => row.accountId === accountId && row.workspaceId === workspaceId,
        );
      },
    });
    await store.save(mission);
    await expect(
      store.get({ accountId: 'a', workspaceId: 'w', projectId: 'p', missionId: 'm' }),
    ).resolves.toEqual(mission);
    await expect(
      store.get({ accountId: 'other', workspaceId: 'w', projectId: 'p', missionId: 'm' }),
    ).resolves.toBeUndefined();
    await expect(
      store.get({ accountId: 'a', workspaceId: 'w', projectId: 'other', missionId: 'm' }),
    ).resolves.toBeUndefined();
  });

  it('rejects foreign-account and foreign-project overwrites while rejecting malformed rows', async () => {
    const rows = new Map<string, any>();
    const store = createCaoMissionStore({
      async get(id) {
        return rows.get(id);
      },
      async insertIfAbsent(row) {
        if (rows.has(row.id)) return false;
        rows.set(row.id, row);
        return true;
      },
      async put(row) {
        rows.set(row.id, row);
      },
      async compareAndPut(expected, next) {
        const current = rows.get(expected.id);
        if (!current || JSON.stringify(current) !== JSON.stringify(expected)) return false;
        rows.set(next.id, next);
        return true;
      },
      async list(accountId, workspaceId) {
        return [...rows.values()].filter(
          (row) => row.accountId === accountId && row.workspaceId === workspaceId,
        );
      },
    });
    await store.save(mission);
    await expect(store.save({ ...mission, accountId: 'other' })).rejects.toThrow(
      'cao_mission_scope_mismatch',
    );
    await expect(store.save({ ...mission, projectId: 'other' })).rejects.toThrow(
      'cao_mission_scope_mismatch',
    );

    rows.set('m', {
      id: 'm',
      schemaVersion: 1,
      accountId: 'a',
      workspaceId: 'w',
      projectId: 'p',
      status: 'running',
      serializedMission: JSON.stringify({ ...mission, status: 'completed' }),
      createdAt: 1,
      updatedAt: 2,
    });
    await expect(
      store.get({ accountId: 'a', workspaceId: 'w', projectId: 'p', missionId: 'm' }),
    ).rejects.toThrow('cao_mission_payload_invalid');
  });

  it('creates once, allows an identical retry, and refuses changed same-id saves', async () => {
    const rows = new Map<string, any>();
    const store = createCaoMissionStore({
      async get(id) {
        return rows.get(id);
      },
      async insertIfAbsent(row) {
        if (rows.has(row.id)) return false;
        rows.set(row.id, row);
        return true;
      },
      async put(row) {
        rows.set(row.id, row);
      },
      async compareAndPut(expected, next) {
        const current = rows.get(expected.id);
        if (!current || JSON.stringify(current) !== JSON.stringify(expected)) return false;
        rows.set(next.id, next);
        return true;
      },
      async list(accountId, workspaceId) {
        return [...rows.values()].filter(
          (row) => row.accountId === accountId && row.workspaceId === workspaceId,
        );
      },
    });

    await store.save(mission);
    await store.save(mission);
    await expect(store.save({ ...mission, objective: 'Changed' })).rejects.toThrow(
      'cao_mission_conflict',
    );
    await expect(
      store.get({ accountId: 'a', workspaceId: 'w', projectId: 'p', missionId: 'm' }),
    ).resolves.toEqual(mission);
  });

  it('round-trips a bounded failure reason and rejects oversized diagnostics', async () => {
    const rows = new Map<string, any>();
    const store = createCaoMissionStore({
      async get(id) {
        return rows.get(id);
      },
      async insertIfAbsent(row) {
        if (rows.has(row.id)) return false;
        rows.set(row.id, row);
        return true;
      },
      async put(row) {
        rows.set(row.id, row);
      },
      async compareAndPut(expected, next) {
        const current = rows.get(expected.id);
        if (!current || JSON.stringify(current) !== JSON.stringify(expected)) return false;
        rows.set(next.id, next);
        return true;
      },
      async list(accountId, workspaceId) {
        return [...rows.values()].filter(
          (row) => row.accountId === accountId && row.workspaceId === workspaceId,
        );
      },
    });
    const failed = { ...mission, id: 'failed', failureReason: 'cao_snapshot_mission_invalid' };
    await store.save(failed);
    await expect(
      store.get({ accountId: 'a', workspaceId: 'w', projectId: 'p', missionId: 'failed' }),
    ).resolves.toEqual(failed);

    rows.set('failed', {
      id: 'failed',
      schemaVersion: 1,
      accountId: 'a',
      workspaceId: 'w',
      projectId: 'p',
      status: 'cancelled',
      serializedMission: JSON.stringify({ ...failed, failureReason: 'x'.repeat(513) }),
      createdAt: 1,
      updatedAt: 1,
    });
    await expect(
      store.get({ accountId: 'a', workspaceId: 'w', projectId: 'p', missionId: 'failed' }),
    ).rejects.toThrow('cao_mission_payload_invalid');
  });

  it('keeps two production store instances from overwriting a same-id mission across scopes', async () => {
    const database: JarvisDexie = createJarvisDb(
      `cao-mission-${crypto.randomUUID()}`,
      TEST_INDEXED_DB,
    );
    await database.open();
    try {
      const first = createCaoMissionStoreFromDatabase(database);
      const second = createCaoMissionStoreFromDatabase(database);
      const foreign = { ...mission, accountId: 'other' };
      const results = await Promise.allSettled([first.save(mission), second.save(foreign)]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const stored = await database.cao_missions.get('m');
      const winner = results[0].status === 'fulfilled' ? mission : foreign;
      expect(stored?.accountId).toBe(winner.accountId);
    } finally {
      database.close();
      await database.delete();
    }
  });
});
