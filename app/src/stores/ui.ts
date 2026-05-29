import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Theme } from '@/types/common';

/**
 * UI state - panes, modals, theme. Persisted across reloads.
 */

export type ChatMode = 'chat' | 'council' | 'doc' | 'code';

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
      }),
    },
  ),
);
