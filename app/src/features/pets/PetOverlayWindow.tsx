/**
 * Dedicated entry for Tauri window label `pet-overlay`.
 * Transparent, frameless surface — Pixi pet only.
 *
 * Click opens the real mini panel via openOrFocusPetMiniPanel (shared with Axo).
 * Does not alter Glitch animation/drag — only panel open wiring.
 */
import * as React from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PetOverlay } from './PetOverlay';
import {
  openOrFocusPetMiniPanel,
  reassertPetOverlayTopmost,
  setPetPanelOpenFlag,
  showPetOverlay,
} from './petTauriBridge';
import { installPetPresentationStorageSync } from './petPresentationStore';
import { installPetSettingsStorageSync, usePetSettingsStore } from './petSettingsStore';
import { applyThemeToDocument, useUIStore } from '@/stores/ui';
import { createSingleFlightRunner } from '@/stability/singleFlight';
import { resolvePetOverlayViewport } from './petOverlayViewport';

export interface PetOverlayWindowProps {
  runtimeEffectsEnabled?: boolean;
}

export function PetOverlayWindow({ runtimeEffectsEnabled = true }: PetOverlayWindowProps = {}) {
  const enabled = usePetSettingsStore((s) => s.enabled) ?? true;
  const overlayVisible = usePetSettingsStore((s) => s.overlayVisible) ?? true;
  const reducedMotion = usePetSettingsStore((s) => s.reducedMotion);
  const sleepTimeoutMs = usePetSettingsStore((s) => s.sleepTimeoutMs);
  const idleFunIntervalMs = usePetSettingsStore((s) => s.idleFunIntervalMs);
  const panelMode = usePetSettingsStore((s) => s.panelMode) ?? 'normal';
  const setOverlayVisible = usePetSettingsStore((s) => s.setOverlayVisible);
  const theme = useUIStore((s) => s.theme);
  const [viewport, setViewport] = React.useState(() =>
    resolvePetOverlayViewport(
      typeof window === 'undefined' ? 144 : window.innerWidth,
      typeof window === 'undefined' ? 144 : window.innerHeight,
    ),
  );
  React.useEffect(() => {
    const resize = () => {
      const next = resolvePetOverlayViewport(window.innerWidth, window.innerHeight);
      setViewport((current) => (current.shellSize === next.shellSize ? current : next));
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const shouldRenderPet = !runtimeEffectsEnabled || (enabled && overlayVisible);

  React.useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  React.useEffect(() => {
    document.documentElement.dataset.vibespaceView = 'pet-overlay';
    document.body.dataset.vibespaceView = 'pet-overlay';
    document.documentElement.style.background = 'transparent';
    document.documentElement.style.backgroundColor = 'transparent';
    document.documentElement.style.backgroundImage = 'none';
    document.body.style.background = 'transparent';
    document.body.style.backgroundColor = 'transparent';
    document.body.style.backgroundImage = 'none';
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.overflow = 'hidden';
    const root = document.getElementById('root');
    if (root) {
      root.style.background = 'transparent';
      root.style.backgroundColor = 'transparent';
      root.style.backgroundImage = 'none';
      root.style.width = `${viewport.shellSize}px`;
      root.style.height = `${viewport.shellSize}px`;
      root.style.margin = '0';
      root.style.padding = '0';
      root.style.overflow = 'hidden';
    }
    const uninstallPresentationSync = runtimeEffectsEnabled
      ? installPetPresentationStorageSync()
      : () => undefined;
    const uninstallSettingsSync = runtimeEffectsEnabled
      ? installPetSettingsStorageSync()
      : () => undefined;
    return () => {
      uninstallPresentationSync();
      uninstallSettingsSync();
      if (document.documentElement.dataset.vibespaceView === 'pet-overlay') {
        delete document.documentElement.dataset.vibespaceView;
      }
      if (document.body.dataset.vibespaceView === 'pet-overlay') {
        delete document.body.dataset.vibespaceView;
      }
    };
  }, [runtimeEffectsEnabled, viewport.shellSize]);

  React.useEffect(() => {
    if (!runtimeEffectsEnabled || (enabled && overlayVisible)) return;
    setPetPanelOpenFlag(false);
    void getCurrentWindow()
      .hide()
      .catch(() => undefined);
  }, [enabled, overlayVisible, runtimeEffectsEnabled]);

  React.useEffect(() => {
    if (!runtimeEffectsEnabled || !enabled || !overlayVisible) return;
    // Keep the pet above browsers / borderless games. OS exclusive-fullscreen
    // can still cover all topmost HWNDs; reassert helps the common cases.
    const recovery = createSingleFlightRunner(async () => {
      // Occlusion sets visibilityState to hidden — that is exactly when the pet
      // must re-pin above YouTube / other apps. Native watchdog owns the loop.
      await reassertPetOverlayTopmost();
    });
    const recoverTopmost = () => {
      void recovery.run().catch(() => undefined);
    };
    recoverTopmost();
    // Immediate follow-up — Windows/WebView2 sometimes drops topmost right after show.
    const boot = window.setTimeout(recoverTopmost, 400);
    const interval = window.setInterval(recoverTopmost, 15_000);
    window.addEventListener('focus', recoverTopmost);
    window.addEventListener('pageshow', recoverTopmost);
    document.addEventListener('visibilitychange', recoverTopmost);
    return () => {
      recovery.stop();
      window.clearTimeout(boot);
      window.clearInterval(interval);
      window.removeEventListener('focus', recoverTopmost);
      window.removeEventListener('pageshow', recoverTopmost);
      document.removeEventListener('visibilitychange', recoverTopmost);
    };
  }, [enabled, overlayVisible, runtimeEffectsEnabled]);

  return (
    <div
      data-pet-window="pet-overlay"
      data-testid="pet-overlay-root"
      data-monochrome-surface="pet-overlay-window"
      className="pet-overlay-root"
      style={{
        width: viewport.shellSize,
        height: viewport.shellSize,
        background: 'transparent',
        backgroundColor: 'transparent',
        backgroundImage: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <PetOverlay
        enabled={shouldRenderPet}
        reducedMotion={runtimeEffectsEnabled ? reducedMotion : true}
        animationLevelOverride={runtimeEffectsEnabled ? undefined : 'off'}
        tauriWindowMode
        displaySize={viewport.displaySize}
        sleepTimeoutMs={sleepTimeoutMs}
        idleFunIntervalMs={idleFunIntervalMs}
        onRequestClose={() => {
          if (!runtimeEffectsEnabled) return;
          setOverlayVisible(false);
          setPetPanelOpenFlag(false);
          void getCurrentWindow()
            .hide()
            .catch(() => undefined);
        }}
        onOpenPanel={() => {
          if (!runtimeEffectsEnabled) return;
          // Shared Axo+Glitch path: single-flight open, confirm-then-hide overlay.
          // Does NOT hide overlay optimistically before confirm (avoids both-hidden).
          void openOrFocusPetMiniPanel(undefined, undefined, panelMode)
            .then(({ panelVisible }) => {
              if (!panelVisible) {
                // Bridge already restored overlay + cleared flag; keep fail-open.
                setPetPanelOpenFlag(false);
                void showPetOverlay().catch(() => undefined);
              }
            })
            .catch(() => {
              setPetPanelOpenFlag(false);
              void showPetOverlay().catch(() => undefined);
            });
        }}
      />
    </div>
  );
}
