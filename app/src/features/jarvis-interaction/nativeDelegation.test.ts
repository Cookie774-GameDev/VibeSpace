import { expect, it, vi } from 'vitest';
import { requestNativeDelegation } from './nativeDelegation';
it.each(['multitask', 'subagents'] as const)('routes %s through the parent session without synthetic child chats', async commandName => {
  const getById = vi.fn().mockResolvedValue({ id: 'parent' });
  const create = vi.fn().mockResolvedValue({}); const dispatchEvent = vi.fn();
  await requestNativeDelegation({ parentChatId: 'parent', task: 'Review the game', commandName,
    repos: { chatRepo: { getById }, messageRepo: { create } }, dispatchEvent });
  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith({ chat_id: 'parent', role: 'user', parts: [{ kind: 'text', text: `/${commandName} Review the game` }] });
  expect(dispatchEvent.mock.calls[0][0].detail).toMatchObject({ chatId: 'parent', queueIfBusy: true,
    structuredContext: { payload: { delegation: 'provider-native', instruction: expect.stringContaining('task_id') } } });
  expect(JSON.stringify(dispatchEvent.mock.calls)).not.toContain('You are a chat-native');
});
