import { describe, expect, it } from 'vitest';
import {
  VOICE_SILENCE_DELAY_MS_DEFAULT,
  clampVoiceSilenceDelayMs,
  resolveVoiceListenTimeoutMs,
  voiceSilenceDelayLabel,
} from './voiceConversation';

describe('voiceConversation', () => {
  it('defaults silence delay to two seconds', () => {
    expect(VOICE_SILENCE_DELAY_MS_DEFAULT).toBe(2000);
    expect(voiceSilenceDelayLabel(VOICE_SILENCE_DELAY_MS_DEFAULT)).toBe('2 seconds');
  });

  it('clamps the single pause duration into the supported 1-60 second range', () => {
    expect(clampVoiceSilenceDelayMs(500)).toBe(1000);
    expect(clampVoiceSilenceDelayMs(2500)).toBe(2500);
    expect(clampVoiceSilenceDelayMs(90_000)).toBe(60_000);
  });

  it('disables inactivity timeout for send-it and click-to-talk modes', () => {
    expect(resolveVoiceListenTimeoutMs(false, 'silence', 15_000)).toBeNull();
    expect(resolveVoiceListenTimeoutMs(true, 'phrase', 15_000)).toBeNull();
  });

  it('uses the same bounded duration for hands-free pause submission', () => {
    expect(resolveVoiceListenTimeoutMs(true, 'silence', 20_000)).toBe(20_000);
    expect(resolveVoiceListenTimeoutMs(true, 'silence', 90_000)).toBe(60_000);
  });
});
