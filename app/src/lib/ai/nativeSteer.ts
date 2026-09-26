import type { MessageId } from '@/types';
import type { ChatId } from '@/types/common';
export interface NativeSteerControl {
  steer(input: { clientUserMessageId: string; text: string; skills?: readonly import('./adapters/codexAppServerProtocol').CodexDiscoveredSkill[] }): Promise<void>;
}

/** The provider may have accepted a control request even though its reply was not observed. */
export class NativeTurnControlOutcomeUnknownError extends Error {
  readonly code = 'native_turn_control_outcome_unknown';

  constructor() {
    super('Codex may have accepted the steer; review it before retrying.');
    this.name = 'NativeTurnControlOutcomeUnknownError';
  }
}

export function nativeSteerFailureDisposition(
  error: unknown,
  nativeAcknowledged: boolean,
): 'review_required' | 'retryable' {
  return error instanceof NativeTurnControlOutcomeUnknownError || nativeAcknowledged
    ? 'review_required'
    : 'retryable';
}

/** Provider acknowledgement precedes the single durable user-message append. */
export async function dispatchRuntimeNativeSteer(input: {
  control: NativeSteerControl;
  clientUserMessageId: string;
  chatId: string;
  text: string;
  skills?: readonly import('./adapters/codexAppServerProtocol').CodexDiscoveredSkill[];
  isStillActive: () => boolean;
  appendUserMessage: (message: {
    chat_id: ChatId;
    role: 'user';
    parts: [{ kind: 'text'; text: string }];
  }) => Promise<{ id: MessageId }>;
  acceptedCancellationKey: MessageId;
  onAccepted?: (cancellationKey: MessageId) => void;
  onNativeAck?: () => void;
}): Promise<MessageId> {
  if (!input.isStillActive()) throw new Error('The exact Codex turn is no longer active.');
  await input.control.steer({ clientUserMessageId: input.clientUserMessageId, text: input.text,
    ...(input.skills?.length ? { skills: input.skills } : {}) });
  input.onNativeAck?.();
  const userMessage = await input.appendUserMessage({
    chat_id: input.chatId as ChatId,
    role: 'user',
    parts: [{ kind: 'text', text: input.text }],
  });
  try {
    input.onAccepted?.(input.acceptedCancellationKey);
  } catch {
    /* durable write remains authoritative */
  }
  return userMessage.id;
}
