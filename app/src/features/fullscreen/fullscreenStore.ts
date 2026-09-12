import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { safeLocalStorage } from '@/lib/persistence/safeLocalStorage';
import {
  DEFAULT_FULLSCREEN_PREFERENCES,
  activateLayer,
  deactivateLayer,
  lastActiveLayer,
  normalizeFullscreenPreferences,
  resolveRestorableLayers,
  type FullscreenAvailability,
  type FullscreenLayer,
  type FullscreenPreferences,
} from './contracts';
import { createNativeFullscreenAdapter, type NativeFullscreenAdapter } from './nativeFullscreen';

const FULLSCREEN_STORAGE_KEY = 'vibespace-fullscreen-preferences-v1';
const NATIVE_FULLSCREEN_ERROR =
  'VibeSpace could not change fullscreen. Try again or use the window controls.';

export interface FullscreenState {
  focusActive: boolean;
  systemActive: boolean;
  activationOrder: FullscreenLayer[];
  preferences: FullscreenPreferences;
  rememberedFocusActive: boolean;
  rememberedSystemActive: boolean;
  cleanShutdown: boolean;
  storedAppVersion: string | null;
  recoveryLaunch: boolean;
  nativeAvailability: FullscreenAvailability;
  nativePending: boolean;
  error: string | null;
  setFocusActive(enabled: boolean): void;
  toggleFocus(): void;
  requestSystemActive(enabled: boolean): Promise<boolean>;
  toggleSystem(): Promise<boolean>;
  exitMostRecentLayer(): Promise<FullscreenLayer | null>;
  syncNativeState(enabled: boolean): void;
  setPreferences(patch: Partial<FullscreenPreferences>): void;
  beginSession(input: { appVersion: string; recoveryLaunch: boolean }): FullscreenLayer[];
  markCleanShutdown(appVersion: string): void;
  clearError(): void;
}

type PersistedFullscreenState = Pick<
  FullscreenState,
  | 'preferences'
  | 'rememberedFocusActive'
  | 'rememberedSystemActive'
  | 'cleanShutdown'
  | 'storedAppVersion'
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

let nativeAdapter: NativeFullscreenAdapter = createNativeFullscreenAdapter();
let nativeQueue: Promise<void> = Promise.resolve();
let latestNativeRequest = 0;
let adapterGeneration = 0;

export function configureFullscreenAdapter(adapter: NativeFullscreenAdapter): () => void {
  const previous = nativeAdapter;
  nativeAdapter = adapter;
  nativeQueue = Promise.resolve();
  latestNativeRequest = 0;
  adapterGeneration += 1;
  useFullscreenStore.setState({
    nativeAvailability: adapter.availability(),
    nativePending: false,
    error: null,
  });

  return () => {
    if (nativeAdapter !== adapter) return;
    nativeAdapter = previous;
    nativeQueue = Promise.resolve();
    latestNativeRequest = 0;
    adapterGeneration += 1;
    useFullscreenStore.setState({
      nativeAvailability: previous.availability(),
      nativePending: false,
      error: null,
    });
  };
}

export const useFullscreenStore = create<FullscreenState>()(
  persist(
    (set, get) => ({
      focusActive: false,
      systemActive: false,
      activationOrder: [],
      preferences: { ...DEFAULT_FULLSCREEN_PREFERENCES },
      rememberedFocusActive: false,
      rememberedSystemActive: false,
      cleanShutdown: false,
      storedAppVersion: null,
      recoveryLaunch: false,
      nativeAvailability: nativeAdapter.availability(),
      nativePending: false,
      error: null,

      setFocusActive(enabled) {
        set((state) => ({
          focusActive: enabled,
          activationOrder: enabled
            ? activateLayer(state.activationOrder, 'focus')
            : deactivateLayer(state.activationOrder, 'focus'),
          rememberedFocusActive: state.preferences.rememberFocusMode
            ? enabled
            : state.rememberedFocusActive,
        }));
      },

      toggleFocus() {
        get().setFocusActive(!get().focusActive);
      },

      requestSystemActive(enabled) {
        const requestId = ++latestNativeRequest;
        const generation = adapterGeneration;
        const adapter = nativeAdapter;
        set({
          nativeAvailability: adapter.availability(),
          nativePending: true,
          error: null,
        });

        const operation = nativeQueue.then(() => adapter.write(enabled));
        nativeQueue = operation.then(
          () => undefined,
          () => undefined,
        );

        return operation.then(
          (observed) => {
            if (requestId === latestNativeRequest && generation === adapterGeneration) {
              set((state) => ({
                systemActive: observed,
                activationOrder: observed
                  ? activateLayer(state.activationOrder, 'system')
                  : deactivateLayer(state.activationOrder, 'system'),
                rememberedSystemActive: state.preferences.rememberSystemFullscreen
                  ? observed
                  : state.rememberedSystemActive,
                nativePending: false,
                error: null,
              }));
            }
            return observed;
          },
          () => {
            if (requestId === latestNativeRequest && generation === adapterGeneration) {
              set({ nativePending: false, error: NATIVE_FULLSCREEN_ERROR });
            }
            return get().systemActive;
          },
        );
      },

      toggleSystem() {
        return get().requestSystemActive(!get().systemActive);
      },

      async exitMostRecentLayer() {
        const layer = lastActiveLayer(get().activationOrder);
        if (layer === 'focus') {
          get().setFocusActive(false);
          return 'focus';
        }
        if (layer === 'system') {
          const wasActive = get().systemActive;
          const observed = await get().requestSystemActive(false);
          return wasActive && !observed ? 'system' : null;
        }
        return null;
      },

      syncNativeState(enabled) {
        set((state) => {
          if (state.systemActive === enabled) return { nativePending: false };
          return {
            systemActive: enabled,
            activationOrder: enabled
              ? activateLayer(state.activationOrder, 'system')
              : deactivateLayer(state.activationOrder, 'system'),
            rememberedSystemActive: state.preferences.rememberSystemFullscreen
              ? enabled
              : state.rememberedSystemActive,
            nativePending: false,
            error: null,
          };
        });
      },

      setPreferences(patch) {
        set((state) => {
          const preferences = normalizeFullscreenPreferences({
            ...state.preferences,
            ...patch,
          });
          return {
            preferences,
            rememberedFocusActive: preferences.rememberFocusMode ? state.focusActive : false,
            rememberedSystemActive: preferences.rememberSystemFullscreen
              ? state.systemActive
              : false,
          };
        });
      },

      beginSession(input) {
        const state = get();
        const restorable = resolveRestorableLayers({
          preferences: state.preferences,
          record: {
            focusActive: state.rememberedFocusActive,
            systemActive: state.rememberedSystemActive,
            cleanShutdown: state.cleanShutdown,
            appVersion: state.storedAppVersion,
            recoveryLaunch: input.recoveryLaunch,
          },
          currentVersion: input.appVersion,
        });

        set({
          cleanShutdown: false,
          storedAppVersion: input.appVersion,
          recoveryLaunch: input.recoveryLaunch,
          rememberedFocusActive: restorable.includes('focus'),
          rememberedSystemActive: restorable.includes('system'),
        });
        return restorable;
      },

      markCleanShutdown(appVersion) {
        set((state) => ({
          cleanShutdown: true,
          storedAppVersion: appVersion,
          rememberedFocusActive: state.preferences.rememberFocusMode ? state.focusActive : false,
          rememberedSystemActive: state.preferences.rememberSystemFullscreen
            ? state.systemActive
            : false,
        }));
      },

      clearError() {
        set({ error: null });
      },
    }),
    {
      name: FULLSCREEN_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (state): PersistedFullscreenState => ({
        preferences: state.preferences,
        rememberedFocusActive: state.rememberedFocusActive,
        rememberedSystemActive: state.rememberedSystemActive,
        cleanShutdown: state.cleanShutdown,
        storedAppVersion: state.storedAppVersion,
      }),
      merge: (persisted, current) => {
        const value = isRecord(persisted) ? persisted : {};
        return {
          ...current,
          preferences: normalizeFullscreenPreferences(value.preferences),
          rememberedFocusActive:
            typeof value.rememberedFocusActive === 'boolean' ? value.rememberedFocusActive : false,
          rememberedSystemActive:
            typeof value.rememberedSystemActive === 'boolean'
              ? value.rememberedSystemActive
              : false,
          cleanShutdown: typeof value.cleanShutdown === 'boolean' ? value.cleanShutdown : false,
          storedAppVersion:
            typeof value.storedAppVersion === 'string' ? value.storedAppVersion : null,
        };
      },
    },
  ),
);
