/**
 * Confirm-then-hide panel open + single-flight openOrFocusPetMiniPanel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

function invoked(cmd: string): boolean {
  return invokeMock.mock.calls.some((c) => c[0] === cmd);
}

function invokeCount(cmd: string): number {
  return invokeMock.mock.calls.filter((c) => c[0] === cmd).length;
}

function nativePanelOpenResult(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'native-panel',
    created: true,
    visible: true,
    focused: true,
    topmostApplied: true,
    rendererReady: null,
    reason: null,
    ...overrides,
  };
}

function nativeOverlayShowResult(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'native-overlay',
    created: true,
    visible: true,
    topmostApplied: true,
    rendererReady: null,
    reason: null,
    ...overrides,
  };
}

describe('openOrFocusPetMiniPanel / openPetPanelSafely', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    localStorage.clear();
    (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  });

  afterEach(async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    const { __resetPetPanelOpenFlightForTests } = await import('./petTauriBridge');
    __resetPetPanelOpenFlightForTests();
    vi.resetModules();
  });

  it('finishes configuring a newly scheduled native panel before hiding the pet', async () => {
    let attempts = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'pet_open_or_focus_panel') {
        attempts += 1;
        return attempts === 1
          ? nativePanelOpenResult({
              visible: false,
              focused: false,
              topmostApplied: false,
              reason: 'not_visible',
            })
          : nativePanelOpenResult({ created: false });
      }
      if (cmd === 'pet_is_panel_visible') return true;
      if (cmd === 'pet_show_overlay') return nativeOverlayShowResult();
      return undefined;
    });
    const { openOrFocusPetMiniPanel } = await import('./petTauriBridge');
    const result = await openOrFocusPetMiniPanel();
    expect(result.panelVisible).toBe(true);
    expect(attempts).toBe(2);
    expect(invoked('pet_show_overlay')).toBe(false);
    expect(invoked('pet_hide_overlay')).toBe(true);
  });

  it('hides the overlay when the panel is confirmed visible', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'pet_open_or_focus_panel') return nativePanelOpenResult();
      if (cmd === 'pet_is_panel_visible') return true;
      if (cmd === 'pet_hide_overlay') return undefined;
      if (cmd === 'pet_show_overlay') return undefined;
      return null;
    });

    const { openPetPanelSafely } = await import('./petTauriBridge');
    const result = await openPetPanelSafely(10, 20);

    expect(result.panelVisible).toBe(true);
    expect(invoked('pet_open_or_focus_panel')).toBe(true);
    expect(invoked('pet_is_panel_visible')).toBe(true);
    expect(invoked('pet_hide_overlay')).toBe(true);
    expect(invoked('pet_show_overlay')).toBe(false);
  });

  it('passes the validated panel window mode to the native open command', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'pet_open_or_focus_panel') return nativePanelOpenResult();
      if (cmd === 'pet_is_panel_visible') return true;
      return undefined;
    });

    const { openPetPanelSafely } = await import('./petTauriBridge');
    await openPetPanelSafely(10, 20, 'follow-pet');

    const openCall = invokeMock.mock.calls.find((call) => call[0] === 'pet_open_or_focus_panel');
    expect(openCall?.[1]).toMatchObject({
      nearX: 10,
      nearY: 20,
      panelMode: 'follow-pet',
    });
  });

  it('opens as a normal window by default while preserving explicit topmost', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'pet_open_or_focus_panel') return nativePanelOpenResult();
      if (cmd === 'pet_is_panel_visible') return true;
      return undefined;
    });

    const { openPetPanelSafely } = await import('./petTauriBridge');
    await openPetPanelSafely(10, 20);
    await openPetPanelSafely(30, 40, 'always-on-top');

    const openCalls = invokeMock.mock.calls.filter((call) => call[0] === 'pet_open_or_focus_panel');
    expect(openCalls[0]?.[1]).toMatchObject({ panelMode: 'normal' });
    expect(openCalls.at(-1)?.[1]).toMatchObject({ panelMode: 'always-on-top' });
  });

  it('offers a bounded native topmost recovery command for lifecycle health checks', async () => {
    invokeMock.mockResolvedValue(undefined);

    const { reassertPetOverlayTopmost } = await import('./petTauriBridge');
    await reassertPetOverlayTopmost();

    expect(invoked('pet_reassert_overlay_topmost')).toBe(true);
  });

  it('queries and changes the opt-in Windows startup entry through bounded Pet commands', async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: { enabled?: boolean }) => {
      if (cmd === 'pet_get_start_with_windows') return false;
      if (cmd === 'pet_set_start_with_windows') return args?.enabled === true;
      return undefined;
    });

    const { getPetStartWithWindows, setPetStartWithWindows } = await import('./petTauriBridge');
    expect(await getPetStartWithWindows()).toBe(false);
    expect(await setPetStartWithWindows(true)).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('pet_set_start_with_windows', { enabled: true });
  });

  it('restores the detached overlay instead of mounting an inline panel when Tauri panel open fails', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'pet_open_or_focus_panel') {
        return nativePanelOpenResult({
          visible: false,
          focused: false,
          topmostApplied: false,
          reason: 'show_failed',
        });
      }
      if (cmd === 'pet_show_overlay') return nativeOverlayShowResult();
      return null;
    });

    const { openOrFocusPetMiniPanel } = await import('./petTauriBridge');
    const result = await openOrFocusPetMiniPanel();

    expect(result.panelVisible).toBe(false);
    expect(result.useInlineFallback).toBe(false);
    expect(result.reason).toBe('show_failed');
    expect(result.overlayVisible).toBe(true);
    expect(invoked('pet_hide_overlay')).toBe(false);
    expect(invoked('pet_show_overlay')).toBe(true);
    expect(localStorage.getItem('vibespace-pet-panel-open')).toBeNull();
  });

  it('reports the native creation failure when neither detached surface can be recovered', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'pet_open_or_focus_panel') {
        return nativePanelOpenResult({
          visible: false,
          focused: false,
          topmostApplied: false,
          reason: 'window_create_failed',
        });
      }
      if (cmd === 'pet_show_overlay') {
        return nativeOverlayShowResult({
          visible: false,
          topmostApplied: false,
          reason: 'window_create_failed',
        });
      }
      return null;
    });

    const { openOrFocusPetMiniPanel } = await import('./petTauriBridge');
    await expect(openOrFocusPetMiniPanel()).resolves.toEqual({
      panelVisible: false,
      useInlineFallback: false,
      overlayVisible: false,
      reason: 'window_create_failed',
      coalesced: false,
    });
    expect(invokeCount('pet_open_or_focus_panel')).toBe(1);
    expect(invokeCount('pet_show_overlay')).toBe(1);
    expect(invoked('pet_hide_overlay')).toBe(false);
  });

  it('single-flight: concurrent opens share one open request', async () => {
    let openCalls = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'pet_open_or_focus_panel') {
        openCalls += 1;
        await new Promise((r) => setTimeout(r, 80));
        return nativePanelOpenResult();
      }
      if (cmd === 'pet_is_panel_visible') return true;
      if (cmd === 'pet_hide_overlay') return undefined;
      return null;
    });

    const { openOrFocusPetMiniPanel } = await import('./petTauriBridge');
    const [a, b] = await Promise.all([
      openOrFocusPetMiniPanel(1, 2),
      openOrFocusPetMiniPanel(3, 4),
    ]);

    expect(a.panelVisible).toBe(true);
    expect(b.panelVisible).toBe(true);
    expect(a.coalesced || b.coalesced).toBe(true);
    // Only one in-flight open sequence (may retry once internally if needed).
    expect(openCalls).toBeLessThanOrEqual(2);
    expect(invokeCount('pet_open_or_focus_panel')).toBeLessThanOrEqual(2);
  });

  it('returns a typed native-command failure and restores the overlay when the panel invoke rejects', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'pet_open_or_focus_panel') throw new Error('synthetic panel create failure');
      if (cmd === 'pet_show_overlay') return nativeOverlayShowResult();
      return null;
    });

    const { openOrFocusPetMiniPanel } = await import('./petTauriBridge');
    const result = await openOrFocusPetMiniPanel();
    expect(result.panelVisible).toBe(false);
    expect(result.useInlineFallback).toBe(false);
    expect(result.reason).toBe('native_command_failed');
    expect(result.overlayVisible).toBe(true);
    expect(invoked('pet_hide_overlay')).toBe(false);
    expect(invoked('pet_show_overlay')).toBe(true);
  });

  it('bounds a stalled native panel command and restores the detached overlay', async () => {
    vi.useFakeTimers();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'pet_open_or_focus_panel') return new Promise(() => undefined);
      if (cmd === 'pet_show_overlay') return Promise.resolve(nativeOverlayShowResult());
      return Promise.resolve(null);
    });

    const { openOrFocusPetMiniPanel } = await import('./petTauriBridge');
    const opening = openOrFocusPetMiniPanel();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(opening).resolves.toMatchObject({
      panelVisible: false,
      useInlineFallback: false,
      overlayVisible: true,
      reason: 'visibility_timeout',
    });
    expect(invokeCount('pet_open_or_focus_panel')).toBe(1);
    expect(invokeCount('pet_show_overlay')).toBe(1);
    vi.useRealTimers();
  });

  it('uses the inline panel only outside Tauri', async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;

    const { openOrFocusPetMiniPanel } = await import('./petTauriBridge');
    const result = await openOrFocusPetMiniPanel();

    expect(result).toMatchObject({
      panelVisible: false,
      useInlineFallback: true,
      overlayVisible: false,
      reason: 'native_unavailable',
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('signals other Pet windows whenever the overlay is shown', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'pet_show_overlay') {
        return nativeOverlayShowResult();
      }
      return undefined;
    });
    const onShow = vi.fn();
    window.addEventListener('vibespace:pet-overlay-show', onShow);

    const { showPetOverlay } = await import('./petTauriBridge');
    await showPetOverlay();

    expect(invoked('pet_show_overlay')).toBe(true);
    expect(localStorage.getItem('vibespace-pet-overlay-show-epoch')).toBeTruthy();
    expect(onShow).toHaveBeenCalledTimes(1);
    window.removeEventListener('vibespace:pet-overlay-show', onShow);
  });

  it('returns a typed failure and does not announce an overlay that native creation rejected', async () => {
    invokeMock.mockRejectedValueOnce(new Error('synthetic native overlay creation failure'));
    const onShow = vi.fn();
    window.addEventListener('vibespace:pet-overlay-show', onShow);

    const { showPetOverlay } = await import('./petTauriBridge');
    const result = await showPetOverlay();

    expect(result).toMatchObject({
      mode: 'native-overlay',
      created: false,
      visible: false,
      topmostApplied: false,
      reason: 'native_command_failed',
    });
    expect(onShow).not.toHaveBeenCalled();
    window.removeEventListener('vibespace:pet-overlay-show', onShow);
  });

  it('bounds a stalled native overlay command and coalesces later recovery attempts', async () => {
    vi.useFakeTimers();
    invokeMock.mockImplementation(() => new Promise(() => undefined));

    const { showPetOverlay } = await import('./petTauriBridge');
    const first = showPetOverlay();
    const second = showPetOverlay();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(first).resolves.toMatchObject({
      mode: 'native-overlay',
      visible: false,
      reason: 'visibility_timeout',
    });
    await expect(second).resolves.toMatchObject({ reason: 'visibility_timeout' });
    expect(invokeCount('pet_show_overlay')).toBe(1);
    vi.useRealTimers();
  });

  it('fails closed when native returns an invalid overlay result', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const onShow = vi.fn();
    window.addEventListener('vibespace:pet-overlay-show', onShow);

    const { showPetOverlay } = await import('./petTauriBridge');
    const result = await showPetOverlay();

    expect(result).toMatchObject({
      mode: 'native-overlay',
      visible: false,
      reason: 'native_result_invalid',
    });
    expect(onShow).not.toHaveBeenCalled();
    window.removeEventListener('vibespace:pet-overlay-show', onShow);
  });

  it.each(['stale_window_retire_failed', 'window_label_conflict'] as const)(
    'preserves the sanitized native recovery reason %s',
    async (reason) => {
      invokeMock.mockResolvedValueOnce({
        mode: 'native-overlay',
        created: false,
        visible: false,
        topmostApplied: false,
        rendererReady: null,
        reason,
      });

      const { showPetOverlay } = await import('./petTauriBridge');
      await expect(showPetOverlay()).resolves.toMatchObject({ reason });
    },
  );
});
