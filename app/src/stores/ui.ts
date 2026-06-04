import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Theme } from '@/types/common';
import { safeLocalStorage, measureStorageSizes } from '@/lib/persistence/safeLocalStorage';

export type AmbientTrack =
  | 'calm-focus'
  | 'soothing-rain'
  | 'warm-hearth'
  | 'deep-ocean'
  | 'starlight'
  | 'forest-rain'
  | 'lofi-night'
  | 'rap-instrumental';

export type ChatMode = 'chat' | 'council' | 'doc' | 'code';

export type DoneNotificationKey = 'jarvis' | 'terminal' | 'tasks' | 'contextMaps' | 'skills';
export type DoneNotificationSettings = Record<DoneNotificationKey, boolean>;

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
  | 'schedule'
  | 'agents'
  | 'agent-detail'
  | 'project-detail'
  | 'context'
  | 'skills'
  | 'benchmarks'
  | 'history'
  | 'tools'
  | 'files'
  | 'account';

/**
 * Wellness break kinds. The 20-20-20 eye break is the only kind today;
 * room reserved for a future stretch / breath / hydration variant.
 */
export type WellnessKind = 'eye-break-20-20-20';

interface UIState {
  // Layout
  navOpen: boolean;
  inspectorOpen: boolean;
  activeChatId: string | null;
  /**
   * Currently-selected agent for the agent-detail route. Null while
   * no agent is selected. Drives the AgentDetail page; clicking an
   * agent in the nav sidebar sets this and flips `route` to
   * `'agent-detail'` instead of creating a chat.
   */
  activeAgentId: string | null;
  chatMode: ChatMode;

  /**
   * Persistent collapse state of the collapsible vertical sections
   * in `NavPane.tsx` ('workspace', 'pinned', 'projects', 'chats', 'agents', 'context', 'files').
   * Missing keys default to "open".
   */
  navSectionsCollapsed: Record<string, boolean>;

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
  /** Which procedural soundscape track to play. */
  ambientTrack: AmbientTrack;
  /** Volume level 0–100. Default 40. */
  ambientVolume: number;
  /** When true, audio plays continuously even outside ambient mode. */
  ambientAlwaysPlay: boolean;

  // V2 — fullscreen canvas
  chatFullscreen: boolean;

  // V2 — launcher
  launcherOpen: boolean;
  /** V2 — Jarvis Assistant natural-language command bar (Mod+J). */
  assistantOpen: boolean;
  /**
   * V3 — In-app changelog modal. Auto-opened by `<WhatsNewHost />` on the
   * first launch after a version bump; also reachable manually from the
   * TopBar megaphone button. Transient — never persisted.
   */
  whatsNewOpen: boolean;

  // V2 — accessibility
  /** Show the speech-to-text mic button in the chat composer. */
  composerStt: boolean;
  /** Global default font size for newly spawned or unscaled terminal panes. */
  defaultTerminalFontSize: number;

  // V3 — done notifications
  notificationMaster: boolean;
  doneNotifications: DoneNotificationSettings;
  aiCompletionCue: boolean;

  // V3 — pages router
  /** The page the workspace canvas is showing. Default 'chat'. Transient. */
  route: Route;
  /** True while the in-app phone call modal (Path C) is open. Transient. */
  callModalOpen: boolean;
  /**
   * V3 — last release-notes version the user dismissed in the
   * "What's new" modal. Compared against `CURRENT_VERSION` from
   * `features/whats-new/releases.ts` to decide whether to auto-open
   * on boot. Persisted across reloads. `null` on a fresh install.
   */
  lastSeenWhatsNewVersion: string | null;

  // V3 — wellness break overlay
  /**
   * True while the full-screen wellness break (e.g. 20-20-20 eye break)
   * is active. The overlay sits at z-index 80 above ambient idle and
   * below toasts. Transient — never persisted.
   */
  wellnessActive: boolean;
  /** Which wellness modality is active. `null` when `wellnessActive` is false. */
  wellnessKind: WellnessKind | null;
  /**
   * Unix-ms when the current wellness break started. Used to compute the
   * countdown display. `null` when inactive.
   */
  wellnessStartedAt: number | null;
  /**
   * Total duration of the active break in ms. Default 20s for the
   * 20-20-20 eye-break; `null` when inactive.
   */
  wellnessDurationMs: number | null;

  // V3 — actions palette
  /**
   * True while the AI/user actions palette is open (Mod+Shift+A).
   * Transient.
   */
  actionsPaletteOpen: boolean;

  // Actions
  toggleNav: () => void;
  toggleInspector: () => void;
  togglePalette: () => void;
  setPaletteOpen: (open: boolean) => void;
  toggleVoice: () => void;
  setVoiceListening: (v: boolean) => void;
  setVoiceModalOpen: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  setActiveChat: (id: string | null) => void;
  setActiveAgent: (id: string | null) => void;
  toggleNavSection: (id: string) => void;
  setChatMode: (mode: ChatMode) => void;
  setTheme: (t: Theme) => void;
  finishOnboarding: () => void;
  resetUI: () => void;

  // V2 actions
  setAmbient: (v: boolean) => void;
  setAmbientActive: (v: boolean) => void;
  setAmbientThresholdMs: (ms: number) => void;
  setAmbientDrone: (v: boolean) => void;
  setAmbientTrack: (t: AmbientTrack) => void;
  setAmbientVolume: (v: number) => void;
  setAmbientAlwaysPlay: (v: boolean) => void;
  toggleChatFullscreen: () => void;
  setChatFullscreen: (v: boolean) => void;
  setLauncherOpen: (v: boolean) => void;
  setAssistantOpen: (v: boolean) => void;
  setWhatsNewOpen: (v: boolean) => void;
  setComposerStt: (v: boolean) => void;
  setDefaultTerminalFontSize: (v: number) => void;
  setNotificationMaster: (v: boolean) => void;
  setDoneNotification: (key: DoneNotificationKey, enabled: boolean) => void;
  setAiCompletionCue: (v: boolean) => void;

  // V3 actions
  setRoute: (r: Route) => void;
  setCallModalOpen: (v: boolean) => void;
  markWhatsNewSeen: (version: string) => void;
  startWellness: (kind: WellnessKind, durationMs: number) => void;
  endWellness: () => void;
  setActionsPaletteOpen: (v: boolean) => void;
  toggleActionsPalette: () => void;
}

const defaults: Pick<
  UIState,
  | 'navOpen'
  | 'inspectorOpen'
  | 'activeChatId'
  | 'activeAgentId'
  | 'navSectionsCollapsed'
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
  | 'ambientTrack'
  | 'ambientVolume'
  | 'ambientAlwaysPlay'
  | 'chatFullscreen'
  | 'launcherOpen'
  | 'assistantOpen'
  | 'whatsNewOpen'
  | 'composerStt'
  | 'defaultTerminalFontSize'
  | 'notificationMaster'
  | 'doneNotifications'
  | 'aiCompletionCue'
  | 'route'
  | 'callModalOpen'
  | 'lastSeenWhatsNewVersion'
  | 'wellnessActive'
  | 'wellnessKind'
  | 'wellnessStartedAt'
  | 'wellnessDurationMs'
  | 'actionsPaletteOpen'
> = {
  navOpen: true,
  inspectorOpen: false,
  activeChatId: null,
  activeAgentId: null,
  navSectionsCollapsed: {},
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
  ambientTrack: 'calm-focus',
  ambientVolume: 55,
  ambientAlwaysPlay: false,
  chatFullscreen: false,
  launcherOpen: false,
  assistantOpen: false,
  whatsNewOpen: false,
  composerStt: true,
  defaultTerminalFontSize: 13,
  notificationMaster: true,
  doneNotifications: {
    jarvis: true,
    terminal: true,
    tasks: true,
    contextMaps: true,
    skills: true,
  },
  aiCompletionCue: true,
  route: 'chat',
  callModalOpen: false,
  lastSeenWhatsNewVersion: null,
  wellnessActive: false,
  wellnessKind: null,
  wellnessStartedAt: null,
  wellnessDurationMs: null,
  actionsPaletteOpen: false,
};

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      ...defaults,

      toggleNav: () => set((s) => ({ navOpen: !s.navOpen })),
      toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
      togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
      setPaletteOpen: (open) => set({ paletteOpen: open }),
      toggleVoice: () => set((s) => ({ voiceModalOpen: !s.voiceModalOpen })),
      setVoiceListening: (v) => set({ voiceListening: v }),
      setVoiceModalOpen: (v) => set({ voiceModalOpen: v }),
      setSettingsOpen: (v) => set({ settingsOpen: v }),
      setActiveChat: (id) => set({ activeChatId: id }),
      setActiveAgent: (id) => set({ activeAgentId: id }),
      toggleNavSection: (id) =>
        set((s) => ({
          navSectionsCollapsed: {
            ...s.navSectionsCollapsed,
            [id]: !s.navSectionsCollapsed[id],
          },
        })),
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
      setAmbientDrone: (v) => set({ ambientDrone: v }),
      setAmbientTrack: (t) => set({ ambientTrack: t }),
      setAmbientVolume: (v) => set({ ambientVolume: Math.max(0, Math.min(100, v)) }),
      setAmbientAlwaysPlay: (v) => set({ ambientAlwaysPlay: v }),
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
      setLauncherOpen: (v) => set({ launcherOpen: v }),
      setAssistantOpen: (v) => set({ assistantOpen: v }),
      setWhatsNewOpen: (v) => set({ whatsNewOpen: v }),
      setComposerStt: (v) => set({ composerStt: v }),
      setDefaultTerminalFontSize: (v) => set({ defaultTerminalFontSize: Math.max(1, Math.min(100, v)) }),
      setNotificationMaster: (v) => set({ notificationMaster: v }),
      setDoneNotification: (key, enabled) =>
        set((s) => ({
          doneNotifications: {
            ...s.doneNotifications,
            [key]: enabled,
          },
        })),
      setAiCompletionCue: (v) => set({ aiCompletionCue: v }),

      // V3
      setRoute: (r) => set({ route: r }),
      setCallModalOpen: (v) => set({ callModalOpen: v }),
      markWhatsNewSeen: (version) => set({ lastSeenWhatsNewVersion: version }),

      startWellness: (kind, durationMs) =>
        set({
          wellnessActive: true,
          wellnessKind: kind,
          wellnessStartedAt: Date.now(),
          wellnessDurationMs: Math.max(1000, durationMs),
        }),
      endWellness: () =>
        set({
          wellnessActive: false,
          wellnessKind: null,
          wellnessStartedAt: null,
          wellnessDurationMs: null,
        }),
      setActionsPaletteOpen: (v) => set({ actionsPaletteOpen: v }),
      toggleActionsPalette: () =>
        set((s) => ({ actionsPaletteOpen: !s.actionsPaletteOpen })),
    }),
    {
      name: 'jarvis-ui',
      storage: createJSONStorage(() => safeLocalStorage),
      version: 1,
      migrate: (persistedState: any, version: number) => {
        if (version < 1) {
          console.info(`[useUIStore] Migrating persisted state from version ${version} to 1`);
          const safeKeys = [
            'navOpen', 'inspectorOpen', 'activeChatId', 'activeAgentId', 'route',
            'navSectionsCollapsed', 'chatMode', 'theme', 'density', 'onboardingComplete',
            'ambient', 'ambientThresholdMs', 'ambientDrone', 'ambientTrack', 'ambientVolume',
            'ambientAlwaysPlay', 'composerStt', 'defaultTerminalFontSize', 'notificationMaster',
            'doneNotifications', 'aiCompletionCue', 'lastSeenWhatsNewVersion'
          ];
          const migrated: Record<string, any> = {};
          if (persistedState && typeof persistedState === 'object') {
            for (const key of safeKeys) {
              if (key in persistedState) {
                migrated[key] = persistedState[key];
              }
            }
          }
          measureStorageSizes('migration', true);
          return migrated;
        }
        return persistedState;
      },
      partialize: (s) => ({
        navOpen: s.navOpen,
        inspectorOpen: s.inspectorOpen,
        activeChatId: s.activeChatId,
        activeAgentId: s.activeAgentId,
        route: s.route,
        navSectionsCollapsed: s.navSectionsCollapsed,
        chatMode: s.chatMode,
        theme: s.theme,
        density: s.density,
        onboardingComplete: s.onboardingComplete,
        ambient: s.ambient,
        ambientThresholdMs: s.ambientThresholdMs,
        ambientDrone: s.ambientDrone,
        ambientTrack: s.ambientTrack,
        ambientVolume: s.ambientVolume,
        ambientAlwaysPlay: s.ambientAlwaysPlay,
        composerStt: s.composerStt,
        defaultTerminalFontSize: s.defaultTerminalFontSize,
        notificationMaster: s.notificationMaster,
        doneNotifications: s.doneNotifications,
        aiCompletionCue: s.aiCompletionCue,
        lastSeenWhatsNewVersion: s.lastSeenWhatsNewVersion,
      }),
    },
  ),
);

// Trigger debug-gated boot diagnostics on initialization
measureStorageSizes('boot');
