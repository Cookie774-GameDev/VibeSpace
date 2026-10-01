import { create } from 'zustand';
import {
  DEFAULT_PANEL_SIZE,
  MAX_CUSTOM_TEMPLATES,
  MAX_WORKBENCH_PANELS,
  PANEL_TITLES,
  type WallpaperId,
  type WorkbenchDocument,
  type WorkbenchPanel,
  type WorkbenchPanelKind,
  type WorkbenchPanelSettings,
  type WorkbenchTemplate,
  type WorkbenchView,
} from './types';
import { findBuiltInTemplate, instantiateTemplate, createWorkbenchId } from './templates';
import {
  createWorkbenchSyncChannel,
  loadWorkbenchDocument,
  saveWorkbenchDocument,
  serializeContentFingerprint,
  type WorkbenchSaveResult,
} from './persistence';
import { basename } from '@/features/files/projectFiles';
import {
  DEFAULT_WORKBENCH_NAME,
  resolveWorkbenchName,
  sanitizeWorkbenchName,
} from './workbenchName';
import { getDevicePreset, orientSize } from '@/features/preview/previewDevices';
import { buildDevicePreviewDocument } from './editorPreview';

interface WorkbenchSnapshot {
  panels: WorkbenchPanel[];
  view: WorkbenchView;
  name: string;
}

interface WorkbenchState extends WorkbenchDocument {
  selectedIds: string[];
  history: WorkbenchSnapshot[];
  future: WorkbenchSnapshot[];
  persistenceWarning: string | null;
  persistenceError: string | null;
  lastSavedFingerprint: string | null;
  lastKnownRevision: number;
  addPanel: (
    kind: WorkbenchPanelKind,
    at?: { x: number; y: number },
    settings?: WorkbenchPanelSettings,
  ) => string | null;
  updatePanel: (
    id: string,
    patch: Partial<WorkbenchPanel>,
    options?: { recordHistory?: boolean },
  ) => void;
  removePanel: (id: string) => void;
  duplicatePanel: (id: string) => void;
  selectPanel: (id: string, additive?: boolean) => void;
  clearSelection: () => void;
  bringToFront: (id: string) => void;
  setView: (view: Partial<WorkbenchView>) => void;
  setName: (name: string) => boolean;
  applyTemplate: (templateId: string) => boolean;
  saveTemplate: (name: string) => string | null;
  deleteTemplate: (templateId: string) => void;
  setWallpaper: (id: WallpaperId, assetUrl?: string) => void;
  configureWallpaper: (patch: Partial<WorkbenchDocument['wallpaper']>) => void;
  /** Viewport size of the spatial canvas (updated by WorkbenchCanvas). */
  canvasSize: { width: number; height: number };
  setCanvasSize: (size: { width: number; height: number }) => void;
  /**
   * Camera-only recenter: pan/zoom so all panels are visible.
   * Does NOT move, resize, or reorder panel nodes.
   */
  fitView: () => void;
  /** Destructive grid layout — only for explicit “rearrange” actions. */
  autoArrange: () => void;
  undo: () => void;
  redo: () => void;
  resetWorkbench: () => void;
  openFileInEditor: (path: string) => string | null;
  /**
   * Open (or refresh) a separate device-preview panel/tab for editor content.
   * One panel per device id so iPhone and iPad previews can sit side by side.
   */
  openDevicePreview: (input: {
    sourcePanelId: string;
    deviceId: string;
    language: string;
    content: string;
    label?: string;
    orientation?: 'portrait' | 'landscape';
    zoom?: number;
  }) => string | null;
  applyRemoteDocument: (document: WorkbenchDocument) => void;
  flushPersistence: () => WorkbenchSaveResult;
  toDocument: () => WorkbenchDocument;
}

const snapshot = (
  state: Pick<WorkbenchState, 'panels' | 'view' | 'name'>,
): WorkbenchSnapshot => ({
  panels: state.panels.map((panel) => ({ ...panel, settings: { ...panel.settings } })),
  view: { ...state.view },
  name: state.name,
});

const historyUpdate = (
  state: WorkbenchState,
  next: Partial<WorkbenchState>,
): Partial<WorkbenchState> => ({
  ...next,
  history: [...state.history.slice(-39), snapshot(state)],
  future: [],
  updatedAt: Date.now(),
});

export function createDefaultWorkbenchDocument(): WorkbenchDocument {
  const coding = findBuiltInTemplate('coding')!;
  return {
    version: 1,
    name: DEFAULT_WORKBENCH_NAME,
    revision: 0,
    panels: instantiateTemplate(coding),
    view: { x: 24, y: 24, zoom: 0.78 },
    wallpaper: {
      id: coding.wallpaperId,
      paused: false,
      interactive: true,
      intensity: 0.72,
      brightness: 0.5,
      quality: 'balanced',
    },
    customTemplates: [],
    updatedAt: Date.now(),
  };
}

const loaded =
  typeof window === 'undefined'
    ? { document: createDefaultWorkbenchDocument(), source: 'default' as const }
    : loadWorkbenchDocument(window.localStorage, createDefaultWorkbenchDocument);

const ORIGIN_ID =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `wb-${Date.now().toString(36)}`;

export const useWorkbenchStore = create<WorkbenchState>((set, get) => ({
  ...loaded.document,
  name: resolveWorkbenchName(loaded.document.name),
  revision: loaded.document.revision ?? 0,
  selectedIds: [],
  history: [],
  future: [],
  canvasSize: { width: 1200, height: 800 },
  persistenceWarning: loaded.warning ?? null,
  persistenceError: null,
  lastSavedFingerprint: serializeContentFingerprint(loaded.document),
  lastKnownRevision: loaded.document.revision ?? 0,

  toDocument: () => {
    const state = get();
    return {
      version: 1 as const,
      name: state.name,
      revision: state.revision,
      panels: state.panels,
      view: state.view,
      wallpaper: state.wallpaper,
      customTemplates: state.customTemplates,
      updatedAt: state.updatedAt,
    };
  },

  addPanel: (kind, at, initialSettings) => {
    if (get().panels.length >= MAX_WORKBENCH_PANELS) {
      set({ persistenceError: `Panel limit reached (${MAX_WORKBENCH_PANELS}).` });
      return null;
    }
    const id = createWorkbenchId(kind);
    set((state) => {
      const size = DEFAULT_PANEL_SIZE[kind];
      const maxZ = Math.max(0, ...state.panels.map((panel) => panel.z));
      const panel: WorkbenchPanel = {
        id,
        kind,
        title: PANEL_TITLES[kind],
        x: at?.x ?? 100 + state.panels.length * 28,
        y: at?.y ?? 90 + state.panels.length * 24,
        width: size.width,
        height: size.height,
        z: maxZ + 1,
        minimized: false,
        status: 'idle',
        settings: {
          ...(
          kind === 'browser'
            ? { url: 'https://developer.mozilla.org' }
            : kind === 'files'
              ? { route: 'files' }
              : kind === 'jarvis'
                ? { route: 'chat' }
                : kind === 'editor'
                ? { note: '', previewEnabled: false }
                  : {}),
          ...initialSettings,
        },
      };
      return historyUpdate(state, { panels: [...state.panels, panel], selectedIds: [id] });
    });
    return id;
  },

  updatePanel: (id, patch, options) =>
    set((state) => {
      const panels = state.panels.map((panel) =>
        panel.id === id
          ? {
              ...panel,
              ...patch,
              settings: patch.settings ? { ...panel.settings, ...patch.settings } : panel.settings,
            }
          : panel,
      );
      if (options?.recordHistory === false) {
        return { panels, updatedAt: Date.now() };
      }
      return historyUpdate(state, { panels });
    }),

  removePanel: (id) =>
    set((state) =>
      historyUpdate(state, {
        panels: state.panels.filter((panel) => panel.id !== id),
        selectedIds: state.selectedIds.filter((selected) => selected !== id),
      }),
    ),

  duplicatePanel: (id) =>
    set((state) => {
      if (state.panels.length >= MAX_WORKBENCH_PANELS) {
        return { persistenceError: `Panel limit reached (${MAX_WORKBENCH_PANELS}).` };
      }
      const source = state.panels.find((panel) => panel.id === id);
      if (!source) return state;
      const nextId = createWorkbenchId(source.kind);
      const clone: WorkbenchPanel = {
        ...source,
        id: nextId,
        title: `${source.title} copy`,
        x: source.x + 36,
        y: source.y + 36,
        z: Math.max(...state.panels.map((panel) => panel.z), 0) + 1,
        status: 'idle',
        settings: { ...source.settings, resourceId: undefined },
      };
      return historyUpdate(state, { panels: [...state.panels, clone], selectedIds: [nextId] });
    }),

  selectPanel: (id, additive = false) =>
    set((state) => ({
      selectedIds: additive
        ? state.selectedIds.includes(id)
          ? state.selectedIds.filter((selected) => selected !== id)
          : [...state.selectedIds, id]
        : [id],
    })),
  clearSelection: () => set({ selectedIds: [] }),
  bringToFront: (id) =>
    set((state) => ({
      panels: state.panels.map((panel) =>
        panel.id === id
          ? { ...panel, z: Math.max(...state.panels.map((entry) => entry.z), 0) + 1 }
          : panel,
      ),
    })),
  setView: (view) =>
    set((state) => ({
      view: {
        x: Number.isFinite(view.x) ? (view.x as number) : state.view.x,
        y: Number.isFinite(view.y) ? (view.y as number) : state.view.y,
        zoom: Math.max(0.25, Math.min(2, view.zoom ?? state.view.zoom)),
      },
      updatedAt: Date.now(),
    })),

  setName: (name) => {
    const safe = sanitizeWorkbenchName(name);
    if (!safe) return false;
    set({ name: safe, updatedAt: Date.now() });
    return true;
  },

  applyTemplate: (templateId) => {
    const state = get();
    const template =
      findBuiltInTemplate(templateId) ??
      state.customTemplates.find((entry) => entry.id === templateId);
    if (!template) return false;
    set((current) =>
      historyUpdate(current, {
        panels: instantiateTemplate(template),
        selectedIds: [],
        view: { x: 24, y: 24, zoom: template.panels.length > 6 ? 0.68 : 0.8 },
        wallpaper: { ...current.wallpaper, id: template.wallpaperId, assetUrl: undefined },
      }),
    );
    // Immediate flush after template switch (caller may also flush).
    get().flushPersistence();
    return true;
  },

  saveTemplate: (name) => {
    const trimmed = name.trim().slice(0, 120);
    if (!trimmed) return null;
    if (get().customTemplates.length >= MAX_CUSTOM_TEMPLATES) {
      set({ persistenceError: `Template limit reached (${MAX_CUSTOM_TEMPLATES}).` });
      return null;
    }
    const id = createWorkbenchId('template');
    set((state) => {
      const template: WorkbenchTemplate = {
        id,
        name: trimmed,
        description: 'Saved from this Workbench layout.',
        builtIn: false,
        wallpaperId: state.wallpaper.id,
        panels: state.panels.map(({ id: _id, z: _z, status: _status, ...panel }) => ({
          ...panel,
          settings: { ...panel.settings, resourceId: undefined },
        })),
      };
      return { customTemplates: [...state.customTemplates, template], updatedAt: Date.now() };
    });
    return id;
  },
  deleteTemplate: (templateId) =>
    set((state) => ({
      customTemplates: state.customTemplates.filter((entry) => entry.id !== templateId),
      updatedAt: Date.now(),
    })),
  setWallpaper: (id, assetUrl) =>
    set((state) => ({
      wallpaper: { ...state.wallpaper, id, assetUrl },
      updatedAt: Date.now(),
    })),
  configureWallpaper: (patch) =>
    set((state) => ({
      wallpaper: {
        ...state.wallpaper,
        ...patch,
        intensity: Math.max(0, Math.min(1, patch.intensity ?? state.wallpaper.intensity)),
        brightness: Math.max(0, Math.min(1, patch.brightness ?? state.wallpaper.brightness)),
      },
      updatedAt: Date.now(),
    })),

  setCanvasSize: (size) =>
    set({
      canvasSize: {
        width: Math.max(1, size.width),
        height: Math.max(1, size.height),
      },
    }),

  fitView: () =>
    set((state) => {
      const { panels, canvasSize } = state;
      const pad = 80;
      if (panels.length === 0) {
        return {
          view: { x: 24, y: 24, zoom: 0.8 },
          updatedAt: Date.now(),
        };
      }
      const minX = Math.min(...panels.map((panel) => panel.x));
      const minY = Math.min(...panels.map((panel) => panel.y));
      const maxX = Math.max(...panels.map((panel) => panel.x + panel.width));
      const maxY = Math.max(
        ...panels.map((panel) => panel.y + (panel.minimized ? 42 : panel.height)),
      );
      const width = Math.max(1, maxX - minX);
      const height = Math.max(1, maxY - minY);
      const zoom = Math.max(
        0.25,
        Math.min(
          1.1,
          (canvasSize.width - pad) / width,
          (canvasSize.height - pad) / height,
        ),
      );
      // Only the camera moves — panel x/y/width/height stay exactly as the user left them.
      return {
        view: {
          zoom,
          x: (canvasSize.width - width * zoom) / 2 - minX * zoom,
          y: (canvasSize.height - height * zoom) / 2 - minY * zoom,
        },
        updatedAt: Date.now(),
      };
    }),

  autoArrange: () =>
    set((state) => {
      const columns = Math.max(1, Math.ceil(Math.sqrt(state.panels.length)));
      const panels = state.panels.map((panel, index) => ({
        ...panel,
        x: 80 + (index % columns) * 500,
        y: 80 + Math.floor(index / columns) * 390,
        width: Math.min(panel.width, 460),
        height: Math.min(panel.height, 350),
        z: index + 1,
      }));
      return historyUpdate(state, { panels, view: { x: 24, y: 24, zoom: 0.72 } });
    }),

  undo: () =>
    set((state) => {
      const previous = state.history.at(-1);
      if (!previous) return state;
      return {
        panels: previous.panels,
        view: previous.view,
        name: previous.name,
        history: state.history.slice(0, -1),
        future: [snapshot(state), ...state.future.slice(0, 39)],
        selectedIds: [],
        updatedAt: Date.now(),
      };
    }),
  redo: () =>
    set((state) => {
      const next = state.future[0];
      if (!next) return state;
      return {
        panels: next.panels,
        view: next.view,
        name: next.name,
        history: [...state.history.slice(-39), snapshot(state)],
        future: state.future.slice(1),
        selectedIds: [],
        updatedAt: Date.now(),
      };
    }),
  resetWorkbench: () =>
    set((state) => ({
      ...createDefaultWorkbenchDocument(),
      customTemplates: state.customTemplates,
      selectedIds: [],
      history: [],
      future: [],
      persistenceWarning: null,
      persistenceError: null,
      lastSavedFingerprint: null,
      lastKnownRevision: state.lastKnownRevision,
    })),

  openFileInEditor: (path) => {
    const clean = path.trim();
    if (!clean) return null;
    const state = get();
    const existing = state.panels.find(
      (panel) => panel.kind === 'editor' && panel.settings.filePath === clean,
    );
    if (existing) {
      get().bringToFront(existing.id);
      get().selectPanel(existing.id);
      return existing.id;
    }
    let editor = state.panels.find((panel) => panel.kind === 'editor' && !panel.settings.filePath);
    if (!editor) {
      const id = get().addPanel('editor');
      if (!id) return null;
      editor = get().panels.find((panel) => panel.id === id);
    }
    if (!editor) return null;
    get().updatePanel(editor.id, {
      title: basename(clean) || 'Editor',
      status: 'ready',
      settings: {
        ...editor.settings,
        filePath: clean,
        note: undefined,
        language: clean.split('.').pop()?.toLowerCase(),
      },
    });
    get().bringToFront(editor.id);
    get().selectPanel(editor.id);
    return editor.id;
  },

  openDevicePreview: (input) => {
    if (get().panels.length >= MAX_WORKBENCH_PANELS) {
      set({ persistenceError: `Panel limit reached (${MAX_WORKBENCH_PANELS}).` });
      return null;
    }
    const deviceId = input.deviceId || 'iphone-15';
    const preset = getDevicePreset(deviceId);
    const orientation = input.orientation ?? 'portrait';
    const zoom = Math.min(1, Math.max(0.25, input.zoom ?? 0.5));
    const logical = orientSize(preset, orientation, 390, 844, 800, 600);
    const doc = buildDevicePreviewDocument(input.language, input.content);
    const label = (input.label || input.language || 'preview').slice(0, 40);
    const title = `${preset.name} · ${label}`.slice(0, 80);

    // One dedicated tab per device (+ source editor) so multiple devices can be open.
    const existing = get().panels.find(
      (p) =>
        p.kind === 'device-preview' &&
        p.settings.sourcePanelId === input.sourcePanelId &&
        p.settings.previewDeviceId === deviceId,
    );

    if (existing) {
      get().updatePanel(existing.id, {
        title,
        status: 'ready',
        settings: {
          ...existing.settings,
          sourcePanelId: input.sourcePanelId,
          previewDeviceId: deviceId,
          previewOrientation: orientation,
          previewZoom: zoom,
          previewShowFrame: true,
          previewDocument: doc,
          previewLabel: label,
          language: input.language,
        },
      });
      get().bringToFront(existing.id);
      get().selectPanel(existing.id);
      return existing.id;
    }

    const id = createWorkbenchId('device-preview');
    // Panel chrome needs room for exact device + chrome; size to scaled viewport + padding.
    const padX = 48;
    const padY = 120;
    const width = Math.min(920, Math.max(360, Math.round(logical.width * zoom) + padX));
    const height = Math.min(980, Math.max(420, Math.round(logical.height * zoom) + padY));

    set((state) => {
      const maxZ = Math.max(0, ...state.panels.map((p) => p.z));
      const source = state.panels.find((p) => p.id === input.sourcePanelId);
      const panel: WorkbenchPanel = {
        id,
        kind: 'device-preview',
        title,
        x: (source?.x ?? 120) + (source?.width ?? 400) + 28,
        y: source?.y ?? 80,
        width,
        height,
        z: maxZ + 1,
        minimized: false,
        status: 'ready',
        settings: {
          sourcePanelId: input.sourcePanelId,
          previewDeviceId: deviceId,
          previewOrientation: orientation,
          previewZoom: zoom,
          previewShowFrame: true,
          previewDocument: doc,
          previewLabel: label,
          language: input.language,
        },
      };
      return historyUpdate(state, { panels: [...state.panels, panel], selectedIds: [id] });
    });
    return id;
  },

  applyRemoteDocument: (document) => {
    const state = get();
    if ((document.revision ?? 0) <= state.lastKnownRevision) return;
    set({
      name: resolveWorkbenchName(document.name),
      revision: document.revision,
      panels: document.panels,
      view: document.view,
      wallpaper: document.wallpaper,
      customTemplates: document.customTemplates,
      updatedAt: document.updatedAt,
      lastKnownRevision: document.revision,
      lastSavedFingerprint: serializeContentFingerprint(document),
      selectedIds: [],
      history: [],
      future: [],
    });
  },

  flushPersistence: () => {
    if (typeof window === 'undefined') return { ok: true, skipped: true };
    const state = get();
    const document = state.toDocument();
    const fingerprint = serializeContentFingerprint(document);
    if (fingerprint === state.lastSavedFingerprint) {
      return { ok: true, skipped: true, document };
    }
    const result = saveWorkbenchDocument(document, window.localStorage, {
      lastKnownRevision: state.lastKnownRevision,
    });
    if (result.ok && result.document) {
      set({
        revision: result.document.revision,
        lastKnownRevision: result.document.revision,
        lastSavedFingerprint: serializeContentFingerprint(result.document),
        updatedAt: result.document.updatedAt,
        persistenceError: null,
      });
      syncChannel?.post(result.document);
      return result;
    }
    if (result.reason === 'stale' && result.document) {
      get().applyRemoteDocument(result.document);
      set({
        persistenceWarning: 'Another Workbench window had newer changes; adopted that state.',
      });
      return result;
    }
    if (result.reason === 'quota') {
      set({ persistenceError: 'Workbench could not save — browser storage is full.' });
    } else if (result.reason === 'limit') {
      set({ persistenceError: 'Workbench could not save — panel or template limit exceeded.' });
    } else if (!result.ok) {
      set({ persistenceError: 'Workbench could not save layout state.' });
    }
    return result;
  },
}));

let saveTimer: number | null = null;
let safetyTimer: number | null = null;
let syncChannel: ReturnType<typeof createWorkbenchSyncChannel> | null = null;
let pendingDirty = false;

const SAVE_DEBOUNCE_MS = 350;
const SAFETY_FLUSH_MS = 5000;

function scheduleSave(): void {
  if (typeof window === 'undefined') return;
  pendingDirty = true;
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    pendingDirty = false;
    useWorkbenchStore.getState().flushPersistence();
  }, SAVE_DEBOUNCE_MS);
}

if (typeof window !== 'undefined') {
  syncChannel = createWorkbenchSyncChannel((document) => {
    useWorkbenchStore.getState().applyRemoteDocument(document);
  }, ORIGIN_ID);

  useWorkbenchStore.subscribe((state, prev) => {
    const meaningful =
      state.panels !== prev.panels ||
      state.view !== prev.view ||
      state.wallpaper !== prev.wallpaper ||
      state.customTemplates !== prev.customTemplates ||
      state.name !== prev.name;
    if (meaningful) scheduleSave();
  });

  safetyTimer = window.setInterval(() => {
    if (pendingDirty) {
      pendingDirty = false;
      useWorkbenchStore.getState().flushPersistence();
    }
  }, SAFETY_FLUSH_MS);

  const flushNow = () => {
    if (saveTimer) window.clearTimeout(saveTimer);
    pendingDirty = false;
    useWorkbenchStore.getState().flushPersistence();
  };
  window.addEventListener('pagehide', flushNow);
  window.addEventListener('beforeunload', flushNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow();
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== 'vibespace-workbench:v1' || !event.newValue) return;
    try {
      const parsed = JSON.parse(event.newValue) as WorkbenchDocument;
      if (parsed?.version === 1) useWorkbenchStore.getState().applyRemoteDocument(parsed);
    } catch {
      // ignore
    }
  });
}

export function getWorkbenchOriginId(): string {
  return ORIGIN_ID;
}
