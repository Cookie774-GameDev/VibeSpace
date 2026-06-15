/**
 * Vitest global setup.
 *
 * Three jobs:
 *   1. Stub `@tauri-apps/api/core` and `@tauri-apps/api/event` so any
 *      module that calls `invoke()` or `listen()` at import time (the
 *      Terminal view, the Ollama bridge, the keychain shim) doesn't
 *      crash inside jsdom.
 *   2. Polyfill `crypto.randomUUID` for `nanoid` and ID generators on
 *      older jsdom versions.
 *   3. Reset persisted Zustand stores between test files so a stale
 *      `localStorage` value from one suite doesn't leak into another.
 */
import { vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    label: 'main',
    listen: vi.fn(async () => () => {}),
  }),
}));

// jsdom in newer node versions has crypto.randomUUID, but we keep this
// guard for forward compat with environments that don't.
if (typeof globalThis.crypto === 'undefined') {
  // @ts-expect-error -- jsdom always has it in our setup, this is just defence
  globalThis.crypto = {};
}
if (typeof globalThis.crypto.randomUUID !== 'function') {
  // Minimal RFC 4122 v4 fallback. Good enough for tests; we don't
  // depend on cryptographic randomness here.
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    value: () =>
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      }),
    configurable: true,
  });
}

// Persisted Zustand state is cleared in suites that need isolation (see each
// test file's beforeEach). Vitest 4 rejects lifecycle hooks in setupFiles.
