/** Default pause after you stop speaking before Jarvis sends your message. */
export const VOICE_SILENCE_DELAY_MS_DEFAULT = 2000;

export const VOICE_SILENCE_DELAY_MS_MIN = 1000;
export const VOICE_SILENCE_DELAY_MS_MAX = 4000;

export function clampVoiceSilenceDelayMs(ms: number): number {
  return Math.round(
    Math.min(VOICE_SILENCE_DELAY_MS_MAX, Math.max(VOICE_SILENCE_DELAY_MS_MIN, ms)),
  );
}

export function voiceSilenceDelayLabel(ms: number): string {
  const seconds = ms / 1000;
  return seconds === 1 ? '1 second' : `${seconds.toFixed(1).replace(/\.0$/, '')} seconds`;
}
