import * as React from 'react';
import { useBoundHotkey } from '@/lib/hotkeys';
import { useUIStore } from '@/stores/ui';
import { emitJarvisEvent } from './actions';

/**
 * Bundle every global hotkey into a single hook so the application can mount
 * it once at the root. Bindings resolve live from the customizable registry.
 *
 * Behavior summary:
 *  - State-affecting hotkeys call the relevant useUIStore setter.
 *  - Feature-specific hotkeys emit jarvis:* events.
 *  - ESCAPE is left for the modal layer (Radix Dialog).
 *
 * Modifier combos use whenInputs: true so they work in the composer.
 */
export function useGlobalHotkeys(): void {
  useBoundHotkey(
    'PALETTE',
    React.useCallback((e: KeyboardEvent) => {
      e.preventDefault();
      useUIStore.getState().togglePalette();
    }, []),
    { whenInputs: true },
  );

  useBoundHotkey(
    'TOGGLE_NAV',
    React.useCallback((e: KeyboardEvent) => {
      e.preventDefault();
      useUIStore.getState().toggleNav();
    }, []),
    { whenInputs: true },
  );

  useBoundHotkey(
    'TOGGLE_INSPECTOR',
    React.useCallback((e: KeyboardEvent) => {
      e.preventDefault();
      useUIStore.getState().toggleInspector();
    }, []),
    { whenInputs: true },
  );
  useBoundHotkey(
    'TOGGLE_INSPECTOR_I',
    React.useCallback((e: KeyboardEvent) => {
      e.preventDefault();
      useUIStore.getState().toggleInspector();
    }, []),
    { whenInputs: true },
  );
  useBoundHotkey(
    'TOGGLE_INSPECTOR_DOT',
    React.useCallback((e: KeyboardEvent) => {
      if (e.shiftKey) return;
      e.preventDefault();
      useUIStore.getState().toggleInspector();
    }, []),
    { whenInputs: true },
  );

  useBoundHotkey(
    'PUSH_TO_TALK',
    React.useCallback((e: KeyboardEvent) => {
      e.preventDefault();
      if (e.repeat) return;
      useUIStore.getState().toggleVoice();
    }, []),
    { whenInputs: true },
  );

  useBoundHotkey(
    'SETTINGS',
    React.useCallback((e: KeyboardEvent) => {
      e.preventDefault();
      useUIStore.getState().setSettingsOpen(true);
    }, []),
    { whenInputs: true },
  );

  // New chat / new tab share a binding (linked in the registry).
  useBoundHotkey(
    'NEW_CHAT',
    React.useCallback((e: KeyboardEvent) => {
      e.preventDefault();
      emitJarvisEvent('jarvis:new-chat');
      emitJarvisEvent('jarvis:new-tab');
    }, []),
    { whenInputs: true },
  );

  useBoundHotkey(
    'CLOSE_TAB',
    React.useCallback((e: KeyboardEvent) => {
      e.preventDefault();
      emitJarvisEvent('jarvis:close-tab');
    }, []),
    { whenInputs: true },
  );

  useBoundHotkey(
    'SEND',
    React.useCallback((_e: KeyboardEvent) => {
      emitJarvisEvent('jarvis:send-message');
    }, []),
    { whenInputs: true },
  );

  useBoundHotkey(
    'BROADCAST',
    React.useCallback((_e: KeyboardEvent) => {
      emitJarvisEvent('jarvis:broadcast-message');
    }, []),
    { whenInputs: true },
  );

  useBoundHotkey(
    'COMPOSER_STT',
    React.useCallback((e: KeyboardEvent) => {
      e.preventDefault();
      emitJarvisEvent('jarvis:stt:toggle');
    }, []),
    { whenInputs: true },
  );
}
