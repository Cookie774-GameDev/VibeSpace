import { describe, expect, it, vi } from 'vitest';
import type { ChatModelSelection } from '@/lib/ai/modelSelection';
import type { SendDetail } from '@/lib/ai/runtime';
import { createVoiceSessionBinding } from './voiceSessionBinding';
import {
  buildVoiceMainRequestSendDetail,
  createVoiceAgentFlow,
  VOICE_BRIEF_SYSTEM_INSTRUCTION,
  type VoiceAgentFlowDependencies,
  type VoiceAgentRequest,
} from './voiceAgentFlow';
import type { VoiceMainDispatchReceipt } from './voiceNativeDelegation';

const selection = {
  mode: 'single',
  providerId: 'openai',
  modelId: 'gpt-6',
  connectionId: 'openai-codex',
} as ChatModelSelection;

const binding = createVoiceSessionBinding({
  sessionId: 'voice-session-1',
  accountId: 'account-1',
  chatId: 'chat-voice' as never,
  startedAt: 1,
});

const request: VoiceAgentRequest = {
  chatId: 'chat-voice',
  text: 'Check the failing tests on my screen',
  mainProvider: 'codex',
  workerProvider: 'opencode',
  selection,
  voiceSession: binding,
  requestId: 'voice-request-1',
};

function setup() {
  const calls: string[] = [];
  const deps = {
    now: vi.fn(() => 1000),
    acknowledge: vi.fn(() => {
      calls.push('ack');
    }),
    persistUser: vi.fn(async () => {
      calls.push('persist');
      return 'message-1';
    }),
    captureScreen: vi.fn(async (): ReturnType<VoiceAgentFlowDependencies['captureScreen']> => {
      calls.push('capture');
      return {
        ok: true as const,
        attachment: {
          id: 'screen-1',
          name: 'screen.jpg',
          mimeType: 'image/jpeg',
          data: 'base64-image',
          size: 12,
        },
      };
    }),
    dispatchMain: vi.fn(async (detail: SendDetail): Promise<VoiceMainDispatchReceipt> => {
      calls.push('dispatch');
      return {
        status: 'accepted',
        chatId: detail.chatId,
        cancellationKey: String(detail.cancellationKey),
      };
    }),
    createRequestId: vi.fn(() => 'voice-request-generated'),
    reportStatus: vi.fn(),
  };
  return { deps, calls, flow: createVoiceAgentFlow(deps) };
}

describe('voice Main Agent request', () => {
  it('builds one Main send with voice-only brevity, selected Main model, worker constraints, and bounded context', () => {
    const detail = buildVoiceMainRequestSendDetail({
      chatId: request.chatId,
      userText: 'Check the failing tests',
      mainProvider: 'codex',
      workerProvider: 'opencode',
      selection,
      cancellationKey: 'message-1',
      requestId: 'voice-request-1',
      voiceSession: binding,
      sourceContext: 'Recent source chat context.',
      priorTaskContext: 'An earlier native task is still running.',
    });

    expect(detail).toMatchObject({
      chatId: 'chat-voice',
      text: 'Check the failing tests',
      cancellationKey: 'message-1',
      speakReply: true,
      interactionMode: 'agent',
      modelSelectionOverride: selection,
      autoApproveActions: false,
      accountId: 'account-1',
      voiceSessionId: 'voice-session-1',
    });
    expect(detail.localCommandContext).toContain(VOICE_BRIEF_SYSTEM_INSTRUCTION);
    expect(detail.localCommandContext).toContain('Answer simple requests directly');
    expect(detail.localCommandContext).toContain('Cross-provider');
    expect(detail.structuredContext?.payload).toMatchObject({
      requestId: 'voice-request-1',
      mainProvider: 'codex',
      requestedWorkerProvider: 'opencode',
      crossProviderNativeSessionUnavailable: true,
      sourceContext: 'Recent source chat context.',
      priorTaskContext: 'An earlier native task is still running.',
    });
  });

  it('does not pre-block a direct Main answer when the worker provider differs', () => {
    const detail = buildVoiceMainRequestSendDetail({
      chatId: request.chatId,
      userText: 'What time is it?',
      mainProvider: 'codex',
      workerProvider: 'opencode',
      selection,
      cancellationKey: 'message-2',
      requestId: 'voice-request-2',
    });

    expect(detail.text).toBe('What time is it?');
    expect(detail.interactionMode).toBe('agent');
    expect(detail.localCommandContext).toContain('Answer simple requests directly');
  });

  it('keeps the selected voice effort with the exact Main model through dispatch', async () => {
    const preference = { mode: 'normal' as const, effortOverride: 'low' as const };
    const { deps, flow } = setup();
    await flow.run({ ...request, reasoningPreference: preference });

    expect(deps.dispatchMain).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelectionOverride: selection,
        reasoningPreference: preference,
      }),
    );
  });

  it('keeps typed sends free of voice-only brevity and speech controls', () => {
    const detail = buildVoiceMainRequestSendDetail({
      chatId: request.chatId,
      userText: 'Summarize this file',
      mainProvider: 'codex',
      workerProvider: 'codex',
      selection,
      cancellationKey: 'message-3',
      requestId: 'voice-request-3',
      sourceContext: 'The user asked about src/app.ts.',
    });

    expect(detail.speakReply).toBe(false);
    expect(detail.localCommandContext).not.toContain(VOICE_BRIEF_SYSTEM_INSTRUCTION);
    expect(detail.modelSelectionOverride).toBe(selection);
  });

  it('acknowledges, persists once, captures once, and dispatches the original request once to Main', async () => {
    const { deps, calls, flow } = setup();
    const result = await flow.run(request);

    expect(calls).toEqual(['ack', 'persist', 'capture', 'dispatch']);
    expect(deps.persistUser).toHaveBeenCalledOnce();
    expect(deps.captureScreen).toHaveBeenCalledWith(request.text, 'opencode');
    const sent = deps.dispatchMain.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      chatId: 'chat-voice',
      text: request.text,
      cancellationKey: 'message-1',
      imageAttachments: [expect.objectContaining({ id: 'screen-1' })],
    });
    expect(sent?.structuredContext?.payload).toMatchObject({ requestId: 'voice-request-1' });
    expect(result).toMatchObject({
      status: 'main_accepted',
      duplicate: false,
      requestId: 'voice-request-1',
      cancellationKey: 'message-1',
    });
    expect(deps.reportStatus).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'main_accepted' }),
    );
    expect(result).not.toHaveProperty('actualWorkerProvider');
    expect(result).not.toHaveProperty('childChatId');
  });

  it('deduplicates repeated final transcripts without acknowledging, persisting, capturing, or dispatching twice', async () => {
    const { deps, flow } = setup();
    await flow.run(request);
    const duplicate = await flow.run({
      ...request,
      text: '  Check   the failing tests on my screen. ',
      requestId: 'different-transcript-id',
    });

    expect(duplicate).toMatchObject({ status: 'main_accepted', duplicate: true });
    expect(deps.acknowledge).toHaveBeenCalledOnce();
    expect(deps.persistUser).toHaveBeenCalledOnce();
    expect(deps.captureScreen).toHaveBeenCalledOnce();
    expect(deps.dispatchMain).toHaveBeenCalledOnce();
  });

  it('continues with text after screenshot capture failure and tells Main the limitation', async () => {
    const { deps, flow } = setup();
    deps.captureScreen.mockResolvedValueOnce({
      ok: false,
      code: 'permission-denied',
      message: 'Screen capture was not permitted.',
    });

    const result = await flow.run(request);
    const sent = deps.dispatchMain.mock.calls[0]?.[0];

    expect(result.status).toBe('main_accepted');
    expect(sent?.text).toBe(request.text);
    expect(sent?.imageAttachments).toBeUndefined();
    expect(sent?.localCommandContext).toContain('Screen capture was not permitted.');
    expect(deps.reportStatus).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'capture_failed' }),
    );
  });

  it('does not dispatch if persistence fails', async () => {
    const { deps, flow } = setup();
    deps.persistUser.mockRejectedValueOnce(new Error('save failed'));

    const result = await flow.run(request);

    expect(result.status).toBe('persist_failed');
    expect(deps.dispatchMain).not.toHaveBeenCalled();
    expect(deps.captureScreen).not.toHaveBeenCalled();
  });

  it('reports runtime rejection without calling the Main turn accepted', async () => {
    const { deps, flow } = setup();
    deps.dispatchMain.mockResolvedValueOnce({
      status: 'failed',
      code: 'runtime_timeout',
      message: 'No runtime acceptance was observed.',
    });

    const result = await flow.run({ ...request, text: 'Check the tests' });

    expect(result.status).toBe('dispatch_failed');
    expect(deps.reportStatus).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'dispatch_failed' }),
    );
    expect(deps.reportStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'main_accepted' }),
    );
  });

  it('does not persist or dispatch an aborted turn', async () => {
    const { deps, flow } = setup();
    const controller = new AbortController();
    controller.abort();

    const result = await flow.run({ ...request, signal: controller.signal });

    expect(result.status).toBe('cancelled');
    expect(deps.persistUser).not.toHaveBeenCalled();
    expect(deps.dispatchMain).not.toHaveBeenCalled();
  });
});
