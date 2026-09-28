import {
  getChatActivityEvents,
  useChatActivityStore,
  type ChatActivityEvent,
} from '@/features/chat/activity';
import { db } from '@/lib/db';
import type { ChatId } from '@/types';
import type { VoiceAgentProvider } from './voiceProviderSelection';

export interface VoiceWorkerReceiptSource {
  find(parentChatId: string, expectedMessageId: string): ChatActivityEvent | undefined;
  getBoundProvider(parentChatId: string): Promise<VoiceAgentProvider | undefined>;
  subscribe(listener: () => void): () => void;
}

const liveReceiptSource: VoiceWorkerReceiptSource = {
  find: (parentChatId, expectedMessageId) =>
    getChatActivityEvents(parentChatId).find((event) => event.messageId === expectedMessageId),
  getBoundProvider: async (parentChatId) => {
    const chat = await db.chats.get(parentChatId as ChatId);
    const backend = chat?.backend_affinity?.backend;
    return backend === 'codex' || backend === 'opencode' ? backend : undefined;
  },
  subscribe: (listener) => useChatActivityStore.subscribe(listener),
};

export interface VoiceWorkerReceipt {
  status: 'launched';
  provider: VoiceAgentProvider;
  evidence: 'provider_native_task_tool';
  parentChatId: string;
  parentMessageId: string;
  /** Native child thread/session ID returned by Codex or OpenCode. */
  nativeTaskId: string;
  providerCallId: string;
  modelId?: string;
}

/** Convert exact runtime task activity into a receipt; never infer from UI prose. */
export function resolveVoiceNativeTaskReceipt(input: {
  parentChatId: string;
  expectedMessageId: string;
  actualMainProvider: VoiceAgentProvider;
  requestedWorkerProvider: VoiceAgentProvider;
  activity: ChatActivityEvent;
}): VoiceWorkerReceipt | null {
  const activity = input.activity;
  if (
    input.actualMainProvider !== input.requestedWorkerProvider ||
    String(activity.chatId) !== input.parentChatId ||
    activity.messageId !== input.expectedMessageId ||
    activity.kind !== 'tool' ||
    activity.status === 'error' ||
    activity.status === 'cancelled'
  ) {
    return null;
  }
  const nativeTaskId = activity.nativeTask?.sessionId?.trim();
  const providerCallId = activity.providerCallId?.trim();
  if (
    !nativeTaskId ||
    nativeTaskId.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(nativeTaskId) ||
    !providerCallId ||
    providerCallId.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(providerCallId)
  ) {
    return null;
  }
  const modelId = activity.nativeTask?.modelLabel?.trim();
  return {
    status: 'launched',
    provider: input.actualMainProvider,
    evidence: 'provider_native_task_tool',
    parentChatId: input.parentChatId,
    parentMessageId: input.expectedMessageId,
    nativeTaskId,
    providerCallId,
    ...(modelId ? { modelId: modelId.slice(0, 180) } : {}),
  };
}

/** Wait for an exact correlated native task event and verified parent backend affinity. */
export function waitForVoiceWorkerReceipt(
  input: {
    parentChatId: string;
    expectedMessageId: string;
    requestedWorkerProvider: VoiceAgentProvider;
    timeoutMs?: number;
  },
  source: VoiceWorkerReceiptSource = liveReceiptSource,
): Promise<VoiceWorkerReceipt> {
  const timeoutMs = input.timeoutMs === undefined ? null : Math.max(1, input.timeoutMs);
  return new Promise((resolve, reject) => {
    let finished = false;
    let checking = false;
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
      if (finished || checking) return;
      checking = true;
      void source
        .getBoundProvider(input.parentChatId)
        .then((actualMainProvider) => {
          checking = false;
          if (finished) return;
          if (!actualMainProvider) {
            finish(
              new Error(
                'Native worker provider identity could not be verified from parent affinity.',
              ),
            );
            return;
          }
          if (actualMainProvider !== input.requestedWorkerProvider) {
            finish(
              new Error(
                `cross_provider_native_session_unavailable: Main is ${actualMainProvider}; Worker is ${input.requestedWorkerProvider}.`,
              ),
            );
            return;
          }
          const activity = source.find(input.parentChatId, input.expectedMessageId);
          if (!activity) return;
          const receipt = resolveVoiceNativeTaskReceipt({
            parentChatId: input.parentChatId,
            expectedMessageId: input.expectedMessageId,
            actualMainProvider,
            requestedWorkerProvider: input.requestedWorkerProvider,
            activity,
          });
          if (receipt) finish(receipt);
        })
        .catch(() => {
          checking = false;
          finish(
            new Error(
              'Native worker provider identity could not be verified from parent affinity.',
            ),
          );
        });
    };
    const timeout =
      timeoutMs === null
        ? null
        : setTimeout(
            () => finish(new Error('Voice native task receipt was not confirmed before timeout.')),
            timeoutMs,
          );
    unsubscribe = source.subscribe(inspect);
    inspect();
  });
}
