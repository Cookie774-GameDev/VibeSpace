import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Chat, ChatId, Message, MessageId, Part, WorkspaceId } from '@/types';
import type { SyncQueueRow } from './schema';
import { db } from './database';
import { messageRepo } from './repositories';

const chatId = 'chat-plan-revision' as ChatId;
const messageId = 'message-plan-revision' as MessageId;
const planPart: Extract<Part, { kind: 'plan_review' }> = { kind: 'plan_review', plan: {
  id: 'plan-revision', title: 'Synthetic plan', summary: 'Keep revisions atomic.',
  steps: ['Inspect', 'Verify'], status: 'pending',
} };
const source: Message = { id: messageId, chat_id: chatId, role: 'assistant',
  parts: [{ kind: 'text', text: 'Preserve this unrelated part.' }, planPart], created_at: 10, updated_at: 11 };
const chat: Chat = { id: chatId, workspace_id: 'workspace-plan-revision' as WorkspaceId,
  title: 'Revision fixture', mode: 'chat', active_agent_ids: [], created_at: 1, updated_at: 11 };
const input = () => ({ chatId, planId: planPart.plan.id, expectedParts: structuredClone(source.parts),
  revision: '  Include rollback verification.  ', preserveExistingRequirements: false });
const text = 'Redo this plan with this instruction: Include rollback verification.';

async function assertUnchanged() {
  expect(await db.messages.toArray()).toEqual([source]);
  expect(await db.chats.get(chatId)).toEqual(chat);
  expect(await db.sync_queue.count()).toBe(0);
  expect(await db.settings.count()).toBe(0);
}
async function assertOnce(expected = text) {
  const rows = await db.messages.toArray();
  expect(rows).toHaveLength(2);
  expect(rows.filter(row => row.role === 'user')).toEqual([expect.objectContaining({
    chat_id: chatId, parts: [{ kind: 'text', text: expected }],
  })]);
  expect(await db.messages.get(messageId)).toMatchObject({ created_at: 10,
    parts: [source.parts[0], { kind: 'plan_review', plan: { ...planPart.plan, status: 'redone' } }] });
  expect(await db.sync_queue.count()).toBe(3);
  expect((await db.chats.get(chatId))!.updated_at).toBeGreaterThan(chat.updated_at);
}

describe('messageRepo.revisePlan', () => {
  beforeEach(async () => {
    expect(Dexie.currentTransaction).toBeNull();
    await db.delete(); await db.open();
    await db.chats.add(structuredClone(chat)); await db.messages.add(structuredClone(source));
  });
  afterEach(async () => { expect(Dexie.currentTransaction).toBeNull(); await db.delete(); });

  it.each([false, true])('commits one exact revision with preserve-existing=%s', async preserveExistingRequirements => {
    const expected = preserveExistingRequirements
      ? 'Redo this plan with this instruction: Preserve the existing requirements and add: Include rollback verification.' : text;
    await expect(messageRepo.revisePlan(messageId, { ...input(), preserveExistingRequirements })).resolves.toBe(expected);
    await assertOnce(expected);
  });

  it.each(['before-message', 'after-message', 'final-sync'] as const)('rolls back %s failure and permits one retry', async boundary => {
    const failMessage = (_key: unknown, row: Message) => { if (row.role === 'user') throw new Error('Synthetic rollback'); };
    const failChat = () => { throw new Error('Synthetic rollback'); };
    const failQueue = (_key: unknown, row: SyncQueueRow) => { if (row.table === 'chats') throw new Error('Synthetic rollback'); };
    if (boundary === 'before-message') db.messages.hook('creating', failMessage);
    if (boundary === 'after-message') db.chats.hook('updating', failChat);
    if (boundary === 'final-sync') db.sync_queue.hook('creating', failQueue);
    try { await expect(messageRepo.revisePlan(messageId, input())).rejects.toThrow('Synthetic rollback'); }
    finally {
      db.messages.hook('creating').unsubscribe(failMessage); db.chats.hook('updating').unsubscribe(failChat);
      db.sync_queue.hook('creating').unsubscribe(failQueue);
    }
    await assertUnchanged();
    await messageRepo.revisePlan(messageId, input()); await assertOnce();
    await expect(messageRepo.revisePlan(messageId, input())).rejects.toThrow(/no longer pending/);
    await assertOnce();
  });

  it('serializes duplicate revisions to one caller and one durable message', async () => {
    const results = await Promise.allSettled([messageRepo.revisePlan(messageId, input()), messageRepo.revisePlan(messageId, input())]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    await assertOnce();
  });

  it('serializes competing approval and revision without committing both decisions', async () => {
    const results = await Promise.allSettled([messageRepo.revisePlan(messageId, input()), messageRepo.approvePlan(messageId, input())]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await db.messages.count()).toBe(2); expect(await db.sync_queue.count()).toBe(3);
  });

  it.each(['built', 'building', 'cancelled', 'redone'] as const)('rejects a %s plan even with matching source parts', async status => {
    const parts: Part[] = [{ ...planPart, plan: { ...planPart.plan, status } }];
    await db.messages.update(messageId, { parts });
    await expect(messageRepo.revisePlan(messageId, { ...input(), expectedParts: parts })).rejects.toThrow(/no longer pending/);
    expect(await db.messages.count()).toBe(1); expect(await db.sync_queue.count()).toBe(0);
  });

  it.each(['wrong-chat', 'archived-chat', 'wrong-role', 'stale-parts'] as const)('rejects %s without losing existing content', async boundary => {
    if (boundary === 'archived-chat') await db.chats.update(chatId, { archived: true });
    if (boundary === 'wrong-role') await db.messages.update(messageId, { role: 'user' });
    if (boundary === 'stale-parts') await db.messages.update(messageId, { parts: [...source.parts, { kind: 'text', text: 'New content.' }] });
    const before = await db.messages.toArray();
    await expect(messageRepo.revisePlan(messageId, { ...input(), chatId: boundary === 'wrong-chat' ? 'other' as ChatId : chatId })).rejects.toThrow(/no longer pending/);
    expect(await db.messages.toArray()).toEqual(before); expect(await db.sync_queue.count()).toBe(0);
  });

  it('rejects a blank revision before any persistence', async () => {
    await expect(messageRepo.revisePlan(messageId, { ...input(), revision: ' \n ' })).rejects.toThrow(/revision/i);
    await assertUnchanged();
  });
});
