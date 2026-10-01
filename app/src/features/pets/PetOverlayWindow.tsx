/**
 * Dedicated entry for Tauri window label `pet-overlay`.
 * Transparent, frameless surface — Pixi pet only.
 *
 * Click opens the real mini panel via openOrFocusPetMiniPanel (shared with Axo).
 * Does not alter Glitch animation/drag — only panel open wiring.
 */
import * as React from 'react';
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

export interface PetOverlayWindowProps {
  runtimeEffectsEnabled?: boolean;
}

export function PetOverlayWindow({ runtimeEffectsEnabled = true }: PetOverlayWindowProps = {}) {
  const reducedMotion = usePetSettingsStore((s) => s.reducedMotion);
  const sleepTimeoutMs = usePetSettingsStore((s) => s.sleepTimeoutMs);
  const idleFunIntervalMs = usePetSettingsStore((s) => s.idleFunIntervalMs);
  const panelMode = usePetSettingsStore((s) => s.panelMode) ?? 'normal';
  const theme = useUIStore((s) => s.theme);

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
      root.style.width = '144px';
      root.style.height = '144px';
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
  }, [runtimeEffectsEnabled]);

  React.useEffect(() => {
    if (!runtimeEffectsEnabled) return;
    // Keep the pet above browsers / borderless games. OS exclusive-fullscreen
    // can still cover all topmost HWNDs; reassert helps the common cases.
    const recoverTopmost = () => {
      if (document.visibilityState === 'hidden') return;
      void reassertPetOverlayTopmost().catch(() => undefined);
    };
    recoverTopmost();
    // Immediate follow-up — Windows/WebView2 sometimes drops topmost right after show.
    const boot = window.setTimeout(recoverTopmost, 400);
    const interval = window.setInterval(recoverTopmost, 12_000);
    window.addEventListener('focus', recoverTopmost);
    window.addEventListener('pageshow', recoverTopmost);
    document.addEventListener('visibilitychange', recoverTopmost);
    return () => {
      window.clearTimeout(boot);
      window.clearInterval(interval);
      window.removeEventListener('focus', recoverTopmost);
      window.removeEventListener('pageshow', recoverTopmost);
      document.removeEventListener('visibilitychange', recoverTopmost);
    };
  }, [runtimeEffectsEnabled]);

  return (
    <div
      data-pet-window="pet-overlay"
      data-testid="pet-overlay-root"
      data-monochrome-surface="pet-overlay-window"
      className="pet-overlay-root"
      style={{
        width: 144,
        height: 144,
        background: 'transparent',
        backgroundColor: 'transparent',
        backgroundImage: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <PetOverlay
        enabled
        reducedMotion={runtimeEffectsEnabled ? reducedMotion : true}
        animationLevelOverride={runtimeEffectsEnabled ? undefined : 'off'}
        tauriWindowMode
        sleepTimeoutMs={sleepTimeoutMs}
        idleFunIntervalMs={idleFunIntervalMs}
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
