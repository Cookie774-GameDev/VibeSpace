import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cloudSyncQueueClaimKey,
  cloudSyncQueueOwnerKey,
  legacyCloudSyncQueueAuthorityKey,
  materializeSyncQueueOwner,
  parseSyncQueueOwner,
  type SyncQueueOwnerSnapshot,
} from '@/lib/cloudSyncQueueOwner';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import type { Chat, Message } from '@/types/chat';
import { createJarvisDb, type JarvisDexie } from './index';
import { enqueueLocalSyncInTransaction } from './kernelTurnTransactionAuthority';

const NOW = 1_786_200_100_000;
const OWNER = Object.freeze({
  state: 'cloud' as const,
  userId: 'account-a',
  capturedAt: NOW,
}) satisfies SyncQueueOwnerSnapshot;

function message(): Message {
  return {
    id: 'msg_kernel_1',
    chat_id: 'chat_kernel_1',
    role: 'assistant',
    parts: [{ kind: 'text', text: 'Committed output.' }],
    created_at: NOW,
    updated_at: NOW,
  } as Message;
}

function chat(): Chat {
  return {
    id: 'chat_kernel_1',
    workspace_id: 'ws_kernel_1',
    title: 'Kernel chat',
    mode: 'chat',
    active_agent_ids: [],
    connection: {
      id: 'conn_private',
      provider: 'openai',
      label: 'Private connection',
      authMode: 'api_key',
    } as never,
    created_at: NOW,
    updated_at: NOW,
  } as unknown as Chat;
}

describe('enqueueLocalSyncInTransaction', () => {
  let db: JarvisDexie;

  beforeEach(async () => {
    db = createJarvisDb(uniqueTestDbName('kernel-sync-helper'), TEST_INDEXED_DB);
    await db.open();
  });

  afterEach(async () => {
    await db.delete();
  });

  async function enqueue(
    input:
      | { op: 'insert'; table: 'messages'; row: Message; createdAt: number }
      | { op: 'update'; table: 'chats'; row: Chat; createdAt: number },
  ): Promise<void> {
    await db.transaction('rw', [db.sync_queue, db.settings], () =>
      enqueueLocalSyncInTransaction(
        { sync_queue: db.sync_queue, settings: db.settings },
        { ...input, ownerSnapshot: OWNER },
      ),
    );
  }

  it('creates a pending message row with one immutable owner and no claim or legacy sidecar', async () => {
    await enqueue({ op: 'insert', table: 'messages', row: message(), createdAt: NOW });

    const rows = await db.sync_queue.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      op: 'insert',
      table: 'messages',
      row_id: 'msg_kernel_1',
      payload: message(),
      status: 'pending',
      created_at: NOW,
    });
    const rowId = rows[0]!.id;
    expect(
      parseSyncQueueOwner(rowId, (await db.settings.get(cloudSyncQueueOwnerKey(rowId)))?.value),
    ).toEqual(materializeSyncQueueOwner(rowId, OWNER));
    await expect(db.settings.get(cloudSyncQueueClaimKey(rowId))).resolves.toBeUndefined();
    await expect(db.settings.get(legacyCloudSyncQueueAuthorityKey(rowId))).resolves.toBeUndefined();
  });

  it('coalesces a same-owner chat update without rewriting the owner or syncing connection', async () => {
    await enqueue({ op: 'update', table: 'chats', row: chat(), createdAt: NOW });
    const first = (await db.sync_queue.toArray())[0]!;
    const ownerBefore = structuredClone(
      await db.settings.get(cloudSyncQueueOwnerKey(first.id)),
    );

    await enqueue({
      op: 'update',
      table: 'chats',
      row: { ...chat(), title: 'Updated kernel chat', updated_at: NOW + 1 },
      createdAt: NOW + 1,
    });

    const rows = await db.sync_queue.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.id,
      op: 'update',
      table: 'chats',
      row_id: 'chat_kernel_1',
      payload: { title: 'Updated kernel chat', updated_at: NOW + 1 },
      created_at: NOW + 1,
    });
    expect(rows[0]?.payload).not.toHaveProperty('connection');
    expect(await db.settings.get(cloudSyncQueueOwnerKey(first.id))).toEqual(ownerBefore);
  });

  it('leaves claimed, legacy-marked, ownerless, and foreign-owner candidates untouched', async () => {
    const candidates = [
      { id: 'syq_claimed', owner: OWNER, marker: 'claim' as const },
      { id: 'syq_legacy', owner: OWNER, marker: 'legacy' as const },
      { id: 'syq_ownerless', owner: null, marker: null },
      {
        id: 'syq_foreign',
        owner: Object.freeze({ state: 'cloud' as const, userId: 'account-b', capturedAt: NOW }),
        marker: null,
      },
    ];
    for (const candidate of candidates) {
      await db.sync_queue.add({
        id: candidate.id,
        op: 'update',
        table: 'chats',
        row_id: 'chat_kernel_1',
        payload: { sentinel: candidate.id },
        status: 'pending',
        created_at: NOW - 10,
      });
      if (candidate.owner) {
        await db.settings.put({
          key: cloudSyncQueueOwnerKey(candidate.id),
          value: materializeSyncQueueOwner(candidate.id, candidate.owner),
          updated_at: NOW - 10,
        });
      }
      if (candidate.marker === 'claim') {
        await db.settings.put({
          key: cloudSyncQueueClaimKey(candidate.id),
          value: { sentinel: true },
          updated_at: NOW - 10,
        });
      }
      if (candidate.marker === 'legacy') {
        await db.settings.put({
          key: legacyCloudSyncQueueAuthorityKey(candidate.id),
          value: { sentinel: true },
          updated_at: NOW - 10,
        });
      }
    }

    await enqueue({ op: 'update', table: 'chats', row: chat(), createdAt: NOW });

    expect(await db.sync_queue.count()).toBe(5);
    for (const candidate of candidates) {
      expect(await db.sync_queue.get(candidate.id)).toMatchObject({
        payload: { sentinel: candidate.id },
        created_at: NOW - 10,
      });
    }
    const fresh = (await db.sync_queue.toArray()).find(
      (row) => !candidates.some((candidate) => candidate.id === row.id),
    );
    expect(fresh).toMatchObject({ table: 'chats', row_id: 'chat_kernel_1', status: 'pending' });
    expect(
      parseSyncQueueOwner(
        fresh!.id,
        (await db.settings.get(cloudSyncQueueOwnerKey(fresh!.id)))?.value,
      ),
    ).toMatchObject({ state: 'cloud', userId: 'account-a' });
  });

  it('stays independent of the generic repository module', () => {
    const source = readFileSync(resolve('src/lib/db/kernelTurnTransactionAuthority.ts'),
      'utf8',
    );
    expect(source).not.toContain("from './repositories'");
    expect(source).not.toContain("from '@/lib/db/repositories'");
  });

  it('keeps generic message insert and chat update on the same narrow helper', () => {
    const source = readFileSync(resolve('src/lib/db/repositories.ts'), 'utf8');
    expect(source).toContain("from './kernelTurnTransactionAuthority'");
    // Count the generic routing function only: atomic Plan approval now also
    // uses this helper inside its own all-or-nothing transaction.
    const genericRouting = source.slice(source.indexOf('async function enqueueLocalSync('), source.indexOf('async function syncInsert<'));
    expect(genericRouting.match(/enqueueLocalSyncInTransaction\(/g)).toHaveLength(1);
    const planApproval = source.slice(source.indexOf('async function persistPlanReviewTransition('), source.indexOf('export const messageRepo ='));
    const planDecisions = source.slice(source.indexOf('  async approvePlan('), source.indexOf('  async getById(', source.indexOf('  async approvePlan(')));
    expect(planDecisions.match(/persistPlanReviewTransition\(/g)).toHaveLength(2);
    expect(planApproval.match(/enqueueLocalSyncInTransaction\(/g)).toHaveLength(2);
    expect(planApproval).toContain("op: 'insert', table: 'messages', row: userMessage");
    expect(planApproval).toContain("op: 'update', table: 'chats', row: updatedChat");
    expect(genericRouting).toContain("table === 'messages' && op === 'insert'");
    expect(genericRouting).toContain("table === 'chats' && op === 'update'");
  });
});
