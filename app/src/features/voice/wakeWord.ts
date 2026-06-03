export const WAKE_WORD_STORAGE_KEY = 'jarvis-wake-word';
export const WAKE_WORD_SETTING_EVENT = 'jarvis:wake-word-setting';

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
