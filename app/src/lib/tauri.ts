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
async function tauriInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/* -------------------------------------------------------------------------- */
/*  Notifications                                                             */
/* -------------------------------------------------------------------------- */

export interface NotifyOptions {
  /** Suppress sound on supported platforms. */
  silent?: boolean;
  /** Show an in-app toast when native/browser delivery is unavailable. */
  fallbackToast?: boolean;
}

export type NotificationPermissionState = NotificationPermission | 'unavailable';

function normalizeNotificationPermission(value: unknown): NotificationPermission {
  if (value === 'granted' || value === 'denied') return value;
  return 'default';
}

export async function getNotificationPermission(): Promise<NotificationPermissionState> {
  if (isTauri) {
    try {
      const granted = await tauriInvoke<boolean | null>(
        'plugin:notification|is_permission_granted',
      );
      return granted === true ? 'granted' : 'default';
    } catch {
      return 'unavailable';
    }
  }

  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unavailable';
  }
  return window.Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  const current = await getNotificationPermission();
  if (current === 'granted' || current === 'denied' || current === 'unavailable') {
    return current;
  }

  if (isTauri) {
    try {
      const result = await tauriInvoke<string>('plugin:notification|request_permission');
      return normalizeNotificationPermission(result);
    } catch {
      return 'unavailable';
    }
  }

  try {
    return await window.Notification.requestPermission();
  } catch {
    return 'denied';
  }
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
      if ((await requestNotificationPermission()) === 'granted') {
        await tauriInvoke('plugin:notification|notify', {
          options: { title, body, silent: options.silent ?? false },
        });
        return;
      }
    } catch (err) {
      console.warn('[tauri] notification failed, falling back', err);
    }
  } else if (typeof window !== 'undefined' && 'Notification' in window) {
    try {
      const permission = await requestNotificationPermission();
      if (permission === 'granted') {
        new window.Notification(title, { body, silent: options.silent });
        return;
      }
    } catch (err) {
      console.warn('[browser] Notification failed, falling back to toast', err);
    }
  }

  if (options.fallbackToast !== false) {
    try {
      toast.info(title, body);
    } catch {
      /* nothing more we can do */
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Tray badge                                                                */
/* -------------------------------------------------------------------------- */

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

export async function registerGlobalHotkey(
  combo: string,
  handler: GlobalHotkeyHandler,
): Promise<UnregisterHotkey> {
  return registerWindowHotkey(combo, handler);
}

function registerWindowHotkey(combo: string, handler: GlobalHotkeyHandler): UnregisterHotkey {
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

export interface NativeOllamaStatus {
  installed: boolean | null;
  version?: string | null;
  executable?: string | null;
  detail?: string | null;
}

export interface NativeOllamaRunningStatus {
  running: boolean;
  pids: number[];
  listeningPort11434: boolean;
  detail?: string | null;
}

export interface NativeOllamaEnsureResult {
  ready: boolean;
  apiReachable: boolean;
  installed: boolean;
  version?: string | null;
  phase: string;
  detail?: string | null;
}

export async function getNativeOllamaStatus(): Promise<NativeOllamaStatus> {
  if (!isTauri) {
    return {
      installed: null,
      detail: 'Native Ollama detection is available in the desktop app.',
    };
  }

  try {
    return await tauriInvoke<NativeOllamaStatus>('ollama_installation_status');
  } catch (err) {
    return {
      installed: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function isOllamaProcessRunning(): Promise<NativeOllamaRunningStatus> {
  if (!isTauri) {
    return { running: false, pids: [], listeningPort11434: false, detail: 'Not in Tauri runtime' };
  }
  try {
    return await tauriInvoke<NativeOllamaRunningStatus>('is_ollama_running');
  } catch {
    return { running: false, pids: [], listeningPort11434: false, detail: 'Command failed' };
  }
}

export async function startNativeOllama(): Promise<void> {
  if (!isTauri) {
    throw new Error('Starting Ollama automatically is only available in the desktop app.');
  }
  await tauriInvoke('ollama_start');
}

export async function ensureNativeOllamaReady(
  baseUrl?: string,
): Promise<NativeOllamaEnsureResult> {
  if (!isTauri) {
    return {
      ready: false,
      apiReachable: false,
      installed: false,
      phase: 'error',
      detail: 'Native Ollama startup is only available in the desktop app.',
    };
  }

  try {
    return await tauriInvoke<NativeOllamaEnsureResult>('ensure_ollama_ready', {
      baseUrl: baseUrl ?? null,
    });
  } catch (err) {
    return {
      ready: false,
      apiReachable: false,
      installed: false,
      phase: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function openOllamaTroubleshooting(): Promise<void> {
  if (!isTauri) {
    throw new Error('Ollama troubleshooting is only available in the desktop app.');
  }
  await tauriInvoke('open_ollama_troubleshooting');
}

export async function openSystemSpeechSettings(): Promise<void> {
  if (!isTauri) {
    throw new Error('Open your operating system speech settings to install a local voice.');
  }
  await tauriInvoke('open_system_speech_settings');
}

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
