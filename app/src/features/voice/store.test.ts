import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoiceStore } from './store';

describe('useVoiceStore transcripts', () => {
  beforeEach(() => {
    useVoiceStore.getState().reset();
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('caps finalized captions so long hands-free sessions do not grow forever', () => {
    for (let i = 0; i < 80; i++) {
      vi.setSystemTime(1_000 + i);
      useVoiceStore.getState().pushFinalTranscript(`utterance ${i}`);
    }

    const finals = useVoiceStore.getState().finalTranscript;
    expect(finals).toHaveLength(24);
    expect(finals[0]?.text).toBe('utterance 56');
    expect(finals.at(-1)?.text).toBe('utterance 79');
  });
});
