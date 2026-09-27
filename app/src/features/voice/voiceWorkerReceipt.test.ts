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
