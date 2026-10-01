import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatId, MessageId, WorkspaceId } from '@/types';
import { db } from './index';
import { chatRepo } from './repositories';

describe('chatRepo.delete outcome', () => {
  beforeAll(async () => {
    await db.delete();
    await db.open();
  });

  afterAll(async () => {
    await db.delete();
  });

  beforeEach(async () => {
    await db.transaction('rw', [db.chats, db.messages, db.sync_queue, db.settings], async () => {
      await Promise.all([
        db.chats.clear(),
        db.messages.clear(),
        db.sync_queue.clear(),
        db.settings.clear(),
      ]);
    });
  });

  it('reports degraded synchronization after local deletion when the queue sidecar fails', async () => {
    const chatId = 'chat-delete-outcome' as ChatId;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await db.chats.add({
      id: chatId,
      workspace_id: 'workspace-a' as WorkspaceId,
      title: 'Delete outcome',
      mode: 'chat',
      active_agent_ids: [],
      created_at: 1,
      updated_at: 1,
    });
    await db.messages.add({
      id: 'message-delete-outcome' as MessageId,
      chat_id: chatId,
      role: 'user',
      parts: [{ kind: 'text', text: 'Delete me' }],
      created_at: 1,
      updated_at: 1,
    });
    const settingsPut = vi
      .spyOn(db.settings, 'put')
      .mockRejectedValue(new Error('owner sidecar write failed'));

    const outcome = await chatRepo.delete(chatId);

    expect(outcome).toEqual({ localDeleted: true, syncQueued: false });
    expect(await db.chats.get(chatId)).toBeUndefined();
    expect(await db.messages.where('chat_id').equals(chatId).count()).toBe(0);
    expect(warning).toHaveBeenCalledWith(
      '[sync] failed to enqueue local mutation',
      expect.objectContaining({ op: 'delete' }),
    );
    settingsPut.mockRestore();
    warning.mockRestore();
  });

  it('rolls back local deletion and enqueues nothing when authority drifts before transaction acquisition', async () => {
    const chatId = 'chat-authority-drift' as ChatId;
    const messageId = 'message-authority-drift' as MessageId;
    await db.chats.add({
      id: chatId,
      workspace_id: 'workspace-a' as WorkspaceId,
      title: 'Authority drift',
      mode: 'chat',
      active_agent_ids: [],
      created_at: 1,
      updated_at: 1,
    });
    await db.messages.add({
      id: messageId,
      chat_id: chatId,
      role: 'user',
      parts: [{ kind: 'text', text: 'Keep me' }],
      created_at: 1,
      updated_at: 1,
    });

    let releaseBlocker: (() => void) | undefined;
    let blockerStarted: (() => void) | undefined;
    const blockerGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blockerReady = new Promise<void>((resolve) => {
      blockerStarted = resolve;
    });
    const blocker = db.transaction('rw', [db.chats, db.messages], async () => {
      await db.chats.count();
      blockerStarted?.();
      await blockerGate;
    });
    const blockerSettled = blocker.catch(() => undefined);
    await blockerReady;

    let activeWorkspaceId = 'workspace-a';
    const pending = Dexie.ignoreTransaction(() =>
      chatRepo.deleteAuthorized(chatId, {
        expectedAccountId: 'account-a',
        expectedWorkspaceId: 'workspace-a',
        getActiveAccountId: () => 'account-a',
        getActiveWorkspaceId: () => activeWorkspaceId,
      }),
    );
    activeWorkspaceId = 'workspace-b';
    releaseBlocker?.();
    await blockerSettled;

    await expect(pending).rejects.toThrow(/workspace changed/i);
    expect(await db.chats.get(chatId)).toBeDefined();
    expect(await db.messages.get(messageId)).toBeDefined();
    expect(await db.sync_queue.count()).toBe(0);
    expect(await db.settings.count()).toBe(0);
  });

  it('captures a message committed before transaction acquisition and enqueues every exact tombstone', async () => {
    const chatId = 'chat-concurrent-message' as ChatId;
    const firstMessageId = 'message-before-delete' as MessageId;
    const concurrentMessageId = 'message-concurrent-delete' as MessageId;
    await db.chats.add({
      id: chatId,
      workspace_id: 'workspace-a' as WorkspaceId,
      title: 'Concurrent message',
      mode: 'chat',
      active_agent_ids: [],
      created_at: 1,
      updated_at: 1,
    });
    await db.messages.add({
      id: firstMessageId,
      chat_id: chatId,
      role: 'user',
      parts: [{ kind: 'text', text: 'First' }],
      created_at: 1,
      updated_at: 1,
    });

    let releaseInsertion: (() => void) | undefined;
    let insertionStarted: (() => void) | undefined;
    const insertionGate = new Promise<void>((resolve) => {
      releaseInsertion = resolve;
    });
    const insertionReady = new Promise<void>((resolve) => {
      insertionStarted = resolve;
    });
    const insertion = db.transaction('rw', [db.chats, db.messages], async () => {
      await db.messages.count();
      insertionStarted?.();
      await insertionGate;
      await db.messages.add({
        id: concurrentMessageId,
        chat_id: chatId,
        role: 'assistant',
        parts: [{ kind: 'text', text: 'Committed before delete acquisition' }],
        created_at: 2,
        updated_at: 2,
      });
    });
    const insertionSettled = insertion.catch(() => undefined);
    await insertionReady;

    const pending = Dexie.ignoreTransaction(() =>
      chatRepo.deleteAuthorized(chatId, {
        expectedAccountId: 'account-a',
        expectedWorkspaceId: 'workspace-a',
        getActiveAccountId: () => 'account-a',
        getActiveWorkspaceId: () => 'workspace-a',
      }),
    );
    releaseInsertion?.();
    await insertionSettled;

    await expect(pending).resolves.toEqual({
      localDeleted: true,
      syncQueued: true,
      deletedChatId: chatId,
      deletedMessageIds: [firstMessageId, concurrentMessageId],
    });
    expect(await db.chats.get(chatId)).toBeUndefined();
    expect(await db.messages.where('chat_id').equals(chatId).count()).toBe(0);
    const tombstones = (await db.sync_queue.toArray())
      .filter((row) => row.op === 'delete')
      .map((row) => `${row.table}:${row.row_id}`)
      .sort();
    expect(tombstones).toEqual(
      [`chats:${chatId}`, `messages:${concurrentMessageId}`, `messages:${firstMessageId}`].sort(),
    );
  });
});
