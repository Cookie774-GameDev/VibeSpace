/**
 * Main-window pet coordinator.
 *
 * Single visible pet path:
 * - Tauri: prefer dedicated pet-overlay; inline only as fallback.
 * - Hide the standalone pet while the mini panel is open; restore on close/minimize.
 * - Poll isPetPanelVisible only to reconcile panel/fallback state.
 */
import * as React from 'react';
import { PetOverlay } from './PetOverlay';
import { PetMiniPanel } from './PetMiniPanel';
import {
  claimPetHostInstance,
  hidePetOverlay,
  hidePetPanel,
  isPetOverlayVisible,
  isPetPanelVisible,
  isTauriRuntime,
  openOrFocusPetMiniPanel,
  PET_OPEN_PANEL_EVENT,
  PET_PANEL_OPEN_FLAG_KEY,
  readPetPanelOpenFlag,
  reassertPetOverlayTopmost,
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
import { createSingleFlightRunner } from '@/stability/singleFlight';
import { installPetVoiceHost } from './petVoiceBridge';

// WebView2 can reject the first detached-window show while its host is still
// attaching. Retrying a few times recovers that startup race without turning
// the Pet into an app-only substitute.
const PET_OVERLAY_SHOW_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;
const PET_OVERLAY_HEALTH_INTERVAL_MS = 5_000;

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
  const [tauri, setTauri] = React.useState(() => isTauriRuntime());
  /** Tracks panel state for diagnostics and inline fallback selection. */
  const [hideSpriteForPanel, setHideSpriteForPanel] = React.useState(false);
  const [useInlineFallback, setUseInlineFallback] = React.useState(false);
  /** App is exiting / hiding — never respawn pet-overlay. */
  const [shuttingDown, setShuttingDown] = React.useState(false);
  const shuttingDownRef = React.useRef(false);

  React.useEffect(() => {
    if (runtimeEffectsEnabled && tauri && claimed) return installPetVoiceHost();
  }, [runtimeEffectsEnabled, tauri, claimed]);

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
      // Browser mode deliberately owns the inline panel. In Tauri, a panel
      // request stays native-only until its dedicated window acknowledges it.
      if (open) setUseInlineFallback(!tauri);
    };
    window.addEventListener('storage', onStorage);
    // Seed from flag
    if (readPetPanelOpenFlag()) {
      setHideSpriteForPanel(true);
      setPanelOpen(true);
      setUseInlineFallback(!tauri);
    }
    return () => window.removeEventListener('storage', onStorage);
  }, [claimed, runtimeEffectsEnabled, tauri]);

  // Poll Tauri panel visibility to reconcile the native and inline panel paths.
  React.useEffect(() => {
    if (!runtimeEffectsEnabled || !claimed || !tauri || !enabled) return;
    let cancelled = false;
    const poll = createSingleFlightRunner(async () => {
      const panelVis = await isPetPanelVisible();
      if (cancelled) return;
      if (panelVis) {
        setHideSpriteForPanel(true);
        setPanelOpen(true);
        setPetPanelOpenFlag(true);
        // Real Tauri mini panel is up — drop in-app duplicate if it was a bridge.
        setUseInlineFallback(false);
      } else if (readPetPanelOpenFlag()) {
        // A stale cross-window flag must never turn a failed native panel into
        // an inline Tauri widget. Clear it so the detached overlay can recover.
        setPetPanelOpenFlag(false);
        setPanelOpen(false);
        setHideSpriteForPanel(false);
        setUseInlineFallback(false);
      }
    });
    const tick = () => void poll.run().catch(() => undefined);
    tick();
    const id = window.setInterval(tick, 400);
    return () => {
      cancelled = true;
      poll.stop();
      window.clearInterval(id);
    };
  }, [claimed, enabled, runtimeEffectsEnabled, tauri]);

  // Renderer teardown only: tray hides and persistence checkpoints must leave the
  // detached desktop Pet alive while VibeSpace is out of the way.
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
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [claimed, runtimeEffectsEnabled]);

  // Drive Tauri pet-overlay visibility.
  React.useEffect(() => {
    if (!runtimeEffectsEnabled || !claimed || !tauri) return;
    let cancelled = false;
    let retryAttempt = 0;
    let retryTimer: number | undefined;

    const scheduleRetry = () => {
      const delay = PET_OVERLAY_SHOW_RETRY_DELAYS_MS[retryAttempt];
      if (cancelled || delay === undefined) return;
      retryAttempt += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        void sync();
      }, delay);
    };

    const sync = async () => {
      if (shuttingDownRef.current) {
        await hidePetOverlay().catch(() => undefined);
        return;
      }
      // A persisted disabled Pet owns neither detached surface. The detached
      // panel observes the shared settings store and hides its own window;
      // calling pet_hide_panel here would restore the overlay before hiding it.
      if (!enabled) {
        setPetPanelOpenFlag(false);
        setPanelOpen(false);
        setHideSpriteForPanel(false);
        setUseInlineFallback(false);
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
      const result = await showPetOverlay().catch(() => null);
      if (cancelled || shuttingDownRef.current) return;
      if (!result?.visible) {
        scheduleRetry();
        return;
      }
      // Tauri remains a detached-overlay surface. A native show failure is
      // represented by its typed bridge result, never by an inline substitute.
      setUseInlineFallback(false);
    };

    void sync();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
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

  // Startup retries intentionally stop, but an enabled desktop companion must
  // not remain missing for the rest of the session after a late WebView/native
  // recovery. This low-frequency supervisor verifies the real detached window,
  // restores it when absent, and reasserts topmost only after visibility truth.
  React.useEffect(() => {
    if (!runtimeEffectsEnabled || !claimed || !tauri || !enabled || !overlayVisible) return;
    let cancelled = false;
    let busy = false;
    const supervise = async () => {
      if (
        cancelled ||
        busy ||
        shuttingDownRef.current ||
        hideSpriteForPanel ||
        readPetPanelOpenFlag()
      ) {
        return;
      }
      busy = true;
      try {
        const alreadyVisible = await isPetOverlayVisible().catch(() => false);
        if (cancelled) return;
        const result = alreadyVisible ? null : await showPetOverlay().catch(() => null);
        if (cancelled || (!alreadyVisible && !result?.visible)) return;
        await reassertPetOverlayTopmost().catch(() => undefined);
      } finally {
        busy = false;
      }
    };
    const id = window.setInterval(() => void supervise(), PET_OVERLAY_HEALTH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [claimed, enabled, hideSpriteForPanel, overlayVisible, runtimeEffectsEnabled, tauri]);

  const closePanel = React.useCallback(() => {
    setPanelOpen(false);
    setHideSpriteForPanel(false);
    setUseInlineFallback(false);
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
      if (tauri) {
        const result = await openOrFocusPetMiniPanel(undefined, undefined, panelMode).catch(() => {
          return {
            panelVisible: false,
            useInlineFallback: false,
            overlayVisible: false,
            reason: 'native_command_failed' as const,
            coalesced: false,
          };
        });
        if (result.panelVisible) {
          // Dedicated Tauri mini panel confirmed; hide the floating pet.
          setPanelOpen(true);
          setHideSpriteForPanel(true);
          setUseInlineFallback(false);
        } else {
          // The bridge keeps/restores the native overlay. Do not silently
          // replace it with an inline Pet Panel in Tauri.
          setUseInlineFallback(false);
          setHideSpriteForPanel(false);
          setPanelOpen(false);
          setPetPanelOpenFlag(false);
        }
      } else {
        setPanelOpen(true);
        setHideSpriteForPanel(true);
        setPetPanelOpenFlag(true);
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
      void (async () => {
        if (tauri) await hidePetPanel().catch(() => undefined);
        setPanelOpen(false);
        setHideSpriteForPanel(false);
        setUseInlineFallback(false);
        setPetPanelOpenFlag(false);
        await showPetOverlay().catch(() => undefined);
      })();
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
  }, [closePanel, openPanel, runtimeEffectsEnabled, tauri]);

  if (!claimed || !enabled || !effectiveOverlayVisible || shuttingDown) return null;

  const showStandalone = shouldShowStandalonePet({
    enabled: true,
    overlayVisible: true,
    panelOpenFlag: hideSpriteForPanel || panelOpen,
    panelVisible: false,
    shuttingDown,
  });
  const showInlineSprite = showStandalone && !tauri;

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
      {/* Browser-only: Tauri primary and failure paths use native windows. */}
      {!tauri && useInlineFallback && (
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
