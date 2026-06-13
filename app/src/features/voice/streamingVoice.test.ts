import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SPEECH_SYNTHESIS_END_EVENT,
  SPEECH_SYNTHESIS_START_EVENT,
  STREAMING_VOICE_END_EVENT,
  STREAMING_VOICE_START_EVENT,
} from './speechSynthesis';

const mocks = vi.hoisted(() => ({
  speakWithSettings: vi.fn(async () => undefined),
}));

vi.mock('@/stores/auth', () => ({
  useAuthStore: {
    getState: () => ({
      voiceEngine: 'system',
      voicePreset: 'jarvis-prime',
    }),
  },
}));

vi.mock('@/stores/ui', () => ({
  useUIStore: {
    getState: () => ({ voiceModalOpen: true }),
  },
}));

vi.mock('./voiceRouter', () => ({
  registerActiveStreamingVoiceSession: vi.fn(),
  speakWithSettings: mocks.speakWithSettings,
  stopAllVoiceOutput: vi.fn(),
}));

import { StreamingVoiceSession } from './streamingVoice';

describe('StreamingVoiceSession lifecycle', () => {
  beforeEach(() => {
    mocks.speakWithSettings.mockClear();
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
});
