import { describe, expect, it, vi } from 'vitest';
import { Terminal } from 'xterm';
import { detachTerminalAddon, safeDisposeTerminal } from './terminalDispose';

function mockTerm(addons: Array<{ instance: unknown }>, dispose = vi.fn()) {
  return {
    dispose,
    _addonManager: { _addons: addons },
  } as unknown as Terminal;
}

describe('detachTerminalAddon', () => {
  it('removes the targeted addon from xterm addon manager', () => {
    const webgl = { id: 'webgl' };
    const fit = { id: 'fit' };
    const term = mockTerm([{ instance: fit }, { instance: webgl }]);

    detachTerminalAddon(term, webgl);

    expect((term as unknown as { _addonManager: { _addons: unknown[] } })._addonManager._addons).toEqual([
      { instance: fit },
    ]);
  });

  it('falls back to core addon manager when present', () => {
    const webgl = { id: 'webgl' };
    const term = {
      dispose: vi.fn(),
      _core: { _addonManager: { _addons: [{ instance: webgl }] } },
    } as unknown as Terminal;

    detachTerminalAddon(term, webgl);

    expect(
      (term as unknown as { _core: { _addonManager: { _addons: unknown[] } } })._core._addonManager._addons,
    ).toEqual([]);
  });
});

describe('safeDisposeTerminal', () => {
  it('detaches and disposes WebGL before terminal dispose on normal unmount', () => {
    const webgl = {
      dispose: vi.fn(),
    } as unknown as import('xterm-addon-webgl').WebglAddon;
    const termDispose = vi.fn();
    const term = mockTerm([{ instance: webgl }], termDispose);

    safeDisposeTerminal(term, webgl, false);

    expect(webgl.dispose).toHaveBeenCalledTimes(1);
    expect(
      (term as unknown as { _addonManager: { _addons: unknown[] } })._addonManager._addons,
    ).toEqual([]);
    expect(termDispose).toHaveBeenCalledTimes(1);
  });

  it('skips second WebGL dispose after context loss but still detaches', () => {
    const webgl = {
      dispose: vi.fn(),
    } as unknown as import('xterm-addon-webgl').WebglAddon;
    const term = mockTerm([{ instance: webgl }], vi.fn());

    safeDisposeTerminal(term, webgl, true);

    expect(webgl.dispose).not.toHaveBeenCalled();
    expect(
      (term as unknown as { _addonManager: { _addons: unknown[] } })._addonManager._addons,
    ).toEqual([]);
  });

  it('swallows dispose errors from partially torn-down renderers', () => {
    const webgl = {
      dispose: vi.fn(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'onRequestRedraw')");
      }),
    } as unknown as import('xterm-addon-webgl').WebglAddon;
    const term = mockTerm([{ instance: webgl }], vi.fn(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'onRequestRedraw')");
    }));

    expect(() => safeDisposeTerminal(term, webgl, false)).not.toThrow();
  });
});
