import type { FullscreenAvailability } from './contracts';

export interface NativeFullscreenWindow {
  setFullscreen(enabled: boolean): Promise<void>;
  isFullscreen(): Promise<boolean>;
  show(): Promise<void>;
  unminimize(): Promise<void>;
  setFocus(): Promise<void>;
  onResized(listener: () => void): Promise<() => void>;
  onFocusChanged(listener: () => void): Promise<() => void>;
}

export interface NativeFullscreenAdapter {
  availability(): FullscreenAvailability;
  read(): Promise<boolean>;
  write(enabled: boolean): Promise<boolean>;
  subscribe(listener: (enabled: boolean) => void): Promise<() => void>;
}

export interface BrowserFullscreenDocument {
  readonly fullscreenEnabled?: boolean;
  readonly fullscreenElement: Element | null;
  readonly documentElement: {
    requestFullscreen?: () => Promise<void>;
  };
  readonly exitFullscreen?: () => Promise<void>;
  addEventListener(type: 'fullscreenchange', listener: () => void): void;
  removeEventListener(type: 'fullscreenchange', listener: () => void): void;
}

const isInstalledTauriRuntime = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function loadCurrentWindow(): Promise<NativeFullscreenWindow> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const current = getCurrentWindow();
  return {
    setFullscreen: (enabled) => current.setFullscreen(enabled),
    isFullscreen: () => current.isFullscreen(),
    show: () => current.show(),
    unminimize: () => current.unminimize(),
    setFocus: () => current.setFocus(),
    onResized: async (listener) => current.onResized(() => listener()),
    onFocusChanged: async (listener) => current.onFocusChanged(() => listener()),
  };
}

export function createNativeFullscreenAdapter(options?: {
  isTauriRuntime?: () => boolean;
  loadWindow?: () => Promise<NativeFullscreenWindow>;
  browserDocument?: BrowserFullscreenDocument;
}): NativeFullscreenAdapter {
  const isTauriRuntime = options?.isTauriRuntime ?? isInstalledTauriRuntime;
  const loadWindow = options?.loadWindow ?? loadCurrentWindow;
  const browserDocument =
    options?.browserDocument ??
    (typeof document === 'undefined'
      ? undefined
      : (document as unknown as BrowserFullscreenDocument));
  const browserSupported = () =>
    browserDocument?.fullscreenEnabled !== false &&
    typeof browserDocument?.documentElement.requestFullscreen === 'function' &&
    typeof browserDocument.exitFullscreen === 'function';

  const requireWindow = async (): Promise<NativeFullscreenWindow> => {
    if (!isTauriRuntime()) {
      throw new Error('System fullscreen requires the installed VibeSpace desktop app.');
    }
    return loadWindow();
  };

  return {
    availability: () => (isTauriRuntime() || browserSupported() ? 'available' : 'web-preview'),

    async read() {
      if (isTauriRuntime()) return (await requireWindow()).isFullscreen();
      if (!browserSupported()) {
        throw new Error('System fullscreen requires the installed VibeSpace desktop app.');
      }
      return browserDocument!.fullscreenElement !== null;
    },

    async write(enabled) {
      if (isTauriRuntime()) {
        const current = await requireWindow();
        await current.setFullscreen(enabled);
        await current.show();
        await current.unminimize();
        await current.setFocus();
        const observed = await current.isFullscreen();
        if (observed !== enabled) {
          throw new Error('Native fullscreen did not reach the requested state.');
        }
        return observed;
      }
      if (!browserSupported()) {
        throw new Error('System fullscreen requires the installed VibeSpace desktop app.');
      }
      const currentlyEnabled = browserDocument!.fullscreenElement !== null;
      if (enabled && !currentlyEnabled) {
        await browserDocument!.documentElement.requestFullscreen!();
      } else if (!enabled && currentlyEnabled) {
        await browserDocument!.exitFullscreen!();
      }
      const observed = browserDocument!.fullscreenElement !== null;
      if (observed !== enabled) {
        throw new Error('Fullscreen did not reach the requested state.');
      }
      return observed;
    },

    async subscribe(listener) {
      if (!isTauriRuntime()) {
        if (!browserSupported()) {
          throw new Error('System fullscreen requires the installed VibeSpace desktop app.');
        }
        const publishObservedState = () => listener(browserDocument!.fullscreenElement !== null);
        browserDocument!.addEventListener('fullscreenchange', publishObservedState);
        return () => browserDocument!.removeEventListener('fullscreenchange', publishObservedState);
      }
      const current = await requireWindow();
      let queued = false;
      let disposed = false;

      const publishObservedState = () => {
        if (queued || disposed) return;
        queued = true;
        queueMicrotask(() => {
          queued = false;
          if (disposed) return;
          void current
            .isFullscreen()
            .then((enabled) => {
              if (!disposed) listener(enabled);
            })
            .catch(() => {
              // A transient native query must not break the application shell.
            });
        });
      };

      const stopResize = await current.onResized(publishObservedState);
      let stopFocus: (() => void) | null = null;
      try {
        stopFocus = await current.onFocusChanged(publishObservedState);
      } catch (error) {
        stopResize();
        throw error;
      }

      return () => {
        if (disposed) return;
        disposed = true;
        stopResize();
        stopFocus?.();
      };
    },
  };
}
