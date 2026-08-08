import * as React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const playerState = vi.hoisted(() => ({
  instances: [] as Array<{
    disposed: boolean;
    initialized: boolean;
    setAnimationCalls: number;
    loadCalls: number;
    animations: Array<{ fps: number; playbackKey?: string }>;
  }>,
}));

vi.mock('./petSettingsStore', () => {
  const state = { characterId: 'vibespace-axolotl', showDiagnostics: false };
  const usePetSettingsStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  );
  return {
    PET_FORCE_ANIM_EVENT: 'vibespace:pet-force-animation',
    usePetSettingsStore,
  };
});

vi.mock('./pixiAtlasPlayer', () => {
  class MockPlayer {
    disposed = false;
    initialized = false;
    setAnimationCalls = 0;
    loadCalls = 0;
    animations: Array<{ fps: number; playbackKey?: string }> = [];
    isDestroyed = false;
    application = {};

    constructor() {
      playerState.instances.push(this);
    }

    static selectAtlasScale(def: { atlas: string }) {
      return { atlasPath: def.atlas, scale: '1x' as const };
    }

    async init(host: HTMLElement) {
      await Promise.resolve();
      if (!this.disposed) {
        this.initialized = true;
        host.replaceChildren(document.createElement('canvas'));
      }
    }

    async load() {
      this.loadCalls += 1;
      await Promise.resolve();
    }

    isPlaybackReady() {
      return false;
    }

    setPlaybackFps() {}

    pause() {}

    resume() {}

    setContextLostHandler(_handler: (() => void) | null) {}

    isContextUnhealthy() {
      return this.disposed || this.isDestroyed;
    }

    ensureAliveRendering() {
      return !this.disposed && !this.isDestroyed && this.initialized;
    }

    setAnimation(meta: { fps: number; playbackKey?: string }) {
      this.setAnimationCalls += 1;
      this.animations.push(meta);
    }

    getDiagnostics() {
      return {
        currentFrameIndex: 0,
        frameCount: 2,
        currentFrameName: 'frame_000',
        elapsedAnimationMs: 0,
        fps: 12,
        loop: true,
        done: false,
        tickerRunning: true,
        tickerStarted: true,
        tickerListenerCount: 1,
        animationPaused: false,
        textureCacheKey: 'idle.png',
        loadedAtlasJsonUrl: 'idle.json',
        currentTextureUid: 'texture-0',
        currentTextureSourceUid: 'source-0',
        currentTextureFrameRect: '0,0,128,128',
        lastTextureChanged: true,
        textureAssignmentCount: 1,
        setAnimationCallCount: this.setAnimationCalls,
        ignoredDuplicateAnimationRequests: 0,
        animationResetCount: this.setAnimationCalls,
        liveApplicationCount: 1,
        backgroundAlpha: 0,
        scaleMode: 'nearest' as const,
      };
    }

    dispose() {
      this.disposed = true;
      this.isDestroyed = true;
    }
  }

  return { PixiAtlasPlayer: MockPlayer };
});

vi.mock('./petTauriBridge', () => ({
  PET_OVERLAY_SHOW_EVENT: 'vibespace:pet-overlay-show',
  PET_OVERLAY_SHOW_EPOCH_KEY: 'vibespace-pet-overlay-show-epoch',
  PET_PANEL_OPEN_FLAG_KEY: 'vibespace-pet-panel-open',
  notifyPetPanelOpenRequested: vi.fn(),
  openOrFocusPetMiniPanel: vi.fn(async () => ({
    panelVisible: true,
    useInlineFallback: false,
    coalesced: false,
  })),
  setPetOverlayPosition: vi.fn(async () => undefined),
  snapPetOverlayToEdge: vi.fn(async () => undefined),
}));

import { PetOverlay } from './PetOverlay';
import { setPetOverlayPosition, snapPetOverlayToEdge } from './petTauriBridge';
import { publishPetRuntimeEvent, resetPetRuntimeEventDedupeForTests } from './petRuntimeEvents';

describe('PetOverlay StrictMode player lifecycle', () => {
  afterEach(() => {
    playerState.instances.length = 0;
    vi.mocked(setPetOverlayPosition).mockClear();
    vi.mocked(snapPetOverlayToEdge).mockClear();
    resetPetRuntimeEventDedupeForTests();
    vi.useRealTimers();
  });

  it('uses the bundled static portrait when animation is off and publishes image readiness', async () => {
    const view = render(<PetOverlay reducedMotion animationLevelOverride="off" tauriWindowMode />);
    const overlay = view.container.querySelector('[data-pet-overlay="true"]') as HTMLElement;
    const staticFrame = view.container.querySelector(
      '[data-pet-static-frame="true"]',
    ) as HTMLImageElement;

    expect(overlay.getAttribute('data-pet-render-ready')).toBe('false');
    expect(staticFrame).toBeTruthy();
    fireEvent.load(staticFrame);
    await waitFor(() => {
      expect(overlay.getAttribute('data-pet-render-ready')).toBe('true');
    });
    expect(playerState.instances.every((player) => player.setAnimationCalls === 0)).toBe(true);

    view.unmount();
  });

  it('shows then clears a sanitized success reaction from the shared runtime event broker', () => {
    vi.useFakeTimers();
    const view = render(<PetOverlay />);
    const overlay = view.container.querySelector('[data-pet-overlay="true"]') as HTMLElement;
    expect(overlay).toBeTruthy();

    act(() => {
      publishPetRuntimeEvent({
        id: 'chat-finished-1',
        kind: 'chat.completed',
        sourceId: 'chat-real-id',
        occurredAt: Date.now(),
      });
    });

    expect(overlay.getAttribute('data-pet-reaction')).toBe('success');
    // Status reactions stay semantic (data attribute + screen-reader copy) —
    // no floating corner dots on the desktop pet.
    expect(view.container.querySelector('[data-pet-reaction-indicator]')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(2_400);
    });
    expect(overlay.getAttribute('data-pet-reaction')).toBe('idle');
    view.unmount();
  });

  it('does not paint a hover status dot on pointer enter', () => {
    const view = render(<PetOverlay />);
    const overlay = view.container.querySelector('[data-pet-overlay="true"]') as HTMLElement;
    expect(overlay).toBeTruthy();

    fireEvent.pointerEnter(overlay);
    expect(overlay.getAttribute('data-pet-reaction')).toBe('hover');
    expect(view.container.querySelector('[data-pet-reaction-indicator]')).toBeNull();

    fireEvent.pointerLeave(overlay);
    expect(overlay.getAttribute('data-pet-reaction')).toBe('idle');
    view.unmount();
  });

  it('snaps an unlocked desktop Pet only after the drag ends', async () => {
    const view = render(<PetOverlay tauriWindowMode edgeSnapping />);
    await waitFor(() => {
      expect(view.container.querySelector('[data-pet-overlay="true"]')).toBeTruthy();
    });
    const overlay = view.container.querySelector('[data-pet-overlay="true"]') as HTMLElement;
    overlay.setPointerCapture = vi.fn();

    fireEvent.pointerDown(overlay, {
      button: 0,
      pointerId: 8,
      clientX: 20,
      clientY: 20,
      screenX: 200,
      screenY: 200,
    });
    fireEvent.pointerMove(overlay, {
      pointerId: 8,
      clientX: 45,
      clientY: 20,
      screenX: 225,
      screenY: 200,
    });
    expect(snapPetOverlayToEdge).not.toHaveBeenCalled();

    fireEvent.pointerUp(overlay, {
      pointerId: 8,
      clientX: 45,
      clientY: 20,
      screenX: 225,
      screenY: 200,
    });
    expect(snapPetOverlayToEdge).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('keeps clicks active while position lock prevents desktop movement', async () => {
    const view = render(<PetOverlay tauriWindowMode positionLocked />);

    await waitFor(() => {
      expect(view.container.querySelector('[data-pet-overlay="true"]')).toBeTruthy();
    });
    const overlay = view.container.querySelector('[data-pet-overlay="true"]') as HTMLElement;
    overlay.setPointerCapture = vi.fn();

    fireEvent.pointerDown(overlay, {
      button: 0,
      pointerId: 7,
      clientX: 20,
      clientY: 20,
      screenX: 200,
      screenY: 200,
    });
    fireEvent.pointerMove(overlay, {
      pointerId: 7,
      clientX: 70,
      clientY: 55,
      screenX: 250,
      screenY: 235,
    });
    fireEvent.pointerUp(overlay, {
      pointerId: 7,
      clientX: 70,
      clientY: 55,
      screenX: 250,
      screenY: 235,
    });

    expect(setPetOverlayPosition).not.toHaveBeenCalled();
    expect(overlay.getAttribute('data-pet-position-locked')).toBe('true');
    view.unmount();
  });

  it('allows only the final live player generation to start the visible animation', async () => {
    const view = render(
      <React.StrictMode>
        <PetOverlay />
      </React.StrictMode>,
    );

    await waitFor(() => {
      const live = playerState.instances.filter((player) => player.initialized && !player.disposed);
      expect(live).toHaveLength(1);
      expect(live[0].setAnimationCalls).toBe(1);
    });

    for (const stale of playerState.instances.filter((player) => player.disposed)) {
      expect(stale.setAnimationCalls).toBe(0);
    }

    view.unmount();
  });

  it('applies the shared 15 percent speed increase to the initial welcome', async () => {
    const view = render(<PetOverlay />);

    await waitFor(() => {
      const live = playerState.instances.find((player) => player.initialized && !player.disposed);
      expect(live?.animations[0]?.fps).toBeCloseTo(8.625, 8);
    });

    view.unmount();
  });

  it('restarts welcome when the native overlay receives a cross-window show signal', async () => {
    const view = render(<PetOverlay tauriWindowMode />);

    await waitFor(() => {
      const live = playerState.instances.find((player) => player.initialized && !player.disposed);
      expect(live?.setAnimationCalls).toBe(1);
    });
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'vibespace-pet-overlay-show-epoch',
        oldValue: '1',
        newValue: '2',
      }),
    );

    await waitFor(
      () => {
        const live = playerState.instances.find((player) => player.initialized && !player.disposed);
        const welcomeStarts =
          live?.animations.filter((animation) => animation.playbackKey?.includes(':welcome:'))
            .length ?? 0;
        expect(welcomeStarts).toBe(2);
      },
      { timeout: 1500 },
    );

    view.unmount();
  });

  it('restarts welcome when the mini-panel flag is cleared on close or minimize', async () => {
    const view = render(<PetOverlay tauriWindowMode />);

    await waitFor(() => {
      const live = playerState.instances.find((player) => player.initialized && !player.disposed);
      expect(live?.setAnimationCalls).toBe(1);
    });
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'vibespace-pet-panel-open',
        oldValue: '1',
        newValue: null,
      }),
    );

    await waitFor(
      () => {
        const live = playerState.instances.find((player) => player.initialized && !player.disposed);
        const welcomeStarts =
          live?.animations.filter((animation) => animation.playbackKey?.includes(':welcome:'))
            .length ?? 0;
        expect(welcomeStarts).toBe(2);
      },
      { timeout: 1500 },
    );

    view.unmount();
  });
});
