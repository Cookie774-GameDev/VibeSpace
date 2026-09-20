import type { StreamingPreviewSegment } from '@/features/chat/streamingPreviewStore';
import { mergePublicToolDetails } from '@/lib/ai/publicToolDetails';
import type { Part } from '@/types/chat';
import { createStreamingPreviewState, pushStreamingPreviewChunk } from './streamingPreviewGate';

type ToolSegment = Extract<StreamingPreviewSegment, { kind: 'tool' }>;
type TextSegment = Extract<StreamingPreviewSegment, { kind: 'text' }>;
type ReasoningSegment = Extract<StreamingPreviewSegment, { kind: 'reasoning' }>;
type Entry =
  | { kind: 'text'; id: string; raw: string; public: Readonly<TextSegment> }
  | { kind: 'reasoning'; id: string; public: Readonly<ReasoningSegment> }
  | { kind: 'tool'; id: string; public: Readonly<ToolSegment> };
export interface PublicStreamSnapshot {
  readonly text: string;
  readonly segments: readonly Readonly<StreamingPreviewSegment>[];
}
const EMPTY: Readonly<PublicStreamSnapshot> = Object.freeze({
  text: '',
  segments: Object.freeze([]),
});

/**
 * One request owns one ordered projection. Only the adapter's public text
 * public text/reasoning channels enter this module; executable authority never
 * does. Reasoning is rendered only through the public disclosure component.
 * Append events advance one shared gate, so split markers remain guarded even
 * across provider part IDs. Replacement recovery rebuilds only when required;
 * tool/prose updates retain unchanged public objects for memoized rendering.
 */
export function createPublicStreamProjection() {
  const entries: Entry[] = [];
  const texts = new Map<string, Extract<Entry, { kind: 'text' }>>();
  const tools = new Map<string, Extract<Entry, { kind: 'tool' }>>();
  let state = createStreamingPreviewState();
  let lastText: Extract<Entry, { kind: 'text' }> | undefined;
  let cached: Readonly<PublicStreamSnapshot> = EMPTY;
  let dirty = false;
  let sealed = false;
  let disposed = false;
  let textDone = false;

  function publishText(entry: Extract<Entry, { kind: 'text' }>, text: string): void {
    if (entry.public.text === text) return;
    entry.public = Object.freeze({ kind: 'text', id: entry.id, text });
    dirty = true;
  }

  function advance(
    entry: Extract<Entry, { kind: 'text' }>,
    delta: string,
    complete: boolean,
  ): void {
    const prior = state.visible;
    const next = pushStreamingPreviewChunk(state, delta, {
      publicProgress: true,
      itemComplete: complete,
    });
    state = next.state;
    if (state.visible === prior) return;
    // Gate visibility only grows on append. Full replacements use rebuild(),
    // which deliberately discards obsolete visible text before revalidation.
    publishText(entry, entry.public.text + state.visible.slice(prior.length));
  }

  function rebuild(): void {
    state = createStreamingPreviewState();
    for (const entry of entries) {
      if (entry.kind !== 'text') continue;
      publishText(entry, '');
      advance(entry, entry.raw, textDone && entry === lastText);
    }
    dirty = true;
  }

  function getPartialText(): string | undefined {
    if (disposed) return undefined;
    // Interrupted completion is a separate, bounded consumer, not a render
    // hot path. Keep the existing complete-buffer safety check for it.
    const result = pushStreamingPreviewChunk(
      createStreamingPreviewState(),
      entries
        .filter((entry): entry is Extract<Entry, { kind: 'text' }> => entry.kind === 'text')
        .map((entry) => entry.raw)
        .join(''),
      { interrupted: true },
    );
    return result.allowed ? result.visibleText.slice(0, 32_768) : undefined;
  }

  return Object.freeze({
    pushText(
      chunk: Readonly<{
        delta: string;
        streamPartId?: string;
        mode?: 'append' | 'replace';
        done?: boolean;
      }>,
    ): boolean {
      if (sealed || disposed || textDone) return false;
      const id = chunk.streamPartId ?? 'default';
      if (!id || id.length > 512) return false;
      const previous = texts.get(id);
      let entry = previous;
      if (chunk.delta || (chunk.mode === 'replace' && previous)) {
        if (!entry) {
          entry = {
            kind: 'text',
            id,
            raw: '',
            public: Object.freeze({ kind: 'text', id, text: '' }),
          };
          texts.set(id, entry);
          entries.push(entry);
          lastText = entry;
        }
        const replacement = chunk.mode === 'replace';
        const nextRaw = replacement ? chunk.delta : entry.raw + chunk.delta;
        const changed = nextRaw !== entry.raw;
        entry.raw = nextRaw;
        if (changed) {
          if (replacement || entry !== lastText) rebuild();
          else advance(entry, chunk.delta, false);
        }
      }
      if (chunk.done) {
        textDone = true;
        if (lastText) advance(lastText, '', true);
      }
      return dirty;
    },

    updateTool(input: Readonly<Omit<ToolSegment, 'kind'>>): boolean {
      if (
        sealed ||
        disposed ||
        !input.id ||
        input.id.length > 512 ||
        !input.name ||
        input.name.length > 256
      )
        return false;
      const entry = tools.get(input.id);
      if (
        entry?.public.status !== undefined &&
        entry.public.status !== 'started' &&
        input.status === 'started'
      )
        return false;
      const prior = entry?.public;
      const details =
        input.details && input.details !== prior?.details
          ? prior?.details
            ? mergePublicToolDetails(prior.details, input.details)
            : input.details
          : prior?.details;
      const fileLabel = input.fileLabel ?? prior?.fileLabel;
      if (
        prior &&
        prior.name === input.name &&
        prior.status === input.status &&
        prior.fileLabel === fileLabel &&
        prior.details === details
      )
        return false;
      const value: Readonly<ToolSegment> = Object.freeze({
        kind: 'tool',
        id: input.id,
        name: input.name,
        status: input.status,
        ...(fileLabel ? { fileLabel } : {}),
        ...(details ? { details } : {}),
      });
      if (entry) entry.public = value;
      else {
        const next = { kind: 'tool' as const, id: input.id, public: value };
        entries.push(next);
        tools.set(input.id, next);
      }
      dirty = true;
      return true;
    },

    pushReasoning(input: Readonly<{ delta: string; mode?: 'append' | 'replace' }>): boolean {
      if (sealed || disposed || !input.delta) return false;
      const previous = entries.at(-1);
      if (previous?.kind === 'reasoning') {
        const text = input.mode === 'replace' ? input.delta : previous.public.text + input.delta;
        if (text === previous.public.text) return false;
        previous.public = Object.freeze({ kind: 'reasoning', id: previous.id, text });
        dirty = true;
        return true;
      }
      const id = `reasoning-${entries.filter((entry) => entry.kind === 'reasoning').length + 1}`;
      entries.push({
        kind: 'reasoning',
        id,
        public: Object.freeze({ kind: 'reasoning', id, text: input.delta }),
      });
      dirty = true;
      return true;
    },

    getTool(id: string): Readonly<ToolSegment> | undefined {
      return tools.get(id)?.public;
    },

    snapshot(): Readonly<PublicStreamSnapshot> {
      if (!dirty) return cached;
      cached = Object.freeze({
        text: state.visible,
        segments: Object.freeze(
          entries.flatMap<Readonly<StreamingPreviewSegment>>((entry) =>
            entry.kind === 'text' && !entry.public.text ? [] : [entry.public],
          ),
        ),
      });
      dirty = false;
      return cached;
    },

    getPartialText(): string | undefined {
      return getPartialText();
    },

    getPartialParts(): readonly Part[] {
      if (disposed) return Object.freeze([]);

      // Re-run the complete text through the interrupted safety gate before
      // copying any text into a failed-message suffix. Reasoning and tool
      // rows have already crossed their public projection boundaries; raw
      // provider envelopes never enter this result.
      const safeText = getPartialText();
      const parts: Part[] = [];
      let remainingText = safeText?.length ?? 0;
      for (const segment of this.snapshot().segments) {
        if (segment.kind === 'text') {
          if (safeText !== undefined && remainingText > 0 && segment.text) {
            const text = segment.text.slice(0, remainingText);
            remainingText -= text.length;
            if (text) parts.push({ kind: 'text', text });
          }
          continue;
        }
        if (segment.kind === 'reasoning') {
          if (segment.text) parts.push({ kind: 'reasoning', text: segment.text });
          continue;
        }

        parts.push({
          kind: 'tool_call',
          tool: segment.name,
          args: {},
          call_id: segment.id,
          ...(segment.details ? { details: segment.details } : {}),
        });
        if (segment.status === 'completed') {
          parts.push({ kind: 'tool_result', call_id: segment.id, result: { status: 'completed' } });
        } else if (segment.status === 'failed') {
          parts.push({ kind: 'tool_result', call_id: segment.id, error: 'Tool failed' });
        } else {
          parts.push({ kind: 'tool_result', call_id: segment.id, error: 'Tool interrupted' });
        }
      }
      return Object.freeze(parts);
    },

    seal(): void {
      sealed = true;
    },
    dispose(): void {
      sealed = true;
      disposed = true;
      entries.length = 0;
      texts.clear();
      tools.clear();
      lastText = undefined;
      state = createStreamingPreviewState();
      cached = EMPTY;
      dirty = false;
    },
  });
}
