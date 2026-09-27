import { describe, expect, it, vi } from 'vitest';
import {
  buildVoiceMainResultSendDetail,
  createVoiceAgentFlow,
  VOICE_BRIEF_SYSTEM_INSTRUCTION,
  type VoiceMainDelivery,
} from './voiceAgentFlow';
import { createVoiceSessionBinding } from './voiceSessionBinding';
import type { ChatModelSelection } from '@/lib/ai/modelSelection';

const request = {
  chatId: 'chat-voice',
  text: 'Check the failing tests on my screen',
  mainProvider: 'codex' as const,
  workerProvider: 'opencode' as const,
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
    }),
    captureScreen: vi.fn(async () => ({
      ok: true as const,
      attachment: {
        id: 'screen-1',
        name: 'screen.jpg',
        mimeType: 'image/jpeg',
        data: 'base64-image',
        size: 12,
      },
    })),
    launchWorker: vi.fn(async () => {
      calls.push('launch');
      return { agentId: 'agent-1', childChatId: 'child-1', actualProvider: 'opencode' as const };
    }),
    waitForWorker: vi.fn(async () => ({ status: 'done' as const, text: 'Two tests pass.' })),
    deliverMainResult: vi.fn(async () => {
      calls.push('main');
    }),
    reportStatus: vi.fn(),
  };
  return { deps, calls, flow: createVoiceAgentFlow(deps) };
}

describe('voice agent flow', () => {
  it('puts the brief instruction and selected provider route on the voice-only runtime send', () => {
    const selection = {
      mode: 'single',
      providerId: 'openai',
      modelId: 'gpt-5',
      connectionId: 'openai-codex',
    } as ChatModelSelection;
    const delivery: VoiceMainDelivery = {
      chatId: 'chat-voice',
      userText: 'Check the tests',
      mainProvider: 'codex' as const,
      workerProvider: 'opencode' as const,
      childChatId: 'chat-child',
      workerStatus: 'done' as const,
      workerText: 'Two tests passed.',
      instruction: VOICE_BRIEF_SYSTEM_INSTRUCTION,
    };
    const binding = createVoiceSessionBinding({
      sessionId: 'voice-session-1',
      accountId: 'account-1',
      chatId: 'chat-voice' as never,
      startedAt: 1,
    });
    const voice = buildVoiceMainResultSendDetail({ delivery, selection, voiceSession: binding });
    const typed = buildVoiceMainResultSendDetail({ delivery, selection });

    expect(voice.speakReply).toBe(true);
    expect(voice.modelSelectionOverride).toBe(selection);
    expect(voice.localCommandContext).toContain(VOICE_BRIEF_SYSTEM_INSTRUCTION);
    expect(voice.structuredContext?.payload).toMatchObject({
      workerProvider: 'opencode',
      workerText: 'Two tests passed.',
    });
    expect(typed.speakReply).toBe(false);
    expect(typed.localCommandContext).not.toContain(VOICE_BRIEF_SYSTEM_INSTRUCTION);
  });

  it('acknowledges first, launches one worker with a permitted screen, and forwards its result', async () => {
    const { deps, calls, flow } = setup();
    const outcome = await flow.run(request);

    expect(calls[0]).toBe('ack');
    expect(calls).toEqual(['ack', 'persist', 'launch', 'main']);
    expect(deps.captureScreen).toHaveBeenCalledWith(request.text, 'opencode');
    expect(deps.launchWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        parentChatId: 'chat-voice',
        requestedProvider: 'opencode',
        imageAttachments: [
          {
            id: 'screen-1',
            name: 'screen.jpg',
            mimeType: 'image/jpeg',
            data: 'base64-image',
            size: 12,
          },
        ],
      }),
    );
    expect(deps.deliverMainResult).toHaveBeenCalledWith(
      expect.objectContaining({
        mainProvider: 'codex',
        workerProvider: 'opencode',
        workerStatus: 'done',
        workerText: 'Two tests pass.',
        instruction: VOICE_BRIEF_SYSTEM_INSTRUCTION,
      }),
    );
    expect(outcome).toMatchObject({ status: 'main_dispatched', actualWorkerProvider: 'opencode' });
  });

  it('does not launch or speak again for repeated final transcripts', async () => {
    const { deps, flow } = setup();
    await flow.run(request);
    const duplicate = await flow.run({
      ...request,
      text: '  Check   the failing tests on my screen. ',
    });

    expect(duplicate.duplicate).toBe(true);
    expect(deps.acknowledge).toHaveBeenCalledTimes(1);
    expect(deps.launchWorker).toHaveBeenCalledTimes(1);
    expect(deps.deliverMainResult).toHaveBeenCalledTimes(1);
  });

  it('sends text after capture failure and never claims an image was attached', async () => {
    const { deps, flow } = setup();
    deps.captureScreen.mockResolvedValueOnce({
      ok: false,
      code: 'permission-denied',
      message: 'Screen capture was not permitted.',
    } as never);
    await flow.run(request);

    expect(deps.launchWorker).toHaveBeenCalledWith(
      expect.objectContaining({ imageAttachments: [] }),
    );
    expect(deps.deliverMainResult).toHaveBeenCalledWith(
      expect.objectContaining({ captureNotice: 'Screen capture was not permitted.' }),
    );
  });

  it('reports a launch failure without claiming a worker started', async () => {
    const { deps, flow } = setup();
    deps.launchWorker.mockRejectedValueOnce(new Error('provider unavailable'));
    const outcome = await flow.run({ ...request, text: 'Check the failing tests' });

    expect(outcome.status).toBe('launch_failed');
    expect(deps.reportStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'launched' }),
    );
    expect(deps.waitForWorker).not.toHaveBeenCalled();
    expect(deps.deliverMainResult).not.toHaveBeenCalled();
  });

  it('reports delivery failure truthfully after a worker was launched', async () => {
    const { deps, flow } = setup();
    deps.deliverMainResult.mockRejectedValueOnce(new Error('main runtime unavailable'));
    const outcome = await flow.run({ ...request, text: 'Check the failing tests' });

    expect(outcome.status).toBe('delivery_failed');
    expect(outcome.actualWorkerProvider).toBe('opencode');
    expect(deps.reportStatus).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'delivery_failed', message: 'main runtime unavailable' }),
    );
  });
});
