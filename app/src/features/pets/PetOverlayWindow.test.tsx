import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PetOverlayWindow } from './PetOverlayWindow';

const overlayBridge = vi.hoisted(() => ({
  hidePetOverlay: vi.fn(async () => undefined),
  reassertPetOverlayTopmost: vi.fn(async () => undefined),
}));

const petSettings = vi.hoisted(() => ({
  enabled: true,
  overlayVisible: true,
  setOverlayVisible: vi.fn(),
}));

const currentWindow = vi.hoisted(() => ({
  hide: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => currentWindow,
}));

vi.mock('./PetOverlay', () => ({
  PetOverlay: ({ onRequestClose }: { onRequestClose: () => void }) => (
    <>
      <canvas data-pet-pixi-canvas="true" />
      <button onClick={onRequestClose}>Close Pet</button>
    </>
  ),
}));

vi.mock('./petTauriBridge', () => ({
  hidePetOverlay: overlayBridge.hidePetOverlay,
  openOrFocusPetPanel: vi.fn(async () => undefined),
  openOrFocusPetMiniPanel: vi.fn(async () => ({
    panelVisible: true,
    useInlineFallback: false,
    coalesced: false,
  })),
  reassertPetOverlayTopmost: overlayBridge.reassertPetOverlayTopmost,
  setPetPanelOpenFlag: vi.fn(),
  showPetOverlay: vi.fn(async () => undefined),
}));

vi.mock('./petPresentationStore', () => ({
  installPetPresentationStorageSync: vi.fn(() => () => undefined),
}));

vi.mock('./petSettingsStore', () => ({
  installPetSettingsStorageSync: vi.fn(() => () => undefined),
  usePetSettingsStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      enabled: petSettings.enabled,
      overlayVisible: petSettings.overlayVisible,
      reducedMotion: false,
      sleepTimeoutMs: 300_000,
      idleFunIntervalMs: 60_000,
      setOverlayVisible: petSettings.setOverlayVisible,
    }),
}));

vi.mock('@/stores/ui', () => ({
  useUIStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ theme: 'default' }),
  applyThemeToDocument: vi.fn(),
}));

describe('PetOverlayWindow transparency shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    petSettings.enabled = true;
    petSettings.overlayVisible = true;
  });

  it('persists an intentional hide when Close is selected in the detached overlay', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
    render(<PetOverlayWindow />, { container: root });

    fireEvent.click(screen.getByRole('button', { name: 'Close Pet' }));

    expect(petSettings.setOverlayVisible).toHaveBeenCalledWith(false);
    await waitFor(() => expect(currentWindow.hide).toHaveBeenCalledTimes(1));
    expect(overlayBridge.hidePetOverlay).not.toHaveBeenCalled();
    root.remove();
  });

  it('self-hides and skips topmost recovery when persisted Pet settings are disabled', async () => {
    petSettings.enabled = false;
    petSettings.overlayVisible = false;
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);

    render(<PetOverlayWindow />, { container: root });

    await waitFor(() => expect(currentWindow.hide).toHaveBeenCalledTimes(1));
    expect(overlayBridge.reassertPetOverlayTopmost).not.toHaveBeenCalled();
    root.remove();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.removeAttribute('data-vibespace-view');
    document.body.removeAttribute('data-vibespace-view');
    document.documentElement.removeAttribute('style');
    document.body.removeAttribute('style');
    const root = document.getElementById('root');
    root?.removeAttribute('style');
  });

  it('marks the document and overlay root as transparent pet-only chrome', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);

    render(<PetOverlayWindow />, { container: root });

    await waitFor(() => {
      expect(document.documentElement.dataset.vibespaceView).toBe('pet-overlay');
    });
    expect(document.body.dataset.vibespaceView).toBe('pet-overlay');
    expect(document.documentElement.style.background).toBe('transparent');
    expect(document.body.style.background).toBe('transparent');
    expect(document.body.style.margin).toBe('0px');
    expect(document.body.style.overflow).toBe('hidden');
    expect(root.style.background).toBe('transparent');

    const overlayRoot = screen.getByTestId('pet-overlay-root');
    expect(overlayRoot.classList.contains('pet-overlay-root')).toBe(true);
    expect(
      overlayRoot.style.background === 'transparent' ||
        overlayRoot.style.backgroundColor === 'transparent',
    ).toBe(true);
    expect(overlayRoot.querySelectorAll('[data-pet-pixi-canvas="true"]')).toHaveLength(1);

    root.remove();
  });

  it('keeps the real visual shell while suppressing native and storage effects', async () => {
    const { installPetPresentationStorageSync } = await import('./petPresentationStore');
    const { installPetSettingsStorageSync } = await import('./petSettingsStore');
    const { reassertPetOverlayTopmost } = await import('./petTauriBridge');
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);

    render(<PetOverlayWindow runtimeEffectsEnabled={false} />, { container: root });

    await waitFor(() => {
      expect(screen.getByTestId('pet-overlay-root')).toBeTruthy();
    });
    expect(installPetPresentationStorageSync).not.toHaveBeenCalled();
    expect(installPetSettingsStorageSync).not.toHaveBeenCalled();
    expect(reassertPetOverlayTopmost).not.toHaveBeenCalled();

    root.remove();
  });

  it('reasserts topmost even when the overlay webview reports hidden/occluded', async () => {
    const { reassertPetOverlayTopmost } = await import('./petTauriBridge');
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });

    render(<PetOverlayWindow />, { container: root });

    await waitFor(() => {
      expect(reassertPetOverlayTopmost).toHaveBeenCalled();
    });

    root.remove();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
  });

  it('coalesces concurrent topmost recovery triggers and stops after cleanup', async () => {
    vi.useFakeTimers();
    let releaseRecovery: (() => void) | undefined;
    overlayBridge.reassertPetOverlayTopmost
      .mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            releaseRecovery = () => resolve(undefined);
          }),
      )
      .mockResolvedValue(undefined);
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);

    const { unmount } = render(<PetOverlayWindow />, { container: root });
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('pageshow'));
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(overlayBridge.reassertPetOverlayTopmost).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseRecovery?.();
      await Promise.resolve();
    });
    window.dispatchEvent(new Event('focus'));
    await act(async () => undefined);
    expect(overlayBridge.reassertPetOverlayTopmost).toHaveBeenCalledTimes(2);

    unmount();
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(overlayBridge.reassertPetOverlayTopmost).toHaveBeenCalledTimes(2);
  });
});
