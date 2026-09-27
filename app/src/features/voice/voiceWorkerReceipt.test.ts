import { describe, expect, it, vi } from 'vitest';
import { waitForVoiceWorkerReceipt, type VoiceWorkerReceiptSource } from './voiceWorkerReceipt';

function receiptSource() {
  let card: { harnessSessionId?: string; status?: string } | undefined;
  const listeners = new Set<() => void>();
  const source: VoiceWorkerReceiptSource = {
    find: () => card,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    publish(next: typeof card) {
      card = next;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

describe('voice worker runtime receipt', () => {
  it('waits for a real harness session before reporting which provider received the task', async () => {
    const cards = receiptSource();
    const receipt = waitForVoiceWorkerReceipt(
      { parentChatId: 'parent', agentId: 'agent', provider: 'opencode' },
      cards.source,
    );
    let settled = false;
    void receipt.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    cards.publish({ status: 'thinking', harnessSessionId: 'native-session-1' });
    await expect(receipt).resolves.toEqual({
      provider: 'opencode',
      proof: 'session',
      sessionId: 'native-session-1',
    });
    expect(cards.listenerCount()).toBe(0);
  });

  it('rejects a failed worker before any provider receipt', async () => {
    const cards = receiptSource();
    const receipt = waitForVoiceWorkerReceipt(
      { parentChatId: 'parent', agentId: 'agent', provider: 'codex' },
      cards.source,
    );
    const rejected = expect(receipt).rejects.toThrow('Codex worker session did not start.');
    cards.publish({ status: 'failed' });
    await rejected;
    expect(cards.listenerCount()).toBe(0);
  });

  it('accepts a completed child only after matching persisted provider evidence', async () => {
    const cards = receiptSource();
    const verifyCompletedProvider = vi.fn(async () => true);
    const receipt = waitForVoiceWorkerReceipt(
      {
        parentChatId: 'parent',
        agentId: 'agent',
        provider: 'codex',
        childChatId: 'child',
        expectedProviderId: 'openai',
        expectedModelId: 'codex-auto-review',
      },
      { ...cards.source, verifyCompletedProvider },
    );
    cards.publish({ status: 'done' });
    await expect(receipt).resolves.toEqual({ provider: 'codex', proof: 'completed_response' });
    expect(verifyCompletedProvider).toHaveBeenCalledWith({
      childChatId: 'child',
      provider: 'codex',
      expectedProviderId: 'openai',
      expectedModelId: 'codex-auto-review',
    });
  });

  it('rejects a done child whose persisted response does not match the requested provider', async () => {
    const cards = receiptSource();
    const receipt = waitForVoiceWorkerReceipt(
      {
        parentChatId: 'parent',
        agentId: 'agent',
        provider: 'codex',
        childChatId: 'child',
        expectedProviderId: 'openai',
        expectedModelId: 'codex-auto-review',
      },
      { ...cards.source, verifyCompletedProvider: async () => false },
    );
    const rejected = expect(receipt).rejects.toThrow('without matching provider proof');
    cards.publish({ status: 'done' });
    await rejected;
  });

  it('does not claim provider receipt after a bounded timeout', async () => {
    vi.useFakeTimers();
    try {
      const cards = receiptSource();
      const receipt = waitForVoiceWorkerReceipt(
        { parentChatId: 'parent', agentId: 'agent', provider: 'codex', timeoutMs: 25 },
        cards.source,
      );
      const rejected = expect(receipt).rejects.toThrow(
        'Codex worker session was created, but provider receipt was not confirmed.',
      );
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(cards.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
