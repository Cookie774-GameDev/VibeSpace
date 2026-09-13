import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import {
  __resetHotkeyBindingsForTests,
  setHotkeyBinding,
  loadHotkeyBindingsFromStorage,
} from '@/lib/hotkeys';
import { nativeDictationHotkey, useDictationHotkey } from './dictationHotkey';
beforeEach(() => {
  localStorage.clear();
  __resetHotkeyBindingsForTests();
});
it('defaults to Ctrl+Shift+Space and follows saved edits and cross-window changes', () => {
  const hook = renderHook(useDictationHotkey);
  expect(hook.result.current).toBe('Ctrl+Shift+Space');
  act(() => {
    expect(setHotkeyBinding('GLOBAL_DICTATION', 'Alt+Shift+d').ok).toBe(true);
  });
  expect(nativeDictationHotkey(hook.result.current)).toBe('Alt+Shift+D');
  loadHotkeyBindingsFromStorage();
  expect(hook.result.current).toBe('Alt+Shift+D');
  act(() => {
    localStorage.setItem('jarvis-hotkeys-v1', JSON.stringify({ GLOBAL_DICTATION: 'Ctrl+Space' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'jarvis-hotkeys-v1' }));
  });
  expect(hook.result.current).toBe('Ctrl+Space');
});
