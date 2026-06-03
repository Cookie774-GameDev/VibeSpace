/**
 * Build a context block describing the recent terminal output for an
 * agent slug, ready to splice into an LLM call.
 *
 * Why this lives here (not in `transcriptStore`):
 *   The store is pure state (Zustand record + selectors). Formatting
 *   for the model — picking how many sessions to surface, capping the
 *   per-session window, building the literal prompt-shaped text — is
 *   a presentation concern that belongs in the runtime layer. Keeping
 *   it separate makes the store reusable from a future "show recent
 *   transcript" UI without forcing a prompt-shaped string on it.
 *
 * The output is a single string designed to be inserted as a `system`
 * message at the start of `LLMMessage[]`. Empty string is returned
 * when the agent has no tagged sessions or all tagged sessions have
 * no captured output yet — callers can skip the splice in that case.
 */

import {
  getSessionsForAgent,
  type SessionTranscript,
} from './transcriptStore';

/** Hard cap on the number of sessions whose output we surface. */
const MAX_SESSIONS = 3;

/**
 * Per-session character budget surfaced to the model. The store keeps
 * up to `MAX_BYTES_PER_SESSION` (32 KB) but most chats don't want the
 * whole thing — recent action is more useful than historical noise.
 *
 * 6 KB ≈ 1.5K tokens which is comfortable to pass alongside a normal
 * chat turn even on smaller-context models.
 */
const PER_SESSION_TAIL_CHARS = 6 * 1024;

/**
 * Idle threshold. A session whose last write is older than this is
 * skipped — the user's question is almost never about output from
 * yesterday, and surfacing it just wastes context. 10 minutes is the
 * sweet spot from informal testing: long enough to cover a "still
 * working on the same thing" return, short enough to drop genuinely
 * stale panes.
 */
const FRESHNESS_WINDOW_MS = 10 * 60 * 1000;

/**
 * Take the last `n` characters of `text` without splitting in the
 * middle of a UTF-16 surrogate pair (which would corrupt emoji or
 * astral-plane characters in the LLM's input).
 *
 * For practical CLI output this is rarely an issue, but the cost of
 * doing it right is one extra char-code check.
 */
function safeTail(text: string, n: number): string {
  if (text.length <= n) return text;
  let start = text.length - n;
  // If we landed on the low half of a surrogate pair, walk back one.
  const ch = text.charCodeAt(start);
  if (ch >= 0xdc00 && ch <= 0xdfff) start -= 1;
  return text.slice(start);
}

/**
 * Format a single session as a fenced block. We use a fenced block
 * (rather than free-form prose) because models reliably treat
 * triple-backtick regions as data, not instructions — so a stray
 * "ignore previous instructions" inside a tool's output can't hijack
 * the chat.
 */
function formatSession(s: SessionTranscript): string {
  const headerBits: string[] = [`session=${s.sessionId}`];
  if (s.command) headerBits.push(`command=${s.command}`);
  const ageSec = Math.max(0, Math.round((Date.now() - s.lastWriteAt) / 1000));
  headerBits.push(`last_write=${ageSec}s ago`);
  const header = headerBits.join(' · ');
  const tail = safeTail(s.text, PER_SESSION_TAIL_CHARS).trimEnd();
  return [
    `--- ${header} ---`,
    '```',
    tail,
    '```',
  ].join('\n');
}

/**
 * Build the context block for an agent slug. Returns the empty string
 * when there's nothing useful to show — callers should treat that as
 * "skip the splice entirely" rather than emitting an empty section.
 *
 * The intentional shape:
 *
 *   You are also operating one or more terminal panes. Below is the
 *   recent output the user can see in those panes. Use this as
 *   factual context — do not invent activity that isn't shown.
 *
 *   --- session=pty_abc · command=claude · last_write=4s ago ---
 *   ```
 *   <recent output, ANSI stripped, capped at PER_SESSION_TAIL_CHARS>
 *   ```
 *
 * Multiple sessions are concatenated with blank lines between blocks
 * in most-recently-active order so the freshest pane is closest to
 * the user's question (LLMs weight recent context more heavily).
 */
export function buildAgentTerminalContext(agentSlug: string): string {
  if (!agentSlug) return '';
  const sessions = getSessionsForAgent(agentSlug);
  if (sessions.length === 0) return '';

  const now = Date.now();
  const fresh = sessions
    .filter((s) => now - s.lastWriteAt <= FRESHNESS_WINDOW_MS)
    .filter((s) => s.text.trim().length > 0)
    .slice(0, MAX_SESSIONS);
  if (fresh.length === 0) return '';

  const blocks = fresh.map(formatSession).join('\n\n');
  const intro = [
    `You are also operating ${fresh.length === 1 ? 'a terminal pane' : `${fresh.length} terminal panes`} on the user's machine.`,
    `The blocks below show the recent output the user can see in ${fresh.length === 1 ? 'that pane' : 'those panes'}.`,
    'Treat these as factual context. Do not invent activity that is not shown. If the user asks "what just happened?", reference what is actually in these blocks.',
  ].join(' ');

  return `${intro}\n\n${blocks}`;
}
