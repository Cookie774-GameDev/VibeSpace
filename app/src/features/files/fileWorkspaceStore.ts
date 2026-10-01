import * as React from 'react';

import type { ProjectId } from '@/types';

export type FileAssistantLine = {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
};

export type FileWorkspaceTab = {
  path: string;
  content: string;
  savedContent: string;
  loaded: boolean;
  askDraft: string;
  attachedSelection: string;
  assistantLines: FileAssistantLine[];
};

export type FileWorkspaceState = {
  tabs: FileWorkspaceTab[];
  activePath: string | null;
  sidebarWidth: number;
  askCollapsed: boolean;
  askOpenByDefault: boolean;
};

type PersistedFileWorkspace = Pick<
  FileWorkspaceState,
  'activePath' | 'sidebarWidth' | 'askCollapsed' | 'askOpenByDefault'
> & {
  openPaths: string[];
};

const STORAGE_PREFIX = 'vibespace-files-workspace-v1';
const DEFAULT_ASK_DRAFT = 'Explain this code and suggest a safe edit.';
export const MIN_FILES_SIDEBAR_WIDTH = 240;
export const MAX_FILES_SIDEBAR_WIDTH = 560;
export const DEFAULT_FILES_SIDEBAR_WIDTH = 360;

const states = new Map<string, FileWorkspaceState>();
const listeners = new Map<string, Set<() => void>>();

function projectKey(projectId: ProjectId | null): string {
  return projectId ?? '__default__';
}

function storageKey(projectId: ProjectId | null): string {
  return `${STORAGE_PREFIX}:${projectKey(projectId)}`;
}

function createTab(path: string): FileWorkspaceTab {
  return {
    path,
    content: '',
    savedContent: '',
    loaded: false,
    askDraft: DEFAULT_ASK_DRAFT,
    attachedSelection: '',
    assistantLines: [],
  };
}

export function clampFilesSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_FILES_SIDEBAR_WIDTH;
  return Math.min(MAX_FILES_SIDEBAR_WIDTH, Math.max(MIN_FILES_SIDEBAR_WIDTH, Math.round(width)));
}

export function fileWorkspaceTabLabel(path: string, openPaths: readonly string[]): string {
  const parts = path.split(/[\\/]/g).filter(Boolean);
  const name = parts.at(-1) ?? path;
  const duplicateCount = openPaths.filter((candidate) => {
    const candidateParts = candidate.split(/[\\/]/g).filter(Boolean);
    return (candidateParts.at(-1) ?? candidate) === name;
  }).length;
  return duplicateCount > 1 && parts.length > 1 ? `${parts.at(-2)}/${name}` : name;
}

function loadPersisted(projectId: ProjectId | null): FileWorkspaceState {
  const fallback: FileWorkspaceState = {
    tabs: [],
    activePath: null,
    sidebarWidth: DEFAULT_FILES_SIDEBAR_WIDTH,
    askCollapsed: false,
    askOpenByDefault: true,
  };
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(storageKey(projectId));
    if (!raw) return fallback;
    const value = JSON.parse(raw) as Partial<PersistedFileWorkspace>;
    const openPaths = Array.isArray(value.openPaths)
      ? [
          ...new Set(
            value.openPaths.filter(
              (path): path is string => typeof path === 'string' && path.length > 0,
            ),
          ),
        ]
      : [];
    const activePath =
      typeof value.activePath === 'string' && openPaths.includes(value.activePath)
        ? value.activePath
        : (openPaths[0] ?? null);
    return {
      tabs: openPaths.map(createTab),
      activePath,
      sidebarWidth: clampFilesSidebarWidth(value.sidebarWidth ?? DEFAULT_FILES_SIDEBAR_WIDTH),
      askCollapsed: Boolean(value.askCollapsed),
      askOpenByDefault: value.askOpenByDefault !== false,
    };
  } catch {
    return fallback;
  }
}

function persist(projectId: ProjectId | null, state: FileWorkspaceState): void {
  if (typeof window === 'undefined') return;
  const value: PersistedFileWorkspace = {
    openPaths: state.tabs.map((tab) => tab.path),
    activePath: state.activePath,
    sidebarWidth: state.sidebarWidth,
    askCollapsed: state.askCollapsed,
    askOpenByDefault: state.askOpenByDefault,
  };
  window.localStorage.setItem(storageKey(projectId), JSON.stringify(value));
  window.dispatchEvent(
    new CustomEvent('jarvis:files:workspace-changed', {
      detail: { projectId, activePath: state.activePath },
    }),
  );
}

function persistedLayoutChanged(previous: FileWorkspaceState, next: FileWorkspaceState): boolean {
  return (
    previous.activePath !== next.activePath ||
    previous.sidebarWidth !== next.sidebarWidth ||
    previous.askCollapsed !== next.askCollapsed ||
    previous.askOpenByDefault !== next.askOpenByDefault ||
    previous.tabs.length !== next.tabs.length ||
    previous.tabs.some((tab, index) => tab.path !== next.tabs[index]?.path)
  );
}

export function getFileWorkspaceState(projectId: ProjectId | null): FileWorkspaceState {
  const key = projectKey(projectId);
  const existing = states.get(key);
  if (existing) return existing;
  const hydrated = loadPersisted(projectId);
  states.set(key, hydrated);
  return hydrated;
}

function update(
  projectId: ProjectId | null,
  recipe: (current: FileWorkspaceState) => FileWorkspaceState,
): FileWorkspaceState {
  const key = projectKey(projectId);
  const previous = getFileWorkspaceState(projectId);
  const next = recipe(previous);
  if (next === previous) return previous;
  states.set(key, next);
  if (persistedLayoutChanged(previous, next)) persist(projectId, next);
  listeners.get(key)?.forEach((listener) => listener());
  return next;
}

export function subscribeFileWorkspace(
  projectId: ProjectId | null,
  listener: () => void,
): () => void {
  const key = projectKey(projectId);
  const projectListeners = listeners.get(key) ?? new Set<() => void>();
  projectListeners.add(listener);
  listeners.set(key, projectListeners);
  return () => {
    projectListeners.delete(listener);
    if (projectListeners.size === 0) listeners.delete(key);
  };
}

export function useFileWorkspace(projectId: ProjectId | null): FileWorkspaceState {
  return React.useSyncExternalStore(
    React.useCallback((listener) => subscribeFileWorkspace(projectId, listener), [projectId]),
    React.useCallback(() => getFileWorkspaceState(projectId), [projectId]),
    React.useCallback(() => getFileWorkspaceState(projectId), [projectId]),
  );
}

export function openWorkspaceFile(
  projectId: ProjectId | null,
  path: string,
  content: string,
): void {
  update(projectId, (current) => {
    const existing = current.tabs.find((tab) => tab.path === path);
    const tabs = existing
      ? current.tabs.map((tab) =>
          tab.path === path && !tab.loaded
            ? { ...tab, content, savedContent: content, loaded: true }
            : tab,
        )
      : [...current.tabs, { ...createTab(path), content, savedContent: content, loaded: true }];
    return {
      ...current,
      tabs,
      activePath: path,
      askCollapsed: existing ? current.askCollapsed : !current.askOpenByDefault,
    };
  });
}

export function patchWorkspaceTab(
  projectId: ProjectId | null,
  path: string,
  patch: Partial<Omit<FileWorkspaceTab, 'path'>>,
): void {
  update(projectId, (current) => ({
    ...current,
    tabs: current.tabs.map((tab) => (tab.path === path ? { ...tab, ...patch } : tab)),
  }));
}

export function reconcileWorkspaceFile(
  projectId: ProjectId | null,
  path: string,
  result: { ok: true; content: string } | { ok: false },
): 'updated' | 'closed-missing' | 'preserved-unsaved' | 'not-open' {
  const tab = getFileWorkspaceState(projectId).tabs.find((candidate) => candidate.path === path);
  if (!tab) return 'not-open';
  if (!result.ok) {
    if (tab.content !== tab.savedContent) return 'preserved-unsaved';
    closeWorkspaceFile(projectId, path);
    return 'closed-missing';
  }
  if (tab.content !== tab.savedContent) return 'preserved-unsaved';
  patchWorkspaceTab(projectId, path, {
    content: result.content,
    savedContent: result.content,
    loaded: true,
  });
  return 'updated';
}

export function activateWorkspaceFile(projectId: ProjectId | null, path: string): void {
  update(projectId, (current) =>
    current.tabs.some((tab) => tab.path === path) ? { ...current, activePath: path } : current,
  );
}

export function renameWorkspaceFile(
  projectId: ProjectId | null,
  path: string,
  newPath: string,
): boolean {
  const current = getFileWorkspaceState(projectId);
  if (!current.tabs.some((tab) => tab.path === path)) return false;
  if (current.tabs.some((tab) => tab.path === newPath)) return false;
  update(projectId, (state) => ({
    ...state,
    tabs: state.tabs.map((tab) => (tab.path === path ? { ...tab, path: newPath } : tab)),
    activePath: state.activePath === path ? newPath : state.activePath,
  }));
  return true;
}

export function closeWorkspaceFile(projectId: ProjectId | null, path: string): void {
  update(projectId, (current) => {
    const index = current.tabs.findIndex((tab) => tab.path === path);
    if (index < 0) return current;
    const tabs = current.tabs.filter((tab) => tab.path !== path);
    const activePath =
      current.activePath === path
        ? (tabs[index]?.path ?? tabs[index - 1]?.path ?? null)
        : current.activePath;
    return { ...current, tabs, activePath };
  });
}

export function setFilesSidebarWidth(projectId: ProjectId | null, width: number): void {
  update(projectId, (current) => ({
    ...current,
    sidebarWidth: clampFilesSidebarWidth(width),
  }));
}

export function setAskPanelCollapsed(projectId: ProjectId | null, collapsed: boolean): void {
  update(projectId, (current) => ({ ...current, askCollapsed: collapsed }));
}

export function setAskPanelDefault(projectId: ProjectId | null, openByDefault: boolean): void {
  update(projectId, (current) => ({ ...current, askOpenByDefault: openByDefault }));
}

export function resetFileWorkspaceForTests(): void {
  states.clear();
  listeners.clear();
}
