import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Theme } from '@/types/common';

/**
 * UI state - panes, modals, theme. Persisted across reloads.
 */

export type ChatMode = 'chat' | 'council' | 'doc' | 'code';

/**
 * V3 — top-level page route the workspace canvas is showing.
 * Owned by this store; consumed by `PageRouter` and `NavPane`.
 *
 * NOTE: `route` is intentionally **transient** — see `partialize` below.
 * Reloads always land back on `'chat'` unless the user navigates again.
 */
export type Route =
  | 'chat'
  | 'terminal'
  | 'kanban'
  | 'agents'
  | 'skills'
  | 'benchmarks'
  | 'history';

interface UIState {
  // Layout
  navOpen: boolean;
  inspectorOpen: boolean;
  todoDrawerOpen: boolean;
  activeChatId: string | null;
  chatMode: ChatMode;

  // Modals / overlays
  paletteOpen: boolean;
  voiceModalOpen: boolean;
  voiceListening: boolean; // distinct - drives glow border without modal
  settingsOpen: boolean;
  onboardingComplete: boolean;

  // Theme + layout prefs
  theme: Theme;
  density: 'compact' | 'cozy';

  // V2 — ambient idle home
  /** User-level master switch. When false, idle never triggers ambient. */
  ambient: boolean;
  /** True only while the takeover screen is rendered. */
  ambientActive: boolean;
  /** Idle threshold in ms before ambient appears. Default 5 min. */
  ambientThresholdMs: number;
  /** Optional drone audio while ambient is active (off by default). */
  ambientDrone: boolean;

  // V2 — fullscreen canvas
  chatFullscreen: boolean;

  // V2 — schedule + launcher
  scheduleOpen: boolean;
  launcherOpen: boolean;
  /** V2 — Jarvis Assistant natural-language command bar (Mod+J). */
  assistantOpen: boolean;

  // V2 — accessibility
  /** Show the speech-to-text mic button in the chat composer. */
  composerStt: boolean;

  // V3 — pages router
  /** The page the workspace canvas is showing. Default 'chat'. Transient. */
  route: Route;
  /** True while the in-app phone call modal (Path C) is open. Transient. */
  callModalOpen: boolean;

  // Actions
  toggleNav: () => void;
  toggleInspector: () => void;
  toggleTodoDrawer: () => void;
  togglePalette: () => void;
  setPaletteOpen: (open: boolean) => void;
  toggleVoice: () => void;
  setVoiceListening: (v: boolean) => void;
  setVoiceModalOpen: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  setActiveChat: (id: string | null) => void;
  setChatMode: (mode: ChatMode) => void;
  setTheme: (t: Theme) => void;
  finishOnboarding: () => void;
  resetUI: () => void;

  // V2 actions
  setAmbient: (v: boolean) => void;
  setAmbientActive: (v: boolean) => void;
  setAmbientThresholdMs: (ms: number) => void;
  toggleChatFullscreen: () => void;
  setChatFullscreen: (v: boolean) => void;
  setScheduleOpen: (v: boolean) => void;
  setLauncherOpen: (v: boolean) => void;
  setAssistantOpen: (v: boolean) => void;
  setComposerStt: (v: boolean) => void;

  // V3 actions
  setRoute: (r: Route) => void;
  setCallModalOpen: (v: boolean) => void;
}

const defaults: Pick<
  UIState,
  | 'navOpen'
  | 'inspectorOpen'
  | 'todoDrawerOpen'
  | 'activeChatId'
  | 'chatMode'
  | 'paletteOpen'
  | 'voiceModalOpen'
  | 'voiceListening'
  | 'settingsOpen'
  | 'onboardingComplete'
  | 'theme'
  | 'density'
  | 'ambient'
  | 'ambientActive'
  | 'ambientThresholdMs'
  | 'ambientDrone'
  | 'chatFullscreen'
  | 'scheduleOpen'
  | 'launcherOpen'
  | 'assistantOpen'
  | 'composerStt'
  | 'route'
  | 'callModalOpen'
> = {
  navOpen: true,
  inspectorOpen: false,
  todoDrawerOpen: true,
  activeChatId: null,
  chatMode: 'chat',
  paletteOpen: false,
  voiceModalOpen: false,
  voiceListening: false,
  settingsOpen: false,
  onboardingComplete: false,
  theme: 'dark',
  density: 'cozy',
  ambient: true,
  ambientActive: false,
  ambientThresholdMs: 5 * 60 * 1000,
  ambientDrone: false,
  chatFullscreen: false,
  scheduleOpen: false,
  launcherOpen: false,
  assistantOpen: false,
  composerStt: true,
  route: 'chat',
  callModalOpen: false,
};

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      ...defaults,

      toggleNav: () => set((s) => ({ navOpen: !s.navOpen })),
      toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
      toggleTodoDrawer: () => set((s) => ({ todoDrawerOpen: !s.todoDrawerOpen })),
      togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
      setPaletteOpen: (open) => set({ paletteOpen: open }),
      toggleVoice: () => set((s) => ({ voiceModalOpen: !s.voiceModalOpen })),
      setVoiceListening: (v) => set({ voiceListening: v }),
      setVoiceModalOpen: (v) => set({ voiceModalOpen: v }),
      setSettingsOpen: (v) => set({ settingsOpen: v }),
      setActiveChat: (id) => set({ activeChatId: id }),
      setChatMode: (mode) => set({ chatMode: mode }),
      setTheme: (t) => {
        document.documentElement.setAttribute('data-theme', t === 'system' ? 'dark' : t);
        set({ theme: t });
      },
      finishOnboarding: () => set({ onboardingComplete: true }),
      resetUI: () => set(defaults),

      // V2
      setAmbient: (v) => set({ ambient: v, ambientActive: v ? undefined : false } as Partial<UIState>),
      setAmbientActive: (v) => set({ ambientActive: v }),
      setAmbientThresholdMs: (ms) => set({ ambientThresholdMs: Math.max(15_000, ms) }),
      toggleChatFullscreen: () =>
        set((s) => {
          const next = !s.chatFullscreen;
          if (typeof document !== 'undefined') {
            document.documentElement.setAttribute('data-fullscreen', next ? 'true' : 'false');
          }
          return { chatFullscreen: next };
        }),
      setChatFullscreen: (v) => {
        if (typeof document !== 'undefined') {
          document.documentElement.setAttribute('data-fullscreen', v ? 'true' : 'false');
        }
        set({ chatFullscreen: v });
      },
      setScheduleOpen: (v) => set({ scheduleOpen: v }),
      setLauncherOpen: (v) => set({ launcherOpen: v }),
      setAssistantOpen: (v) => set({ assistantOpen: v }),
      setComposerStt: (v) => set({ composerStt: v }),

      // V3
      setRoute: (r) => set({ route: r }),
      setCallModalOpen: (v) => set({ callModalOpen: v }),
    }),
    {
      name: 'jarvis-ui',
      partialize: (s) => ({
        navOpen: s.navOpen,
        inspectorOpen: s.inspectorOpen,
        todoDrawerOpen: s.todoDrawerOpen,
        chatMode: s.chatMode,
        theme: s.theme,
        density: s.density,
        onboardingComplete: s.onboardingComplete,
        ambient: s.ambient,
        ambientThresholdMs: s.ambientThresholdMs,
        ambientDrone: s.ambientDrone,
        composerStt: s.composerStt,
      }),
    },
  ),
);
