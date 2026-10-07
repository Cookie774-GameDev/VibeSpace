import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Chat, ChatId, Message, MessageId, Part, WorkspaceId } from '@/types';
import { db } from './database';
import { messageRepo } from './repositories';

const chatId = 'chat-plan-atomic' as ChatId;
const messageId = 'message-plan-atomic' as MessageId;
const planPart: Extract<Part, { kind: 'plan_review' }> = {
  kind: 'plan_review',
  plan: { id: 'plan-atomic', title: 'Synthetic project', summary: 'Keep approval atomic.',
    steps: ['Write one fixture', 'Verify it'], status: 'pending' },
};
const original: Message = {
  id: messageId, chat_id: chatId, role: 'assistant',
  parts: [{ kind: 'text', text: 'Keep this unrelated part.' }, planPart],
  created_at: 10, updated_at: 11,
};
const chat: Chat = {
  id: chatId, workspace_id: 'workspace-plan-atomic' as WorkspaceId,
  title: 'Synthetic approval test', mode: 'chat', active_agent_ids: [],
  created_at: 1, updated_at: 11,
};
const approve = () => messageRepo.approvePlan(messageId, {
  chatId, planId: planPart.plan.id, expectedParts: structuredClone(original.parts),
});

async function expectUnchanged() {
  expect(await db.messages.toArray()).toEqual([original]);
  expect(await db.chats.get(chatId)).toEqual(chat);
  expect(await db.sync_queue.count()).toBe(0);
  expect(await db.settings.count()).toBe(0);
}

async function expectSingleApproval() {
  const messages = await db.messages.toArray();
  expect(messages).toHaveLength(2);
  expect(messages.filter(row => row.role === 'user')).toEqual([
    expect.objectContaining({ chat_id: chatId, role: 'user',
      parts: [{ kind: 'text', text: 'Yes, implement the plan.' }] }),
  ]);
  expect(await db.messages.get(messageId)).toMatchObject({
    id: messageId, created_at: 10,
    parts: [original.parts[0], { kind: 'plan_review', plan: { ...planPart.plan, status: 'building' } }],
  });
  const queue = await db.sync_queue.toArray();
  expect(queue).toHaveLength(3);
  expect(queue).toEqual(expect.arrayContaining([
    expect.objectContaining({ table: 'messages', op: 'update', row_id: messageId }),
    expect.objectContaining({ table: 'messages', op: 'insert' }),
    expect.objectContaining({ table: 'chats', op: 'update', row_id: chatId }),
  ]));
  expect((await db.chats.get(chatId))!.updated_at).toBeGreaterThan(chat.updated_at);
}

describe('messageRepo.approvePlan', () => {
  beforeEach(async () => {
    expect(Dexie.currentTransaction).toBeNull();
    await db.delete();
    await db.open();
    await db.chats.add(structuredClone(chat));
    await db.messages.add(structuredClone(original));
  });
  afterEach(async () => {
    expect(Dexie.currentTransaction).toBeNull();
    await db.delete();
  });

  it('atomically records the approval, one exact user message, recency and sync rows', async () => {
    await approve();
    await expectSingleApproval();
  });

  it.each(['before-user-insert', 'after-user-insert', 'after-sync-insert'] as const)(
    'rolls back %s failure and permits one safe retry', async (boundary) => {
      const failUser = (_key: unknown, row: Message) => {
        if (row.role === 'user') throw new Error('Synthetic before-user-insert failure');
      };
      const failChat = () => { throw new Error('Synthetic after-user-insert failure'); };
      const failOwner = () => { throw new Error('Synthetic after-sync-insert failure'); };
      if (boundary === 'before-user-insert') db.messages.hook('creating', failUser);
      if (boundary === 'after-user-insert') db.chats.hook('updating', failChat);
      if (boundary === 'after-sync-insert') db.settings.hook('creating', failOwner);
      try {
        await expect(approve()).rejects.toThrow(`Synthetic ${boundary} failure`);
      } finally {
        db.messages.hook('creating').unsubscribe(failUser);
        db.chats.hook('updating').unsubscribe(failChat);
        db.settings.hook('creating').unsubscribe(failOwner);
      }
      await expectUnchanged();
      await approve();
      await expectSingleApproval();
      await expect(approve()).rejects.toThrow(/no longer pending/);
      await expectSingleApproval();
    },
  );

  it('serializes competing approvals so only one caller can dispatch', async () => {
    const results = await Promise.allSettled([approve(), approve()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    await expectSingleApproval();
  });

  it('rejects an intervening edit instead of overwriting unrelated message parts', async () => {
    const parts: Part[] = [...original.parts, { kind: 'text', text: 'Newly persisted content.' }];
    await db.messages.update(messageId, { parts });
    await expect(approve()).rejects.toThrow(/no longer pending/);
    expect(await db.messages.toArray()).toEqual([{ ...original, parts }]);
    expect(await db.sync_queue.count()).toBe(0);
  });

  it.each(['building', 'cancelled', 'redone'] as const)('rejects the %s status even with matching parts', async status => {
    const parts: Part[] = [{ ...planPart, plan: { ...planPart.plan, status } }];
    await db.messages.update(messageId, { parts });
    await expect(messageRepo.approvePlan(messageId, { chatId, planId: planPart.plan.id, expectedParts: parts }))
      .rejects.toThrow(/no longer pending/);
    expect(await db.messages.count()).toBe(1);
    expect(await db.sync_queue.count()).toBe(0);
  });

  it('allows explicit implementation of an informational plan previously marked Done', async () => {
    const parts: Part[] = [{ ...planPart, plan: { ...planPart.plan, executable: false, status: 'built' } }];
    await db.messages.update(messageId, { parts });
    await messageRepo.approvePlan(messageId, { chatId, planId: planPart.plan.id, expectedParts: parts });
    expect(await db.messages.count()).toBe(2);
    expect((await db.messages.get(messageId))!.parts[0]).toMatchObject({ plan: { status: 'building', executable: false } });
  });

  it.each(['wrong-chat', 'non-assistant', 'archived-chat', 'missing-chat', 'duplicate-plan-id'] as const)(
    'rejects %s authority without inserting an approval', async boundary => {
      if (boundary === 'non-assistant') await db.messages.update(messageId, { role: 'user' });
      if (boundary === 'archived-chat') await db.chats.update(chatId, { archived: true });
      if (boundary === 'missing-chat') await db.chats.delete(chatId);
      const parts = boundary === 'duplicate-plan-id' ? [planPart, planPart] : original.parts;
      if (boundary === 'duplicate-plan-id') await db.messages.update(messageId, { parts });
      await expect(messageRepo.approvePlan(messageId, {
        chatId: boundary === 'wrong-chat' ? 'other-chat' as ChatId : chatId,
        planId: planPart.plan.id, expectedParts: parts,
      })).rejects.toThrow(/no longer pending/);
      expect(await db.messages.count()).toBe(1);
      expect(await db.sync_queue.count()).toBe(0);
    },
  );
});
