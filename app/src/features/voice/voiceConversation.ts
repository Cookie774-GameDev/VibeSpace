/** How hands-free mode decides a user turn is complete. */
export type VoiceEndTrigger = 'phrase' | 'silence';

export const VOICE_END_TRIGGER_DEFAULT: VoiceEndTrigger = 'phrase';

/** Default pause after you stop speaking before Jarvis sends your message. */
export const VOICE_SILENCE_DELAY_MS_DEFAULT = 2000;

export const VOICE_SILENCE_DELAY_MS_MIN = 1000;
export const VOICE_SILENCE_DELAY_MS_MAX = 4000;

/** Hands-free only: max time Jarvis keeps listening without speech before stopping. */
export const VOICE_LISTEN_TIMEOUT_MS_DEFAULT = 15_000;

export const VOICE_LISTEN_TIMEOUT_MS_MIN = 5_000;
export const VOICE_LISTEN_TIMEOUT_MS_MAX = 60_000;

export function clampVoiceSilenceDelayMs(ms: number): number {
  return Math.round(
    Math.min(VOICE_SILENCE_DELAY_MS_MAX, Math.max(VOICE_SILENCE_DELAY_MS_MIN, ms)),
  );
}

export function clampVoiceListenTimeoutMs(ms: number): number {
  return Math.round(
    Math.min(VOICE_LISTEN_TIMEOUT_MS_MAX, Math.max(VOICE_LISTEN_TIMEOUT_MS_MIN, ms)),
  );
}

export function voiceSilenceDelayLabel(ms: number): string {
  const seconds = ms / 1000;
  return seconds === 1 ? '1 second' : `${seconds.toFixed(1).replace(/\.0$/, '')} seconds`;
}

export function voiceListenTimeoutLabel(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds === 1 ? '1 second' : `${seconds} seconds`;
}

/** Push-to-talk disables the listen cap; hands-free uses the configured timeout. */
export function resolveVoiceListenTimeoutMs(handsFree: boolean, configuredMs: number): number | null {
  if (!handsFree) return null;
  return clampVoiceListenTimeoutMs(configuredMs);
}
