/**
 * @file Tauri <-> web bridge.
 *
 * Wraps the small surface area we need from Tauri so that:
 *  - The same call sites work in the web/dev build with sensible fallbacks.
 *  - The browser bundle never pulls in Tauri code at build time -
 *    every Tauri import is `await import(...)`-ed inside `if (isTauri)` branches.
 *  - Plugin commands are issued via raw `invoke()` rather than the per-plugin
 *    JS packages, so the bridge works even when only `@tauri-apps/api` is
 *    installed in the frontend.
 *
 * If you need a new Tauri capability, extend this module so the fallback,
 * typing, and detection stay consistent across the app.
 */

import { isTauri as isTauriRuntime } from './utils';
// Static import so Vite can bundle `toast` into the same chunk as the
// rest of the UI primitives. Earlier this file `await import`-ed it from
// inside `notify()` to avoid eagerly loading the toast module, but every
// other call site already imports `toast` statically — the dynamic import
// just defeated chunk consolidation and produced a build warning.
import { toast } from '@/components/ui/toast';

/** Runtime detection. Re-exported here so feature modules can import a single thing. */
export const isTauri: boolean = isTauriRuntime;

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Lazy `invoke()`. Imported dynamically so production browser bundles never
 * pull in `@tauri-apps/api/core`. Always called inside an `if (isTauri)` guard
 * to avoid loading the module on web, but the inner try/catch is defensive.
 */
async function tauriInvoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/* -------------------------------------------------------------------------- */
/*  Notifications                                                             */
/* -------------------------------------------------------------------------- */

export interface NotifyOptions {
  /** Suppress sound on supported platforms. */
  silent?: boolean;
}

/**
 * Send a user-facing notification. Routing:
 *   1. Native OS notification via `tauri-plugin-notification` (desktop).
 *   2. Browser `Notification` API (web).
 *   3. Last-resort in-app toast (always available).
 */
export async function notify(
  title: string,
  body?: string,
  options: NotifyOptions = {},
): Promise<void> {
  if (isTauri) {
    try {
      let granted = await tauriInvoke<boolean>('plugin:notification|is_permission_granted');
      if (!granted) {
        const result = await tauriInvoke<string>('plugin:notification|request_permission');
        granted = result === 'granted';
      }
      if (granted) {
        await tauriInvoke('plugin:notification|notify', {
          options: { title, body, silent: options.silent ?? false },
        });
        return;
      }
      // Permission denied -> fall through to the in-app toast below.
    } catch (err) {
      console.warn('[tauri] notification failed, falling back', err);
    }
  } else if (typeof window !== 'undefined' && 'Notification' in window) {
    try {
      let permission = window.Notification.permission;
      if (permission === 'default') {
        permission = await window.Notification.requestPermission();
      }
      if (permission === 'granted') {
        new window.Notification(title, { body, silent: options.silent });
        return;
      }
    } catch (err) {
      console.warn('[browser] Notification failed, falling back to toast', err);
    }
  }

  // Last resort: in-app toast. Imported statically at the top of the
  // file so Vite keeps it on the same chunk as every other UI consumer.
  try {
    toast.info(title, body);
  } catch {
    /* nothing more we can do */
  }
}

/* -------------------------------------------------------------------------- */
/*  Tray badge                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Set the unread badge count on the system tray icon.
 *
 * Currently a no-op placeholder. Tray icon support is wired in a later
 * milestone (`tauri::tray::TrayIconBuilder` from the Rust side); when that
 * lands this will issue a custom invoke command. The signature is stable so
 * call sites can adopt it now.
 */
export async function setTrayBadge(count: number): Promise<void> {
  if (!isTauri) return;
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.debug('[tauri] setTrayBadge', count, '(placeholder - tray not yet wired)');
  }
}

/* -------------------------------------------------------------------------- */
/*  Global hotkey                                                             */
/* -------------------------------------------------------------------------- */

export type GlobalHotkeyHandler = () => void;
export type UnregisterHotkey = () => Promise<void> | void;

/**
 * Register a global hotkey.
 *
 * In Tauri this is meant to be OS-wide via `tauri-plugin-global-shortcut`.
 * That plugin is not yet registered in lib.rs (deferred to the voice/orb
 * milestone), so for V1 we always fall back to a window-level listener.
 * The signature is stable so we can swap implementations without churn.
 *
 * Combo grammar matches `lib/hotkeys.ts`: `Mod` is Cmd on macOS / Ctrl
 * elsewhere, plus optional `Shift`, `Alt`/`Option`, and a final key.
 *
 * @returns an unregister function.
 */
export async function registerGlobalHotkey(
  combo: string,
  handler: GlobalHotkeyHandler,
): Promise<UnregisterHotkey> {
  // TODO(global-shortcut): once `tauri-plugin-global-shortcut` is registered
  // in lib.rs and the JS package is added, route through:
  //   await tauriInvoke('plugin:globalShortcut|register', { shortcuts: [combo] })
  //   plus a `globalShortcut://triggered` event listener.
  return registerWindowHotkey(combo, handler);
}

/** Window-level fallback. Same parsing rules as `lib/hotkeys.ts`. */
function registerWindowHotkey(
  combo: string,
  handler: GlobalHotkeyHandler,
): UnregisterHotkey {
  if (typeof window === 'undefined') return () => {};

  const parts = combo.split('+').map((p) => p.trim().toLowerCase());
  const wantMod = parts.includes('mod') || parts.includes('cmd') || parts.includes('ctrl');
  const wantShift = parts.includes('shift');
  const wantAlt = parts.includes('alt') || parts.includes('option');
  const key = parts[parts.length - 1];
  const isMacOs = /Mac|iPhone|iPod|iPad/i.test(
    (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || '',
  );

  const onKey = (e: KeyboardEvent) => {
    const modPressed = isMacOs ? e.metaKey : e.ctrlKey;
    if (wantMod !== modPressed) return;
    if (wantShift !== e.shiftKey) return;
    if (wantAlt !== e.altKey) return;

    const eKey = e.key.toLowerCase();
    let match = false;
    if (key === 'space') match = eKey === ' ' || eKey === 'spacebar';
    else if (key === 'enter') match = eKey === 'enter';
    else if (key === 'esc' || key === 'escape') match = eKey === 'escape';
    else if (key === '\\' || key === 'backslash') match = eKey === '\\';
    else match = eKey === key;

    if (match) handler();
  };

  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}

/* -------------------------------------------------------------------------- */
/*  Misc                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * App version. Pulled from the Tauri context in desktop, from
 * `import.meta.env.VITE_APP_VERSION` in web (set by Vite at build time).
 */
export async function getAppVersion(): Promise<string> {
  if (isTauri) {
    try {
      const { getVersion } = await import('@tauri-apps/api/app');
      return await getVersion();
    } catch (err) {
      console.warn('[tauri] getVersion failed', err);
    }
  }
  return import.meta.env.VITE_APP_VERSION ?? '0.0.0';
}

/**
 * Open a URL in the user's OS browser. In Tauri this goes through the shell
 * plugin's scoped `open` (allowed schemes: http, https, mailto, tel). In the
 * browser this is a vanilla `window.open` with `noopener,noreferrer`.
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri) {
    try {
      await tauriInvoke('plugin:shell|open', { path: url });
      return;
    } catch (err) {
      console.warn('[tauri] shell.open failed, using window.open', err);
    }
  }
  if (typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/**
 * Returns the persistent data directory for Jarvis, e.g.
 *   - Windows: `%APPDATA%\ai.jarvis.app`
 *   - macOS:   `~/Library/Application Support/ai.jarvis.app`
 *   - Linux:   `~/.local/share/ai.jarvis.app`
 *
 * In the browser there is no native FS, so we return a synthetic identifier
 * (`browser:idb`) that downstream storage code can detect and route to
 * IndexedDB instead.
 */
export async function getDataDir(): Promise<string> {
  if (isTauri) {
    try {
      const { appDataDir } = await import('@tauri-apps/api/path');
      return await appDataDir();
    } catch (err) {
      console.warn('[tauri] appDataDir failed', err);
    }
  }
  return 'browser:idb';
}
