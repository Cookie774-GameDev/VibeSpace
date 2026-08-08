import { describe, expect, it, vi } from 'vitest';
import {
  createNativeFullscreenAdapter,
  type BrowserFullscreenDocument,
  type NativeFullscreenWindow,
} from './nativeFullscreen';

function createWindow(initial = false) {
  let fullscreen = initial;
  let resized: (() => void) | null = null;
  let focused: (() => void) | null = null;
  const stopResize = vi.fn();
  const stopFocus = vi.fn();
  const show = vi.fn(async () => undefined);
  const unminimize = vi.fn(async () => undefined);
  const setFocus = vi.fn(async () => undefined);

  const windowApi = {
    async setFullscreen(enabled) {
      fullscreen = enabled;
    },
    async isFullscreen() {
      return fullscreen;
    },
    async onResized(listener) {
      resized = listener;
      return stopResize;
    },
    async onFocusChanged(listener) {
      focused = listener;
      return stopFocus;
    },
    show,
    unminimize,
    setFocus,
  } as NativeFullscreenWindow & {
    show: typeof show;
    unminimize: typeof unminimize;
    setFocus: typeof setFocus;
  };

  return {
    windowApi,
    setObserved: (enabled: boolean) => {
      fullscreen = enabled;
    },
    emitResize: () => resized?.(),
    emitFocus: () => focused?.(),
    stopResize,
    stopFocus,
    show,
    unminimize,
    setFocus,
  };
}

function createBrowserDocument() {
  let fullscreen = false;
  const listeners = new Set<() => void>();
  const browserDocument: BrowserFullscreenDocument = {
    get fullscreenElement() {
      return fullscreen ? ({} as Element) : null;
    },
    fullscreenEnabled: true,
    documentElement: {
      requestFullscreen: vi.fn(async () => {
        fullscreen = true;
        listeners.forEach((listener) => listener());
      }),
    },
    exitFullscreen: vi.fn(async () => {
      fullscreen = false;
      listeners.forEach((listener) => listener());
    }),
    addEventListener: (_event, listener) => listeners.add(listener),
    removeEventListener: (_event, listener) => listeners.delete(listener),
  };
  return {
    browserDocument,
    exitExternally() {
      fullscreen = false;
      listeners.forEach((listener) => listener());
    },
  };
}

describe('native fullscreen adapter', () => {
  it('sets native fullscreen and returns verified native truth', async () => {
    const fake = createWindow();
    const adapter = createNativeFullscreenAdapter({
      isTauriRuntime: () => true,
      loadWindow: async () => fake.windowApi,
    });

    expect(adapter.availability()).toBe('available');
    await expect(adapter.write(true)).resolves.toBe(true);
    await expect(adapter.read()).resolves.toBe(true);
  });

  it('restores the native window presentation after applying fullscreen', async () => {
    const fake = createWindow();
    const adapter = createNativeFullscreenAdapter({
      isTauriRuntime: () => true,
      loadWindow: async () => fake.windowApi,
    });

    await expect(adapter.write(true)).resolves.toBe(true);

    expect(fake.show).toHaveBeenCalledOnce();
    expect(fake.unminimize).toHaveBeenCalledOnce();
    expect(fake.setFocus).toHaveBeenCalledOnce();
  });

  it('rejects a native transition whose observed truth does not match the request', async () => {
    const fake = createWindow();
    const windowApi: NativeFullscreenWindow = {
      ...fake.windowApi,
      async setFullscreen() {
        fake.setObserved(false);
      },
    };
    const adapter = createNativeFullscreenAdapter({
      isTauriRuntime: () => true,
      loadWindow: async () => windowApi,
    });

    await expect(adapter.write(true)).rejects.toThrow(
      'Native fullscreen did not reach the requested state.',
    );
  });

  it('fails safely in web preview without invoking a native loader', async () => {
    const loadWindow = vi.fn(async () => createWindow().windowApi);
    const adapter = createNativeFullscreenAdapter({
      isTauriRuntime: () => false,
      loadWindow,
      browserDocument: {
        fullscreenElement: null,
        fullscreenEnabled: false,
        documentElement: {},
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });

    expect(adapter.availability()).toBe('web-preview');
    await expect(adapter.write(true)).rejects.toThrow(
      'System fullscreen requires the installed VibeSpace desktop app.',
    );
    expect(loadWindow).not.toHaveBeenCalled();
  });

  it('enters, exits, and synchronizes browser fullscreen when native Tauri is absent', async () => {
    const browser = createBrowserDocument();
    const adapter = createNativeFullscreenAdapter({
      isTauriRuntime: () => false,
      browserDocument: browser.browserDocument,
    });
    const observed: boolean[] = [];
    const unsubscribe = await adapter.subscribe((enabled) => observed.push(enabled));

    expect(adapter.availability()).toBe('available');
    await expect(adapter.write(true)).resolves.toBe(true);
    expect(observed).toEqual([true]);

    browser.exitExternally();
    expect(observed).toEqual([true, false]);

    await expect(adapter.write(false)).resolves.toBe(false);
    unsubscribe();
  });

  it('coalesces native resize and focus signals and releases both listeners', async () => {
    const fake = createWindow();
    const observed: boolean[] = [];
    const adapter = createNativeFullscreenAdapter({
      isTauriRuntime: () => true,
      loadWindow: async () => fake.windowApi,
    });
    const unsubscribe = await adapter.subscribe((enabled) => observed.push(enabled));

    fake.setObserved(true);
    fake.emitResize();
    fake.emitFocus();
    await Promise.resolve();
    await Promise.resolve();

    expect(observed).toEqual([true]);
    unsubscribe();
    expect(fake.stopResize).toHaveBeenCalledOnce();
    expect(fake.stopFocus).toHaveBeenCalledOnce();
  });
});
