export const WORKBENCH_PANEL_KINDS = [
  'terminal',
  'browser',
  'jarvis',
  'agent',
  'files',
  'editor',
  'device-preview',
  'kanban',
  'actions',
  'notes',
  'diagram',
  'plugins',
  'plugin',
  'tools',
  'github',
  'supabase',
  'activity',
] as const;

export type WorkbenchPanelKind = (typeof WORKBENCH_PANEL_KINDS)[number];
export type WorkbenchPanelStatus = 'idle' | 'ready' | 'busy' | 'attention' | 'error';

export interface WorkbenchPanelSettings {
  url?: string;
  cwd?: string;
  command?: string;
  route?: string;
  resourceId?: string;
  agentId?: string;
  note?: string;
  language?: string;
  /** Absolute project file path for editor panels (live session only). */
  filePath?: string;
  /** Whether editor device preview is open. */
  previewEnabled?: boolean;
  /** Device preset id for editor preview (iphone-15, ipad-mini, …). */
  previewDeviceId?: string;
  /** Portrait or landscape for editor device preview. */
  previewOrientation?: 'portrait' | 'landscape';
  /** Show device chrome around the preview. */
  previewShowFrame?: boolean;
  /** Preview scale factor (0.25–1) — visual only; CSS viewport stays exact. */
  previewZoom?: number;
  /** Linked editor panel id for live device preview tabs. */
  sourcePanelId?: string;
  /** Snapshot / live document HTML for device-preview panels. */
  previewDocument?: string;
  /** Display name of the source file/language for device-preview chrome. */
  previewLabel?: string;
  /** Plugin manifest id for a pinned plugin dashboard panel. */
  pluginId?: string;
}

export interface WorkbenchPanel {
  id: string;
  kind: WorkbenchPanelKind;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  minimized: boolean;
  status: WorkbenchPanelStatus;
  settings: WorkbenchPanelSettings;
}

export type WorkbenchPanelTemplate = Omit<WorkbenchPanel, 'id' | 'z' | 'status'> & {
  status?: WorkbenchPanelStatus;
};

export interface WorkbenchView {
  x: number;
  y: number;
  zoom: number;
}

export type WallpaperId =
  | 'none'
  | 'warm-gradient'
  | 'space-clouds'
  | 'starfield'
  | 'orbital-lights'
  | 'particles'
  | 'fluid-gradient'
  | 'aurora'
  | 'cozy-night-window'
  | 'grid-pulse'
  | 'custom-image'
  | 'custom-video'
  | 'user-pack';

export interface WorkbenchWallpaperConfig {
  id: WallpaperId;
  paused: boolean;
  interactive: boolean;
  intensity: number;
  /** Wallpaper-layer brightness only, normalized from 0 to 1. */
  brightness: number;
  quality: 'low' | 'balanced' | 'high';
  assetUrl?: string;
}

export interface WorkbenchTemplate {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
  wallpaperId: WallpaperId;
  panels: WorkbenchPanelTemplate[];
}

export interface WorkbenchDocument {
  version: 1;
  /** User-facing Workbench name (live session). */
  name: string;
  /**
   * Monotonic revision for multi-window stale-write rejection.
   * Incremented on every successful persistence write.
   */
  revision: number;
  panels: WorkbenchPanel[];
  view: WorkbenchView;
  wallpaper: WorkbenchWallpaperConfig;
  customTemplates: WorkbenchTemplate[];
  updatedAt: number;
}

export const DEFAULT_PANEL_SIZE: Record<WorkbenchPanelKind, { width: number; height: number }> = {
  terminal: { width: 520, height: 300 },
  browser: { width: 680, height: 440 },
  jarvis: { width: 420, height: 520 },
  agent: { width: 330, height: 300 },
  files: { width: 320, height: 480 },
  editor: { width: 620, height: 440 },
  'device-preview': { width: 480, height: 720 },
  kanban: { width: 620, height: 420 },
  actions: { width: 360, height: 360 },
  notes: { width: 360, height: 330 },
  diagram: { width: 560, height: 400 },
  plugins: { width: 400, height: 360 },
  plugin: { width: 480, height: 420 },
  tools: { width: 680, height: 500 },
  github: { width: 440, height: 380 },
  supabase: { width: 480, height: 400 },
  activity: { width: 400, height: 360 },
};

export const PANEL_TITLES: Record<WorkbenchPanelKind, string> = {
  terminal: 'Terminal',
  browser: 'Browser',
  jarvis: 'Jarvis',
  agent: 'Agent',
  files: 'Project files',
  editor: 'Editor',
  'device-preview': 'Device preview',
  kanban: 'Kanban',
  actions: 'Jarvis actions',
  notes: 'Notes',
  diagram: 'Diagram',
  plugins: 'Plugins & MCP',
  plugin: 'Plugin',
  tools: 'Tools',
  github: 'GitHub',
  supabase: 'Supabase',
  activity: 'Activity',
};

/** Max panels accepted at write time (enforced before save). */
export const MAX_WORKBENCH_PANELS = 80;
/** Max custom templates. */
export const MAX_CUSTOM_TEMPLATES = 24;
