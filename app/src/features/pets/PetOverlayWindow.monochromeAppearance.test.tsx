import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ theme: 'monochrome' }),
  applyThemeToDocument: vi.fn((theme: string) => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-theme-preference', theme);
  }),
}));

vi.mock('./PetOverlay', () => ({
  PetOverlay: ({
    animationLevelOverride,
    reducedMotion,
  }: {
    animationLevelOverride?: string;
    reducedMotion?: boolean;
  }) => (
    <canvas
      data-pet-animation-level={animationLevelOverride ?? 'default'}
      data-pet-pixi-canvas="true"
      data-pet-reduced-motion={String(reducedMotion)}
    />
  ),
}));

vi.mock('./petTauriBridge', () => ({
  openOrFocusPetMiniPanel: vi.fn(async () => ({
    panelVisible: true,
    useInlineFallback: false,
    coalesced: false,
  })),
  reassertPetOverlayTopmost: vi.fn(async () => undefined),
  setPetPanelOpenFlag: vi.fn(),
  showPetOverlay: vi.fn(async () => undefined),
}));

vi.mock('./petPresentationStore', () => ({
  installPetPresentationStorageSync: vi.fn(() => () => undefined),
}));

vi.mock('./petSettingsStore', () => ({
  installPetSettingsStorageSync: vi.fn(() => () => undefined),
  usePetSettingsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      reducedMotion: true,
      sleepTimeoutMs: 300_000,
      idleFunIntervalMs: 60_000,
      panelMode: 'normal',
    }),
}));

import { PetOverlayWindow } from './PetOverlayWindow';

function mountOverlayRoot(): HTMLDivElement {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  return root;
}

describe('PetOverlayWindow MonoChrome appearance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme-preference');
  });

  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute('data-vibespace-view');
    document.body.removeAttribute('data-vibespace-view');
    document.documentElement.removeAttribute('style');
    document.body.removeAttribute('style');
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme-preference');
    document.getElementById('root')?.remove();
  });

  it('applies the active MonoChrome theme to the document and keeps the surface flat', async () => {
    const { applyThemeToDocument } = await import('@/stores/ui');
    const root = mountOverlayRoot();

    render(<PetOverlayWindow />, { container: root });

    await waitFor(() => {
      expect(applyThemeToDocument).toHaveBeenCalledWith('monochrome');
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('monochrome');

    const surface = screen.getByTestId('pet-overlay-root');
    expect(surface.getAttribute('data-monochrome-surface')).toBe('pet-overlay-window');
    expect(surface.className).not.toMatch(/gradient|blur|shadow/);
    expect(surface.style.backgroundColor).toBe('transparent');
    expect(surface.style.backgroundImage).toBe('none');
    expect(surface.querySelectorAll('[data-pet-pixi-canvas="true"]')).toHaveLength(1);
  });

  it('refits the pet shell after the native viewport changes size', () => {
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    const view = render(<PetOverlayWindow runtimeEffectsEnabled={false} />);
    try {
      act(() => {
        Object.defineProperty(window, 'innerWidth', { value: 116, configurable: true });
        Object.defineProperty(window, 'innerHeight', { value: 116, configurable: true });
        window.dispatchEvent(new Event('resize'));
      });
      expect(screen.getByTestId('pet-overlay-root').style.width).toBe('116px');
      act(() => {
        Object.defineProperty(window, 'innerWidth', { value: 144, configurable: true });
        Object.defineProperty(window, 'innerHeight', { value: 144, configurable: true });
        window.dispatchEvent(new Event('resize'));
      });
      expect(screen.getByTestId('pet-overlay-root').style.width).toBe('144px');
    } finally {
      view.unmount();
      Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: originalHeight, configurable: true });
    }
  });

  it('themes the deterministic fixture without native or storage side effects', async () => {
    const { applyThemeToDocument } = await import('@/stores/ui');
    const { installPetPresentationStorageSync } = await import('./petPresentationStore');
    const { installPetSettingsStorageSync } = await import('./petSettingsStore');
    const { reassertPetOverlayTopmost } = await import('./petTauriBridge');
    const root = mountOverlayRoot();

    render(<PetOverlayWindow runtimeEffectsEnabled={false} />, { container: root });

    await waitFor(() => {
      expect(screen.getByTestId('pet-overlay-root')).toBeTruthy();
    });

    expect(applyThemeToDocument).toHaveBeenCalledWith('monochrome');
    expect(document.documentElement.getAttribute('data-theme')).toBe('monochrome');
    expect(installPetPresentationStorageSync).not.toHaveBeenCalled();
    expect(installPetSettingsStorageSync).not.toHaveBeenCalled();
    expect(reassertPetOverlayTopmost).not.toHaveBeenCalled();

    const surface = screen.getByTestId('pet-overlay-root');
    expect(surface.className).not.toMatch(/gradient|blur|shadow/);
    expect(surface.style.backgroundColor).toBe('transparent');
    const canvas = surface.querySelector('[data-pet-pixi-canvas="true"]');
    expect(canvas?.getAttribute('data-pet-animation-level')).toBe('off');
    expect(canvas?.getAttribute('data-pet-reduced-motion')).toBe('true');
  });
});
