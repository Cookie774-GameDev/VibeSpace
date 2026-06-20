/**
 * Local types for the terminals feature.
 *
 * `TerminalViewProps` is the public contract shared with Slice 4 (the
 * terminal grid host). Don't change shape without bumping
 * WAVE4_CONTRACTS.md.
 */
import type { AgentCoordinationMode } from './agentCoordination';

export interface TerminalViewProps {
  /** Existing session to attach to. `null`/`undefined` => spawn fresh on mount. */
  sessionId?: string | null;
  /** Stable pane id used for terminal references across PTY respawns. */
  paneId?: string;
  /** Default shell or command to run when spawning. */
  command?: string;
  /** Command typed into the shell after spawn/attach. */
  startupCommand?: string;
  /** One-shot command requested by the assistant/action queue. */
  pendingCommand?: string;
  /** Token for repeated pending commands with identical text. */
  pendingCommandId?: number;
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Active project ID to scope the 10-terminal session limit. */
  projectId?: string | null;
  /** Active project name to associate with the terminal. */
  projectName?: string | null;
  /** Initial rows passed to `terminal_spawn`. Default 30. */
  rows?: number;
  /** Initial cols passed to `terminal_spawn`. Default 100. */
  cols?: number;
  /** Class name applied to the chrome wrapper. */
  className?: string;
  /**
   * Suppress the internal chrome strip + outer border. Used when the
   * parent (TileGrid pane, splits leaf) draws its own frame and a second
   * border would be visual noise. Default `false` preserves the legacy
   * standalone look for any other call site.
   */
  hideChrome?: boolean;
  /**
   * Per-pane font size in pixels. Cycled by the pane toolbar. When this
   * changes after mount, TerminalView updates `term.options.fontSize` and
   * re-fits so the PTY learns the new cols/rows. Default `13`.
   */
  fontSize?: number;
  /**
   * Optional agent slug bound to this pane (e.g. `'builder'`,
   * `'scout'`). Forwarded into the transcript store so the AI runtime
   * can later pull "what did Builder just do" by-slug rather than by
   *-session-id. Changing it after mount re-tags the live buffer
   * without losing what's already captured.
   */
  agentSlug?: string | null;
  /** Controls terminal agent prompt/context delivery and coordination behavior. */
  agentMode?: AgentCoordinationMode;
  /** Fired once the session is live (post-spawn or on attach). */
  onReady?: (sessionId: string) => void;
  /** Fired after a pending command has been written. */
  onPendingCommandSent?: () => void;
  /**
   * Fired exactly once per mount when the PTY ends.
   * `code` is the exit code from the backend, or `null` when the user
   * killed the session via the chrome A- button.
   */
  onExit?: (code: number | null) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}
