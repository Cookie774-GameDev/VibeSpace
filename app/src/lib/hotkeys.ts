import { useEffect } from 'react';
import { isMac } from './utils';

/**
 * Lightweight global hotkey hook.
 *
 * Usage:
 *   useHotkey('Mod+K', () => openPalette())
 *   useHotkey('Mod+Shift+Enter', () => broadcast(), { whenInputs: false })
 *
 * 'Mod' = Cmd on Mac, Ctrl on Windows/Linux.
 *
 * By default the handler is suppressed when an input/textarea/contenteditable is focused,
 * unless `whenInputs: true` is passed.
 */
export type Hotkey = string;

type Options = {
  /** Allow the hotkey to fire even when a text input has focus */
  whenInputs?: boolean;
  /** Disable the binding (handy for conditional registration) */
  disabled?: boolean;
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * Test whether a KeyboardEvent satisfies a hotkey string like
 * 'Mod+Shift+1', 'Enter', or 'Mod+\\'. Exported so feature code (e.g. the
 * launcher's per-link hotkey hook) can reuse the same parsing rules without
 * going through the hook layer.
 */
export function matchesHotkey(e: KeyboardEvent, hotkey: Hotkey): boolean {
  const parts = hotkey.split('+').map((p) => p.trim().toLowerCase());
  const wantMod = parts.includes('mod') || parts.includes('cmd') || parts.includes('ctrl');
  const wantShift = parts.includes('shift');
  const wantAlt = parts.includes('alt') || parts.includes('option');
  const key = parts[parts.length - 1];

  const modPressed = isMac ? e.metaKey : e.ctrlKey;
  if (wantMod && !modPressed) return false;
  if (!wantMod && modPressed) return false;
  if (wantShift !== e.shiftKey) return false;
  if (wantAlt !== e.altKey) return false;

  // Normalize the key: 'enter', 'escape', 'space', '/', single chars
  const eKey = e.key.toLowerCase();
  if (key === 'space') return eKey === ' ' || eKey === 'spacebar';
  if (key === 'esc' || key === 'escape') return eKey === 'escape';
  if (key === 'enter') return eKey === 'enter';
  // Special handling for backslash because '+' separator collides
  if (key === '\\' || key === 'backslash') return eKey === '\\';
  return eKey === key;
}

export function useHotkey(hotkey: Hotkey, handler: (e: KeyboardEvent) => void, opts: Options = {}): void {
  useEffect(() => {
    if (opts.disabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!opts.whenInputs && isEditableTarget(e.target)) return;
      if (matchesHotkey(e, hotkey)) {
        handler(e);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkey, handler, opts.whenInputs, opts.disabled]);
}

/**
 * The canonical hotkey table - keep in sync with docs/05-ui-ux-design.md section 13.
 */
export const HOTKEYS = {
  PALETTE: 'Mod+K',
  TOGGLE_NAV: 'Mod+B',
  TOGGLE_INSPECTOR: 'Mod+\\',
  NEW_CHAT: 'Mod+T',
  NEW_TAB: 'Mod+T',
  CLOSE_TAB: 'Mod+W',
  SEND: 'Mod+Enter',
  BROADCAST: 'Mod+Shift+Enter',
  PUSH_TO_TALK: 'Mod+Space',
  TOGGLE_TODO: 'Mod+Shift+T',
  SETTINGS: 'Mod+,',
  ESCAPE: 'Escape',
  // V2
  TOGGLE_FULLSCREEN: 'Mod+Shift+F',
  AMBIENT_TOGGLE: 'Mod+Shift+.',
  COMPOSER_STT: 'Mod+Shift+M',
  SCHEDULE: 'Mod+Shift+S',
  LAUNCHER: 'Mod+Shift+L',
  /** Jarvis Assistant — natural-language command bar. */
  ASSISTANT: 'Mod+J',
} as const;
