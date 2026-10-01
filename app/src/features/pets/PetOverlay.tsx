/**
 * Floating Pet interaction surface — PixiJS atlas playback + velocity drag.
 * Used inside the pet-overlay Tauri window or as in-app fallback.
 * Does not decode MP4. Click opens/focuses mini-panel (including wake-from-sleep).
 */
import * as React from 'react';
import { PixiAtlasPlayer } from './pixiAtlasPlayer';
import {
  canEnterSleep,
  canScheduleIdleFun,
  createInitialPetState,
  reducePetEvent,
  type PetAnimId,
  type PetMachineState,
} from './petStateMachine';
import { createPetScheduler } from './petScheduler';
import {
  createDragVelocityState,
  dragWalkFpsFromVelocity,
  sampleDragVelocity,
  sampleStationaryDragVelocity,
  type DragVelocityState,
} from './petDragVelocity';
import { disposeAll, mapReducedMotionAnim, petPlaybackFps } from './petLifecycle';
import {
  clampPetPosition,
  getAnimDef,
  getPetAnimationsManifest,
  resolveAtlasUrls,
} from './petManifest';
import { PET_CHARACTERS, resolvePetCharacterId } from './petCharacters';
import {
  beginPetPointerGesture,
  samplePetPointerGesture,
  shouldOpenPanelFromGesture,
  type PetPointerGesture,
} from './petClickGesture';
import {
  notifyPetPanelOpenRequested,
  openOrFocusPetMiniPanel,
  PET_OVERLAY_SHOW_EPOCH_KEY,
  PET_OVERLAY_SHOW_EVENT,
  PET_PANEL_OPEN_FLAG_KEY,
  setPetOverlayPosition,
  snapPetOverlayToEdge,
} from './petTauriBridge';
import { petPerfRecordDragUpdate, petPerfRecordStateTransition } from './petDevPerf';
import { buildPetRuntimeDiagnostics, installPetRuntimeDiagGlobal } from './petRuntimeDiagnostics';
import {
  PET_FORCE_ANIM_EVENT,
  type PetAnimationLevel,
  type PetForceAnimDetail,
  usePetSettingsStore,
} from './petSettingsStore';
import { resolvePetMotionPolicy } from './petMotionPolicy';
import {
  petReactionForEvent,
  shouldAcceptPetReaction,
  subscribePetRuntimeEvents,
  type PetReactionDescriptor,
  type PetReactionId,
} from './petRuntimeEvents';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/ui';
import { installPetContextMenuDismissal } from './petContextMenuDismissal';

const DISPLAY = 128;
const DEBUG_ANIMS: PetAnimId[] = [
  'welcome',
  'idlePrimary',
  'idleFun',
  'walkLeft',
  'walkRight',
  'sleepTransition',
  'sleepingLoop',
  'wakeFromSleep',
];

export interface PetOverlayProps {
  enabled?: boolean;
  reducedMotion?: boolean;
  animationLevelOverride?: PetAnimationLevel;
  className?: string;
  panelOpen?: boolean;
  onOpenPanel?: () => void;
  onPanelClose?: () => void;
  onRequestClose?: () => void;
  onAnimChange?: (anim: string) => void;
  tauriWindowMode?: boolean;
  sleepTimeoutMs?: number;
  idleFunIntervalMs?: number;
  positionLocked?: boolean;
  edgeSnapping?: boolean;
}

export function PetOverlay({
  enabled = true,
  reducedMotion: reducedMotionProp = false,
  animationLevelOverride,
  className,
  panelOpen = false,
  onOpenPanel,
  onPanelClose: _onPanelClose,
  onRequestClose,
  onAnimChange,
  tauriWindowMode = false,
  sleepTimeoutMs,
  idleFunIntervalMs,
  positionLocked: positionLockedProp,
  edgeSnapping: edgeSnappingProp,
}: PetOverlayProps) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const contextMenuRef = React.useRef<HTMLDivElement>(null);
  const playerRef = React.useRef(new PixiAtlasPlayer());
  const stateRef = React.useRef<PetMachineState>(createInitialPetState());
  const characterId = usePetSettingsStore((s) => s.characterId);
  const settingsPositionLocked = usePetSettingsStore((s) => s.positionLocked);
  const setPositionLocked = usePetSettingsStore((s) => s.setPositionLocked);
  const panelMode = usePetSettingsStore((s) => s.panelMode) ?? 'normal';
  const settingsEdgeSnapping = usePetSettingsStore((s) => s.edgeSnapping);
  const settingsAnimationLevel = usePetSettingsStore((s) => s.animationLevel) ?? 'calm';
  const animationLevel = animationLevelOverride ?? settingsAnimationLevel;
  const settingsIdleFunIntervalMs = usePetSettingsStore((s) => s.idleFunIntervalMs);
  const notificationReactions = usePetSettingsStore((s) => s.notificationReactions) ?? true;
  const pointerTracking = usePetSettingsStore((s) => s.pointerTracking) ?? true;
  const positionLocked = positionLockedProp ?? settingsPositionLocked ?? false;
  const edgeSnapping = edgeSnappingProp ?? settingsEdgeSnapping ?? true;
  const characterIdRef = React.useRef(characterId);
  characterIdRef.current = characterId;

  const [animLabel, setAnimLabel] = React.useState<PetAnimId>('welcome');
  const [renderReady, setRenderReady] = React.useState(false);
  const [systemReducedMotion, setSystemReducedMotion] = React.useState(false);
  const [runtimeReaction, setRuntimeReaction] = React.useState<PetReactionId>('idle');
  const [pos, setPos] = React.useState({ left: 24, top: 120 });
  const dragRef = React.useRef<{
    active: boolean;
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
    vel: DragVelocityState;
    windowOriginX: number;
    windowOriginY: number;
    gesture: PetPointerGesture;
    canMove: boolean;
  } | null>(null);
  /** Prevents double open from setState(panelOpen) + explicit openPanelNow. */
  const openingPanelRef = React.useRef(false);
  const animCache = React.useRef(new Map<string, { jsonUrl: string; imageUrl: string }>());
  const currentAnim = React.useRef<string | null>(null);
  const schedulerRef = React.useRef<ReturnType<typeof createPetScheduler> | null>(null);
  const initOnce = React.useRef(false);
  const lifecycleGenerationRef = React.useRef(0);
  const animationRequestRef = React.useRef(0);
  const welcomeReplayTimerRef = React.useRef(0);
  const reactionTimerRef = React.useRef(0);
  const reactionRef = React.useRef<PetReactionDescriptor | null>(null);
  const reactionExpiresAtRef = React.useRef(0);
  const reactionBaseAnimRef = React.useRef<PetAnimId>('idlePrimary');
  const onOpenPanelRef = React.useRef(onOpenPanel);
  onOpenPanelRef.current = onOpenPanel;
  const onAnimChangeRef = React.useRef(onAnimChange);
  onAnimChangeRef.current = onAnimChange;

  const man = React.useMemo(() => getPetAnimationsManifest(characterId), [characterId]);
  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setSystemReducedMotion(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  const motionPolicy = React.useMemo(
    () =>
      resolvePetMotionPolicy({
        level: animationLevel,
        userReducedMotion: reducedMotionProp,
        systemReducedMotion,
        idleFunIntervalMs:
          idleFunIntervalMs ?? settingsIdleFunIntervalMs ?? man.scheduler.idleFunIntervalMs,
      }),
    [
      animationLevel,
      idleFunIntervalMs,
      man.scheduler.idleFunIntervalMs,
      reducedMotionProp,
      settingsIdleFunIntervalMs,
      systemReducedMotion,
    ],
  );
  const reducedMotion = motionPolicy.reducedMotion;
  const staticPreview = PET_CHARACTERS[resolvePetCharacterId(characterId)].preview;
  const showDiagnostics = usePetSettingsStore((s) => s.showDiagnostics);
  const setCharacterId = usePetSettingsStore((s) => s.setCharacterId);
  const debugMode =
    import.meta.env.DEV &&
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('petDebug') === '1';
  const [debugTick, setDebugTick] = React.useState(0);

  React.useEffect(() => {
    if (!debugMode) return;
    const timer = window.setInterval(() => setDebugTick((value) => value + 1), 100);
    return () => window.clearInterval(timer);
  }, [debugMode]);

  // DEV-only full chain diagnostics (no production spam).
  React.useEffect(() => {
    if (!enabled) return;
    return installPetRuntimeDiagGlobal(() =>
      buildPetRuntimeDiagnostics({
        characterId: characterIdRef.current,
        anim: stateRef.current.anim,
        reducedMotion,
        panelOpen: panelOpen || stateRef.current.panelOpen,
        player: playerRef.current,
      }),
    );
  }, [enabled, reducedMotion, panelOpen]);

  /** Stable state applicator — must not thrash boot effects. */
  const setState = React.useCallback((next: PetMachineState) => {
    const prevAnim = stateRef.current.anim;
    stateRef.current = next;
    if (next.anim !== prevAnim) {
      petPerfRecordStateTransition();
      setAnimLabel(next.anim);
      onAnimChangeRef.current?.(next.anim);
    }
    // Panel open is driven exclusively by openPanelNow / openOrFocusPetMiniPanel
    // so we never double-fire on click (was: setState panelOpen + openPanelNow).
  }, []);

  React.useEffect(() => {
    if (!panelOpen && stateRef.current.panelOpen) {
      setState(reducePetEvent(stateRef.current, { type: 'panel_close' }));
    }
  }, [panelOpen, setState]);

  const playAnim = React.useCallback(
    async (id: PetAnimId) => {
      const lifecycleGeneration = lifecycleGenerationRef.current;
      const requestGeneration = ++animationRequestRef.current;
      const charId = characterIdRef.current;
      const resolved = reducedMotion ? mapReducedMotionAnim(id) : id;
      const animKey = `${charId}:${resolved}`;
      const def = getAnimDef(resolved, charId);
      if (!def) {
        console.warn('[pets] missing anim def', resolved, charId);
        return;
      }

      const player = playerRef.current;
      const host = hostRef.current;
      if (!host) return;

      const isCurrentRequest = () =>
        lifecycleGenerationRef.current === lifecycleGeneration &&
        animationRequestRef.current === requestGeneration &&
        playerRef.current === player &&
        !player.isDestroyed;

      if (!initOnce.current) {
        await player.init(host, {
          displaySize: DISPLAY,
          resolution: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
          backgroundAlpha: 0,
        });
        if (!isCurrentRequest()) return;
        initOnce.current = true;
      }

      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      const scaleSel = PixiAtlasPlayer.selectAtlasScale(def, dpr);
      // characterId + anim + scale path — never share Axo/Glitch cache entries.
      const cacheKey = `${charId}:${resolved}:${scaleSel.atlasPath}`;
      let urls = animCache.current.get(cacheKey);
      if (!urls) {
        urls = resolveAtlasUrls(def, charId, scaleSel.atlasPath);
        animCache.current.set(cacheKey, urls);
      }

      const playbackKey = `${charId}:${resolved}:${scaleSel.scale}:${urls.jsonUrl}:${urls.imageUrl}:v1`;
      if (currentAnim.current === animKey && player.isPlaybackReady(playbackKey, urls.jsonUrl)) {
        const fps = petPlaybackFps(resolved, def.fps, reducedMotion);
        player.setPlaybackFps(fps);
        if (motionPolicy.animationsEnabled) player.resume();
        else player.pause();
        setRenderReady(true);
        return;
      }

      try {
        // load() keeps previous texture until new atlas is ready (no blink).
        await player.load(urls.jsonUrl, urls.imageUrl);
        if (!isCurrentRequest()) return;
        // Stale request guard: character or desired anim may have changed mid-load.
        if (characterIdRef.current !== charId) return;

        currentAnim.current = animKey;
        const fps = petPlaybackFps(resolved, def.fps, reducedMotion);
        player.setAnimation(
          {
            frames: def.frames,
            fps,
            loop: def.loop,
            oneShot: def.oneShot,
            playbackKey,
          },
          () => {
            const s = stateRef.current;
            if (resolved === 'welcome' || id === 'welcome') {
              setState(reducePetEvent(s, { type: 'welcome_done' }));
            } else if (resolved === 'idleFun' || id === 'idleFun') {
              setState(reducePetEvent(s, { type: 'idle_fun_done' }));
            } else if (resolved === 'sleepTransition' || id === 'sleepTransition') {
              setState(reducePetEvent(s, { type: 'sleep_transition_done' }));
            } else if (resolved === 'wakeFromSleep' || id === 'wakeFromSleep') {
              setState(reducePetEvent(s, { type: 'wake_done' }));
            }
          },
        );
        if (!motionPolicy.animationsEnabled) player.pause();
        setRenderReady(true);
      } catch (err) {
        console.warn('[pets] pixi atlas load failed', resolved, charId, err);
        currentAnim.current = null;
      }
    },
    [motionPolicy.animationsEnabled, reducedMotion, setState],
  );

  const playAnimRef = React.useRef(playAnim);
  playAnimRef.current = playAnim;

  React.useEffect(() => {
    setRenderReady(false);
  }, [characterId, motionPolicy.animationsEnabled]);

  React.useEffect(() => {
    if (motionPolicy.animationsEnabled) playerRef.current.resume();
    else playerRef.current.pause();
  }, [motionPolicy.animationsEnabled]);

  // The Pixi Application belongs to the mounted overlay, not to a character.
  // Axo ↔ Glitch swaps atlases on this same player/canvas/ticker.
  React.useEffect(() => {
    if (!enabled) return;
    return () => {
      lifecycleGenerationRef.current += 1;
      animationRequestRef.current += 1;
      disposeAll([playerRef.current]);
      currentAnim.current = null;
      initOnce.current = false;
      playerRef.current = new PixiAtlasPlayer();
    };
  }, [enabled]);

  /**
   * Recover when the sprite vanishes but the window/drag surface remains.
   * Typical cause: WebGL context loss or a stopped ticker after long idle /
   * GPU pressure. Soft-recover first; hard re-init + reload current anim
   * when the canvas is unhealthy.
   */
  React.useEffect(() => {
    if (!enabled || !motionPolicy.animationsEnabled) return;

    let recovering = false;
    const hardRecover = () => {
      if (recovering) return;
      recovering = true;
      try {
        lifecycleGenerationRef.current += 1;
        animationRequestRef.current += 1;
        disposeAll([playerRef.current]);
        currentAnim.current = null;
        initOnce.current = false;
        playerRef.current = new PixiAtlasPlayer();
        const anim = stateRef.current.anim;
        void playAnimRef.current(anim).finally(() => {
          recovering = false;
        });
      } catch {
        recovering = false;
      }
    };

    const softOrHardRecover = () => {
      if (document.visibilityState === 'hidden') return;
      const player = playerRef.current as PixiAtlasPlayer & {
        ensureAliveRendering?: () => boolean;
        isDestroyed?: boolean;
      };
      if (player.isDestroyed) {
        hardRecover();
        return;
      }
      if (typeof player.ensureAliveRendering === 'function' && player.ensureAliveRendering()) {
        return;
      }
      // Missing soft-recovery API (tests) or unhealthy canvas → hard re-init.
      if (typeof player.ensureAliveRendering === 'function') {
        hardRecover();
      }
    };

    const player = playerRef.current as PixiAtlasPlayer & {
      setContextLostHandler?: (handler: (() => void) | null) => void;
      ensureAliveRendering?: () => boolean;
      isContextUnhealthy?: () => boolean;
    };
    player.setContextLostHandler?.(() => {
      // Defer so contextrestored can finish before we tear down.
      window.setTimeout(softOrHardRecover, 0);
    });

    const onVisibility = () => {
      if (document.visibilityState === 'visible') softOrHardRecover();
    };
    const onPageShow = () => softOrHardRecover();
    // Bounded health poll — cheap when healthy; recovers a blank but draggable pet.
    const interval = window.setInterval(softOrHardRecover, 12_000);

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      playerRef.current.setContextLostHandler?.(null);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      window.clearInterval(interval);
    };
  }, [enabled, motionPolicy.animationsEnabled]);

  /**
   * Boot / character mount — runs once per enabled+characterId.
   * Must NOT depend on playAnim identity or panelOpen (that re-fired welcome forever).
   */
  React.useEffect(() => {
    if (!enabled) return;

    lifecycleGenerationRef.current += 1;
    animationRequestRef.current += 1;

    animCache.current.clear();
    currentAnim.current = null;
    initOnce.current = false;
    setRenderReady(false);

    const s0 = reducePetEvent(createInitialPetState(), { type: 'boot' });
    stateRef.current = s0;
    setAnimLabel(s0.anim);
    onAnimChangeRef.current?.(s0.anim);

    const sched = createPetScheduler({
      idleFunIntervalMs: motionPolicy.idleFunIntervalMs,
      sleepTimeoutMs: sleepTimeoutMs ?? man.scheduler.sleepTimeoutMs,
    });
    schedulerRef.current = sched;

    return () => {
      lifecycleGenerationRef.current += 1;
      animationRequestRef.current += 1;
      disposeAll([sched]);
      schedulerRef.current = null;
      currentAnim.current = null;
    };
    // characterId intentionally included: skin change = one clean remount + welcome once.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- playAnim via ref
  }, [
    enabled,
    characterId,
    motionPolicy.idleFunIntervalMs,
    sleepTimeoutMs,
    man.scheduler.idleFunIntervalMs,
    man.scheduler.sleepTimeoutMs,
  ]);

  const forceAnimation = React.useCallback(
    (anim: PetAnimId) => {
      if (anim === 'sleepTransition') {
        setState({
          ...stateRef.current,
          anim: 'sleepTransition',
          dragging: false,
          sleeping: false,
          panelOpen: false,
        });
      } else if (anim === 'wakeFromSleep') {
        setState({
          ...stateRef.current,
          anim: 'wakeFromSleep',
          dragging: false,
          sleeping: false,
          panelOpen: false,
        });
      } else if (anim === 'idleFun') {
        setState(
          reducePetEvent({ ...stateRef.current, anim: 'idlePrimary' }, { type: 'idle_fun_tick' }),
        );
      } else if (anim === 'walkLeft' || anim === 'walkRight') {
        setState({
          ...stateRef.current,
          dragging: true,
          anim,
          lastWalk: anim,
          sleeping: false,
        });
      } else if (anim === 'welcome') {
        const wasWelcome = stateRef.current.anim === 'welcome';
        currentAnim.current = null;
        setState({ ...createInitialPetState(), welcomePlayed: false, anim: 'welcome' });
        if (wasWelcome) {
          void playAnimRef.current('welcome');
        }
      } else {
        setState({ ...stateRef.current, anim, sleeping: anim === 'sleepingLoop' });
      }
    },
    [setState],
  );

  // A hidden Tauri WebView stays mounted. The main/panel windows signal show,
  // close, and minimize through shared-origin storage. Debounce the paired
  // close+show signals so one clean welcome starts after the native window is
  // visible, while retaining the shared player/canvas.
  React.useEffect(() => {
    if (!enabled || !tauriWindowMode) return;
    const scheduleWelcome = () => {
      if (welcomeReplayTimerRef.current) {
        window.clearTimeout(welcomeReplayTimerRef.current);
      }
      welcomeReplayTimerRef.current = window.setTimeout(() => {
        welcomeReplayTimerRef.current = 0;
        forceAnimation('welcome');
      }, 160);
    };
    const onStorage = (event: StorageEvent) => {
      const overlayShown =
        event.key === PET_OVERLAY_SHOW_EPOCH_KEY && typeof event.newValue === 'string';
      const panelReturned =
        event.key === PET_PANEL_OPEN_FLAG_KEY && event.oldValue === '1' && event.newValue == null;
      if (overlayShown || panelReturned) scheduleWelcome();
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener(PET_OVERLAY_SHOW_EVENT, scheduleWelcome);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(PET_OVERLAY_SHOW_EVENT, scheduleWelcome);
      if (welcomeReplayTimerRef.current) {
        window.clearTimeout(welcomeReplayTimerRef.current);
        welcomeReplayTimerRef.current = 0;
      }
    };
  }, [enabled, forceAnimation, tauriWindowMode]);

  // Diagnostics: force animation from Settings → Pets
  React.useEffect(() => {
    if (!enabled) return;
    const onForce = (e: Event) => {
      const detail = (e as CustomEvent<PetForceAnimDetail>).detail;
      if (!detail?.anim) return;
      forceAnimation(detail.anim as PetAnimId);
    };
    window.addEventListener(PET_FORCE_ANIM_EVENT, onForce);
    return () => window.removeEventListener(PET_FORCE_ANIM_EVENT, onForce);
  }, [enabled, forceAnimation]);

  const clearRuntimeReaction = React.useCallback(
    (restoreUnderlying = true) => {
      window.clearTimeout(reactionTimerRef.current);
      reactionTimerRef.current = 0;
      const hadReaction = reactionRef.current != null;
      reactionRef.current = null;
      reactionExpiresAtRef.current = 0;
      setRuntimeReaction('idle');
      if (!restoreUnderlying || !hadReaction) return;
      const current = stateRef.current;
      if (current.dragging || current.panelOpen || current.sleeping || current.shutdown) return;
      setState({ ...current, anim: reactionBaseAnimRef.current });
    },
    [setState],
  );

  React.useEffect(() => {
    if (!enabled || !notificationReactions) {
      clearRuntimeReaction();
      return;
    }
    const unsubscribe = subscribePetRuntimeEvents((event) => {
      const incoming = petReactionForEvent(event.kind);
      const now = Date.now();
      if (
        !shouldAcceptPetReaction(reactionRef.current, incoming, now, reactionExpiresAtRef.current)
      ) {
        return;
      }
      if (reactionRef.current == null || now >= reactionExpiresAtRef.current) {
        reactionBaseAnimRef.current = stateRef.current.anim;
      }
      window.clearTimeout(reactionTimerRef.current);
      reactionRef.current = incoming;
      reactionExpiresAtRef.current = now + incoming.durationMs;
      setRuntimeReaction(incoming.reaction);
      if (motionPolicy.animationsEnabled && !stateRef.current.dragging) {
        setState({ ...stateRef.current, anim: incoming.animation, sleeping: false });
      }
      reactionTimerRef.current = window.setTimeout(
        () => clearRuntimeReaction(true),
        incoming.durationMs,
      );
    });
    return () => {
      unsubscribe();
      window.clearTimeout(reactionTimerRef.current);
      reactionTimerRef.current = 0;
    };
  }, [
    clearRuntimeReaction,
    enabled,
    motionPolicy.animationsEnabled,
    notificationReactions,
    setState,
  ]);

  // Play current machine anim (walk/idle/sleep transitions). No texture thrash.
  React.useEffect(() => {
    if (!enabled || !motionPolicy.animationsEnabled) return;
    void playAnim(animLabel);
    const s = stateRef.current;
    if (s.anim === 'idlePrimary' && s.welcomePlayed) {
      schedulerRef.current?.onActivity();
    } else if (s.anim !== 'idleFun') {
      schedulerRef.current?.onHighPriority();
    }
  }, [enabled, animLabel, motionPolicy.animationsEnabled, playAnim]);

  // Scheduler tick
  React.useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    const tick = () => {
      const s = stateRef.current;
      const fire = schedulerRef.current?.tick(
        motionPolicy.idleFunEnabled && canScheduleIdleFun(s),
        canEnterSleep(s),
      );
      if (fire === 'idle_fun') setState(reducePetEvent(s, { type: 'idle_fun_tick' }));
      else if (fire === 'sleep') setState(reducePetEvent(s, { type: 'sleep_timeout' }));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [enabled, motionPolicy.idleFunEnabled, setState]);

  const [ctxMenu, setCtxMenu] = React.useState<{ x: number; y: number } | null>(null);
  const route = useUIStore((state) => state.route);
  const routeRef = React.useRef(route);

  React.useEffect(() => {
    if (routeRef.current !== route) setCtxMenu(null);
    routeRef.current = route;
  }, [route]);

  React.useEffect(() => {
    if (!ctxMenu || !contextMenuRef.current) return;
    return installPetContextMenuDismissal({
      menuElement: contextMenuRef.current,
      close: () => setCtxMenu(null),
    });
  }, [ctxMenu]);

  const openPanelNow = React.useCallback(() => {
    if (openingPanelRef.current) return;
    openingPanelRef.current = true;
    // Wake + mark panel intent in the pure state machine (sleep first-click opens).
    setState(reducePetEvent(stateRef.current, { type: 'click' }));
    schedulerRef.current?.onActivity();
    const left = tauriWindowMode ? 0 : pos.left;
    const top = tauriWindowMode ? 0 : pos.top;
    const finish = () => {
      openingPanelRef.current = false;
    };
    if (onOpenPanel) {
      try {
        onOpenPanel();
      } finally {
        // Host may be async; release after a tick so double-clicks coalesce via bridge.
        window.setTimeout(finish, 400);
      }
      return;
    }
    // No host callback: open Tauri panel + notify main-shell for in-app fallback.
    notifyPetPanelOpenRequested(left, top);
    void openOrFocusPetMiniPanel(left, top, panelMode)
      .catch(() => undefined)
      .finally(finish);
  }, [onOpenPanel, panelMode, pos.left, pos.top, setState, tauriWindowMode]);

  const lastWalkAnimRef = React.useRef<'walkLeft' | 'walkRight' | 'idlePrimary' | null>(null);
  /** Pending locomotion sample applied once per animation frame (not per pointermove). */
  const pendingWalkRef = React.useRef<{
    walkAnim: 'walkLeft' | 'walkRight' | 'idlePrimary';
    vx: number;
  } | null>(null);
  const walkRafRef = React.useRef(0);

  const applyWalkFromVelocity = React.useCallback(
    (walkAnim: 'walkLeft' | 'walkRight' | 'idlePrimary', vx: number) => {
      // Only push state machine when locomotion class changes — prevents walk/idle flicker
      // and avoids restarting walk animation at frame 0 on every pointer sample.
      if (lastWalkAnimRef.current !== walkAnim) {
        lastWalkAnimRef.current = walkAnim;
        setState(reducePetEvent(stateRef.current, { type: 'drag_move', walk: walkAnim }));
      }
      const def = getAnimDef(
        walkAnim === 'idlePrimary' ? 'idlePrimary' : walkAnim,
        characterIdRef.current,
      );
      const baseFps = def?.fps ?? 12;
      const fps = reducedMotion
        ? petPlaybackFps(walkAnim === 'idlePrimary' ? 'idlePrimary' : walkAnim, baseFps, true)
        : dragWalkFpsFromVelocity(
            vx,
            petPlaybackFps(walkAnim === 'idlePrimary' ? 'idlePrimary' : walkAnim, baseFps, false),
          );
      // Speed-only update; do not reset animation phase.
      playerRef.current.setPlaybackFps(fps);
    },
    [reducedMotion, setState],
  );

  const scheduleWalkApply = React.useCallback(
    (walkAnim: 'walkLeft' | 'walkRight' | 'idlePrimary', vx: number) => {
      pendingWalkRef.current = { walkAnim, vx };
      if (walkRafRef.current) return;
      walkRafRef.current = requestAnimationFrame(() => {
        walkRafRef.current = 0;
        const p = pendingWalkRef.current;
        if (!p) return;
        pendingWalkRef.current = null;
        applyWalkFromVelocity(p.walkAnim, p.vx);
      });
    },
    [applyWalkFromVelocity],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 2) return;
    clearRuntimeReaction(false);
    setCtxMenu(null);
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const t = performance.now();
    const gesture = beginPetPointerGesture({
      pointerId: e.pointerId,
      clientX: e.clientX,
      clientY: e.clientY,
      screenX: e.screenX,
      screenY: e.screenY,
      logicalLeft: pos.left,
      logicalTop: pos.top,
      nowMs: t,
    });
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      originLeft: pos.left,
      originTop: pos.top,
      vel: createDragVelocityState(e.clientX, t),
      windowOriginX: e.screenX - e.clientX + pos.left,
      windowOriginY: e.screenY - e.clientY + pos.top,
      gesture,
      canMove: !positionLocked,
    };
    lastWalkAnimRef.current = 'idlePrimary';
    if (!positionLocked) {
      setState(reducePetEvent(stateRef.current, { type: 'drag_start', walk: 'idlePrimary' }));
    }
  };

  const onPointerEnter = () => {
    // Pointer tracking may still drive future behavior; never paint a status/hover dot.
    if (!pointerTracking || reactionRef.current) return;
    setRuntimeReaction('hover');
  };

  const onPointerLeave = () => {
    if (runtimeReaction === 'hover') setRuntimeReaction('idle');
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    clearRuntimeReaction(false);
    dragRef.current = null;
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d?.active) return;
    // Coalesce high-frequency pointer samples when available; keep last sample for position.
    const native = e.nativeEvent as PointerEvent & {
      getCoalescedEvents?: () => PointerEvent[];
    };
    const coalesced =
      typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : null;
    const samples =
      coalesced && coalesced.length > 0
        ? coalesced
        : [{ clientX: e.clientX, clientY: e.clientY, timeStamp: e.timeStamp }];
    let walkAnim: 'walkLeft' | 'walkRight' | 'idlePrimary' = 'idlePrimary';
    let vx = d.vel.vx;
    for (const sample of samples) {
      const t =
        typeof sample.timeStamp === 'number' && sample.timeStamp > 0
          ? sample.timeStamp
          : performance.now();
      const r = sampleDragVelocity(d.vel, sample.clientX, t);
      d.vel = r.state;
      walkAnim = r.walkAnim;
      vx = r.state.vx;
    }
    const last = samples[samples.length - 1]!;
    samplePetPointerGesture(d.gesture, last.clientX, last.clientY);
    if (!d.canMove) return;
    const dx = last.clientX - d.startX;
    const dy = last.clientY - d.startY;
    if (tauriWindowMode) {
      const rawX = d.windowOriginX + dx;
      const rawY = d.windowOriginY + dy;
      const sw =
        typeof window !== 'undefined' ? window.screen.availWidth || window.innerWidth : 1920;
      const sh =
        typeof window !== 'undefined' ? window.screen.availHeight || window.innerHeight : 1080;
      const clamped = clampPetPosition(rawX, rawY, DISPLAY, sw, sh, 0);
      void setPetOverlayPosition(clamped.x, clamped.y);
    } else {
      const sw = typeof window !== 'undefined' ? window.innerWidth : 1920;
      const sh = typeof window !== 'undefined' ? window.innerHeight : 1080;
      const clamped = clampPetPosition(d.originLeft + dx, d.originTop + dy, DISPLAY, sw, sh, 0);
      setPos({ left: clamped.x, top: clamped.y });
    }
    // Position updates immediately; locomotion state applies once per rAF.
    petPerfRecordDragUpdate();
    scheduleWalkApply(walkAnim, vx);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    samplePetPointerGesture(d.gesture, e.clientX, e.clientY);
    const openPanel = shouldOpenPanelFromGesture(d.gesture);
    dragRef.current = null;
    lastWalkAnimRef.current = null;
    if (d.canMove) {
      setState(reducePetEvent(stateRef.current, { type: 'drag_end' }));
      if (tauriWindowMode && edgeSnapping) {
        void snapPetOverlayToEdge();
      } else if (!tauriWindowMode && edgeSnapping) {
        const sw = typeof window !== 'undefined' ? window.innerWidth : 1920;
        const sh = typeof window !== 'undefined' ? window.innerHeight : 1080;
        setPos((current) => {
          const candidates = [
            { left: 0, top: current.top, distance: current.left },
            {
              left: Math.max(0, sw - DISPLAY),
              top: current.top,
              distance: Math.abs(sw - DISPLAY - current.left),
            },
            { left: current.left, top: 0, distance: current.top },
            {
              left: current.left,
              top: Math.max(0, sh - DISPLAY),
              distance: Math.abs(sh - DISPLAY - current.top),
            },
          ];
          const nearest = candidates.reduce((best, candidate) =>
            candidate.distance < best.distance ? candidate : best,
          );
          return { left: nearest.left, top: nearest.top };
        });
      }
    }
    if (openPanel) {
      openPanelNow();
    }
  };

  // Stationary hold while dragging → idle walk anim (also rAF-paced).
  React.useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    const tick = (now: number) => {
      const d = dragRef.current;
      if (d?.active && d.canMove && now - d.vel.lastT >= 40) {
        const { state: vel, walkAnim } = sampleStationaryDragVelocity(d.vel, now);
        d.vel = vel;
        scheduleWalkApply(walkAnim, vel.vx);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (walkRafRef.current) {
        cancelAnimationFrame(walkRafRef.current);
        walkRafRef.current = 0;
      }
    };
  }, [enabled, scheduleWalkApply]);

  if (!enabled) return null;

  return (
    <>
      <div
        className={cn(
          tauriWindowMode
            ? 'relative select-none touch-none w-full h-full'
            : 'fixed z-[80] select-none touch-none pointer-events-auto',
          'cursor-grab active:cursor-grabbing',
          positionLocked && 'cursor-pointer active:cursor-pointer',
          className,
        )}
        style={
          tauriWindowMode
            ? {
                width: DISPLAY,
                height: DISPLAY,
                background: 'transparent',
                backgroundColor: 'transparent',
                margin: 'auto',
              }
            : {
                left: pos.left,
                top: pos.top,
                width: DISPLAY,
                height: DISPLAY,
                background: 'transparent',
                backgroundColor: 'transparent',
                boxShadow: 'none',
                border: 'none',
                outline: 'none',
              }
        }
        data-pet-overlay="true"
        data-pet-anim={animLabel}
        data-pet-character={characterId}
        data-pet-panel-open={panelOpen ? 'true' : 'false'}
        data-pet-reduced-motion={reducedMotion ? 'true' : 'false'}
        data-pet-position-locked={positionLocked ? 'true' : 'false'}
        data-pet-edge-snapping={edgeSnapping ? 'true' : 'false'}
        data-pet-animation-level={animationLevel}
        data-pet-render-ready={renderReady ? 'true' : 'false'}
        data-pet-reaction={runtimeReaction}
        data-pet-show-diag={showDiagnostics ? 'true' : 'false'}
        data-pet-renderer={motionPolicy.animationsEnabled ? 'pixi' : 'static-image'}
        onPointerDown={onPointerDown}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={onContextMenu}
        role="img"
        aria-label={`VibeSpace Pet — ${animLabel}. Drag to move, click to open panel, right-click to close.`}
      >
        <div
          ref={hostRef}
          className="pet-canvas-container block w-full h-full"
          style={{
            width: DISPLAY,
            height: DISPLAY,
            background: 'transparent',
            backgroundColor: 'transparent',
            backgroundImage: 'none',
            border: 'none',
            boxShadow: 'none',
          }}
        >
          {!motionPolicy.animationsEnabled ? (
            <img
              src={staticPreview}
              alt=""
              aria-hidden="true"
              data-pet-static-frame="true"
              className="block h-full w-full object-contain"
              style={{ imageRendering: 'pixelated' }}
              onLoad={() => setRenderReady(true)}
              onError={() => setRenderReady(false)}
            />
          ) : null}
        </div>
        <span className="sr-only" role="status" aria-live="polite">
          {runtimeReaction === 'idle' ? 'Pet is idle' : `Pet status: ${runtimeReaction}`}
        </span>
        {/* No floating status/hover dots — the sprite itself is the only visible chrome. */}
      </div>
      {debugMode && (
        <div
          data-pet-animation-debug="true"
          className="fixed left-2 top-[144px] z-[100] max-w-[560px] rounded bg-black/90 p-2 text-[10px] text-white"
        >
          <div data-pet-debug-status="true">
            {(() => {
              void debugTick;
              const diag = playerRef.current.getDiagnostics();
              return `surface=diagnostic commit=${import.meta.env.VITE_GIT_COMMIT ?? 'unknown'} character=${characterId} anim=${animLabel} frame=${diag.currentFrameIndex}/${diag.frameCount} rect=${diag.currentTextureFrameRect ?? 'none'} ticker=${diag.tickerStarted ? 'started' : 'stopped'} resets=${diag.animationResetCount} app=${diag.applicationObjectId ?? 'none'} canvas=${diag.canvasObjectId ?? 'none'}`;
            })()}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            <button type="button" onClick={() => setCharacterId('vibespace-axolotl')}>
              Axo
            </button>
            <button type="button" onClick={() => setCharacterId('vibespace-axolotl-glitch')}>
              Glitch
            </button>
            {DEBUG_ANIMS.map((anim) => (
              <button key={anim} type="button" onClick={() => forceAnimation(anim)}>
                {anim}
              </button>
            ))}
            <button type="button" onClick={() => playerRef.current.pause()}>
              pause
            </button>
            <button type="button" onClick={() => playerRef.current.resume()}>
              resume
            </button>
            <button type="button" onClick={() => playerRef.current.restartAnimation()}>
              restart
            </button>
          </div>
        </div>
      )}
      {ctxMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-[90] min-w-[120px] rounded-lg border border-border bg-panel shadow-lg p-1"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          data-pet-context-menu="true"
          role="menu"
        >
          <button
            type="button"
            className="w-full rounded px-3 py-1.5 text-left text-sm hover:bg-muted"
            role="menuitem"
            onClick={() => {
              setCtxMenu(null);
              onRequestClose?.();
            }}
          >
            Close
          </button>
          <button
            type="button"
            className="w-full rounded px-3 py-1.5 text-left text-sm hover:bg-muted"
            role="menuitem"
            onClick={() => {
              setCtxMenu(null);
              openPanelNow();
            }}
          >
            Open panel
          </button>
          <button
            type="button"
            className="w-full rounded px-3 py-1.5 text-left text-sm hover:bg-muted"
            role="menuitemcheckbox"
            aria-checked={positionLocked}
            onClick={() => {
              setCtxMenu(null);
              setPositionLocked(!positionLocked);
            }}
          >
            {positionLocked ? 'Unlock position' : 'Lock position'}
          </button>
        </div>
      )}
      {ctxMenu && (
        <button
          type="button"
          className="fixed inset-0 z-[85] cursor-default bg-transparent"
          aria-label="Dismiss pet menu"
          onClick={() => setCtxMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtxMenu(null);
          }}
        />
      )}
    </>
  );
}
