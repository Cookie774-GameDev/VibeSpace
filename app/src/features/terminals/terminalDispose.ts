import type { Terminal } from 'xterm';
import type { WebglAddon } from 'xterm-addon-webgl';

type LoadedAddon = { instance: unknown };
type XtermAddonManager = {
  _addons?: LoadedAddon[];
};

function getAddonManager(term: Terminal): XtermAddonManager | null {
  const root = term as unknown as {
    _addonManager?: XtermAddonManager;
    _core?: { _addonManager?: XtermAddonManager };
  };
  return root._addonManager ?? root._core?._addonManager ?? null;
}

/**
 * xterm 5.3 throws from WebglAddon.dispose() when RenderService is already gone.
 * Remove the addon from xterm's manager so term.dispose() will not call it again.
 */
export function detachTerminalAddon(term: Terminal, addon: object): void {
  const manager = getAddonManager(term);
  if (!manager?._addons) return;
  manager._addons = manager._addons.filter((entry) => entry.instance !== addon);
}

function disposeWebglAddon(addon: WebglAddon): void {
  try {
    addon.dispose();
  } catch {
    // xterm 5.3: RenderService.setRenderer → onRequestRedraw on torn-down core
  }
}

/**
 * Tear down xterm without tripping the WebGL double-dispose bug (xterm #4757).
 * Always detach WebGL from the addon manager before terminal.dispose().
 */
export function safeDisposeTerminal(
  term: Terminal | null,
  webglAddon: WebglAddon | null,
  webglAlreadyDisposed: boolean,
): void {
  if (!term) return;

  if (webglAddon) {
    detachTerminalAddon(term, webglAddon);
    if (!webglAlreadyDisposed) {
      disposeWebglAddon(webglAddon);
    }
  }

  try {
    term.dispose();
  } catch {
    // Best-effort: core may already be partially torn down
  }
}

export function createWebglDisposeTracker() {
  let addon: WebglAddon | null = null;
  let disposed = false;

  return {
    setAddon(next: WebglAddon | null) {
      addon = next;
      disposed = false;
    },
    disposeAddon() {
      if (!addon || disposed) return;
      disposed = true;
      disposeWebglAddon(addon);
    },
    disposeTerminal(term: Terminal | null) {
      safeDisposeTerminal(term, addon, disposed);
      addon = null;
      disposed = false;
    },
    getAddon: () => addon,
    isDisposed: () => disposed,
  };
}
