import { useJarvisInteractionStore } from '@/features/jarvis-interaction/sessionStore';
import { db, messageRepo } from '@/lib/db';
import type { ChatId } from '@/types';
import type { VoiceAgentProvider } from './voiceProviderSelection';

type ReceiptCard = Readonly<{ status?: string; harnessSessionId?: string }>;

export interface VoiceWorkerReceiptSource {
  find(parentChatId: string, agentId: string): ReceiptCard | undefined;
  subscribe(listener: () => void): () => void;
  verifyCompletedProvider?(input: {
    childChatId: string;
    provider: VoiceAgentProvider;
    expectedProviderId: string;
    expectedModelId: string;
  }): Promise<boolean>;
}

const liveReceiptSource: VoiceWorkerReceiptSource = {
  find: (parentChatId, agentId) =>
    useJarvisInteractionStore
      .getState()
      .agentsForChat(parentChatId)
      .find((card) => String(card.agentId) === agentId),
  subscribe: (listener) => useJarvisInteractionStore.subscribe(listener),
  verifyCompletedProvider: async ({
    childChatId,
    provider,
    expectedProviderId,
    expectedModelId,
  }) => {
    const child = await db.chats.get(childChatId as ChatId);
    if (child?.backend_affinity?.backend !== provider) return false;
    const messages = await messageRepo.listByChat(childChatId as ChatId);
    return messages.some(
      (message) =>
        message.role === 'assistant' &&
        message.usage?.provider === expectedProviderId &&
        message.usage?.model === expectedModelId &&
        message.parts.some((part) => part.kind === 'text' && part.text.trim().length > 0),
    );
  },
};

export type VoiceWorkerReceipt =
  | { provider: VoiceAgentProvider; proof: 'session'; sessionId: string }
  | { provider: VoiceAgentProvider; proof: 'completed_response' };

/** A child card and dispatched event are only a request to start. This receipt
 * is set by the runtime after its selected native provider binds a session. */
export function waitForVoiceWorkerReceipt(
  input: {
    parentChatId: string;
    agentId: string;
    provider: VoiceAgentProvider;
    childChatId?: string;
    expectedProviderId?: string;
    expectedModelId?: string;
    timeoutMs?: number;
  },
  source: VoiceWorkerReceiptSource = liveReceiptSource,
): Promise<VoiceWorkerReceipt> {
  const providerLabel = input.provider === 'codex' ? 'Codex' : 'OpenCode';
  const timeoutMs = input.timeoutMs === undefined ? null : Math.max(1, input.timeoutMs);

  return new Promise((resolve, reject) => {
    let finished = false;
    let verifying = false;
    let unsubscribe: () => void = () => undefined;
    const finish = (result: VoiceWorkerReceipt | Error) => {
      if (finished) return;
      finished = true;
      if (timeout !== null) clearTimeout(timeout);
      unsubscribe();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const inspect = () => {
      const card = source.find(input.parentChatId, input.agentId);
      const sessionId = card?.harnessSessionId?.trim();
      if (sessionId) {
        finish({ provider: input.provider, proof: 'session', sessionId });
      } else if (card && ['failed', 'blocked', 'cancelled'].includes(card.status ?? '')) {
        finish(new Error(`${providerLabel} worker session did not start.`));
      } else if (
        card?.status === 'done' &&
        !verifying &&
        input.childChatId &&
        input.expectedProviderId &&
        input.expectedModelId &&
        source.verifyCompletedProvider
      ) {
        verifying = true;
        void source
          .verifyCompletedProvider({
            childChatId: input.childChatId,
            provider: input.provider,
            expectedProviderId: input.expectedProviderId,
            expectedModelId: input.expectedModelId,
          })
          .then(
            (confirmed) =>
              finish(
                confirmed
                  ? { provider: input.provider, proof: 'completed_response' }
                  : new Error(`${providerLabel} worker finished without matching provider proof.`),
              ),
            () => finish(new Error(`${providerLabel} worker provider proof could not be checked.`)),
          );
      }
    };
    const timeout =
      timeoutMs === null
        ? null
        : setTimeout(
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
