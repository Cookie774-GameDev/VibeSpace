import { expect, it, vi } from 'vitest';
import { requestNativeSubagentReply, requestBoundChildReply } from './nativeSubagentReply';
import type { JarvisChatAgent } from './types';

function fixture(backend: 'codex' | 'opencode' = 'codex') {
  const getById = vi.fn().mockResolvedValue({
    id: 'parent',
    account_id: 'account',
    workspace_id: 'workspace',
    project_id: 'project',
    backend_affinity: { backend },
  });
  const create = vi.fn().mockResolvedValue({});
  const dispatchEvent = vi.fn();
  return {
    repos: { chatRepo: { getById }, messageRepo: { create } },
    dispatchEvent,
    getById,
    create,
  };
}
it.each(['codex', 'opencode'] as const)(
  'requests %s native control for the exact returned child without spawning a replacement',
  async (harness) => {
    const f = fixture(harness);
    await requestNativeSubagentReply({
      parentChatId: 'parent',
      text: 'Check the edge case',
      run: {
        name: 'Review',
        sessionId: 'native_child',
        parentSessionId: 'native_parent',
        harness,
      },
      ...f,
    });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.dispatchEvent).toHaveBeenCalledTimes(1);
    expect(f.dispatchEvent.mock.calls[0]![0].detail).toMatchObject({
      chatId: 'parent',
      queueIfBusy: true,
      structuredContext: {
        payload: {
          operation: 'reply',
          nativeSessionId: 'native_child',
          nativeParentSessionId: 'native_parent',
          instruction: expect.stringContaining(harness === 'opencode' ? 'task_id' : 'sendInput'),
        },
      },
    });
    expect(f.dispatchEvent.mock.calls[0]![0].detail.modelSelectionOverride).toBeUndefined();
  },
);
it('fails closed on missing native identity and mismatched harness before writing', async () => {
  const f = fixture('opencode');
  await expect(
    requestNativeSubagentReply({
      parentChatId: 'parent',
      text: 'Continue',
      run: { name: 'Review', harness: 'codex', sessionId: 'child' },
      ...f,
    }),
  ).rejects.toThrow(/backend/i);
  await expect(
    requestNativeSubagentReply({
      parentChatId: 'parent',
      text: 'Continue',
      run: { name: 'Review' },
      ...f,
    }),
  ).rejects.toThrow(/native/i);
  expect(f.create).not.toHaveBeenCalled();
  expect(f.dispatchEvent).not.toHaveBeenCalled();
});
it('uses the already bound compatibility child and its explicit model, preserving scope', async () => {
  const f = fixture('opencode');
  const agent = {
    agentId: 'agent',
    parentChatId: 'parent',
    childChatId: 'child',
    harnessSessionId: 'native_child',
    modelSelection: { mode: 'single', providerId: 'openai', modelId: 'child-model' },
  } as JarvisChatAgent;
  await requestBoundChildReply({ agent, text: 'Continue review', ...f });
  expect(f.create.mock.calls[0]![0].chat_id).toBe('child');
  expect(f.dispatchEvent.mock.calls[0]![0].detail).toMatchObject({
    chatId: 'child',
    queueIfBusy: true,
    modelSelectionOverride: agent.modelSelection,
    structuredContext: { payload: { parentChatId: 'parent', agentId: 'agent' } },
  });
  f.getById
    .mockResolvedValueOnce({ workspace_id: 'workspace' })
    .mockResolvedValueOnce({ workspace_id: 'other' });
  await expect(requestBoundChildReply({ agent, text: 'Cross scope', ...f })).rejects.toThrow(
    /scope/i,
  );
  expect(f.create).toHaveBeenCalledTimes(1);
});
