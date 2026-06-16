import * as React from 'react';

function readAppForeground(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState === 'visible';
}

/**
 * True while the Jarvis window is visible to the user.
 * False when hidden to tray or otherwise backgrounded — voice and wake word stay off.
 */
export function useAppForeground(): boolean {
  const [foreground, setForeground] = React.useState(readAppForeground);

  React.useEffect(() => {
    const markVisible = () => setForeground(true);
    const markHidden = () => setForeground(false);
    const onVisibility = () => setForeground(readAppForeground());

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', markVisible);
    window.addEventListener('pagehide', markHidden);

    let unlistenHide: (() => void) | null = null;
    let unlistenReopen: (() => void) | null = null;
    let disposed = false;

    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen('jarvis:before-hide', markHidden))
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlistenHide = unlisten;
      })
      .catch(() => {});

    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen('jarvis:reopen', markVisible))
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlistenReopen = unlisten;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', markVisible);
      window.removeEventListener('pagehide', markHidden);
      unlistenHide?.();
      unlistenReopen?.();
    };
  }, []);

  return foreground;
}
