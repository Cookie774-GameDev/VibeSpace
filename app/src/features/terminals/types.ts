/**
 * Local types for the terminals feature.
 *
 * `TerminalViewProps` is the public contract shared with Slice 4 (the
 * terminal grid host). Don't change shape without bumping
 * WAVE4_CONTRACTS.md.
 */
export interface TerminalViewProps {
  /** Existing session to attach to. `null`/`undefined` => spawn fresh on mount. */
  sessionId?: string | null;
  /** Default shell or command to run when spawning. */
  command?: string;
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Initial rows passed to `terminal_spawn`. Default 30. */
  rows?: number;
  /** Initial cols passed to `terminal_spawn`. Default 100. */
  cols?: number;
  /** Class name applied to the chrome wrapper. */
  className?: string;
  /** Fired once the session is live (post-spawn or on attach). */
  onReady?: (sessionId: string) => void;
  /**
   * Fired exactly once per mount when the PTY ends.
   * `code` is the exit code from the backend, or `null` when the user
   * killed the session via the chrome × button.
   */
  onExit?: (code: number | null) => void;
}
