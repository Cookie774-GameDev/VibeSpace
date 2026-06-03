import type {
  ProjectId,
  TerminalPresetId,
  TerminalSessionId,
  Timestamped,
  WorkspaceId,
} from './common';

/**
 * Terminal subsystem.
 *
 * Built-in presets (Claude, OpenCode, Bash, PowerShell, Cmd, Python, Node,
 * Git status, npm-dev) live in code only — the only DB rows are
 * `user_defined: true` presets the user has created or built-ins they've
 * customised, in which case the user-defined row shadows the built-in.
 *
 * Sessions denormalize `preset_slug`, `shell_command`, `shell_args` at spawn
 * time so the session row stays usable after the originating preset is
 * deleted (X1 verifier finding 1.2).
 */

/** Lifecycle of a PTY-backed session. */
export type TerminalSessionStatus = 'running' | 'detached' | 'exited';

/**
 * View mode for the terminal canvas.
 *   single     — one pane fills the canvas
 *   grid       — 2-, 3-, or 4-pane grid (layout_id picks the variant)
 *   tabs       — single visible pane, others as tabs above
 *   fullscreen — focused pane fills the whole workspace area below TopBar
 *                (NavPane auto-collapse)
 */
export type TerminalViewMode = 'single' | 'grid' | 'tabs' | 'fullscreen';

/**
 * Slots inside a multi-pane layout. Plan-C grids cap at 4 visible panes;
 * we reserve 8 to keep the type future-proof without changing schema.
 */
export type TerminalPaneSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type TerminalPreset = {
  id: TerminalPresetId;
  /**
   * Workspace scope. Required when persisted; built-ins live in code only.
   * (X1 verifier finding 1.1: uniqueness is `[workspace_id+slug]`.)
   */
  workspace_id: WorkspaceId;
  name: string;
  slug: string;
  /** Executable, e.g. `claude`, `bash`, `pwsh.exe`. */
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Optional cwd override; defaults to project root. */
  cwd?: string;
  color_hue?: number;
  /** Lucide icon name. */
  icon?: string;
  /** True for one-shot commands (e.g. `git status`). Pane closes on exit. */
  one_shot: boolean;
  /** Auto-run on project open. */
  auto_run: boolean;
  /** Capability gate string, e.g. "node>=18". */
  requires?: string;
  /**
   * Always `true` for DB rows. Built-ins live in code; this column lets the
   * UI distinguish overrides vs user-created entries.
   */
  user_defined: boolean;
} & Timestamped;

export type TerminalSession = {
  id: TerminalSessionId;
  workspace_id: WorkspaceId;
  project_id?: ProjectId;
  title: string;
  preset_id?: TerminalPresetId;
  /** Denormalized at spawn — survives preset deletion. */
  preset_slug?: string;
  /** Denormalized command actually executed. */
  shell_command: string;
  /** Denormalized args list. */
  shell_args: string[];
  status: TerminalSessionStatus;
  pid?: number;
  cols: number;
  rows: number;
  cwd?: string;
  env?: Record<string, string>;
  exit_code?: number;
  one_shot: boolean;
  /** Unix ms — last input/output activity. */
  last_active_at: number;
  created_at: number;
};

export interface TerminalScrollbackChunk {
  session_id: TerminalSessionId;
  /** Monotonic per-session sequence number. Compound pkey [session_id+chunk_seq]. */
  chunk_seq: number;
  /** Base64-encoded raw bytes (terminal output is binary-safe). */
  data: string;
  created_at: number;
}

export interface TerminalLayout {
  /** Pkey — one layout per project. */
  project_id: ProjectId;
  view_mode: TerminalViewMode;
  /** Layout variant within view_mode, e.g. '1', '2-h', '2-v', '3', '4'. */
  layout_id: string;
  pane_assignments: Partial<Record<TerminalPaneSlot, TerminalSessionId>>;
  /** Resizable-panel ratios, e.g. {h: 0.5, vTop: 0.6}. */
  panel_sizes: Record<string, number>;
  /** When view_mode='fullscreen', which session is filling the canvas. */
  fullscreen_session_id?: TerminalSessionId;
  updated_at: number;
}

export type TerminalPresetInput = Pick<TerminalPreset, 'workspace_id' | 'name' | 'slug' | 'command'> &
  Partial<Omit<TerminalPreset, 'id' | 'created_at' | 'updated_at'>>;

export type TerminalSessionInput = Pick<TerminalSession, 'workspace_id' | 'title' | 'shell_command'> &
  Partial<Omit<TerminalSession, 'id' | 'created_at' | 'last_active_at'>>;
