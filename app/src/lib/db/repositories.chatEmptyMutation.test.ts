import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatId, MessageId, WorkspaceId } from '@/types';
import { db } from './index';
import { chatRepo, messageRepo } from './repositories';

describe('messageRepo.mutateIfChatEmpty', () => {
  beforeEach(async () => {
    expect(Dexie.currentTransaction).toBeNull();
    await db.delete();
    await db.open();
  });

  afterEach(async () => {
    expect(Dexie.currentTransaction).toBeNull();
    await db.delete();
    expect(Dexie.currentTransaction).toBeNull();
  });

  it('serializes a final empty decision behind a message commit', async () => {
    const chatId = 'chat-atomic-empty' as ChatId;
    let releaseInsertion: (() => void) | undefined;
    let insertionStarted: (() => void) | undefined;
    const insertionGate = new Promise<void>((resolve) => {
      releaseInsertion = resolve;
    });
    const insertionReady = new Promise<void>((resolve) => {
      insertionStarted = resolve;
    });

    const insertion = db.transaction('rw', db.messages, async () => {
      await db.messages.add({
        id: 'message-before-reuse' as MessageId,
        chat_id: chatId,
        role: 'user',
        parts: [{ kind: 'text', text: 'Committed before reuse' }],
        created_at: 1,
        updated_at: 1,
      });
      insertionStarted?.();
      await insertionGate;
    });
    await insertionReady;

    const mutation = vi.fn(() => true);
    const reuse = Dexie.ignoreTransaction(() => messageRepo.mutateIfChatEmpty(chatId, mutation));
    releaseInsertion?.();
    await insertion;

    await expect(reuse).resolves.toBe(false);
    expect(mutation).not.toHaveBeenCalled();
  });

  it('persists and enqueues nothing when scoped chat authority rejects creation', async () => {
    const chatCount = await db.chats.count();
    const syncCount = await db.sync_queue.count();
    const authorize = vi.fn(() => false);

    await expect(
      chatRepo.createAuthorized(
        {
          workspace_id: 'workspace-authority-a' as WorkspaceId,
          title: 'Rejected scoped chat',
          mode: 'chat',
          active_agent_ids: [],
        },
        { state: 'unbound', capturedAt: 1 },
        authorize,
      ),
    ).resolves.toBeNull();

    expect(authorize).toHaveBeenCalledOnce();
    expect(await db.chats.count()).toBe(chatCount);
    expect(await db.sync_queue.count()).toBe(syncCount);
  });

  it('rolls back chat and sync insertion when authority drifts before commit, then retries once', async () => {
    const chatCount = await db.chats.count();
    const syncCount = await db.sync_queue.count();
    let releaseBlocker: (() => void) | undefined;
    let blockerStarted: (() => void) | undefined;
    const blockerGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blockerReady = new Promise<void>((resolve) => {
      blockerStarted = resolve;
    });
    const blocker = db.transaction('rw', db.chats, db.sync_queue, db.settings, async () => {
      await db.chats.count();
      blockerStarted?.();
      await blockerGate;
    });
    const blockerSettled = expect(blocker).resolves.toBeUndefined();
    await blockerReady;

    let authorized = true;
    const input = {
      workspace_id: 'workspace-commit-a' as WorkspaceId,
      title: 'Atomic scoped chat',
      mode: 'chat' as const,
      active_agent_ids: [],
    };
    const pending = Dexie.ignoreTransaction(() =>
      chatRepo.createAuthorized(input, { state: 'unbound', capturedAt: 2 }, () => authorized),
    );
    const pendingAssertion = expect(pending).resolves.toBeNull();
    authorized = false;
    releaseBlocker?.();
    await blockerSettled;

    await pendingAssertion;
    expect(await db.chats.count()).toBe(chatCount);
    expect(await db.sync_queue.count()).toBe(syncCount);

    authorized = true;
    await expect(
      Dexie.ignoreTransaction(() =>
        chatRepo.createAuthorized(input, { state: 'unbound', capturedAt: 3 }, () => authorized),
      ),
    ).resolves.toMatchObject({ workspace_id: 'workspace-commit-a' });
    expect(await db.chats.count()).toBe(chatCount + 1);
    expect(await db.sync_queue.count()).toBe(syncCount + 1);
  });

  it('rolls back chat and sync insertion when the latest target changes before commit', async () => {
    const chatCount = await db.chats.count();
    const syncCount = await db.sync_queue.count();
    let releaseBlocker: (() => void) | undefined;
    let blockerStarted: (() => void) | undefined;
    const blockerGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blockerReady = new Promise<void>((resolve) => {
      blockerStarted = resolve;
    });
    const blocker = db.transaction('rw', db.chats, db.sync_queue, db.settings, async () => {
      await db.chats.count();
      blockerStarted?.();
      await blockerGate;
    });
    const blockerSettled = expect(blocker).resolves.toBeUndefined();
    await blockerReady;

    let latestTarget: 'native' | 'browser' = 'browser';
    const input = {
      workspace_id: 'workspace-intent-a' as WorkspaceId,
      title: 'Latest-intent scoped chat',
      mode: 'chat' as const,
      active_agent_ids: [],
    };
    const pending = Dexie.ignoreTransaction(() =>
      chatRepo.createAuthorized(
        input,
        { state: 'unbound', capturedAt: 4 },
        () => latestTarget === 'browser',
      ),
    );
    const pendingAssertion = expect(pending).resolves.toBeNull();
    latestTarget = 'native';
    releaseBlocker?.();
    await blockerSettled;

    await pendingAssertion;
    expect(await db.chats.count()).toBe(chatCount);
    expect(await db.sync_queue.count()).toBe(syncCount);

    latestTarget = 'browser';
    await expect(
      Dexie.ignoreTransaction(() =>
        chatRepo.createAuthorized(
          input,
          { state: 'unbound', capturedAt: 5 },
          () => latestTarget === 'browser',
        ),
      ),
    ).resolves.toMatchObject({ workspace_id: 'workspace-intent-a' });
    expect(await db.chats.count()).toBe(chatCount + 1);
    expect(await db.sync_queue.count()).toBe(syncCount + 1);
  });
});
