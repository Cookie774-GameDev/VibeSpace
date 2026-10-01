import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  BrowserConsoleEntry,
  BrowserControlMode,
  BrowserReviewedAction,
  BrowserReviewedActionStatus,
  BrowserRuntimeInfo,
  BrowserTab,
} from './browserTypes';

function tabId() {
  return `tab-${Math.random().toString(36).slice(2, 10)}`;
}

function blankTab(url = 'about:blank'): BrowserTab {
  return {
    id: tabId(),
    url,
    title: url === 'about:blank' ? 'New Tab' : url,
    loading: false,
    pinned: false,
    muted: false,
    controlMode: 'ask_every_action',
  };
}

const BROWSER_REVIEW_LIMIT = 100;

function cloneBrowserJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneBrowserJson(entry)) as T;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneBrowserJson(entry)]),
    ) as T;
  }
  return value;
}

function cloneReviewedAction(action: BrowserReviewedAction): BrowserReviewedAction {
  return {
    ...action,
    requester: {
      kind: 'agent',
      agent: { ...action.requester.agent },
      ...(action.requester.runId ? { runId: action.requester.runId } : {}),
    },
    target: {
      ...action.target,
      ...(action.target.coordinates ? { coordinates: { ...action.target.coordinates } } : {}),
    },
    parameters: cloneBrowserJson(action.parameters),
  };
}

const SAFE_RESULTS = new Set([
  'Denied by user.',
  'Denied by local browser stop.',
  'Browser Operator execution is unavailable until canonical approval is active.',
  'Browser Operator review expired.',
  'Approved browser operation completed and was observed.',
  'Canonical browser operation failed before verified settlement.',
  'Browser operation was cancelled before verified settlement.',
  'Browser Operator canonical parent authority is unavailable.',
]);

function safeResult(status: Exclude<BrowserReviewedActionStatus, 'pending'>, result?: string) {
  if (result && SAFE_RESULTS.has(result)) return result;
  if (status === 'denied') return 'Denied by user.';
  if (status === 'expired') return 'Browser Operator review expired.';
  if (status === 'completed') return 'Approved browser operation completed and was observed.';
  if (status === 'failed') return 'Canonical browser operation failed before verified settlement.';
  if (status === 'cancelled') return 'Browser operation was cancelled before verified settlement.';
  return 'Browser Operator execution is unavailable until canonical approval is active.';
}

export interface BrowserState {
  tabs: BrowserTab[];
  activeTabId: string;
  runtime: BrowserRuntimeInfo | null;
  frameDataUrl: string | null;
  consoleEntries: BrowserConsoleEntry[];
  agentActions: BrowserReviewedAction[];
  agentArmed: boolean;
  sidebarOpen: boolean;
  consoleOpen: boolean;
  findQuery: string;
  zoom: number;
  draftUrl: string;
  setDraftUrl: (v: string) => void;
  setRuntime: (r: BrowserRuntimeInfo | null) => void;
  setFrame: (dataUrl: string | null) => void;
  setActiveTab: (id: string) => void;
  newTab: (url?: string) => string;
  closeTab: (id: string) => void;
  updateTab: (id: string, patch: Partial<BrowserTab>) => void;
  restoreClosed: () => void;
  closedStack: BrowserTab[];
  pushConsole: (level: BrowserConsoleEntry['level'], text: string) => void;
  clearConsole: () => void;
  enqueueAgentAction: (action: BrowserReviewedAction) => string;
  resolveAgentAction: (
    id: string,
    status: Exclude<BrowserReviewedActionStatus, 'pending'>,
    result?: string,
  ) => void;
  abortAgentActions: () => void;
  setAgentArmed: (v: boolean) => void;
  setControlMode: (tabId: string, mode: BrowserControlMode) => void;
  setSidebarOpen: (v: boolean) => void;
  setConsoleOpen: (v: boolean) => void;
  setFindQuery: (v: string) => void;
  setZoom: (z: number) => void;
  activeTab: () => BrowserTab | undefined;
}

const initial = blankTab();

export const useBrowserStore = create<BrowserState>()(
  persist(
    (set, get) => ({
      tabs: [initial],
      activeTabId: initial.id,
      runtime: null,
      frameDataUrl: null,
      consoleEntries: [],
      agentActions: [],
      agentArmed: false,
      sidebarOpen: true,
      consoleOpen: false,
      findQuery: '',
      zoom: 1,
      draftUrl: '',
      closedStack: [],
      setDraftUrl: (draftUrl) => set({ draftUrl }),
      setRuntime: (runtime) => set({ runtime }),
      setFrame: (frameDataUrl) => set({ frameDataUrl }),
      setActiveTab: (activeTabId) => {
        const tab = get().tabs.find((t) => t.id === activeTabId);
        set({ activeTabId, draftUrl: tab?.url ?? get().draftUrl });
      },
      newTab: (url) => {
        const tab = blankTab(url);
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id, draftUrl: tab.url }));
        return tab.id;
      },
      closeTab: (id) =>
        set((s) => {
          const closing = s.tabs.find((t) => t.id === id);
          const tabs = s.tabs.filter((t) => t.id !== id);
          if (tabs.length === 0) {
            const t = blankTab();
            return {
              tabs: [t],
              activeTabId: t.id,
              draftUrl: t.url,
              closedStack: closing ? [closing, ...s.closedStack].slice(0, 10) : s.closedStack,
            };
          }
          const activeTabId = s.activeTabId === id ? tabs[tabs.length - 1]!.id : s.activeTabId;
          return {
            tabs,
            activeTabId,
            draftUrl: tabs.find((t) => t.id === activeTabId)?.url ?? '',
            closedStack: closing ? [closing, ...s.closedStack].slice(0, 10) : s.closedStack,
          };
        }),
      updateTab: (id, patch) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
        })),
      restoreClosed: () => {
        const [first, ...rest] = get().closedStack;
        if (!first) return;
        const tab = { ...first, id: tabId() };
        set((s) => ({
          tabs: [...s.tabs, tab],
          activeTabId: tab.id,
          draftUrl: tab.url,
          closedStack: rest,
        }));
      },
      pushConsole: (level, text) =>
        set((s) => ({
          consoleEntries: [
            { id: tabId(), level, text: text.slice(0, 2000), ts: Date.now() },
            ...s.consoleEntries,
          ].slice(0, 200),
        })),
      clearConsole: () => set({ consoleEntries: [] }),
      enqueueAgentAction: (action) => {
        const existing = get().agentActions.find((candidate) => candidate.id === action.id);
        if (existing) return existing.id;
        const entry = cloneReviewedAction({ ...action, status: 'pending', result: undefined });
        set((s) => ({
          agentActions: [
            entry,
            ...s.agentActions.filter((candidate) => candidate.id !== entry.id),
          ].slice(0, BROWSER_REVIEW_LIMIT),
          agentArmed: true,
        }));
        return entry.id;
      },
      resolveAgentAction: (id, status, result) =>
        set((s) => ({
          agentActions: s.agentActions.map((a) =>
            a.id === id && a.status === 'pending'
              ? { ...a, status, result: safeResult(status, result) }
              : a,
          ),
        })),
      abortAgentActions: () =>
        set((s) => ({
          agentActions: s.agentActions.map((a) =>
            a.status === 'pending'
              ? { ...a, status: 'denied', result: 'Denied by local browser stop.' }
              : a,
          ),
          agentArmed: false,
        })),
      setAgentArmed: (agentArmed) => set({ agentArmed }),
      setControlMode: (tabId, controlMode) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, controlMode } : t)),
        })),
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      setConsoleOpen: (consoleOpen) => set({ consoleOpen }),
      setFindQuery: (findQuery) => set({ findQuery }),
      setZoom: (zoom) => set({ zoom: Math.min(2, Math.max(0.5, zoom)) }),
      activeTab: () => get().tabs.find((t) => t.id === get().activeTabId),
    }),
    {
      name: 'vibespace-browser:v1',
      partialize: (s) => ({
        tabs: s.tabs.map(({ id, url, title, pinned, muted, controlMode }) => ({
          id,
          url,
          title,
          pinned,
          muted,
          controlMode,
          loading: false,
        })),
        activeTabId: s.activeTabId,
        zoom: s.zoom,
        sidebarOpen: s.sidebarOpen,
      }),
    },
  ),
);
