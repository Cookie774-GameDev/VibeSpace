import * as React from 'react';
import { HOTKEYS, useHotkey } from '@/lib/hotkeys';
import { useUIStore } from '@/stores/ui';
import { emitJarvisEvent } from './actions';

/**
 * Bundle every global hotkey defined in {@link HOTKEYS} into a single hook so
 * the application can mount it once at the root.
 *
 * Behavior summary:
 *  - State-affecting hotkeys (palette, panes, voice, settings) call the
 *    relevant {@link useUIStore} setter directly.
 *  - Feature-specific hotkeys (new chat, close tab, send, broadcast) emit a
 *    `jarvis:*` custom event so the owning feature can react without us
 *    importing it.
 *  - {@link HOTKEYS.ESCAPE} is intentionally left for the modal layer to
 *    handle (Radix Dialog `onEscapeKeyDown`). Binding it globally would
 *    fight per-modal Esc handlers.
 *
 * Every binding uses `whenInputs: true`. Every shortcut here is a modifier
 * combo, so it cannot collide with normal text input - and we want them
 * available even when a chat input is focused.
 */
export function useGlobalHotkeys(): void {
  // Palette: Mod+K toggles open/closed. Works even when the palette's own
  // search input has focus, so users can dismiss it the same way they
  // opened it.
  useHotkey(
    HOTKEYS.PALETTE,
    React.useCallback((e: KeyboardEvent) => {
      e.preventDefault();
      useUIStore.getState().togglePalette();
    }, []),
    { whenInputs: true },
  );

  // Toggle the left navigation pane.
  useHotkey(
    HOTKEYS.TOGGLE_NAV,
    React.useCallback((e: KeyboardEvent) => {
      e.preventDefault();
      useUIStore.getState().toggleNav();
    }, []),
    { whenInputs: true },
  );

  // Toggle the right inspector pane.
  useHotkey(
    HOTKEYS.TOGGLE_INSPECTOR,
    React.useCallback((e: KeyboardEvent) => {
      e.preventDefault();
      useUIStore.getState().toggleInspector();
    }, []),
    { whenInputs: true },
  );

  // Toggle the to-do drawer.
  useHotkey(
    HOTKEYS.TOGGLE_TODO,
    React.useCallback((e: KeyboardEvent) => {
      e.preventDefault();
      useUIStore.getState().toggleTodoDrawer();
    }, []),
    { whenInputs: true },
  );

  // Push-to-talk / voice toggle. Browsers may treat Cmd+Space as system
  // input; preventDefault lets us claim it inside the app.
  useHotkey(
    HOTKEYS.PUSH_TO_TALK,
    React.useCallback((e: KeyboardEvent) => {
      e.preventDefault();
      useUIStore.getState().toggleVoice();
    }, []),
    { whenInputs: true },
  );

  // Open settings.
  useHotkey(
    HOTKEYS.SETTINGS,
    React.useCallback((e: KeyboardEvent) => {
      e.preventDefault();
      useUIStore.getState().setSettingsOpen(true);
    }, []),
    { whenInputs: true },
  );

  // New chat / new tab. Both HOTKEYS entries map to Mod+T; we bind once and
  // emit both events so the chat and tab features can react independently.
  useHotkey(
    HOTKEYS.NEW_CHAT,
    React.useCallback((e: KeyboardEvent) => {
      e.preventDefault();
      emitJarvisEvent('jarvis:new-chat');
      emitJarvisEvent('jarvis:new-tab');
    }, []),
    { whenInputs: true },
  );

  // Close the active tab.
  useHotkey(
    HOTKEYS.CLOSE_TAB,
    React.useCallback((e: KeyboardEvent) => {
      e.preventDefault();
      emitJarvisEvent('jarvis:close-tab');
    }, []),
    { whenInputs: true },
  );

  // Send the current chat input. The chat input component is the canonical
  // handler; this global wiring is a fallback for non-input contexts.
  useHotkey(
    HOTKEYS.SEND,
    React.useCallback((e: KeyboardEvent) => {
      // Don't preventDefault - the chat input may handle this natively for
      // newline behavior. Just announce the intent.
      emitJarvisEvent('jarvis:send-message');
    }, []),
    { whenInputs: true },
  );

  // Broadcast the current input to every agent in council mode.
  useHotkey(
    HOTKEYS.BROADCAST,
    React.useCallback((e: KeyboardEvent) => {
      emitJarvisEvent('jarvis:broadcast-message');
    }, []),
    { whenInputs: true },
  );

  // HOTKEYS.ESCAPE is deliberately not bound here.
  // - Radix Dialog handles Esc per-modal via `onEscapeKeyDown`.
  // - The palette uses that hook to pop sub-pages or close.
  // - Adding a window-level Esc listener would race those handlers.
}
