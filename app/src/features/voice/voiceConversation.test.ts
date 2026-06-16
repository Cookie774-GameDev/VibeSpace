import { describe, expect, it } from 'vitest';
import {
  VOICE_LISTEN_TIMEOUT_MS_DEFAULT,
  VOICE_SILENCE_DELAY_MS_DEFAULT,
  clampVoiceListenTimeoutMs,
  clampVoiceSilenceDelayMs,
  resolveVoiceListenTimeoutMs,
  voiceListenTimeoutLabel,
  voiceSilenceDelayLabel,
} from './voiceConversation';

describe('voiceConversation', () => {
  it('defaults silence delay to two seconds', () => {
    expect(VOICE_SILENCE_DELAY_MS_DEFAULT).toBe(2000);
    expect(voiceSilenceDelayLabel(VOICE_SILENCE_DELAY_MS_DEFAULT)).toBe('2 seconds');
  });

  it('defaults hands-free listen timeout to fifteen seconds', () => {
    expect(VOICE_LISTEN_TIMEOUT_MS_DEFAULT).toBe(15_000);
    expect(voiceListenTimeoutLabel(VOICE_LISTEN_TIMEOUT_MS_DEFAULT)).toBe('15 seconds');
  });

  it('clamps silence delay into the supported range', () => {
    expect(clampVoiceSilenceDelayMs(500)).toBe(1000);
    expect(clampVoiceSilenceDelayMs(2500)).toBe(2500);
    expect(clampVoiceSilenceDelayMs(9000)).toBe(4000);
  });

  it('clamps listen timeout into the supported range', () => {
    expect(clampVoiceListenTimeoutMs(1000)).toBe(5000);
    expect(clampVoiceListenTimeoutMs(15_000)).toBe(15_000);
    expect(clampVoiceListenTimeoutMs(120_000)).toBe(60_000);
  });

  it('disables listen timeout for push-to-talk', () => {
    expect(resolveVoiceListenTimeoutMs(false, 15_000)).toBeNull();
    expect(resolveVoiceListenTimeoutMs(true, 20_000)).toBe(20_000);
  });
});
