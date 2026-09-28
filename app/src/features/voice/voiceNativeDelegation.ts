import { dispatchJarvisSendWithAcceptance } from '@/features/chat/chatToChatDispatch';
import type { SendDetail } from '@/lib/ai/runtime';
import type { VoiceAgentProvider } from './voiceProviderSelection';

export type VoiceNativeDelegationRoute =
  | {
      status: 'supported';
      provider: VoiceAgentProvider;
      method: 'provider_native_subagent';
      workerParentSessionId?: string;
    }
  | {
      status: 'blocked';
      code: 'cross_provider_native_session_unavailable';
      actualMainProvider: VoiceAgentProvider;
      requestedWorkerProvider: VoiceAgentProvider;
    };

function safeSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const sessionId = value.trim();
  return sessionId && sessionId.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(sessionId)
    ? sessionId
    : undefined;
}

/**
 * Native child tools belong to their current provider session. A provider
 * mismatch cannot be repaired by overriding the durable parent-chat backend.
 */
export function resolveVoiceNativeDelegationRoute(input: {
  actualMainProvider: VoiceAgentProvider;
  requestedWorkerProvider: VoiceAgentProvider;
  workerParentSessionId?: string;
}): VoiceNativeDelegationRoute {
  if (input.actualMainProvider !== input.requestedWorkerProvider) {
    return {
      status: 'blocked',
      code: 'cross_provider_native_session_unavailable',
      actualMainProvider: input.actualMainProvider,
      requestedWorkerProvider: input.requestedWorkerProvider,
    };
  }
  const workerParentSessionId = safeSessionId(input.workerParentSessionId);
  return {
    status: 'supported',
    provider: input.actualMainProvider,
    method: 'provider_native_subagent',
    ...(workerParentSessionId ? { workerParentSessionId } : {}),
  };
}

/** Prompt guidance only; the native task tool result remains the launch proof. */
export function buildVoiceNativeDelegationGuidance(input: {
  selectedMainProvider: VoiceAgentProvider;
  requestedWorkerProvider: VoiceAgentProvider;
}): string {
  const base = [
    'Answer simple requests directly. For real work, use exactly one provider-native subagent and preserve parent context. Never create VibeSpace child chats or claim launch without a native task/session receipt.',
  ];
  if (input.selectedMainProvider !== input.requestedWorkerProvider) {
    base.push(
      `Worker is ${input.requestedWorkerProvider}; Main is ${input.selectedMainProvider}. Cross-provider native sessions are unavailable. Do not substitute Main or another provider; state this limitation for real work.`,
    );
  } else {
    base.push(
      `Worker is ${input.requestedWorkerProvider}; use its native task tool once and report provider/model only after runtime proof.`,
    );
  }
  base.push(
    'A screenshot is attached to Main only; never claim the worker received it without native attachment evidence.',
  );
  return base.join(' ');
}

export type VoiceMainDispatchFailureCode =
  | 'missing_cancellation_key'
  | 'runtime_cancelled'
  | 'runtime_rejected'
  | 'runtime_timeout'
  | 'dispatch_failed';

export type VoiceMainDispatchReceipt =
  | { status: 'accepted'; chatId: string; cancellationKey: string }
  | { status: 'failed'; code: VoiceMainDispatchFailureCode; message: string };

export type VoiceMainDispatchPort = (detail: SendDetail, timeoutMs?: number) => Promise<void>;

export interface DispatchVoiceMainRequestOptions {
  timeoutMs?: number;
  dispatch?: VoiceMainDispatchPort;
}

const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 8_000;

function dispatchFailureCode(error: unknown): VoiceMainDispatchFailureCode {
  const message = error instanceof Error ? error.message : '';
  if (message === 'CHAT_HANDOFF_RUNTIME_TIMEOUT') return 'runtime_timeout';
  if (message === 'CHAT_HANDOFF_RUNTIME_CANCELLED') return 'runtime_cancelled';
  if (message === 'CHAT_HANDOFF_RUNTIME_REJECTED') return 'runtime_rejected';
  return 'dispatch_failed';
}

function dispatchFailureMessage(code: VoiceMainDispatchFailureCode): string {
  switch (code) {
    case 'missing_cancellation_key':
      return 'The persisted Main request identity is unavailable.';
    case 'runtime_cancelled':
      return 'The Main request was cancelled before runtime acceptance.';
    case 'runtime_timeout':
      return 'The Main runtime did not confirm the request in time.';
    case 'runtime_rejected':
      return 'The Main runtime rejected the request.';
    case 'dispatch_failed':
      return 'The Main request could not be dispatched.';
  }
}

/**
 * A `jarvis:send` event alone is not acceptance. This wrapper resolves only
 * after the runtime publishes the matching running state for the persisted
 * user-message cancellation key.
 */
export async function dispatchVoiceMainRequest(
  detail: SendDetail,
  options: DispatchVoiceMainRequestOptions = {},
): Promise<VoiceMainDispatchReceipt> {
  const cancellationKey = String(detail.cancellationKey ?? '').trim();
  if (
    !cancellationKey ||
    cancellationKey.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(cancellationKey)
  ) {
    return {
      status: 'failed',
      code: 'missing_cancellation_key',
      message: dispatchFailureMessage('missing_cancellation_key'),
    };
  }
  const dispatch = options.dispatch ?? dispatchJarvisSendWithAcceptance;
  try {
    await dispatch(detail, Math.max(1, options.timeoutMs ?? DEFAULT_ACCEPTANCE_TIMEOUT_MS));
    return { status: 'accepted', chatId: String(detail.chatId), cancellationKey };
  } catch (error) {
    const code = dispatchFailureCode(error);
    return { status: 'failed', code, message: dispatchFailureMessage(code) };
  }
}
