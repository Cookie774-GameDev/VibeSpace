/**
 * Terminal transcript store — keeps a ring buffer of recent PTY output
 * per session, indexed by both session id and agent slug.
 *
 * Why this exists: a Jarvis "swarm" pane can be tagged with an agent
 * slug (e.g. `builder`) and run a CLI inside it (Claude Code, OpenCode).
 * When the user later messages the chat — "what did Claude just say?" —
 * the AI runtime needs to know the answer without the user copy-
 * pasting. This store gives the runtime a clean text view of what's
 * been on each pane recently.
 *
 * Two indices are maintained because the consumers want different
 * answers:
 *   - by `sessionId`   → "what did this specific PTY emit lately?"
 *     used by the pane chrome's tooltip + future replay UI.
 *   - by `agentSlug`   → "what did the Builder agent just do?"
 *     used by the AI runtime when resolving `@builder` in chat.
 *
 * Memory bound: each entry holds a single string capped at
 * `MAX_BYTES_PER_SESSION`. We drop bytes off the front as new bytes
 * arrive. ANSI escape sequences are stripped on the way in so the
 * stored text is what a human (or LLM) can read without filtering.
 *
 * Lifecycle: TerminalView calls `appendOutput` on every
 * `terminal://output` event and `forgetSession` when it unmounts. The
 * store survives route changes — you can leave the Terminals page,
 * come back, and the captured context is still there until the PTY
 * is killed and re-spawned.
 */

import { create } from 'zustand';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Per-session cap. 32 KB is enough to hold the equivalent of ~500 lines
 * of compiler output or a typical Claude Code turn. Beyond that, older
 * bytes are dropped — long-running sessions still get a useful "last
 * few minutes" window without ballooning memory.
 */
export const MAX_BYTES_PER_SESSION = 32 * 1024;

/**
 * Truncation marker prefixed when the buffer is full and we drop
 * bytes off the front. Helps the LLM (and humans) understand that
 * what they're reading is a tail, not the full transcript.
 */
const TRUNCATION_MARKER = '[…earlier output trimmed…]\n';
const TRANSCRIPT_STORAGE_DEBOUNCE_MS = 350;
const TRANSCRIPT_STORAGE_KEY = 'jarvis-terminal-transcripts';

/* -------------------------------------------------------------------------- */
/*  ANSI stripping                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Strip ANSI escape sequences (CSI, OSC, DCS, simple SGR) so the
 * stored transcript reads as plain text. The regex covers:
 *   \x1B[ ... letter   — CSI sequences (most colour/movement codes)
 *   \x1B] ... \x07     — OSC (window titles, hyperlinks)
 *   \x1B] ... \x1B\\   — OSC terminated with ST
 *   \x1BP ... \x1B\\   — DCS sequences
 *   \x1B (a-z)         — single-char escapes
 *
 * We also drop bare control characters except for newline, tab,
 * carriage return — those carry layout meaning that's useful in a
 * transcript.
 */
const ANSI_REGEX =
  // CSI: ESC [ ... final byte in 0x40-0x7E
  /\x1B\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1BP[^\x1B]*\x1B\\|\x1B[A-Za-z]/g;

/**
 * Bare control-character regex. Keeps `\n`, `\r`, `\t` because they
 * preserve layout; drops everything else in the C0 range plus DEL.
 * Without this we'd see literal `^G` bell characters and form-feeds
 * polluting the LLM's input.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Public so tests + other consumers can compute the same view we
 * store. Kept pure so a caller can pre-compute a stripped string and
 * skip the redundant work in `appendOutput`.
 */
export function stripAnsi(input: string): string {
  if (!input) return '';
  return input.replace(ANSI_REGEX, '').replace(CONTROL_CHARS, '');
}

/* -------------------------------------------------------------------------- */
/*  Store shape                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One snapshot of a PTY session. Stored in a `Record` keyed by
 * sessionId so look-ups are O(1).
 */
export interface SessionTranscript {
  /** PTY session id (e.g. `pty_abc123`). */
  sessionId: string;
  /** Stable UI pane id, if known. Survives PTY respawns. */
  paneId?: string | null;
  /** Owning project id, used to prevent cross-project transcript repair. */
  projectId?: string | null;
  /** Agent slug bound to this pane, if any. May change if the user re-tags. */
  agentSlug: string | null;
  /** Optional CLI label (e.g. `claude`, `opencode`, `bash`). Pure UI metadata. */
  command: string | null;
  /** Stripped, ring-buffered text. */
  text: string;
  /** Raw transcript containing all escape codes for terminal state restoration. */
  rawText?: string;
  /** The currently typed draft input prompt line. */
  currentInput?: string;
  /** Wall-clock ms of the last appended chunk. */
  lastWriteAt: number;
  /** Total raw bytes received (pre-strip, pre-trim). Useful for "is this pane idle?". */
  bytesSeen: number;
}

interface TranscriptState {
  sessions: Record<string, SessionTranscript>;

  /** Bind the session to its agent + command so by-agent lookups work. */
  registerSession: (
    sessionId: string,
    init: { agentSlug?: string | null; command?: string | null; paneId?: string | null; projectId?: string | null },
  ) => void;

  /**
   * Re-tag a live session. The TerminalView calls this when the user
   * picks a new agent role from the pane chrome dropdown — we want
   * the existing transcript to flow under the new slug going forward
   * without losing the bytes already captured.
   */
  retagSession: (
    sessionId: string,
    agentSlug: string | null,
  ) => void;

  /** Append raw PTY bytes; performs ANSI strip + ring-buffer trim internally. */
  appendOutput: (sessionId: string, raw: string) => void;

  /** Track the current typed-but-not-submitted shell input for restore. */
  setCurrentInput: (sessionId: string, currentInput: string) => void;

  /** Forget a session entirely (called from TerminalView on unmount/kill). */
  forgetSession: (sessionId: string) => void;

  /** Transfer/copy transcript/session history from old session ID to new session ID and delete old ID. */
  transferSession: (oldSessionId: string, newSessionId: string) => void;

  /** Reset/erase transcript for a target session. */
  clearSessionTranscript: (sessionId: string) => void;

  /**
   * Test-only escape hatch. Wipes everything; used in `beforeEach`
   * to keep tests independent.
   */
  reset: () => void;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Append `chunk` to `existing`, keeping the result under
 * `MAX_BYTES_PER_SESSION` characters. When trimming is needed we
 * cut from the start (oldest) and prefix the result with a
 * truncation marker so consumers can tell.
 */
function appendBounded(existing: string, chunk: string): string {
  if (!chunk) return existing;
  const combined = existing + chunk;
  if (combined.length <= MAX_BYTES_PER_SESSION) return combined;
  // Reserve room for the marker so the final string still fits.
  const room = MAX_BYTES_PER_SESSION - TRUNCATION_MARKER.length;
  if (room <= 0) {
    // Pathological: chunk alone > cap. Take the tail, no marker.
    return combined.slice(-MAX_BYTES_PER_SESSION);
  }
  return TRUNCATION_MARKER + combined.slice(-room);
}

const pendingStorageWrites = new Map<string, string>();
let transcriptStorageTimer: ReturnType<typeof setTimeout> | null = null;

function loadInitialSessions(): Record<string, SessionTranscript> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(TRANSCRIPT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const sessions =
      parsed?.state?.sessions && typeof parsed.state.sessions === 'object'
        ? parsed.state.sessions
        : parsed?.sessions && typeof parsed.sessions === 'object'
          ? parsed.sessions
          : {};
    const next: Record<string, SessionTranscript> = {};
    for (const [sessionId, value] of Object.entries(sessions)) {
      if (!value || typeof value !== 'object') continue;
      const session = value as Partial<SessionTranscript>;
      const id = typeof session.sessionId === 'string' ? session.sessionId : sessionId;
      if (!id) continue;
      next[id] = {
        sessionId: id,
        paneId: typeof session.paneId === 'string' ? session.paneId : null,
        projectId: typeof session.projectId === 'string' ? session.projectId : null,
        agentSlug: typeof session.agentSlug === 'string' ? session.agentSlug : null,
        command: typeof session.command === 'string' ? session.command : null,
        text: typeof session.text === 'string' ? session.text.slice(-MAX_BYTES_PER_SESSION) : '',
        rawText: typeof session.rawText === 'string' ? session.rawText.slice(-MAX_BYTES_PER_SESSION) : '',
        currentInput: typeof session.currentInput === 'string' ? session.currentInput.slice(-4096) : '',
        lastWriteAt: typeof session.lastWriteAt === 'number' ? session.lastWriteAt : Date.now(),
        bytesSeen: typeof session.bytesSeen === 'number' ? session.bytesSeen : 0,
      };
    }
    return next;
  } catch {
    return {};
  }
}

function flushTranscriptStorage(): void {
  if (typeof window === 'undefined') return;
  if (transcriptStorageTimer) {
    clearTimeout(transcriptStorageTimer);
    transcriptStorageTimer = null;
  }
  try {
    pendingStorageWrites.set(
      TRANSCRIPT_STORAGE_KEY,
      JSON.stringify({ sessions: useTerminalTranscriptStore.getState().sessions }),
    );
  } catch {
    // If serialization fails, skip this flush rather than blocking output.
  }
  for (const [name, value] of pendingStorageWrites) {
    try {
      window.localStorage.setItem(name, value);
    } catch {
      // Terminal rendering should not stall if localStorage is full.
    }
  }
  pendingStorageWrites.clear();
}

function scheduleTranscriptStorageFlush(): void {
  if (typeof window === 'undefined' || transcriptStorageTimer) return;
  transcriptStorageTimer = setTimeout(
    flushTranscriptStorage,
    TRANSCRIPT_STORAGE_DEBOUNCE_MS,
  );
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushTranscriptStorage);
  window.addEventListener('beforeunload', flushTranscriptStorage);
}

/* -------------------------------------------------------------------------- */
/*  Zustand store                                                             */
/* -------------------------------------------------------------------------- */

export const useTerminalTranscriptStore = create<TranscriptState>()(
    (set) => ({
      sessions: loadInitialSessions(),

      registerSession: (sessionId, init) => {
        set((state) => {
          const existing = state.sessions[sessionId];
          return {
            sessions: {
              ...state.sessions,
                [sessionId]: {
                  sessionId,
                  paneId: init.paneId ?? existing?.paneId ?? null,
                  projectId: init.projectId ?? existing?.projectId ?? null,
                  agentSlug: init.agentSlug ?? existing?.agentSlug ?? null,
                  command: init.command ?? existing?.command ?? null,
                  text: existing?.text ?? '',
                  rawText: existing?.rawText ?? '',
                  currentInput: existing?.currentInput ?? '',
                  lastWriteAt: existing?.lastWriteAt ?? Date.now(),
                  bytesSeen: existing?.bytesSeen ?? 0,
                },
            },
          };
        });
        scheduleTranscriptStorageFlush();
      },

      retagSession: (sessionId, agentSlug) => {
        set((state) => {
          const cur = state.sessions[sessionId];
          if (!cur) return {};
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: { ...cur, agentSlug },
            },
          };
        });
        scheduleTranscriptStorageFlush();
      },

      appendOutput: (sessionId, raw) => {
        const cleaned = stripAnsi(raw);
        set((state) => {
          const cur = state.sessions[sessionId];
          if (!cur) return {};
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: {
                ...cur,
                text: appendBounded(cur.text, cleaned),
                rawText: appendBounded(cur.rawText ?? '', raw),
                bytesSeen: cur.bytesSeen + raw.length,
                lastWriteAt: Date.now(),
              },
            },
          };
        });
        scheduleTranscriptStorageFlush();
      },

      setCurrentInput: (sessionId, currentInput) => {
        set((state) => {
          const cur = state.sessions[sessionId];
          if (!cur || cur.currentInput === currentInput) return {};
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: {
                ...cur,
                currentInput,
                lastWriteAt: Date.now(),
              },
            },
          };
        });
        scheduleTranscriptStorageFlush();
      },

      forgetSession: (sessionId) => {
        set((state) => {
          if (!state.sessions[sessionId]) return {};
          const next = { ...state.sessions };
          delete next[sessionId];
          return { sessions: next };
        });
        scheduleTranscriptStorageFlush();
      },

      transferSession: (oldSessionId, newSessionId) => {
        set((state) => {
          const oldSession = state.sessions[oldSessionId];
          if (!oldSession) return {};
          const next = { ...state.sessions };
          next[newSessionId] = {
            ...oldSession,
            sessionId: newSessionId,
            lastWriteAt: Date.now(),
          };
          delete next[oldSessionId];
          return { sessions: next };
        });
        scheduleTranscriptStorageFlush();
      },

      clearSessionTranscript: (sessionId) => {
        set((state) => {
          const cur = state.sessions[sessionId];
          if (!cur) return {};
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: {
                ...cur,
                text: '',
                rawText: '',
                currentInput: '',
                bytesSeen: 0,
                lastWriteAt: Date.now(),
              },
            },
          };
        });
        scheduleTranscriptStorageFlush();
      },

      reset: () => {
        set({ sessions: {} });
        pendingStorageWrites.delete(TRANSCRIPT_STORAGE_KEY);
        if (transcriptStorageTimer) {
          clearTimeout(transcriptStorageTimer);
          transcriptStorageTimer = null;
        }
        if (typeof window !== 'undefined') {
          window.localStorage.removeItem(TRANSCRIPT_STORAGE_KEY);
        }
      },
    })
);

/* -------------------------------------------------------------------------- */
/*  Public selectors                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Read snapshot for a single session. Convenience over poking
 * `useTerminalTranscriptStore.getState().sessions[id]` from non-React
 * callers. Returns `undefined` when the session isn't tracked.
 */
export function getSessionTranscript(
  sessionId: string,
): SessionTranscript | undefined {
  return useTerminalTranscriptStore.getState().sessions[sessionId];
}

/**
 * Every session currently tagged with the given agent slug. Sessions
 * without an explicit slug are excluded; case-sensitive on slug match
 * (slugs are lowercase by convention).
 *
 * Returned in most-recently-active order so callers that only show
 * the top N get the freshest data.
 */
export function getSessionsForAgent(
  agentSlug: string,
): SessionTranscript[] {
  const all = Object.values(
    useTerminalTranscriptStore.getState().sessions,
  );
  const matches = all.filter((s) => s.agentSlug === agentSlug);
  matches.sort((a, b) => b.lastWriteAt - a.lastWriteAt);
  return matches;
}
