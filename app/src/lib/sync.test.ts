import { describe, expect, it } from 'vitest';
import type { SyncQueueRow } from './db';
import { buildCloudSyncRecord, primaryKeyForSyncTable } from './sync';

describe('sync table metadata', () => {
  it('uses id for normal app-sync tables', () => {
    expect(primaryKeyForSyncTable('projects')).toBe('id');
    expect(primaryKeyForSyncTable('messages')).toBe('id');
  });

  it('uses table-specific primary keys for non-id tables', () => {
    expect(primaryKeyForSyncTable('settings')).toBe('key');
    expect(primaryKeyForSyncTable('terminal_layouts')).toBe('project_id');
  });
});

describe('cloud sync records', () => {
  const baseRow: SyncQueueRow = {
    id: 'syq_123',
    op: 'update',
    table: 'workspaces',
    row_id: 'wsp_1',
    payload: {
      id: 'wsp_1',
      owner_id: 'usr_local',
      name: 'Personal',
      created_at: 1,
      updated_at: 2,
    },
    status: 'pending',
    created_at: Date.parse('2026-06-04T12:00:00.000Z'),
  };

  it('wraps local mutations as per-user Supabase documents', () => {
    expect(buildCloudSyncRecord(baseRow, 'auth_user_1')).toEqual({
      user_id: 'auth_user_1',
      table_name: 'workspaces',
      row_id: 'wsp_1',
      op: 'update',
      payload: baseRow.payload,
      deleted_at: null,
      updated_at: '2026-06-04T12:00:00.000Z',
    });
  });

  it('stores deletes as tombstones instead of dropping the cloud record', () => {
    expect(
      buildCloudSyncRecord(
        { ...baseRow, op: 'delete', payload: null },
        'auth_user_1',
        '2026-06-04T12:05:00.000Z',
      ),
    ).toEqual({
      user_id: 'auth_user_1',
      table_name: 'workspaces',
      row_id: 'wsp_1',
      op: 'delete',
      payload: null,
      deleted_at: '2026-06-04T12:05:00.000Z',
      updated_at: '2026-06-04T12:00:00.000Z',
    });
  });
});
