import { useResolvedHotkey } from '@/lib/hotkeys';
import { isMac } from '@/lib/utils';

export function nativeDictationHotkey(combo: string): string {
  return combo
    .split('+')
    .map((part) => (part === 'Mod' ? (isMac ? 'Super' : 'Ctrl') : part))
    .join('+');
}

export function useDictationHotkey() {
  return useResolvedHotkey('GLOBAL_DICTATION');
}
