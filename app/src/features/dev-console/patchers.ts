/**
 * Patchers — install lightweight wrappers around `console`, `fetch`,
 * Tauri `invoke`, `window.dispatchEvent`, and the global error / promise
 * rejection events so every cross-boundary signal flows through the
 * DevConsole feed.
 *
 * Design rules:
 *
 *   1. Originals always run first. We never swallow a console.error
 *      or change the return value of fetch — patching is purely
 *      additive observation. If the patch itself throws, the original
 *      behaviour still occurs (try/catch around our work).
 *
 *   2. Idempotent install. `installPatchers()` is safe to call from
 *      a useEffect; subsequent calls return the same teardown
 *      function and don't double-wrap.
 *
 *   3. Loop-safe. The patched console MUST NOT log into devConsole
 *      when devConsole's internals (zustand, react) themselves call
 *      console. Otherwise a single console.warn from React causes
 *      infinite re-entry. We guard with a per-call flag.
 *
 *   4. Cheap on the hot path. Each patched call adds one timestamp,
 *      one Date.now subtraction, and one zustand push. No
 *      JSON.stringify on the request body — bodies are stored
 *      lazily and serialised only when the UI renders the row's
 *      details panel.
 */

import { devConsole, type DevLogChannel, type DevLogLevel } from './store';

let installed = false;
let teardown: (() => void) | null = null;

/**
 * Re-entry guard. Set to true while we're pushing into the store so
 * that a console.* call from inside zustand (or any subscriber) is
 * delivered to the original console without re-entering devConsole.
 */
let isLogging = false;

/**
 * Console levels mapped to DevConsole levels. We keep `console.log`
 * separate from `console.info` even though both surface as 'info'
 * here — the original method is preserved on the entry's detail so
 * the UI can show the actual one used.
 */
const CONSOLE_METHODS: Array<{ method: keyof Console; level: DevLogLevel }> = [
  { method: 'log', level: 'info' },
  { method: 'info', level: 'info' },
  { method: 'warn', level: 'warn' },
  { method: 'error', level: 'error' },
  { method: 'debug', level: 'debug' },
];

/**
 * Best-effort one-line summary of arbitrary console arguments. We
 * mirror what devtools shows: strings as-is, errors as `name:
 * message`, objects as their constructor name + first key. Full
 * detail still goes into `entry.detail` so the UI can pretty-print.
 */
function summariseArgs(args: unknown[]): string {
  if (args.length === 0) return '';
  const first = args[0];
  if (typeof first === 'string') {
    return args.length === 1 ? first : `${first} (+${args.length - 1})`;
  }
  if (first instanceof Error) {
    return `${first.name}: ${first.message}`;
  }
  if (typeof first === 'object' && first !== null) {
    const ctor = (first as { constructor?: { name?: string } }).constructor?.name ?? 'Object';
    return `[${ctor}]`;
  }
  return String(first);
}

/* -------------------------------------------------------------------------- */
/*  Console patcher                                                           */
/* -------------------------------------------------------------------------- */

interface OriginalConsole {
  log: typeof console.log;
  info: typeof console.info;
  warn: typeof console.warn;
  error: typeof console.error;
  debug: typeof console.debug;
}

function patchConsole(): () => void {
  const original: OriginalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };

  for (const { method, level } of CONSOLE_METHODS) {
    const orig = original[method as keyof OriginalConsole];
    (console as unknown as Record<string, (...args: unknown[]) => void>)[
      method as string
    ] = (...args: unknown[]) => {
      // Always call the original first so devtools sees the real
      // entry regardless of what our patch does.
      try {
        orig(...args);
      } catch {
        /* ignore */
      }
      if (isLogging) return;
      try {
        isLogging = true;
        devConsole.log({
          channel: 'console',
          level,
          message: summariseArgs(args),
          detail: { method, args },
        });
      } catch {
        /* never let the patch throw */
      } finally {
        isLogging = false;
      }
    };
  }

  return () => {
    for (const { method } of CONSOLE_METHODS) {
      (console as unknown as Record<string, (...args: unknown[]) => void>)[
        method as string
      ] = original[method as keyof OriginalConsole];
    }
  };
}

/* -------------------------------------------------------------------------- */
/*  Fetch patcher                                                             */
/* -------------------------------------------------------------------------- */

function patchFetch(): () => void {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') {
    return () => {};
  }
  const original = window.fetch.bind(window);

  window.fetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const start = Date.now();
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    try {
      const res = await original(input, init);
      const dur = Date.now() - start;
      devConsole.log({
        channel: 'fetch',
        level: res.ok ? 'info' : res.status >= 500 ? 'error' : 'warn',
        message: `${method} ${shortUrl(url)} → ${res.status}`,
        durationMs: dur,
        detail: {
          url,
          method,
          status: res.status,
          statusText: res.statusText,
          // Don't read the response body — that would consume the
          // stream. Headers are cheap to enumerate.
          responseHeaders: headersToObj(res.headers),
        },
      });
      return res;
    } catch (err) {
      const dur = Date.now() - start;
      devConsole.log({
        channel: 'fetch',
        level: 'error',
        message: `${method} ${shortUrl(url)} → ${
          err instanceof Error ? err.message : 'failed'
        }`,
        durationMs: dur,
        detail: {
          url,
          method,
          error:
            err instanceof Error
              ? { name: err.name, message: err.message, stack: err.stack }
              : err,
        },
      });
      throw err;
    }
  } as typeof window.fetch;

  return () => {
    window.fetch = original;
  };
}

function shortUrl(url: string): string {
  // Trim long bearer-token query strings + collapse the host so the
  // log row stays readable in 80 cols.
  try {
    const u = new URL(url, typeof window !== 'undefined' ? window.location.href : 'http://x');
    return `${u.host}${u.pathname}`;
  } catch {
    return url.length > 80 ? `${url.slice(0, 80)}…` : url;
  }
}

function headersToObj(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Tauri invoke patcher                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Tauri's `invoke` lives in `@tauri-apps/api/core`. We can't import
 * the module synchronously here without forcing it into the boot
 * chunk, so we patch lazily: the first time anyone in the app
 * imports `@tauri-apps/api/core`, the imported module is cached by
 * Vite. We monkey-patch the cached `invoke` export.
 *
 * In the web/dev build the module never loads (every call site
 * guards with `isTauri`), so this patcher silently does nothing.
 *
 * We type our wrapper through `any` rather than re-exporting Tauri's
 * `InvokeArgs` / `InvokeOptions` because those types live in the
 * lazy chunk and importing them would defeat the lazy-load. The
 * runtime cost of an `any` here is zero — the wrapper just
 * forwards arguments verbatim.
 */
function patchInvoke(): () => void {
  let restore: (() => void) | null = null;

  // Fire-and-forget: try to load the module; if Tauri isn't present
  // (web build), the import simply fails and we return a no-op.
  void (async () => {
    try {
      const mod = await import('@tauri-apps/api/core');
      const original = mod.invoke;
      if (typeof original !== 'function') return;
      const wrapped = wrappedInvoke(
        original as unknown as InvokeFn,
      ) as unknown as typeof mod.invoke;

      // Vite preserves module exports as live bindings, but
      // assigning to them in a re-exported module is brittle.
      // The pragmatic path: wrap the original on `mod` if writable;
      // most call sites do `import { invoke } …` which copies the
      // binding, so we ALSO add a global `__JARVIS_INVOKE__`
      // wrapper that lib/tauri.ts can use to ensure logging.
      try {
        Object.defineProperty(mod, 'invoke', {
          configurable: true,
          writable: true,
          value: wrapped,
        });
        restore = () => {
          try {
            Object.defineProperty(mod, 'invoke', {
              configurable: true,
              writable: true,
              value: original,
            });
          } catch {
            /* ignore */
          }
        };
      } catch {
        // Read-only export (Vite prod can be strict) — fall back to
        // exposing a wrapped invoke on globalThis so opt-in callers
        // can use it.
        (globalThis as unknown as { __JARVIS_INVOKE__?: typeof original }).__JARVIS_INVOKE__ =
          wrapped;
      }
    } catch {
      /* not in a Tauri context — fine */
    }
  })();

  return () => {
    restore?.();
  };
}

/**
 * Loose signature used internally for the invoke wrapper. We
 * deliberately don't re-export Tauri's `InvokeArgs` here because
 * doing so would pull `@tauri-apps/api/core` into the boot chunk
 * and defeat the lazy import.
 */
type InvokeFn = (
  cmd: string,
  args?: unknown,
  options?: unknown,
) => Promise<unknown>;

function wrappedInvoke(original: InvokeFn): InvokeFn {
  return async (cmd, args, options) => {
    const start = Date.now();
    try {
      const result = await original(cmd, args, options);
      devConsole.log({
        channel: 'invoke',
        level: 'info',
        message: `invoke ${cmd}`,
        durationMs: Date.now() - start,
        detail: { cmd, args, ok: true },
      });
      return result;
    } catch (err) {
      devConsole.log({
        channel: 'invoke',
        level: 'error',
        message: `invoke ${cmd} → ${
          err instanceof Error ? err.message : 'failed'
        }`,
        durationMs: Date.now() - start,
        detail: {
          cmd,
          args,
          error:
            err instanceof Error
              ? { name: err.name, message: err.message, stack: err.stack }
              : err,
        },
      });
      throw err;
    }
  };
}

/* -------------------------------------------------------------------------- */
/*  Custom event patcher                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Wrap `window.dispatchEvent` so every `jarvis:*` CustomEvent shows
 * up in the feed. Non-jarvis events (DOM clicks, keydowns, etc.) are
 * skipped to avoid drowning the feed.
 */
function patchDispatchEvent(): () => void {
  if (typeof window === 'undefined') return () => {};
  const original = window.dispatchEvent.bind(window);
  window.dispatchEvent = (event: Event) => {
    try {
      if (event.type.startsWith('jarvis:')) {
        const detail =
          event instanceof CustomEvent ? (event as CustomEvent).detail : undefined;
        devConsole.log({
          channel: 'event',
          level: 'info',
          message: `dispatch ${event.type}`,
          detail: { type: event.type, detail },
        });
      }
    } catch {
      /* never throw from a dispatch wrapper */
    }
    return original(event);
  };
  return () => {
    window.dispatchEvent = original;
  };
}

/* -------------------------------------------------------------------------- */
/*  Window error / unhandledrejection                                         */
/* -------------------------------------------------------------------------- */

function patchWindowErrors(): () => void {
  if (typeof window === 'undefined') return () => {};

  const onError = (e: ErrorEvent) => {
    devConsole.log({
      channel: 'window',
      level: 'error',
      message: e.message || 'window error',
      detail: {
        message: e.message,
        filename: e.filename,
        lineno: e.lineno,
        colno: e.colno,
        error:
          e.error instanceof Error
            ? { name: e.error.name, message: e.error.message, stack: e.error.stack }
            : e.error,
      },
    });
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    const reason = e.reason;
    devConsole.log({
      channel: 'window',
      level: 'error',
      message: reason instanceof Error ? `unhandledrejection: ${reason.message}` : 'unhandledrejection',
      detail: {
        reason:
          reason instanceof Error
            ? { name: reason.name, message: reason.message, stack: reason.stack }
            : reason,
      },
    });
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Install all patchers. Safe to call multiple times; subsequent calls
 * return the existing teardown. Returns a function that uninstalls
 * every patch — call from a `useEffect` cleanup.
 */
export function installPatchers(): () => void {
  if (installed && teardown) return teardown;
  installed = true;

  const restoreConsole = patchConsole();
  const restoreFetch = patchFetch();
  const restoreInvoke = patchInvoke();
  const restoreDispatch = patchDispatchEvent();
  const restoreWindowErrors = patchWindowErrors();

  // Boot breadcrumb so the user can confirm the patcher actually fired.
  devConsole.log({
    channel: 'app',
    level: 'info',
    message: 'DevConsole patchers installed',
    detail: {
      hasFetch: typeof window !== 'undefined' && typeof window.fetch === 'function',
      isTauri:
        typeof window !== 'undefined' &&
        '__TAURI_INTERNALS__' in (window as unknown as Record<string, unknown>),
    },
  });

  teardown = () => {
    restoreConsole();
    restoreFetch();
    restoreInvoke();
    restoreDispatch();
    restoreWindowErrors();
    installed = false;
    teardown = null;
  };
  return teardown;
}

export type { DevLogChannel, DevLogLevel };
