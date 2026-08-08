/**
 * User-facing Pet settings — persisted in the normal app (localStorage).
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { safeLocalStorage } from '@/lib/persistence/safeLocalStorage';
import {
  NORMAL_AXO_RUNTIME_ID,
  resolvePetCharacterId,
  type PetCharacterId,
  type PetCharacterInput,
} from './petCharacters';

export type PetPanelMode = 'follow-pet' | 'always-on-top' | 'normal';
export type PetAnimationLevel = 'off' | 'reduced' | 'calm' | 'normal' | 'playful';

function resolvePetPanelMode(value: unknown): PetPanelMode {
  return value === 'follow-pet' || value === 'normal' ? value : 'always-on-top';
}

function resolvePetAnimationLevel(value: unknown): PetAnimationLevel {
  return value === 'off' || value === 'reduced' || value === 'normal' || value === 'playful'
    ? value
    : 'calm';
}

export interface PetSettingsState {
  enabled: boolean;
  reducedMotion: boolean;
  sleepTimeoutMs: number;
  idleFunIntervalMs: number;
  showDiagnostics: boolean;
  overlayVisible: boolean;
  /** Selected sprite skin */
  characterId: PetCharacterId;
  panelMode: PetPanelMode;
  positionLocked: boolean;
  edgeSnapping: boolean;
  animationLevel: PetAnimationLevel;
  soundEnabled: boolean;
  notificationReactions: boolean;
  pointerTracking: boolean;

  setEnabled: (v: boolean) => void;
  setReducedMotion: (v: boolean) => void;
  setSleepTimeoutMs: (ms: number) => void;
  setIdleFunIntervalMs: (ms: number) => void;
  setShowDiagnostics: (v: boolean) => void;
  setOverlayVisible: (v: boolean) => void;
  setCharacterId: (id: PetCharacterInput) => void;
  setPanelMode: (mode: PetPanelMode) => void;
  setPositionLocked: (v: boolean) => void;
  setEdgeSnapping: (v: boolean) => void;
  setAnimationLevel: (level: PetAnimationLevel) => void;
  setSoundEnabled: (v: boolean) => void;
  setNotificationReactions: (v: boolean) => void;
  setPointerTracking: (v: boolean) => void;
}

export const usePetSettingsStore = create<PetSettingsState>()(
  persist(
    (set) => ({
      enabled: true,
      reducedMotion: false,
      sleepTimeoutMs: 5 * 60 * 1000,
      idleFunIntervalMs: 60_000,
      showDiagnostics: false,
      overlayVisible: true,
      characterId: NORMAL_AXO_RUNTIME_ID,
      panelMode: 'always-on-top',
      positionLocked: false,
      edgeSnapping: true,
      animationLevel: 'calm',
      soundEnabled: true,
      notificationReactions: true,
      pointerTracking: true,

      setEnabled: (v) => set({ enabled: v, overlayVisible: v ? true : false }),
      setReducedMotion: (v) => set({ reducedMotion: v }),
      setSleepTimeoutMs: (ms) =>
        set({ sleepTimeoutMs: Math.max(30_000, Math.min(ms, 60 * 60 * 1000)) }),
      setIdleFunIntervalMs: (ms) =>
        set({ idleFunIntervalMs: Math.max(10_000, Math.min(ms, 30 * 60 * 1000)) }),
      setShowDiagnostics: (v) => set({ showDiagnostics: v }),
      setOverlayVisible: (v) => set({ overlayVisible: v }),
      setCharacterId: (id) => set({ characterId: resolvePetCharacterId(id) }),
      setPanelMode: (mode) => set({ panelMode: resolvePetPanelMode(mode) }),
      setPositionLocked: (v) => set({ positionLocked: v }),
      setEdgeSnapping: (v) => set({ edgeSnapping: v }),
      setAnimationLevel: (level) => set({ animationLevel: resolvePetAnimationLevel(level) }),
      setSoundEnabled: (v) => set({ soundEnabled: v }),
      setNotificationReactions: (v) => set({ notificationReactions: v }),
      setPointerTracking: (v) => set({ pointerTracking: v }),
    }),
    {
      name: 'vibespace-pet-settings',
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (s) => ({
        enabled: s.enabled,
        reducedMotion: s.reducedMotion,
        sleepTimeoutMs: s.sleepTimeoutMs,
        idleFunIntervalMs: s.idleFunIntervalMs,
        showDiagnostics: s.showDiagnostics,
        overlayVisible: s.overlayVisible,
        characterId: s.characterId,
        panelMode: s.panelMode,
        positionLocked: s.positionLocked,
        edgeSnapping: s.edgeSnapping,
        animationLevel: s.animationLevel,
        soundEnabled: s.soundEnabled,
        notificationReactions: s.notificationReactions,
        pointerTracking: s.pointerTracking,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PetSettingsState>;
        return {
          ...current,
          ...p,
          characterId: resolvePetCharacterId(p.characterId),
          panelMode: resolvePetPanelMode(p.panelMode),
          animationLevel: resolvePetAnimationLevel(p.animationLevel),
        };
      },
    },
  ),
);

export const PET_FORCE_ANIM_EVENT = 'jarvis:pet:force-anim';
export const PET_CHARACTER_CHANGED_EVENT = 'jarvis:pet:character-changed';

export type PetForceAnimDetail = {
  anim:
    | 'welcome'
    | 'idlePrimary'
    | 'idleFun'
    | 'walkLeft'
    | 'walkRight'
    | 'sleepTransition'
    | 'sleepingLoop'
    | 'wakeFromSleep';
};

export function forcePetAnim(anim: PetForceAnimDetail['anim']): void {
  window.dispatchEvent(new CustomEvent(PET_FORCE_ANIM_EVENT, { detail: { anim } }));
}

export function notifyPetCharacterChanged(id: PetCharacterId): void {
  window.dispatchEvent(
    new CustomEvent(PET_CHARACTER_CHANGED_EVENT, { detail: { characterId: id } }),
  );
}

/**
 * Cross-window sync for pet settings (main ↔ pet-overlay WebViews share origin).
 * Rehydrates the store when another window writes `vibespace-pet-settings`.
 */
export function installPetSettingsStorageSync(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onStorage = (e: StorageEvent) => {
    if (e.key !== 'vibespace-pet-settings' || e.newValue == null) return;
    try {
      const parsed = JSON.parse(e.newValue) as { state?: Partial<PetSettingsState> };
      const s = parsed.state ?? (parsed as Partial<PetSettingsState>);
      usePetSettingsStore.setState({
        enabled: s.enabled ?? usePetSettingsStore.getState().enabled,
        reducedMotion: s.reducedMotion ?? usePetSettingsStore.getState().reducedMotion,
        sleepTimeoutMs: s.sleepTimeoutMs ?? usePetSettingsStore.getState().sleepTimeoutMs,
        idleFunIntervalMs: s.idleFunIntervalMs ?? usePetSettingsStore.getState().idleFunIntervalMs,
        showDiagnostics: s.showDiagnostics ?? usePetSettingsStore.getState().showDiagnostics,
        overlayVisible: s.overlayVisible ?? usePetSettingsStore.getState().overlayVisible,
        characterId: resolvePetCharacterId(s.characterId),
        panelMode: resolvePetPanelMode(s.panelMode),
        positionLocked: s.positionLocked ?? usePetSettingsStore.getState().positionLocked,
        edgeSnapping: s.edgeSnapping ?? usePetSettingsStore.getState().edgeSnapping,
        animationLevel: resolvePetAnimationLevel(s.animationLevel),
        soundEnabled: s.soundEnabled ?? usePetSettingsStore.getState().soundEnabled,
        notificationReactions:
          s.notificationReactions ?? usePetSettingsStore.getState().notificationReactions,
        pointerTracking: s.pointerTracking ?? usePetSettingsStore.getState().pointerTracking,
      });
    } catch {
      /* ignore corrupt storage */
    }
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
