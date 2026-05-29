import { create } from 'zustand';
import {
  CalendarDays,
  CheckSquare,
  Code,
  FileText,
  History,
  LayoutGrid,
  ListPlus,
  ListTodo,
  type LucideIcon,
  Maximize2,
  MessageSquare,
  MessageSquarePlus,
  Mic,
  Monitor,
  Moon,
  Moon as Ambient,
  PanelLeft,
  PanelRight,
  Palette,
  Rocket,
  Settings,
  Sun,
  User,
  Users,
} from 'lucide-react';
import { HOTKEYS } from '@/lib/hotkeys';
import { useUIStore } from '@/stores/ui';
import type { PageId } from './store';

export type ActionId = string;

/**
 * Context handed to an action's perform function so it can drive the
 * palette UI (close, push a sub-page) without importing the palette.
 */
export type ActionContext = {
  /** Close the palette and reset its page stack. */
  closePalette: () => void;
  /** Navigate to a sub-page. */
  pushPage: (p: PageId) => void;
};

/**
 * A first-class action registered with the palette. Actions are
 * grouped by `page`: 'root' actions show on the top-level palette,
 * other pages show only when navigated to.
 *
 * Actions defined in this file are the built-in set. Other features
 * can append to the registry at runtime via {@link registerAction}.
 */
export type Action = {
  id: ActionId;
  label: string;
  description?: string;
  /** Icon shown left of the label */
  icon?: LucideIcon;
  /**
   * Optional global hotkey, expressed in the same string format used
   * by `useHotkey` (e.g. 'Mod+K'). Hotkeys are bound by
   * `useGlobalHotkeys` and rendered as a hint on the action item.
   */
  hotkey?: string;
  /** Page on which this action lives. */
  page: PageId;
  /** Extra search keywords for fuzzy matching (joined into the cmdk value). */
  keywords?: string[];
  /** Behavior to run when the user selects the action. */
  perform: (ctx: ActionContext) => void;
};

/**
 * Dispatch a global custom event. Used so the palette can notify
 * other features (chat, tasks, voice) without importing them.
 */
export function emitJarvisEvent(name: string, detail?: unknown): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

/* -------------------------------------------------------------------------
 * Built-in actions
 *
 * The set of standard actions shipped with the app. Each is grouped under
 * a page id. Register additional actions from feature code via
 * `registerAction`.
 * ------------------------------------------------------------------------- */

const STATIC_ACTIONS: Action[] = [
  // --- Root ---------------------------------------------------------------
  {
    id: 'new-chat',
    label: 'New chat',
    description: 'Start a new conversation',
    icon: MessageSquarePlus,
    hotkey: HOTKEYS.NEW_CHAT,
    page: 'root',
    keywords: ['create', 'thread', 'conversation'],
    perform: ({ closePalette }) => {
      emitJarvisEvent('jarvis:new-chat');
      closePalette();
    },
  },
  {
    id: 'new-task',
    label: 'New task...',
    description: 'Open the task composer',
    icon: ListPlus,
    page: 'root',
    keywords: ['todo', 'reminder', 'create'],
    perform: ({ closePalette }) => {
      emitJarvisEvent('jarvis:open-task-composer');
      closePalette();
    },
  },
  {
    id: 'switch-agent',
    label: 'Switch agent...',
    description: 'Change the active agent for this chat',
    icon: User,
    page: 'root',
    keywords: ['active', 'who', 'persona'],
    perform: ({ pushPage }) => pushPage('switch-agent'),
  },
  {
    id: 'switch-mode',
    label: 'Switch chat mode...',
    description: 'Chat, council, doc, or code',
    icon: LayoutGrid,
    page: 'root',
    keywords: ['council', 'doc', 'code', 'view'],
    perform: ({ pushPage }) => pushPage('switch-mode'),
  },
  {
    id: 'theme',
    label: 'Theme...',
    description: 'Dark, light, or system',
    icon: Palette,
    page: 'root',
    keywords: ['dark', 'light', 'appearance', 'color'],
    perform: ({ pushPage }) => pushPage('theme'),
  },
  {
    id: 'recent-chats',
    label: 'Recent chats...',
    description: 'Jump to a recent conversation',
    icon: History,
    page: 'root',
    keywords: ['history', 'previous', 'past'],
    perform: ({ pushPage }) => pushPage('recent-chats'),
  },
  {
    id: 'tasks',
    label: 'Tasks...',
    description: 'Browse open tasks',
    icon: CheckSquare,
    page: 'root',
    keywords: ['todo', 'list', 'reminders'],
    perform: ({ pushPage }) => pushPage('tasks'),
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: Settings,
    hotkey: HOTKEYS.SETTINGS,
    page: 'root',
    keywords: ['preferences', 'config'],
    perform: ({ closePalette }) => {
      useUIStore.getState().setSettingsOpen(true);
      closePalette();
    },
  },
  {
    id: 'toggle-voice',
    label: 'Voice',
    description: 'Toggle the voice modal',
    icon: Mic,
    hotkey: HOTKEYS.PUSH_TO_TALK,
    page: 'root',
    keywords: ['talk', 'speak', 'mic', 'jarvis'],
    perform: ({ closePalette }) => {
      useUIStore.getState().toggleVoice();
      closePalette();
    },
  },
  {
    id: 'toggle-nav',
    label: 'Toggle nav',
    icon: PanelLeft,
    hotkey: HOTKEYS.TOGGLE_NAV,
    page: 'root',
    keywords: ['sidebar', 'left', 'pane'],
    perform: ({ closePalette }) => {
      useUIStore.getState().toggleNav();
      closePalette();
    },
  },
  {
    id: 'toggle-inspector',
    label: 'Toggle inspector',
    icon: PanelRight,
    hotkey: HOTKEYS.TOGGLE_INSPECTOR,
    page: 'root',
    keywords: ['right', 'pane', 'tools', 'trace'],
    perform: ({ closePalette }) => {
      useUIStore.getState().toggleInspector();
      closePalette();
    },
  },
  {
    id: 'toggle-todo-drawer',
    label: 'Toggle to-do drawer',
    icon: ListTodo,
    hotkey: HOTKEYS.TOGGLE_TODO,
    page: 'root',
    keywords: ['tasks', 'tray'],
    perform: ({ closePalette }) => {
      useUIStore.getState().toggleTodoDrawer();
      closePalette();
    },
  },

  // V2 — Schedule
  {
    id: 'open-schedule',
    label: 'Schedule',
    description: 'Upcoming events and add-event form',
    icon: CalendarDays,
    hotkey: HOTKEYS.SCHEDULE,
    page: 'root',
    keywords: ['calendar', 'events', 'meetings', 'agenda'],
    perform: ({ closePalette }) => {
      useUIStore.getState().setScheduleOpen(true);
      closePalette();
    },
  },

  // V2 — Quick Launch
  {
    id: 'open-launcher',
    label: 'Quick Launch',
    description: 'One-click links, apps, and Jarvis actions',
    icon: Rocket,
    hotkey: HOTKEYS.LAUNCHER,
    page: 'root',
    keywords: ['links', 'launcher', 'pinned', 'shortcuts'],
    perform: ({ closePalette }) => {
      useUIStore.getState().setLauncherOpen(true);
      closePalette();
    },
  },

  // V2 — Fullscreen workspace toggle
  {
    id: 'toggle-fullscreen',
    label: 'Toggle fullscreen workspace',
    description: 'Hide nav + tasks pane',
    icon: Maximize2,
    hotkey: HOTKEYS.TOGGLE_FULLSCREEN,
    page: 'root',
    keywords: ['focus', 'distraction-free', 'maximize'],
    perform: ({ closePalette }) => {
      useUIStore.getState().toggleChatFullscreen();
      closePalette();
    },
  },

  // V2 — Ambient toggle
  {
    id: 'toggle-ambient',
    label: 'Ambient mode',
    description: 'Calm idle screen with breathing orb + clock',
    icon: Ambient,
    hotkey: HOTKEYS.AMBIENT_TOGGLE,
    page: 'root',
    keywords: ['idle', 'screensaver', 'rest'],
    perform: ({ closePalette }) => {
      const ui = useUIStore.getState();
      if (!ui.ambient) ui.setAmbient(true);
      ui.setAmbientActive(!ui.ambientActive);
      closePalette();
    },
  },

  // --- Theme sub-page -----------------------------------------------------
  {
    id: 'theme-dark',
    label: 'Dark',
    icon: Moon,
    page: 'theme',
    keywords: ['oled', 'night'],
    perform: ({ closePalette }) => {
      useUIStore.getState().setTheme('dark');
      closePalette();
    },
  },
  {
    id: 'theme-light',
    label: 'Light',
    icon: Sun,
    page: 'theme',
    keywords: ['day'],
    perform: ({ closePalette }) => {
      useUIStore.getState().setTheme('light');
      closePalette();
    },
  },
  {
    id: 'theme-system',
    label: 'System',
    icon: Monitor,
    page: 'theme',
    keywords: ['auto', 'os'],
    perform: ({ closePalette }) => {
      useUIStore.getState().setTheme('system');
      closePalette();
    },
  },

  // --- Switch chat mode sub-page -----------------------------------------
  {
    id: 'mode-chat',
    label: 'Chat',
    description: 'Single-agent thread',
    icon: MessageSquare,
    page: 'switch-mode',
    perform: ({ closePalette }) => {
      useUIStore.getState().setChatMode('chat');
      closePalette();
    },
  },
  {
    id: 'mode-council',
    label: 'Council',
    description: 'Multi-agent grid',
    icon: Users,
    page: 'switch-mode',
    perform: ({ closePalette }) => {
      useUIStore.getState().setChatMode('council');
      closePalette();
    },
  },
  {
    id: 'mode-doc',
    label: 'Doc',
    description: 'Long-form document',
    icon: FileText,
    page: 'switch-mode',
    perform: ({ closePalette }) => {
      useUIStore.getState().setChatMode('doc');
      closePalette();
    },
  },
  {
    id: 'mode-code',
    label: 'Code',
    description: 'Read-only code view',
    icon: Code,
    page: 'switch-mode',
    perform: ({ closePalette }) => {
      useUIStore.getState().setChatMode('code');
      closePalette();
    },
  },

  // --- "New" sub-page (extension hook for future creation flows) ---------
  {
    id: 'new-page-chat',
    label: 'New chat',
    icon: MessageSquarePlus,
    page: 'new',
    perform: ({ closePalette }) => {
      emitJarvisEvent('jarvis:new-chat');
      closePalette();
    },
  },
  {
    id: 'new-page-task',
    label: 'New task',
    icon: ListPlus,
    page: 'new',
    perform: ({ closePalette }) => {
      emitJarvisEvent('jarvis:open-task-composer');
      closePalette();
    },
  },
];

/* -------------------------------------------------------------------------
 * Mutable registry
 *
 * Built-in actions are appended to dynamically by `registerAction`. The
 * mutable list lives in a Zustand store so React subscribers update.
 * ------------------------------------------------------------------------- */

interface ActionRegistryState {
  dynamicActions: Action[];
  registerAction: (a: Action) => () => void;
  unregisterAction: (id: ActionId) => void;
}

const useActionRegistry = create<ActionRegistryState>()((set, get) => ({
  dynamicActions: [],
  registerAction: (a) => {
    set((s) => ({
      // Replace any existing action with the same id to keep the registry idempotent.
      dynamicActions: [...s.dynamicActions.filter((x) => x.id !== a.id), a],
    }));
    return () => get().unregisterAction(a.id);
  },
  unregisterAction: (id) =>
    set((s) => ({
      dynamicActions: s.dynamicActions.filter((x) => x.id !== id),
    })),
}));

/**
 * Register an action with the global palette registry. Returns a
 * disposer that removes the action.
 */
export function registerAction(a: Action): () => void {
  return useActionRegistry.getState().registerAction(a);
}

/**
 * Remove a registered action by id.
 */
export function unregisterAction(id: ActionId): void {
  useActionRegistry.getState().unregisterAction(id);
}

/**
 * Snapshot the full action set (static + dynamic). Non-reactive.
 */
export function getAllActions(): Action[] {
  return [...STATIC_ACTIONS, ...useActionRegistry.getState().dynamicActions];
}

/**
 * Run an action by id. Used by `useGlobalHotkeys` to perform an action
 * from outside the palette context, where there's no palette to close
 * or page to push.
 */
export function performAction(id: ActionId, ctx?: Partial<ActionContext>): void {
  const action = getAllActions().find((a) => a.id === id);
  if (!action) return;
  action.perform({
    closePalette: ctx?.closePalette ?? (() => undefined),
    pushPage: ctx?.pushPage ?? (() => undefined),
  });
}

/**
 * Hook: reactively get every action that belongs on a given page.
 */
export function useActionsForPage(page: PageId): Action[] {
  const dynamic = useActionRegistry((s) => s.dynamicActions);
  // Plain filter on each render is fine - the action set is small (<100).
  return [...STATIC_ACTIONS, ...dynamic].filter((a) => a.page === page);
}

/**
 * Build the cmdk `value` string for an action so fuzzy filtering matches
 * label, description, and keywords.
 */
export function actionSearchValue(a: Action): string {
  return [a.label, a.description ?? '', ...(a.keywords ?? [])].join(' ').toLowerCase();
}
