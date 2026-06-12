import { describe, expect, it } from 'vitest';
import {
  VOICE_SILENCE_DELAY_MS_DEFAULT,
  clampVoiceSilenceDelayMs,
  voiceSilenceDelayLabel,
} from './voiceConversation';

describe('voiceConversation', () => {
  it('defaults silence delay to two seconds', () => {
    expect(VOICE_SILENCE_DELAY_MS_DEFAULT).toBe(2000);
    expect(voiceSilenceDelayLabel(VOICE_SILENCE_DELAY_MS_DEFAULT)).toBe('2 seconds');
  });

  it('clamps silence delay into the supported range', () => {
    expect(clampVoiceSilenceDelayMs(500)).toBe(1000);
    expect(clampVoiceSilenceDelayMs(2500)).toBe(2500);
    expect(clampVoiceSilenceDelayMs(9000)).toBe(4000);
  });
});
