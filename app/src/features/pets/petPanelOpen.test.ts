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

  it('keeps the overlay visible when the panel is confirmed visible', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'pet_open_or_focus_panel') return undefined;
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
    expect(invoked('pet_hide_overlay')).toBe(false);
    expect(invoked('pet_show_overlay')).toBe(false);
  });

  it('passes the validated panel window mode to the native open command', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
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

  it('restores overlay when panel is not visible (no disappear)', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'pet_open_or_focus_panel') return undefined;
      if (cmd === 'pet_is_panel_visible') return false;
      if (cmd === 'pet_hide_overlay') return undefined;
      if (cmd === 'pet_show_overlay') return undefined;
      return null;
    });

    const { openPetPanelSafely } = await import('./petTauriBridge');
    const result = await openPetPanelSafely();

    expect(result.panelVisible).toBe(false);
    expect(invoked('pet_show_overlay')).toBe(true);
    expect(invoked('pet_hide_overlay')).toBe(false);
  });

  it('single-flight: concurrent opens share one open request', async () => {
    let openCalls = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'pet_open_or_focus_panel') {
        openCalls += 1;
        await new Promise((r) => setTimeout(r, 80));
        return undefined;
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

  it('signals inline fallback when Tauri panel never becomes visible', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'pet_open_or_focus_panel') return undefined;
      if (cmd === 'pet_is_panel_visible') return false;
      if (cmd === 'pet_show_overlay') return undefined;
      return null;
    });

    const { openOrFocusPetMiniPanel } = await import('./petTauriBridge');
    const result = await openOrFocusPetMiniPanel();
    expect(result.panelVisible).toBe(false);
    expect(result.useInlineFallback).toBe(true);
  });

  it('signals other Pet windows whenever the overlay is shown', async () => {
    invokeMock.mockResolvedValue(undefined);
    const onShow = vi.fn();
    window.addEventListener('vibespace:pet-overlay-show', onShow);

    const { showPetOverlay } = await import('./petTauriBridge');
    await showPetOverlay();

    expect(invoked('pet_show_overlay')).toBe(true);
    expect(localStorage.getItem('vibespace-pet-overlay-show-epoch')).toBeTruthy();
    expect(onShow).toHaveBeenCalledTimes(1);
    window.removeEventListener('vibespace:pet-overlay-show', onShow);
  });
});
