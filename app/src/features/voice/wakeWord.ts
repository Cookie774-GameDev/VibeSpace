import { useAuthStore } from '@/stores/auth';

export const WAKE_WORD_STORAGE_KEY = 'jarvis-wake-word';
export const WAKE_WORD_SETTING_EVENT = 'jarvis:wake-word-setting';

export const WAKE_PHRASES = [
  'jarvis',
  'hey jarvis',
  'hi jarvis',
  'okay jarvis',
  'ok jarvis',
  'yo jarvis',
  'wake up jarvis',
] as const;

export function normalizeWakeTranscript(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function containsWakePhrase(text: string): boolean {
  const normalized = normalizeWakeTranscript(text);
  if (!normalized) return false;
  return WAKE_PHRASES.some((phrase) => {
    const normalizedPhrase = normalizeWakeTranscript(phrase);
    return new RegExp(`(^|\\s)${normalizedPhrase.replace(/\s+/g, '\\s+')}(\\s|$)`).test(normalized);
  });
}

export function readWakeWordEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(WAKE_WORD_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setWakeWordEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(WAKE_WORD_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    return;
  }
  window.dispatchEvent(new CustomEvent(WAKE_WORD_SETTING_EVENT, { detail: { enabled } }));
}

/** Wake-word auto-open is only allowed in hands-free mode with the wake toggle on. */
export function isWakeWordAutoOpenAllowed(): boolean {
  return readWakeWordEnabled() && useAuthStore.getState().voiceAutoListenOnOpen;
}
