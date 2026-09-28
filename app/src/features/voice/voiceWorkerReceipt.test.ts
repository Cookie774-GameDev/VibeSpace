import { describe, expect, it, vi } from 'vitest';
import type { ChatActivityEvent } from '@/features/chat/activity';
import {
  resolveVoiceNativeTaskReceipt,
  waitForVoiceWorkerReceipt,
  type VoiceWorkerReceiptSource,
} from './voiceWorkerReceipt';

function taskActivity(overrides: Partial<ChatActivityEvent> = {}): ChatActivityEvent {
  return {
    id: 'tool-activity-1',
    chatId: 'parent',
    kind: 'tool',
    status: 'running',
    title: 'task',
    ts: 10,
    messageId: 'assistant-message-1',
    providerCallId: 'native-call-1',
    nativeTask: {
      name: 'Check failing tests',
      sessionId: 'native-child-session-1',
      modelLabel: 'openai/gpt-6-mini',
    },
    ...overrides,
  };
}

function receiptSource(initialProvider: 'codex' | 'opencode' | undefined) {
  let events: ChatActivityEvent[] = [];
  let provider = initialProvider;
  const listeners = new Set<() => void>();
  const source: VoiceWorkerReceiptSource = {
    find: (parentChatId, messageId) =>
      events.find(
        (event) => String(event.chatId) === parentChatId && event.messageId === messageId,
      ),
    getBoundProvider: async () => provider,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    publish(next: ChatActivityEvent) {
      events = [...events, next];
      for (const listener of listeners) listener();
    },
    setProvider(next: typeof provider) {
      provider = next;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

describe('provider-native voice worker receipt', () => {
  it('requires matching parent message, actual provider affinity, tool call, and native child session identity', () => {
    expect(
      resolveVoiceNativeTaskReceipt({
        parentChatId: 'parent',
        expectedMessageId: 'assistant-message-1',
        actualMainProvider: 'opencode',
        requestedWorkerProvider: 'opencode',
        activity: taskActivity(),
      }),
    ).toEqual({
      status: 'launched',
      provider: 'opencode',
      evidence: 'provider_native_task_tool',
      parentChatId: 'parent',
      parentMessageId: 'assistant-message-1',
      nativeTaskId: 'native-child-session-1',
      providerCallId: 'native-call-1',
      modelId: 'openai/gpt-6-mini',
    });
  });

  it('does not accept a native task from another Main turn', () => {
    expect(
      resolveVoiceNativeTaskReceipt({
        parentChatId: 'parent',
        expectedMessageId: 'assistant-message-expected',
        actualMainProvider: 'opencode',
        requestedWorkerProvider: 'opencode',
        activity: taskActivity(),
      }),
    ).toBeNull();
  });

  it('fails closed when the Worker provider differs from the actual parent runtime', () => {
    expect(
      resolveVoiceNativeTaskReceipt({
        parentChatId: 'parent',
        expectedMessageId: 'assistant-message-1',
        actualMainProvider: 'codex',
        requestedWorkerProvider: 'opencode',
        activity: taskActivity(),
      }),
    ).toBeNull();
  });

  it('waits for a correlated native task event and then reports the actual same-provider identity', async () => {
    const source = receiptSource('codex');
    const receipt = waitForVoiceWorkerReceipt(
      {
        parentChatId: 'parent',
        expectedMessageId: 'assistant-message-1',
        requestedWorkerProvider: 'codex',
        timeoutMs: 100,
      },
      source.source,
    );
    source.publish(
      taskActivity({
        nativeTask: {
          name: 'Check failing tests',
          sessionId: 'codex-subagent-thread-1',
          modelLabel: 'gpt-6-codex-mini',
        },
      }),
    );

    await expect(receipt).resolves.toMatchObject({
      status: 'launched',
      provider: 'codex',
      evidence: 'provider_native_task_tool',
      nativeTaskId: 'codex-subagent-thread-1',
      modelId: 'gpt-6-codex-mini',
    });
    expect(source.listenerCount()).toBe(0);
  });

  it('rejects a cross-provider request before accepting a Main provider task as the Worker', async () => {
    const source = receiptSource('codex');
    await expect(
      waitForVoiceWorkerReceipt(
        {
          parentChatId: 'parent',
          expectedMessageId: 'assistant-message-1',
          requestedWorkerProvider: 'opencode',
          timeoutMs: 100,
        },
        source.source,
      ),
    ).rejects.toThrow('cross_provider_native_session_unavailable');
    expect(source.listenerCount()).toBe(0);
  });

  it('does not report launch after timeout when a same-provider task has no native event', async () => {
    vi.useFakeTimers();
    try {
      const source = receiptSource('opencode');
      const receipt = waitForVoiceWorkerReceipt(
        {
          parentChatId: 'parent',
          expectedMessageId: 'assistant-message-1',
          requestedWorkerProvider: 'opencode',
          timeoutMs: 25,
        },
        source.source,
      );
      const rejected = expect(receipt).rejects.toThrow('native task receipt was not confirmed');
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(source.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails immediately when durable parent provider affinity is unknown', async () => {
    const source = receiptSource(undefined);
    await expect(
      waitForVoiceWorkerReceipt(
        {
          parentChatId: 'parent',
          expectedMessageId: 'assistant-message-1',
          requestedWorkerProvider: 'opencode',
          timeoutMs: 100,
        },
        source.source,
      ),
    ).rejects.toThrow('provider identity could not be verified');
    expect(source.listenerCount()).toBe(0);
  });

  it('unsubscribes if the runtime affinity lookup fails', async () => {
    const source = receiptSource('codex');
    const failingSource: VoiceWorkerReceiptSource = {
      ...source.source,
      getBoundProvider: vi.fn(async () => {
        throw new Error('storage unavailable');
      }),
    };
    await expect(
      waitForVoiceWorkerReceipt(
        {
          parentChatId: 'parent',
          expectedMessageId: 'assistant-message-1',
          requestedWorkerProvider: 'codex',
          timeoutMs: 100,
        },
        failingSource,
      ),
    ).rejects.toThrow('provider identity could not be verified');
  });
});
