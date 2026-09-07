import { act, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./features/pets/PetOverlayWindow', () => ({
  PetOverlayWindow: () => <div data-testid="pet-overlay-root" data-pet-pixi-canvas="true" />,
}));

vi.mock('./features/pets/PetMiniPanelWindow', () => ({
  PetMiniPanelWindow: () => <div data-testid="pet-mini-panel-root" />,
}));

describe('detached Pet bootstrap', () => {
  it('shows loading feedback until the real panel is ready', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let finish!: (value: { PetMiniPanelWindow: () => React.JSX.Element }) => void;
    const panel = new Promise<{ PetMiniPanelWindow: () => React.JSX.Element }>((resolve) => {
      finish = resolve;
    });
    const { mountPetSurface } = await import('./bootstrapPet');
    await act(async () => {
      mountPetSurface(root, 'pet-mini-panel', {
        panel: () => panel,
        overlay: vi.fn(),
      });
    });
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Loading Chat and Terminals');
    await act(async () => {
      finish({ PetMiniPanelWindow: () => <div data-testid="loaded-panel" /> });
    });
    await waitFor(() => expect(root.querySelector('[data-testid="loaded-panel"]')).not.toBeNull());
    expect(root.querySelector('[role="status"]')).toBeNull();
  });

  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.removeAttribute('data-vibespace-view');
    document.documentElement.removeAttribute('style');
    document.body.removeAttribute('data-vibespace-view');
    document.body.removeAttribute('style');
  });

  it('mounts the animated overlay without exposing a stranded image fallback', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
    let exposedBootstrapFallback = false;
    const observer = new MutationObserver(() => {
      exposedBootstrapFallback ||= root.querySelector('[data-pet-bootstrap-fallback]') !== null;
    });
    observer.observe(root, { childList: true, subtree: true });

    const overlayLoader = vi.fn(async () => ({
      PetOverlayWindow: () => <div data-testid="pet-overlay-root" data-pet-pixi-canvas="true" />,
    }));
    const panelLoader = vi.fn(async () => ({
      PetMiniPanelWindow: () => <div data-testid="pet-mini-panel-root" />,
    }));
    const { mountPetSurface } = await import('./bootstrapPet');
    await act(async () => {
      await mountPetSurface(root, 'pet-overlay', { overlay: overlayLoader, panel: panelLoader });
    });

    await waitFor(() => {
      expect(root.querySelector('[data-testid="pet-overlay-root"]')).not.toBeNull();
    });
    observer.disconnect();
    expect(exposedBootstrapFallback).toBe(false);
    expect(root.querySelector('img[alt="VibeSpace Pet"]')).toBeNull();
    expect(overlayLoader).toHaveBeenCalledTimes(1);
    expect(panelLoader).not.toHaveBeenCalled();
  });

  it('loads only the panel entry when the mini panel route starts', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);

    const overlayLoader = vi.fn(async () => ({
      PetOverlayWindow: () => <div data-testid="pet-overlay-root" />,
    }));
    const panelLoader = vi.fn(async () => ({
      PetMiniPanelWindow: () => <div data-testid="pet-mini-panel-root" />,
    }));
    const { mountPetSurface } = await import('./bootstrapPet');
    await act(async () => {
      await mountPetSurface(root, 'pet-mini-panel', { overlay: overlayLoader, panel: panelLoader });
    });

    await waitFor(() => {
      expect(root.querySelector('[data-testid="pet-mini-panel-root"]')).not.toBeNull();
    });
    expect(overlayLoader).not.toHaveBeenCalled();
    expect(panelLoader).toHaveBeenCalledTimes(1);
    for (const element of [document.documentElement, document.body, root]) {
      expect(element.style.backgroundColor).toBe('transparent');
    }
  });
});
