/**
 * Action proposal parser.
 *
 * The AI signals a proposal by emitting a fenced code block tagged with
 * the language `action`:
 *
 *     ```action
 *     {
 *       "id": "terminal.claude",
 *       "params": { "cwd": "C:\\Users\\me\\proj" },
 *       "rationale": "You asked me to start Claude in your project."
 *     }
 *     ```
 *
 * The runtime calls `parseActionBlocks(finalText)` exactly once, at the
 * canonical-write moment in `lib/ai/runtime.ts` (after the stream is
 * fully done). The result is split into ordered "segments" that map
 * one-to-one to chat `Part` entries — text segments become text parts,
 * proposal segments become `action_proposal` parts.
 *
 * The parser is intentionally permissive: a malformed JSON body or
 * unknown action id surfaces as an `error` segment that the renderer
 * shows inline (with the raw text preserved). Silently dropping a
 * malformed proposal would let the AI lie about having taken an
 * action.
 */

import type { ParsedActionProposal } from './types';

/**
 * One ordered piece of the parsed message. The renderer walks the
 * segments in order and emits a chat Part per segment.
 */
export type ParsedSegment =
  | { kind: 'prose'; text: string }
  | { kind: 'action'; ok: true; proposal: ParsedActionProposal }
  | { kind: 'action'; ok: false; error: string; raw: string };

export interface ParseResult {
  segments: ParsedSegment[];
  /**
   * Convenience flag — true when at least one `kind: 'action'` segment
   * is present (regardless of ok/error). The runtime uses it to skip
   * the parts-array rewrite when the AI didn't propose anything.
   */
  hasActionBlocks: boolean;
}

/* --------------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------------*/

let nextCallId = 1;
function newCallId(): string {
  return `apr_${Date.now().toString(36)}_${(nextCallId++).toString(36)}`;
}

/** Match a line that opens an action block. Lenient on trailing whitespace. */
const RE_OPEN = /^\s*```\s*action\s*$/i;
/** Match a line that closes any code block. Require the fence-only line. */
const RE_CLOSE = /^\s*```\s*$/;

/**
 * Validate + normalise the parsed JSON body. Returns either a
 * `ParsedActionProposal` or an error string.
 */
function normalizeBody(
  raw: unknown,
): { proposal: ParsedActionProposal } | { error: string } {
  if (!raw || typeof raw !== 'object') {
    return { error: 'Action body must be a JSON object.' };
  }
  const obj = raw as Record<string, unknown>;

  const id = obj.id;
  if (typeof id !== 'string' || id.trim().length === 0) {
    return { error: 'Action body is missing a string `id` field.' };
  }
  // We accept dotted ids only (e.g. `nav.chat`). This is the same
  // shape the registry uses, so a typo like "nav chat" surfaces here
  // instead of as a silent unknown-action later.
  if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.-]*$/i.test(id.trim())) {
    return {
      error: `Action id "${id}" must look like "<category>.<name>" (lowercase, dotted).`,
    };
  }

  let params: Record<string, unknown> = {};
  if (obj.params !== undefined) {
    if (
      typeof obj.params !== 'object' ||
      obj.params === null ||
      Array.isArray(obj.params)
    ) {
      return { error: 'Action `params` must be a JSON object.' };
    }
    params = obj.params as Record<string, unknown>;
  }

  const rationale =
    typeof obj.rationale === 'string' && obj.rationale.trim()
      ? obj.rationale.trim()
      : undefined;

  return {
    proposal: {
      call_id: newCallId(),
      action_id: id.trim(),
      params,
      rationale,
    },
  };
}

/* --------------------------------------------------------------------------
 * Public parser
 * --------------------------------------------------------------------------*/

/**
 * Walk the given text and split it into prose + action segments.
 *
 * Implementation is a tiny line-mode state machine because we need to
 * preserve verbatim text outside fences (markdown formatting, code
 * blocks for other languages, etc.) without parsing them.
 *
 * Edge cases handled:
 *   - Open fence with no closing fence: the body is dropped into a
 *     prose segment so the user sees the broken text instead of losing
 *     it entirely. We also surface an `error` segment for visibility.
 *   - Empty body: surfaced as an error segment.
 *   - Non-JSON body: surfaced as an error segment with the parse error.
 *   - Multiple proposals back-to-back: empty prose segments between
 *     them are dropped before the segments array is returned.
 */
export function parseActionBlocks(text: string): ParseResult {
  const segments: ParsedSegment[] = [];
  let prose = '';
  let body = '';
  let mode: 'prose' | 'inside' = 'prose';

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const isLast = i === lines.length - 1;

    if (mode === 'prose') {
      if (RE_OPEN.test(line)) {
        // Flush whatever prose we accumulated, sans the trailing newline
        // we'd otherwise tack on for the open fence's line.
        if (prose.length > 0) {
          segments.push({ kind: 'prose', text: prose.replace(/\n+$/, '') });
        }
        prose = '';
        body = '';
        mode = 'inside';
        continue;
      }
      prose += line;
      if (!isLast) prose += '\n';
      continue;
    }

    // mode === 'inside'
    if (RE_CLOSE.test(line)) {
      // End of the action block. Try to parse the body.
      const trimmed = body.trim();
      if (trimmed.length === 0) {
        segments.push({
          kind: 'action',
          ok: false,
          error: 'Action block was empty.',
          raw: '```action\n```',
        });
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Invalid JSON.';
          segments.push({
            kind: 'action',
            ok: false,
            error: `Could not parse action JSON: ${msg}`,
            raw: '```action\n' + body + '```',
          });
          mode = 'prose';
          body = '';
          prose = '';
          continue;
        }
        const result = normalizeBody(parsed);
        if ('error' in result) {
          segments.push({
            kind: 'action',
            ok: false,
            error: result.error,
            raw: '```action\n' + body + '```',
          });
        } else {
          segments.push({
            kind: 'action',
            ok: true,
            proposal: result.proposal,
          });
        }
      }
      mode = 'prose';
      body = '';
      prose = '';
      continue;
    }

    body += line + '\n';
  }

  // Loop ended. If we're still inside an unterminated block, surface
  // the body as an error and keep the partial text visible as prose.
  if (mode === 'inside') {
    segments.push({
      kind: 'action',
      ok: false,
      error: 'Action block opened with ```action but never closed with ```.',
      raw: '```action\n' + body,
    });
  } else if (prose.length > 0) {
    segments.push({ kind: 'prose', text: prose.replace(/\n+$/, '') });
  }

  // Drop empty prose segments that ended up adjacent to action blocks.
  const cleaned = segments.filter(
    (s) => s.kind !== 'prose' || s.text.length > 0,
  );

  return {
    segments: cleaned,
    hasActionBlocks: cleaned.some((s) => s.kind === 'action'),
  };
}
