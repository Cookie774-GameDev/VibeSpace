import { describe, expect, it, vi } from 'vitest';
import type { SendDetail } from '@/lib/ai/runtime';
import {
  dispatchVoiceMainRequest,
  resolveVoiceNativeDelegationRoute,
  type VoiceMainDispatchPort,
} from './voiceNativeDelegation';

describe('voice provider-native delegation boundary', () => {
  it('fails closed for cross-provider work without substituting the Main provider', () => {
    expect(
      resolveVoiceNativeDelegationRoute({
        actualMainProvider: 'codex',
        requestedWorkerProvider: 'opencode',
      }),
    ).toEqual({
      status: 'blocked',
      code: 'cross_provider_native_session_unavailable',
      actualMainProvider: 'codex',
      requestedWorkerProvider: 'opencode',
    });
  });

  it('permits the provider-native tool path only when Worker and actual Main providers match', () => {
    expect(
      resolveVoiceNativeDelegationRoute({
        actualMainProvider: 'opencode',
        requestedWorkerProvider: 'opencode',
        workerParentSessionId: 'session-parent-1',
      }),
    ).toEqual({
      status: 'supported',
      provider: 'opencode',
      method: 'provider_native_subagent',
      workerParentSessionId: 'session-parent-1',
    });
  });

  it('requires a persisted cancellation key and reports Main acceptance only after runtime confirmation', async () => {
    const detail = {
      chatId: 'chat-1',
      cancellationKey: 'user-message-1',
      text: 'Do one task',
    } as SendDetail;
    const dispatch: VoiceMainDispatchPort = vi.fn(async () => undefined);

    await expect(dispatchVoiceMainRequest(detail, { dispatch })).resolves.toEqual({
      status: 'accepted',
      chatId: 'chat-1',
      cancellationKey: 'user-message-1',
    });
    expect(dispatch).toHaveBeenCalledWith(detail, expect.any(Number));
  });

  it('does not dispatch a send with no persisted user message identity', async () => {
    const dispatch = vi.fn(async () => undefined);
    const receipt = await dispatchVoiceMainRequest(
      { chatId: 'chat-1', text: 'Do one task' } as SendDetail,
      { dispatch },
    );

    expect(receipt).toMatchObject({ status: 'failed', code: 'missing_cancellation_key' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['CHAT_HANDOFF_RUNTIME_TIMEOUT', 'runtime_timeout'],
    ['CHAT_HANDOFF_RUNTIME_CANCELLED', 'runtime_cancelled'],
    ['CHAT_HANDOFF_RUNTIME_REJECTED', 'runtime_rejected'],
    ['unexpected dispatch failure', 'dispatch_failed'],
  ] as const)('preserves runtime dispatch failure %s as %s', async (error, code) => {
    const dispatch = vi.fn(async () => {
      throw new Error(error);
    });
    const receipt = await dispatchVoiceMainRequest(
      { chatId: 'chat-1', cancellationKey: 'message-1', text: 'Do one task' } as SendDetail,
      { dispatch },
    );

    expect(receipt).toMatchObject({ status: 'failed', code });
  });
});
