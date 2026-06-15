/**
 * Terminal transcript store â€” keeps a ring buffer of recent PTY output
 * per session, indexed by both session id and agent slug.
 *
 * Why this exists: a Jarvis "swarm" pane can be tagged with an agent
 * slug (e.g. `builder`) and run a CLI inside it (Claude Code, OpenCode).
 * When the user later messages the chat â€” "what did Claude just say?" â€”
 * the AI runtime needs to know the answer without the user copy-
 * pasting. This store gives the runtime a clean text view of what's
 * been on each pane recently.
 *
 * Two indices are maintained because the consumers want different
 * answers:
 *   - by `sessionId`   â†’ "what did this specific PTY emit lately?"
 *     used by the pane chrome's tooltip + future replay UI.
 *   - by `agentSlug`   â†’ "what did the Builder agent just do?"
 *     used by the AI runtime when resolving `@builder` in chat.
 *
 * Memory bound: each entry holds a single string capped at
 * `MAX_BYTES_PER_SESSION`. We drop bytes off the front as new bytes
 * arrive. ANSI escape sequences are stripped on the way in so the
 * stored text is what a human (or LLM) can read without filtering.
 *
 * Lifecycle: TerminalView calls `appendOutput` on every
 * `terminal://output` event and `forgetSession` when it unmounts. The
 * store survives route changes â€” you can leave the Terminals page,
 * come back, and the captured context is still there until the PTY
 * is killed and re-spawned.
 */

import { create } from 'zustand';
import {
  MAX_PENDING_ESCAPE_CHARS,
  splitTrailingIncompleteEscape,
} from './terminalEscape';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Per-session cap. 32 KB is enough to hold the equivalent of ~500 lines
 * of compiler output or a typical Claude Code turn. Beyond that, older
 * bytes are dropped â€” long-running sessions still get a useful "last
 * few minutes" window without ballooning memory.
 */
export const MAX_BYTES_PER_SESSION = 32 * 1024;
export const MAX_PERSISTED_SESSIONS = 10;
export const MAX_TOTAL_TRANSCRIPTS_SIZE_BYTES = 512 * 1024; // 512 KB

/**
 * Truncation marker prefixed when the buffer is full and we drop
 * bytes off the front. Helps the LLM (and humans) understand that
 * what they're reading is a tail, not the full transcript.
 */
const TRUNCATION_MARKER = '[…earlier output trimmed…]\n';
const TRANSCRIPT_STORAGE_DEBOUNCE_MS = 350;
const TRANSCRIPT_STORAGE_KEY = 'jarvis-terminal-transcripts';
const TRANSCRIPT_BACKUP_STORAGE_KEY = 'jarvis-terminal-transcripts-backup';

/* -------------------------------------------------------------------------- */
/*  ANSI stripping                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Strip ANSI escape sequences (CSI, OSC, DCS, simple SGR) so the
 * stored transcript reads as plain text. The regex covers:
 *   \x1B[ ... letter   â€” CSI sequences (most colour/movement codes)
 *   \x1B] ... \x07     â€” OSC (window titles, hyperlinks)
 *   \x1B] ... \x1B\\   â€” OSC terminated with ST
 *   \x1BP ... \x1B\\   â€” DCS sequences
 *   \x1B (a-z)         â€” single-char escapes
 *
 * We also drop bare control characters except for newline, tab,
 * carriage return â€” those carry layout meaning that's useful in a
 * transcript.
 */
const ANSI_REGEX =
  // CSI: ESC [ ... final byte in 0x40-0x7E
  /\x1B\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1BP[^\x1B]*\x1B\\|\x1B[A-Za-z]/g;

const ORPHAN_CSI_FRAGMENT = /\[(?:\??\d[\d;?]*|[;?][\d;?]*)[\x20-\x2F]*[A-Za-z]/g;
const ORPHAN_CSI_NO_PARAM_FRAGMENT = /(^|[\r\n])\[(?:K|J|H|m)(?=$|[^\w])/g;
const ORPHAN_OSC_FRAGMENT = /(^|[\r\n])(?:\x1B)?\](?:\d{1,3}|[A-Za-z])(?:;[^\r\n\x07]*)?(?:\x07|\r?\n|$)/g;
/** Legacy: orphan `[0` digit-repeat fragments from pre-NoProfile ConPTY artefacts. */
const ORPHAN_DIGIT_REPEAT = /(?:^|[\r\n])(?:\[0)+\[?(?=$|[\r\n])/g;
/** Legacy: orphan `[I` tab fragments from pre-NoProfile PSReadLine escape soup. */
const ORPHAN_TAB_FRAGMENT = /(?:^|[\r\n])\[I(?=$|[\r\n])/g;
/**
 * Mid-line orphan fragments after a PowerShell prompt when ESC was lost
 * across PTY chunk boundaries (e.g. `PS C:...>]4;0;rgb:...` or `> [0[[0[`).
 */
const ORPHAN_MIDLINE =
  /(>[^\S\r\n]*)((?:\]4;|\]10;|\]11;|\]12;)[^\r\n\x07]*(?:\x07)?|(?:\[0|\[I|\[<)[^\r\n]*)(?=\s*$|[\r\n])/gm;
/** Mouse reports echoed after restore can lose the opening CSI bracket as `M[<...`. */
const ORPHAN_MOUSE_REPORT_FRAGMENT = /(?:^|[\r\n])(?:M?\[<[\d;]+[Mm])+/g;
/** Palette payloads can survive as bare hex-ish text when the leading OSC is lost. */
const ORPHAN_PALETTE_PAYLOAD_AFTER_PROMPT =
  /(>[^\S\r\n]*)(?=(?:[a-f0-9]{2,}|\[0|\[I){4,}(?:[^\w\r\n]|$))(?:[a-f0-9]+|\[0|\[I|\[)+[^\r\n]*(?=$|[\r\n])/gim;

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
  return input
    .replace(ANSI_REGEX, '')
    .replace(ORPHAN_CSI_FRAGMENT, '')
    .replace(ORPHAN_CSI_NO_PARAM_FRAGMENT, '$1')
    .replace(ORPHAN_OSC_FRAGMENT, '$1')
    .replace(ORPHAN_DIGIT_REPEAT, '\n')
    .replace(ORPHAN_TAB_FRAGMENT, '')
    .replace(ORPHAN_PALETTE_PAYLOAD_AFTER_PROMPT, '$1')
    .replace(ORPHAN_MIDLINE, '$1')
    .replace(ORPHAN_MOUSE_REPORT_FRAGMENT, '\n')
    .replace(CONTROL_CHARS, '');
}

function sanitizeTerminalOutputChunk(
  raw: string,
  pendingEscape = '',
): { text: string; rawText: string; pendingEscape: string } {
  const combined = `${pendingEscape}${raw}`;
  const split = splitTrailingIncompleteEscape(combined);
  const nextPending =
    split.pendingEscape.length > MAX_PENDING_ESCAPE_CHARS ? '' : split.pendingEscape;
  return {
    text: stripAnsi(split.complete),
    rawText: split.complete,
    pendingEscape: nextPending,
  };
}
export function terminalRestoreText(session: Partial<SessionTranscript> | null | undefined): string {
  const source =
    typeof session?.text === 'string' && session.text.length > 0
      ? session.text
      : typeof session?.rawText === 'string'
        ? stripAnsi(session.rawText)
        : '';
  const safeSource = stripAnsi(source);
  if (!safeSource) return '';

  return safeSource
    .replace(/\x1B/g, '')
    .replace(ORPHAN_DIGIT_REPEAT, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .slice(-800)
    .join('\r\n');
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
  /** Incomplete trailing ANSI/OSC control sequence waiting for the next PTY chunk. */
  pendingEscape?: string;
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
   * picks a new agent role from the pane chrome dropdown â€” we want
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

/**
 * Prunes the terminal session transcript record dynamically to stay
 * within strict limits on count, per-session size, and total size.
 * Newest sessions are kept; oldest are evicted.
 */
export function pruneSessions(sessions: Record<string, SessionTranscript>): Record<string, SessionTranscript> {
  const sessionList = Object.values(sessions);
  if (sessionList.length === 0) return sessions;

  // 1. Ensure all session text payloads are strictly bounded
  for (const s of sessionList) {
    if (s.text && s.text.length > MAX_BYTES_PER_SESSION) {
      s.text = s.text.slice(-MAX_BYTES_PER_SESSION);
    }
    if (s.rawText && s.rawText.length > MAX_BYTES_PER_SESSION) {
      s.rawText = s.rawText.slice(-MAX_BYTES_PER_SESSION);
    }
  }

  // 2. Sort by lastWriteAt descending (newest first)
  sessionList.sort((a, b) => b.lastWriteAt - a.lastWriteAt);

  // 3. Limit to MAX_PERSISTED_SESSIONS
  const activeSessions = sessionList.slice(0, MAX_PERSISTED_SESSIONS);

  // 4. Construct pruned record and check overall size constraint
  const pruned: Record<string, SessionTranscript> = {};
  for (const s of activeSessions) {
    pruned[s.sessionId] = s;
  }

  let jsonStr = JSON.stringify({ sessions: pruned });
  while (activeSessions.length > 0 && jsonStr.length > MAX_TOTAL_TRANSCRIPTS_SIZE_BYTES) {
    const evicted = activeSessions.pop();
    if (evicted) {
      delete pruned[evicted.sessionId];
      console.warn(`[TRANSCRIPTS PRUNING] Evicted old session transcript '${evicted.sessionId}' to fit total cap.`);
    }
    jsonStr = JSON.stringify({ sessions: pruned });
  }

  return pruned;
}

/**
 * Cheap count-based eviction for the hot store paths. Unlike
 * `pruneSessions` this never JSON-serializes the payload — it only
 * sorts by recency and drops the oldest entries past the cap. The
 * expensive total-byte enforcement (which requires a full
 * `JSON.stringify`) happens once per debounced storage flush instead
 * of on every PTY chunk; running it per-chunk pegged the main thread
 * whenever several panes streamed output at once (the post-startup
 * lag with a full 10-pane grid).
 */
function enforceSessionCount(
  sessions: Record<string, SessionTranscript>,
): Record<string, SessionTranscript> {
  const ids = Object.keys(sessions);
  if (ids.length <= MAX_PERSISTED_SESSIONS) return sessions;
  const sorted = Object.values(sessions).sort((a, b) => b.lastWriteAt - a.lastWriteAt);
  const next: Record<string, SessionTranscript> = {};
  for (const s of sorted.slice(0, MAX_PERSISTED_SESSIONS)) {
    next[s.sessionId] = s;
  }
  return next;
}

const pendingStorageWrites = new Map<string, string>();
let transcriptStorageTimer: ReturnType<typeof setTimeout> | null = null;

export function deserializeTranscriptSessions(
  raw: string | null,
): Record<string, SessionTranscript> | null {
  if (!raw) return null;
  try {
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
        text:
          typeof session.text === 'string'
            ? stripAnsi(session.text).slice(-MAX_BYTES_PER_SESSION)
            : '',
        rawText: typeof session.rawText === 'string' ? session.rawText.slice(-MAX_BYTES_PER_SESSION) : '',
        pendingEscape: '',
        currentInput: typeof session.currentInput === 'string' ? session.currentInput.slice(-4096) : '',
        lastWriteAt: typeof session.lastWriteAt === 'number' ? session.lastWriteAt : Date.now(),
        bytesSeen: typeof session.bytesSeen === 'number' ? session.bytesSeen : 0,
      };
    }
    return pruneSessions(next);
  } catch {
    return null;
  }
}

export function loadInitialSessions(): Record<string, SessionTranscript> {
  if (typeof window === 'undefined') return {};
  const primary = deserializeTranscriptSessions(
    window.localStorage.getItem(TRANSCRIPT_STORAGE_KEY),
  );
  const backup = deserializeTranscriptSessions(
    window.localStorage.getItem(TRANSCRIPT_BACKUP_STORAGE_KEY),
  );
  const primaryCount = primary ? Object.keys(primary).length : 0;
  const backupCount = backup ? Object.keys(backup).length : 0;
  // Never let an empty/missing primary shadow a good backup. If the primary
  // was evicted under quota pressure or written empty during a transient boot
  // state, fall back to the last-known-good backup so terminal history is not
  // lost. Prefer whichever snapshot actually has sessions.
  if (primaryCount > 0) return primary as Record<string, SessionTranscript>;
  if (backupCount > 0) return backup as Record<string, SessionTranscript>;
  return primary ?? backup ?? {};
}

export function flushTranscriptStorage(): void {
  if (typeof window === 'undefined') return;
  if (transcriptStorageTimer) {
    clearTimeout(transcriptStorageTimer);
    transcriptStorageTimer = null;
  }
  try {
    // Full prune (count + per-session + total-byte caps) runs here, once
    // per debounced flush, instead of on every appendOutput call.
    const sessions = pruneSessions({ ...useTerminalTranscriptStore.getState().sessions });
    const serialized = JSON.stringify({ sessions });
    const isEmpty = Object.keys(sessions).length === 0;
    const current = window.localStorage.getItem(TRANSCRIPT_STORAGE_KEY);
    const currentParsed = deserializeTranscriptSessions(current);
    const currentCount = currentParsed ? Object.keys(currentParsed).length : 0;
    // GUARD: never overwrite a non-empty saved transcript with an empty one.
    // Prevents an early-boot/transient-empty in-memory state from wiping
    // durable terminal history. (User intentionally clearing goes through a
    // separate explicit path, not this debounced flush.)
    if (isEmpty && currentCount > 0) {
      return;
    }
    // Preserve last-known-good in the backup slot before overwriting primary.
    if (current && current !== serialized && currentCount > 0) {
      pendingStorageWrites.set(TRANSCRIPT_BACKUP_STORAGE_KEY, current);
    }
    pendingStorageWrites.set(TRANSCRIPT_STORAGE_KEY, serialized);
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
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushTranscriptStorage();
  });
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
          const nextSessions = {
            ...state.sessions,
            [sessionId]: {
              sessionId,
              paneId: init.paneId ?? existing?.paneId ?? null,
              projectId: init.projectId ?? existing?.projectId ?? null,
              agentSlug: init.agentSlug ?? existing?.agentSlug ?? null,
              command: init.command ?? existing?.command ?? null,
              text: existing?.text ?? '',
              rawText: existing?.rawText ?? '',
              pendingEscape: existing?.pendingEscape ?? '',
              currentInput: existing?.currentInput ?? '',
              lastWriteAt: existing?.lastWriteAt ?? Date.now(),
              bytesSeen: existing?.bytesSeen ?? 0,
            },
          };
          return { sessions: enforceSessionCount(nextSessions) };
        });
        scheduleTranscriptStorageFlush();
      },

      retagSession: (sessionId, agentSlug) => {
        set((state) => {
          const cur = state.sessions[sessionId];
          if (!cur) return {};
          const nextSessions = {
            ...state.sessions,
            [sessionId]: { ...cur, agentSlug },
          };
          return { sessions: nextSessions };
        });
        scheduleTranscriptStorageFlush();
      },

      appendOutput: (sessionId, raw) => {
        set((state) => {
          const cur = state.sessions[sessionId];
          if (!cur) return {};
          const cleaned = sanitizeTerminalOutputChunk(raw, cur.pendingEscape);
          const nextSessions = {
            ...state.sessions,
            [sessionId]: {
              ...cur,
              text: appendBounded(cur.text, cleaned.text),
              rawText: '',
              pendingEscape: cleaned.pendingEscape,
              bytesSeen: cur.bytesSeen + raw.length,
              lastWriteAt: Date.now(),
            },
          };
          // Hot path (fires on every PTY chunk): per-session bounding is
          // already handled by appendBounded; the expensive full prune
          // happens in the debounced storage flush.
          return { sessions: nextSessions };
        });
        scheduleTranscriptStorageFlush();
      },

      setCurrentInput: (sessionId, currentInput) => {
        set((state) => {
          const cur = state.sessions[sessionId];
          if (!cur || cur.currentInput === currentInput) return {};
          const nextSessions = {
            ...state.sessions,
            [sessionId]: {
              ...cur,
              currentInput,
            },
          };
          // Hot path (typing): do not update lastWriteAt. Draft input is
          // persistence metadata, not PTY activity; bumping it wakes
          // by-activity subscribers across 6-10 panes.
          return { sessions: nextSessions };
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
          const nextSessions = { ...state.sessions };
          nextSessions[newSessionId] = {
            ...oldSession,
            sessionId: newSessionId,
            lastWriteAt: Date.now(),
          };
          delete nextSessions[oldSessionId];
          return { sessions: enforceSessionCount(nextSessions) };
        });
        scheduleTranscriptStorageFlush();
      },

      clearSessionTranscript: (sessionId) => {
        set((state) => {
          const cur = state.sessions[sessionId];
          if (!cur) return {};
          const nextSessions = {
            ...state.sessions,
            [sessionId]: {
              ...cur,
              text: '',
              rawText: '',
              pendingEscape: '',
              currentInput: '',
              bytesSeen: 0,
              lastWriteAt: Date.now(),
            },
          };
          return { sessions: nextSessions };
        });
        scheduleTranscriptStorageFlush();
      },

      reset: () => {
        set({ sessions: {} });
        pendingStorageWrites.delete(TRANSCRIPT_STORAGE_KEY);
        pendingStorageWrites.delete(TRANSCRIPT_BACKUP_STORAGE_KEY);
        if (transcriptStorageTimer) {
          clearTimeout(transcriptStorageTimer);
          transcriptStorageTimer = null;
        }
        if (typeof window !== 'undefined') {
          window.localStorage.removeItem(TRANSCRIPT_STORAGE_KEY);
          window.localStorage.removeItem(TRANSCRIPT_BACKUP_STORAGE_KEY);
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

