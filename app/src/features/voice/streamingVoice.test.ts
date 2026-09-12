import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SPEECH_SYNTHESIS_END_EVENT,
  SPEECH_SYNTHESIS_START_EVENT,
  STREAMING_VOICE_END_EVENT,
  STREAMING_VOICE_START_EVENT,
} from './speechSynthesis';

const mocks = vi.hoisted(() => ({
  speakWithSettings: vi.fn(async (): Promise<void> => undefined),
  authState: {
    voiceEngine: 'system',
    voicePreset: 'jarvis-prime',
  },
  jarvisStream: {
    enqueue: vi.fn(),
    complete: vi.fn(async () => undefined),
    stop: vi.fn(),
  },
  createJarvisStreamingPlayer: vi.fn(),
  stopAllVoiceOutput: vi.fn(),
  canSpeak: true,
  sessionId: 1,
}));

vi.mock('@/stores/auth', () => ({
  useAuthStore: {
    getState: () => mocks.authState,
  },
}));

vi.mock('@/stores/ui', () => ({
  useUIStore: {
    getState: () => ({ voiceModalOpen: true }),
  },
}));

vi.mock('./voiceRouter', () => ({
  createJarvisStreamingPlayer: mocks.createJarvisStreamingPlayer,
  registerActiveStreamingVoiceSession: vi.fn(),
  speakWithSettings: mocks.speakWithSettings,
  stopAllVoiceOutput: mocks.stopAllVoiceOutput,
  canVoiceModuleSpeak: () => mocks.canSpeak,
  getActiveVoiceSessionId: () => mocks.sessionId,
}));

import { createCanonicalVoicePlaybackAdapter, StreamingVoiceSession } from './streamingVoice';
import { validateSpeechChunk } from './speechGate';

function validated(text: string) {
  const decision = validateSpeechChunk({
    text,
    completeSentence: true,
    insideFence: false,
    mode: 'direct_answer',
    lintViolations: [],
  });
  if (!decision.allowed) throw new Error(decision.reason);
  return decision.chunk;
}

describe('StreamingVoiceSession lifecycle', () => {
  beforeEach(() => {
    mocks.speakWithSettings.mockClear();
    mocks.authState.voiceEngine = 'system';
    mocks.authState.voicePreset = 'jarvis-prime';
    mocks.canSpeak = true;
    mocks.sessionId = 1;
    mocks.jarvisStream.enqueue.mockClear();
    mocks.jarvisStream.complete.mockClear();
    mocks.jarvisStream.stop.mockClear();
    mocks.createJarvisStreamingPlayer.mockReset();
    mocks.createJarvisStreamingPlayer.mockReturnValue(mocks.jarvisStream);
    mocks.stopAllVoiceOutput.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits one start/end pair for a multi-segment reply', async () => {
    const events: string[] = [];
    const onStreamStart = () => events.push('stream:start');
    const onStreamEnd = () => events.push('stream:end');
    const onSpeechStart = () => events.push('speech:start');
    const onSpeechEnd = () => events.push('speech:end');
    window.addEventListener(STREAMING_VOICE_START_EVENT, onStreamStart);
    window.addEventListener(STREAMING_VOICE_END_EVENT, onStreamEnd);
    window.addEventListener(SPEECH_SYNTHESIS_START_EVENT, onSpeechStart);
    window.addEventListener(SPEECH_SYNTHESIS_END_EVENT, onSpeechEnd);

    const session = new StreamingVoiceSession();
    session.onDelta('Hello there. ');
    session.onDelta('Hello there. How are you?');
    await session.onComplete('Hello there. How are you?');

    window.removeEventListener(STREAMING_VOICE_START_EVENT, onStreamStart);
    window.removeEventListener(STREAMING_VOICE_END_EVENT, onStreamEnd);
    window.removeEventListener(SPEECH_SYNTHESIS_START_EVENT, onSpeechStart);
    window.removeEventListener(SPEECH_SYNTHESIS_END_EVENT, onSpeechEnd);

    expect(events.filter((e) => e === 'stream:start')).toHaveLength(1);
    expect(events.filter((e) => e === 'stream:end')).toHaveLength(1);
    expect(events.filter((e) => e === 'speech:start')).toHaveLength(1);
    expect(events.filter((e) => e === 'speech:end')).toHaveLength(1);
    expect(mocks.speakWithSettings).toHaveBeenCalled();
  });

  it('haltPlayback emits streaming end when speech had started', async () => {
    const ends: string[] = [];
    const onEnd = () => ends.push('end');
    window.addEventListener(STREAMING_VOICE_END_EVENT, onEnd);

    const session = new StreamingVoiceSession();
    session.onDelta('Hello.');
    await Promise.resolve();
    session.haltPlayback();

    window.removeEventListener(STREAMING_VOICE_END_EVENT, onEnd);
    expect(ends).toHaveLength(1);
  });

  it('emits end when completion has nothing to speak', async () => {
    const ends: string[] = [];
    const onEnd = () => ends.push('end');
    window.addEventListener(STREAMING_VOICE_END_EVENT, onEnd);

    const session = new StreamingVoiceSession();
    await session.onComplete('   ');

    window.removeEventListener(STREAMING_VOICE_END_EVENT, onEnd);
    expect(ends).toHaveLength(1);
    expect(mocks.speakWithSettings).not.toHaveBeenCalled();
  });

  it('ignores speech when the voice session is no longer live', () => {
    const session = new StreamingVoiceSession();
    mocks.canSpeak = false;
    session.onDelta('Hello there.');
    expect(mocks.speakWithSettings).not.toHaveBeenCalled();
  });

  it('keeps speak-replies live when the voice panel session id is unset', async () => {
    mocks.sessionId = 0;
    mocks.canSpeak = true;
    const session = new StreamingVoiceSession();
    session.onDelta('Hello there.');
    await session.onComplete('Hello there.');
    expect(mocks.speakWithSettings).toHaveBeenCalled();
  });

  it('uses the Jarvis streaming player instead of serial speak calls', async () => {
    mocks.authState.voiceEngine = 'jarvis';
    const events: string[] = [];
    const onStart = () => events.push('start');
    const onEnd = () => events.push('end');
    window.addEventListener(STREAMING_VOICE_START_EVENT, onStart);
    window.addEventListener(STREAMING_VOICE_END_EVENT, onEnd);

    const session = new StreamingVoiceSession();
    session.onDelta('First sentence. ');
    session.onDelta('First sentence. Second sentence.');
    await session.onComplete('First sentence. Second sentence.');

    window.removeEventListener(STREAMING_VOICE_START_EVENT, onStart);
    window.removeEventListener(STREAMING_VOICE_END_EVENT, onEnd);

    expect(mocks.createJarvisStreamingPlayer).toHaveBeenCalledWith('jarvis-prime');
    expect(mocks.jarvisStream.enqueue).toHaveBeenCalledTimes(2);
    expect(mocks.jarvisStream.complete).toHaveBeenCalledTimes(1);
    expect(mocks.speakWithSettings).not.toHaveBeenCalled();
    expect(events).toEqual(['start', 'end']);
  });

  it('accepts only gate-branded chunks on the new streaming path', async () => {
    const session = new StreamingVoiceSession();
    session.enqueueValidatedChunk(validated('First sentence.'));
    await session.completeValidated({
      spokenText: 'Second sentence.',
      mode: 'direct_answer',
    });

    expect(mocks.speakWithSettings).toHaveBeenNthCalledWith(
      1,
      'First sentence.',
      expect.any(Object),
    );
    expect(mocks.speakWithSettings).toHaveBeenNthCalledWith(
      2,
      'Second sentence.',
      expect.any(Object),
    );
  });

  it.each([
    {
      spokenText: 'The selected model is unavailable.',
      mode: 'warning' as const,
    },
    {
      spokenText: 'The operation failed before completion.',
      mode: 'action_failure' as const,
      executionState: {
        status: 'failed' as const,
        verifiedBy: 'journal' as const,
        lastEventSeq: 3,
      },
    },
    {
      spokenText: 'The action was cancelled before completion.',
      mode: 'status' as const,
      executionState: {
        status: 'cancelled' as const,
        verifiedBy: 'journal' as const,
        lastEventSeq: 4,
      },
    },
  ])('speaks final validated severity without changing its truth', async (response) => {
    const session = new StreamingVoiceSession();
    await session.completeValidated(response);
    expect(mocks.speakWithSettings).toHaveBeenCalledWith(response.spokenText, expect.any(Object));
  });

  it('clears queued speech on stop and never starts the next chunk', async () => {
    let releaseFirst: (() => void) | undefined;
    mocks.speakWithSettings.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const session = new StreamingVoiceSession();
    session.enqueueValidatedChunk(validated('First sentence.'));
    session.enqueueValidatedChunk(validated('Second sentence.'));
    await vi.waitFor(() => expect(mocks.speakWithSettings).toHaveBeenCalledTimes(1));

    session.stop();
    releaseFirst?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.stopAllVoiceOutput).toHaveBeenCalledOnce();
    expect(mocks.speakWithSettings).toHaveBeenCalledTimes(1);
  });

  it('does not emit a late completion or restart playback after halt', async () => {
    let releaseFirst: (() => void) | undefined;
    mocks.speakWithSettings.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const end = vi.fn();
    window.addEventListener(STREAMING_VOICE_END_EVENT, end);
    const session = new StreamingVoiceSession();
    session.enqueueValidatedChunk(validated('Only sentence.'));
    await vi.waitFor(() => expect(mocks.speakWithSettings).toHaveBeenCalledOnce());
    const completion = session.completeValidated({ mode: 'direct_answer' });

    session.haltPlayback();
    releaseFirst?.();
    await completion;
    await Promise.resolve();

    expect(end).toHaveBeenCalledOnce();
    expect(mocks.speakWithSettings).toHaveBeenCalledOnce();
    window.removeEventListener(STREAMING_VOICE_END_EVENT, end);
  });

  it('issues opaque immutable playback receipts and verifies only its actual completion result', async () => {
    const adapter = createCanonicalVoicePlaybackAdapter();
    const controller = adapter.prepare({
      accountId: 'account-voice',
      runId: 'run-voice',
      requestId: 'request-voice',
      attemptNumber: 1,
      spokenText: 'Validated voice response.',
    });

    expect(Object.isFrozen(adapter)).toBe(true);
    expect(controller).not.toBeNull();
    if (!controller) throw new Error('expected voice controller');
    expect(Object.isFrozen(controller)).toBe(true);
    expect(Object.isFrozen(controller.receipt)).toBe(true);
    expect(controller.receipt).toMatchObject({
      sessionId: expect.stringMatching(/^vsession_/),
      engineId: 'system:jarvis-prime',
      ttsExecutionId: expect.any(String),
      playbackExecutionId: expect.any(String),
    });

    const result = await controller.start();
    expect(result).toMatchObject({
      tts: { state: 'completed' },
      playback: { state: 'completed' },
      terminalStatus: 'completed',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(controller.verify(result)).toBe(true);
    expect(controller.verify(structuredClone(result))).toBe(false);
    expect(mocks.speakWithSettings).toHaveBeenCalledWith(
      'Validated voice response.',
      expect.any(Object),
    );
    expect(JSON.stringify({ receipt: controller.receipt, result })).not.toContain(
      'Validated voice response.',
    );
    expect(controller.abort()).toBe('already_exited');
    controller.dispose();
    controller.dispose();
  });

  it('truthfully degrades without starting speech when the voice module is not live', async () => {
    mocks.canSpeak = false;
    const controller = createCanonicalVoicePlaybackAdapter().prepare({
      accountId: 'account-voice',
      runId: 'run-voice',
      requestId: 'request-voice',
      attemptNumber: 1,
      spokenText: 'Validated voice response.',
    });
    if (!controller) throw new Error('expected voice controller');

    await expect(controller.start()).resolves.toMatchObject({
      tts: { state: 'degraded', reason: 'unavailable' },
      playback: { state: 'degraded', reason: 'unavailable' },
      terminalStatus: 'partial',
    });
    expect(mocks.speakWithSettings).not.toHaveBeenCalled();
  });

  it('reports one real stop signal and never upgrades an aborted playback to completed', async () => {
    let release: (() => void) | undefined;
    mocks.speakWithSettings.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const controller = createCanonicalVoicePlaybackAdapter().prepare({
      accountId: 'account-voice',
      runId: 'run-voice',
      requestId: 'request-voice',
      attemptNumber: 1,
      spokenText: 'Validated voice response.',
    });
    if (!controller) throw new Error('expected voice controller');
    const completion = controller.start();
    await vi.waitFor(() => expect(mocks.speakWithSettings).toHaveBeenCalledOnce());

    expect(controller.abort()).toBe('signal_delivered');
    expect(controller.abort()).toBe('already_exited');
    release?.();
    await expect(completion).resolves.toMatchObject({
      tts: { state: 'degraded', reason: 'stopped' },
      playback: { state: 'degraded', reason: 'stopped' },
      terminalStatus: 'partial',
    });
  });

  it('accepts a stop before start and never lets the prepared controller speak', async () => {
    const controller = createCanonicalVoicePlaybackAdapter().prepare({
      accountId: 'account-voice',
      runId: 'run-voice',
      requestId: 'request-voice',
      attemptNumber: 1,
      spokenText: 'Validated voice response.',
    });
    if (!controller) throw new Error('expected voice controller');

    expect(controller.abort()).toBe('signal_delivered');
    await expect(controller.start()).resolves.toMatchObject({
      tts: { state: 'degraded', reason: 'stopped' },
      playback: { state: 'degraded', reason: 'stopped' },
      terminalStatus: 'partial',
    });
    expect(mocks.speakWithSettings).not.toHaveBeenCalled();
  });
});
