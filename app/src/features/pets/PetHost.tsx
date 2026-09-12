/**
 * Main-window pet coordinator.
 *
 * Single visible pet path:
 * - Tauri: prefer dedicated pet-overlay; inline only as fallback.
 * - Keep the standalone pet visible while the mini panel is open.
 * - Poll isPetPanelVisible only to reconcile panel/fallback state.
 */
import * as React from 'react';
import { PetOverlay } from './PetOverlay';
import { PetMiniPanel } from './PetMiniPanel';
import {
  claimPetHostInstance,
  hidePetOverlay,
  isPetOverlayVisible,
  isPetPanelVisible,
  isTauriRuntime,
  openOrFocusPetMiniPanel,
  PET_OPEN_PANEL_EVENT,
  PET_PANEL_OPEN_FLAG_KEY,
  readPetPanelOpenFlag,
  releasePetHostInstance,
  setPetPanelOpenFlag,
  showPetOverlay,
} from './petTauriBridge';
import { installPetApplicationEventAdapters } from './petRuntimeEvents';
import { shouldShowStandalonePet } from './petPanelLifecycle';
import { installPetPresentationStorageSync } from './petPresentationStore';
import { installPetSettingsStorageSync, usePetSettingsStore } from './petSettingsStore';
import { getLivePixiApplicationCount } from './pixiAtlasPlayer';
import { installPetDevPerfGlobal } from './petDevPerf';

export interface PetHostProps {
  enabled?: boolean;
  reducedMotion?: boolean;
  runtimeEffectsEnabled?: boolean;
}

export function PetHost({
  enabled: enabledProp,
  reducedMotion: reducedMotionProp,
  runtimeEffectsEnabled = true,
}: PetHostProps) {
  const settingsEnabled = usePetSettingsStore((s) => s.enabled);
  const settingsReduced = usePetSettingsStore((s) => s.reducedMotion);
  const panelMode = usePetSettingsStore((s) => s.panelMode);
  const overlayVisible = usePetSettingsStore((s) => s.overlayVisible);
  const sleepTimeoutMs = usePetSettingsStore((s) => s.sleepTimeoutMs);
  const idleFunIntervalMs = usePetSettingsStore((s) => s.idleFunIntervalMs);
  const setOverlayVisible = usePetSettingsStore((s) => s.setOverlayVisible);

  const enabled = runtimeEffectsEnabled ? (enabledProp ?? settingsEnabled) : true;
  const reducedMotion = runtimeEffectsEnabled ? (reducedMotionProp ?? settingsReduced) : true;
  const effectiveOverlayVisible = runtimeEffectsEnabled ? overlayVisible : true;

  const [panelOpen, setPanelOpen] = React.useState(false);
  const [animLabel, setAnimLabel] = React.useState<string>('welcome');
  const [claimed, setClaimed] = React.useState(!runtimeEffectsEnabled);
  const [tauri, setTauri] = React.useState(false);
  /** Tracks panel state for diagnostics and inline fallback selection. */
  const [hideSpriteForPanel, setHideSpriteForPanel] = React.useState(false);
  const [useInlineFallback, setUseInlineFallback] = React.useState(false);
  /** App is exiting / hiding — never respawn pet-overlay. */
  const [shuttingDown, setShuttingDown] = React.useState(false);
  const shuttingDownRef = React.useRef(false);

  React.useEffect(() => {
    if (!runtimeEffectsEnabled) return;
    const a = installPetPresentationStorageSync();
    const b = installPetSettingsStorageSync();
    return () => {
      a();
      b();
    };
  }, [runtimeEffectsEnabled]);

  React.useEffect(() => {
    if (!runtimeEffectsEnabled || !claimed) return;
    return installPetApplicationEventAdapters();
  }, [claimed, runtimeEffectsEnabled]);

  React.useEffect(() => {
    if (!runtimeEffectsEnabled) return;
    if (!claimPetHostInstance()) {
      console.warn('[pets] duplicate PetHost prevented');
      return;
    }
    setClaimed(true);
    setTauri(isTauriRuntime());
    const uninstallPerf = installPetDevPerfGlobal(() => getLivePixiApplicationCount());
    return () => {
      uninstallPerf();
      releasePetHostInstance();
    };
  }, [runtimeEffectsEnabled]);

  // Cross-window panel flag (pet-overlay → main) + Tauri poll.
  React.useEffect(() => {
    if (!runtimeEffectsEnabled || !claimed) return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== PET_PANEL_OPEN_FLAG_KEY) return;
      const open = e.newValue === '1';
      setHideSpriteForPanel(open);
      setPanelOpen(open);
      // Overlay-window click may set the flag before Tauri panel is confirmed.
      // Prefer showing in-app panel until pet-mini-panel is proven visible.
      if (open) setUseInlineFallback(true);
    };
    window.addEventListener('storage', onStorage);
    // Seed from flag
    if (readPetPanelOpenFlag()) {
      setHideSpriteForPanel(true);
      setPanelOpen(true);
      setUseInlineFallback(true);
    }
    return () => window.removeEventListener('storage', onStorage);
  }, [claimed, runtimeEffectsEnabled]);

  // Poll Tauri panel visibility to reconcile the native and inline panel paths.
  React.useEffect(() => {
    if (!runtimeEffectsEnabled || !claimed || !tauri) return;
    let cancelled = false;
    const tick = async () => {
      const panelVis = await isPetPanelVisible();
      if (cancelled) return;
      if (panelVis) {
        setHideSpriteForPanel(true);
        setPanelOpen(true);
        setPetPanelOpenFlag(true);
        // Real Tauri mini panel is up — drop in-app duplicate if it was a bridge.
        setUseInlineFallback(false);
      } else if (readPetPanelOpenFlag()) {
        // Flag says open but Tauri panel is not visible → keep/show in-app panel.
        setPanelOpen(true);
        setHideSpriteForPanel(true);
        setUseInlineFallback(true);
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 400);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [claimed, runtimeEffectsEnabled, tauri]);

  // Shutdown: never briefly respawn the pet while the app is hiding/exiting.
  React.useEffect(() => {
    if (!runtimeEffectsEnabled || !claimed) return;
    const markShutdown = () => {
      shuttingDownRef.current = true;
      setShuttingDown(true);
      setPetPanelOpenFlag(false);
      void hidePetOverlay().catch(() => undefined);
    };
    const onPageHide = () => markShutdown();
    const onBeforeUnload = () => markShutdown();
    const onPersist = () => markShutdown();
    const onBeforeHide = () => markShutdown();
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('jarvis:persist-now', onPersist);
    window.addEventListener('jarvis:before-hide', onBeforeHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('jarvis:persist-now', onPersist);
      window.removeEventListener('jarvis:before-hide', onBeforeHide);
    };
  }, [claimed, runtimeEffectsEnabled]);

  // Drive Tauri pet-overlay visibility.
  React.useEffect(() => {
    if (!runtimeEffectsEnabled || !claimed || !tauri) return;
    let cancelled = false;

    const sync = async () => {
      if (shuttingDownRef.current) {
        await hidePetOverlay().catch(() => undefined);
        return;
      }
      const panelVis = await isPetPanelVisible().catch(() => false);
      const flagOpen = readPetPanelOpenFlag();
      // Single authoritative rule shared with unit tests (Axo + Glitch).
      const wantVisible = shouldShowStandalonePet({
        enabled,
        overlayVisible,
        panelOpenFlag: flagOpen || hideSpriteForPanel,
        panelVisible: panelVis,
        shuttingDown: shuttingDownRef.current,
      });
      if (!wantVisible) {
        await hidePetOverlay().catch(() => undefined);
        if (!cancelled && (!enabled || !overlayVisible)) {
          setUseInlineFallback(false);
        }
        return;
      }
      await showPetOverlay().catch((err) => console.warn('[pets] show overlay', err));
      await new Promise((r) => setTimeout(r, 280));
      if (cancelled || shuttingDownRef.current) return;
      const visible = await isPetOverlayVisible();
      setUseInlineFallback(!visible);
    };

    void sync();
    return () => {
      cancelled = true;
    };
  }, [
    claimed,
    enabled,
    hideSpriteForPanel,
    overlayVisible,
    runtimeEffectsEnabled,
    shuttingDown,
    tauri,
  ]);

  React.useEffect(() => {
    if (!runtimeEffectsEnabled) return;
    if (enabled && !overlayVisible) {
      setOverlayVisible(true);
    }
  }, [enabled, overlayVisible, runtimeEffectsEnabled, setOverlayVisible]);

  const closePanel = React.useCallback(() => {
    setPanelOpen(false);
    setHideSpriteForPanel(false);
    setPetPanelOpenFlag(false);
    void showPetOverlay().catch(() => undefined);
  }, []);

  const hidePet = React.useCallback(() => {
    setOverlayVisible(false);
    setPanelOpen(false);
    setHideSpriteForPanel(false);
    setPetPanelOpenFlag(false);
  }, [setOverlayVisible]);

  const openPanelBusyRef = React.useRef(false);

  const openPanel = React.useCallback(async () => {
    if (!runtimeEffectsEnabled) return;
    if (openPanelBusyRef.current) return;
    openPanelBusyRef.current = true;
    try {
      setPanelOpen(true);
      setHideSpriteForPanel(true);
      setPetPanelOpenFlag(true);
      if (tauri) {
        const result = await openOrFocusPetMiniPanel(undefined, undefined, panelMode).catch(
          (err) => {
            console.warn('[pets] open panel', err);
            return {
              panelVisible: false,
              useInlineFallback: true,
              coalesced: false,
            };
          },
        );
        if (result.panelVisible) {
          // Dedicated Tauri mini panel confirmed; keep the pet visible.
          setHideSpriteForPanel(true);
          setUseInlineFallback(false);
        } else {
          // CRITICAL: if pet-mini-panel did not show, mount in-app PetMiniPanel.
          // Previously hideSpriteForPanel stayed true with no UI → "click does nothing".
          setUseInlineFallback(true);
          setHideSpriteForPanel(true);
          setPanelOpen(true);
          setPetPanelOpenFlag(true);
        }
      } else {
        setUseInlineFallback(true);
      }
    } finally {
      openPanelBusyRef.current = false;
    }
  }, [panelMode, runtimeEffectsEnabled, tauri]);

  React.useEffect(() => {
    if (!runtimeEffectsEnabled) return;
    const onOpen = () => {
      if (!usePetSettingsStore.getState().enabled) {
        usePetSettingsStore.getState().setEnabled(true);
      }
      usePetSettingsStore.getState().setOverlayVisible(true);
      void openPanel();
    };
    const onShow = () => {
      if (!usePetSettingsStore.getState().enabled) {
        usePetSettingsStore.getState().setEnabled(true);
      }
      usePetSettingsStore.getState().setOverlayVisible(true);
      setPanelOpen(false);
      setHideSpriteForPanel(false);
      setPetPanelOpenFlag(false);
      void showPetOverlay().catch(() => undefined);
    };
    const onClosePanel = () => closePanel();
    window.addEventListener(PET_OPEN_PANEL_EVENT, onOpen);
    window.addEventListener('jarvis:pet:show', onShow);
    window.addEventListener('jarvis:pet:close-panel', onClosePanel);
    return () => {
      window.removeEventListener(PET_OPEN_PANEL_EVENT, onOpen);
      window.removeEventListener('jarvis:pet:show', onShow);
      window.removeEventListener('jarvis:pet:close-panel', onClosePanel);
    };
  }, [closePanel, openPanel, runtimeEffectsEnabled]);

  if (!claimed || !enabled || !effectiveOverlayVisible || shuttingDown) return null;

  const showStandalone = shouldShowStandalonePet({
    enabled: true,
    overlayVisible: true,
    panelOpenFlag: hideSpriteForPanel || panelOpen,
    panelVisible: false,
    shuttingDown,
  });
  const showInlineSprite = showStandalone && (!tauri || useInlineFallback);

  return (
    <div
      data-monochrome-surface="pet-host"
      className={
        runtimeEffectsEnabled
          ? 'contents [html[data-theme=monochrome]_&_*]:shadow-none'
          : 'pointer-events-none fixed inset-0 [html[data-theme=monochrome]_&_*]:shadow-none'
      }
    >
      <div
        data-pet-host={tauri ? 'tauri' : 'browser'}
        data-pet-instance="1"
        data-pet-panel-open={panelOpen || hideSpriteForPanel ? 'true' : 'false'}
        data-pet-inline-fallback={useInlineFallback ? 'true' : 'false'}
        data-pet-hide-for-panel={hideSpriteForPanel ? 'true' : 'false'}
        data-pet-renderer-bg-alpha="0"
        hidden
        aria-hidden
      />
      {showInlineSprite && (
        <PetOverlay
          enabled
          reducedMotion={reducedMotion}
          panelOpen={panelOpen}
          onOpenPanel={() => {
            void openPanel();
          }}
          onPanelClose={closePanel}
          onAnimChange={setAnimLabel}
          onRequestClose={hidePet}
          tauriWindowMode={false}
          sleepTimeoutMs={sleepTimeoutMs}
          idleFunIntervalMs={idleFunIntervalMs}
        />
      )}
      {/* Browser / inline fallback: in-app mini panel. Tauri primary path uses pet-mini-panel window. */}
      {(!tauri || useInlineFallback) && (
        <PetMiniPanel
          open={panelOpen}
          onClose={closePanel}
          onMinimize={closePanel}
          animLabel={animLabel}
          resizable
        />
      )}
    </div>
  );
}
