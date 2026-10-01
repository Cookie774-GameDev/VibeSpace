import * as React from 'react';
import { getAppVersion } from '@/lib/tauri';
import { useBoundHotkey } from '@/lib/hotkeys';
import { createNativeFullscreenAdapter, type NativeFullscreenAdapter } from './nativeFullscreen';
import { configureFullscreenAdapter, useFullscreenStore } from './fullscreenStore';

export interface FullscreenHostProps {
  adapter?: NativeFullscreenAdapter;
  getVersion?: () => Promise<string>;
  search?: string;
}

const defaultAdapter = createNativeFullscreenAdapter();

function isRecoveryLaunch(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get('recovery') === '1' || params.get('safe-mode') === '1';
}

export function FullscreenHost({
  adapter = defaultAdapter,
  getVersion = getAppVersion,
  search = typeof window === 'undefined' ? '' : window.location.search,
}: FullscreenHostProps) {
  const activeLayerCount = useFullscreenStore((state) => state.activationOrder.length);
  const error = useFullscreenStore((state) => state.error);

  const toggleFocus = React.useCallback(() => {
    useFullscreenStore.getState().toggleFocus();
  }, []);
  const toggleSystem = React.useCallback(() => {
    void useFullscreenStore.getState().toggleSystem();
  }, []);
  const exitMostRecent = React.useCallback((event: KeyboardEvent) => {
    event.preventDefault();
    void useFullscreenStore.getState().exitMostRecentLayer();
  }, []);

  useBoundHotkey('TOGGLE_FULLSCREEN', toggleFocus, { whenInputs: true });
  useBoundHotkey('TOGGLE_SYSTEM_FULLSCREEN', toggleSystem);
  useBoundHotkey('ESCAPE', exitMostRecent, {
    whenInputs: true,
    disabled: activeLayerCount === 0,
  });

  React.useEffect(() => {
    let disposed = false;
    let unsubscribe: () => void = () => undefined;
    let currentVersion: string | null = null;
    const releaseAdapter = configureFullscreenAdapter(adapter);

    void adapter
      .subscribe((enabled) => {
        if (!disposed) useFullscreenStore.getState().syncNativeState(enabled);
      })
      .then((release) => {
        if (disposed) {
          release();
          return;
        }
        unsubscribe = release;
      })
      .catch(() => {
        // Web preview and unsupported native environments retain Focus Mode.
      });

    void getVersion()
      .then(async (version) => {
        if (disposed) return;
        currentVersion = version;
        const restorable = useFullscreenStore.getState().beginSession({
          appVersion: version,
          recoveryLaunch: isRecoveryLaunch(search),
        });
        if (restorable.includes('focus')) {
          useFullscreenStore.getState().setFocusActive(true);
        }
        if (restorable.includes('system')) {
          await useFullscreenStore.getState().requestSystemActive(true);
          return;
        }
        try {
          const observed = await adapter.read();
          if (!disposed) useFullscreenStore.getState().syncNativeState(observed);
        } catch {
          // The browser preview has no native window truth to synchronize.
        }
      })
      .catch(() => {
        if (disposed) return;
        currentVersion = '0.0.0';
        useFullscreenStore.getState().beginSession({
          appVersion: currentVersion,
          recoveryLaunch: isRecoveryLaunch(search),
        });
      });

    const markCleanShutdown = () => {
      if (currentVersion) {
        useFullscreenStore.getState().markCleanShutdown(currentVersion);
      }
    };
    window.addEventListener('pagehide', markCleanShutdown);
    window.addEventListener('beforeunload', markCleanShutdown);

    return () => {
      disposed = true;
      window.removeEventListener('pagehide', markCleanShutdown);
      window.removeEventListener('beforeunload', markCleanShutdown);
      unsubscribe();
      releaseAdapter();
    };
  }, [adapter, getVersion, search]);

  if (!error) return null;

  return (
    <div className="sr-only" role="status" aria-live="polite">
      {error}
    </div>
  );
}
