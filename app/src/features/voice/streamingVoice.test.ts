import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SPEECH_SYNTHESIS_END_EVENT,
  SPEECH_SYNTHESIS_START_EVENT,
  STREAMING_VOICE_END_EVENT,
  STREAMING_VOICE_START_EVENT,
} from './speechSynthesis';

const mocks = vi.hoisted(() => ({
  speakWithSettings: vi.fn(async () => undefined),
  authState: {
    voiceEngine: 'system',
    voicePreset: 'jarvis-prime',
  },
  kokoroStream: {
    enqueue: vi.fn(),
    complete: vi.fn(async () => undefined),
    stop: vi.fn(),
  },
  createKokoroStreamingPlayer: vi.fn(),
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
  createKokoroStreamingPlayer: mocks.createKokoroStreamingPlayer,
  registerActiveStreamingVoiceSession: vi.fn(),
  speakWithSettings: mocks.speakWithSettings,
  stopAllVoiceOutput: vi.fn(),
}));

import { StreamingVoiceSession } from './streamingVoice';

describe('StreamingVoiceSession lifecycle', () => {
  beforeEach(() => {
    mocks.speakWithSettings.mockClear();
    mocks.authState.voiceEngine = 'system';
    mocks.authState.voicePreset = 'jarvis-prime';
    mocks.kokoroStream.enqueue.mockClear();
    mocks.kokoroStream.complete.mockClear();
    mocks.kokoroStream.stop.mockClear();
    mocks.createKokoroStreamingPlayer.mockReset();
    mocks.createKokoroStreamingPlayer.mockReturnValue(mocks.kokoroStream);
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

  it('uses the Kokoro streaming player instead of serial speak calls', async () => {
    mocks.authState.voiceEngine = 'kokoro';
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

    expect(mocks.createKokoroStreamingPlayer).toHaveBeenCalledWith('jarvis-prime');
    expect(mocks.kokoroStream.enqueue).toHaveBeenCalledTimes(2);
    expect(mocks.kokoroStream.complete).toHaveBeenCalledTimes(1);
    expect(mocks.speakWithSettings).not.toHaveBeenCalled();
    expect(events).toEqual(['start', 'end']);
  });
});
