import { useJarvisInteractionStore } from '@/features/jarvis-interaction/sessionStore';
import type { VoiceAgentProvider } from './voiceProviderSelection';

type ReceiptCard = Readonly<{ status?: string; harnessSessionId?: string }>;

export interface VoiceWorkerReceiptSource {
  find(parentChatId: string, agentId: string): ReceiptCard | undefined;
  subscribe(listener: () => void): () => void;
}

const liveReceiptSource: VoiceWorkerReceiptSource = {
  find: (parentChatId, agentId) =>
    useJarvisInteractionStore
      .getState()
      .agentsForChat(parentChatId)
      .find((card) => String(card.agentId) === agentId),
  subscribe: (listener) => useJarvisInteractionStore.subscribe(listener),
};

export interface VoiceWorkerReceipt {
  provider: VoiceAgentProvider;
  sessionId: string;
}

/** A child card and dispatched event are only a request to start. This receipt
 * is set by the runtime after its selected native provider binds a session. */
export function waitForVoiceWorkerReceipt(
  input: {
    parentChatId: string;
    agentId: string;
    provider: VoiceAgentProvider;
    timeoutMs?: number;
  },
  source: VoiceWorkerReceiptSource = liveReceiptSource,
): Promise<VoiceWorkerReceipt> {
  const providerLabel = input.provider === 'codex' ? 'Codex' : 'OpenCode';
  const timeoutMs = Math.max(1, Math.min(input.timeoutMs ?? 90_000, 120_000));

  return new Promise((resolve, reject) => {
    let finished = false;
    let unsubscribe: () => void = () => undefined;
    const finish = (result: VoiceWorkerReceipt | Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      unsubscribe();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const inspect = () => {
      const card = source.find(input.parentChatId, input.agentId);
      const sessionId = card?.harnessSessionId?.trim();
      if (sessionId) {
        finish({ provider: input.provider, sessionId });
      } else if (card && ['failed', 'blocked', 'cancelled'].includes(card.status ?? '')) {
        finish(new Error(`${providerLabel} worker session did not start.`));
      }
    };
    const timeout = setTimeout(
      () =>
        finish(
          new Error(
            `${providerLabel} worker session was created, but provider receipt was not confirmed.`,
          ),
        ),
      timeoutMs,
    );
    unsubscribe = source.subscribe(inspect);
    inspect();
  });
}
