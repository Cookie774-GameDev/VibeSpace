export type OpenCodeTextChannel = 'text' | 'reasoning';

export interface OpenCodeTextPartUpdate {
  eventId?: string;
  sessionId?: string;
  messageId?: string;
  partId?: string;
  channel: OpenCodeTextChannel;
  /** Incremental text when the installed OpenCode version emits it. */
  delta?: string;
  /** Full current part snapshot; some OpenCode versions emit this without delta. */
  text?: string;
}

export type OpenCodeTextEmission =
  | {
      kind: 'noop';
      channel: OpenCodeTextChannel;
      partKey: string;
      fullText: string;
    }
  | {
      kind: 'delta';
      channel: OpenCodeTextChannel;
      partKey: string;
      text: string;
      fullText: string;
    }
  | {
      kind: 'replace';
      channel: OpenCodeTextChannel;
      partKey: string;
      text: string;
      fullText: string;
    };

export interface OpenCodeRawTextEvent {
  type?: unknown;
  properties?: unknown;
}

function cleanIdentity(value: string | undefined): string {
  const clean = value?.trim() ?? '';
  if (!clean) return '';
  if (clean.length > 512 || /[\u0000-\u001f\u007f]/u.test(clean)) {
    throw new Error('HARNESS_EVENT_INVALID_IDENTITY');
  }
  return clean;
}

function partKey(update: Readonly<OpenCodeTextPartUpdate>): string {
  return JSON.stringify([
    cleanIdentity(update.sessionId),
    cleanIdentity(update.messageId),
    cleanIdentity(update.partId) || 'default',
    update.channel,
  ]);
}

function textOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Extract text/reasoning updates from the documented OpenCode event family.
 * The parser intentionally accepts both `delta` and full `part.text` snapshots,
 * because OpenCode 1.18.x can emit the latter without a delta.
 */
export function extractOpenCodeTextPartUpdate(
  event: Readonly<OpenCodeRawTextEvent>,
): OpenCodeTextPartUpdate | null {
  if (event.type !== 'message.part.updated') return null;
  const properties = recordOf(event.properties);
  const part = recordOf(properties?.part);
  if (!properties || !part) return null;

  const rawType = typeof part.type === 'string' ? part.type.toLocaleLowerCase('en-US') : '';
  const channel: OpenCodeTextChannel | null =
    rawType === 'text' || rawType === 'agent_message'
      ? 'text'
      : rawType === 'reasoning'
        ? 'reasoning'
        : null;
  if (!channel) return null;

  const delta = textOrUndefined(properties.delta ?? part.delta);
  const text = textOrUndefined(part.text ?? properties.text);
  if (delta === undefined && text === undefined) return null;

  return {
    eventId: textOrUndefined(properties.eventID ?? properties.eventId),
    sessionId: textOrUndefined(
      part.sessionID ?? part.sessionId ?? properties.sessionID ?? properties.sessionId,
    ),
    messageId: textOrUndefined(part.messageID ?? part.messageId),
    partId: textOrUndefined(part.id ?? part.partID ?? part.partId),
    channel,
    ...(delta === undefined ? {} : { delta }),
    ...(text === undefined ? {} : { text }),
  };
}

/**
 * Losslessly reconstructs OpenCode streamed parts. It handles delta-only,
 * snapshot-only and mixed event streams, suppresses stale/duplicate snapshots,
 * and never returns an empty final answer merely because `delta` was omitted.
 */
export class OpenCodeTextAccumulator {
  readonly #parts = new Map<string, { channel: OpenCodeTextChannel; text: string }>();
  readonly #seenEventIds = new Set<string>();
  readonly #eventOrder: string[] = [];
  #totalChars = 0;

  constructor(
    private readonly limits: {
      maxParts?: number;
      maxTotalChars?: number;
      maxRememberedEventIds?: number;
    } = {},
  ) {}

  private rememberEvent(eventId: string | undefined): boolean {
    const clean = cleanIdentity(eventId);
    if (!clean) return true;
    if (this.#seenEventIds.has(clean)) return false;
    this.#seenEventIds.add(clean);
    this.#eventOrder.push(clean);
    const max = Math.max(1, this.limits.maxRememberedEventIds ?? 8_192);
    while (this.#eventOrder.length > max) {
      const oldest = this.#eventOrder.shift();
      if (oldest) this.#seenEventIds.delete(oldest);
    }
    return true;
  }

  private setPart(key: string, channel: OpenCodeTextChannel, next: string): void {
    const previous = this.#parts.get(key)?.text ?? '';
    const newTotal = this.#totalChars - previous.length + next.length;
    const maxTotalChars = Math.max(1, this.limits.maxTotalChars ?? 2_000_000);
    if (newTotal > maxTotalChars) throw new Error('HARNESS_TEXT_LIMIT_EXCEEDED');
    if (!this.#parts.has(key) && this.#parts.size >= Math.max(1, this.limits.maxParts ?? 4_096)) {
      throw new Error('HARNESS_TEXT_PART_LIMIT_EXCEEDED');
    }
    this.#parts.set(key, { channel, text: next });
    this.#totalChars = newTotal;
  }

  ingest(update: Readonly<OpenCodeTextPartUpdate>): OpenCodeTextEmission {
    const key = partKey(update);
    const current = this.#parts.get(key)?.text ?? '';
    if (!this.rememberEvent(update.eventId)) {
      return { kind: 'noop', channel: update.channel, partKey: key, fullText: current };
    }

    const snapshot = update.text;
    const delta = update.delta;

    if (snapshot !== undefined) {
      if (snapshot === current || current.startsWith(snapshot)) {
        // Duplicate or delayed stale snapshot. Never regress already-rendered text.
        return { kind: 'noop', channel: update.channel, partKey: key, fullText: current };
      }
      if (snapshot.startsWith(current)) {
        const suffix = snapshot.slice(current.length);
        this.setPart(key, update.channel, snapshot);
        return suffix
          ? { kind: 'delta', channel: update.channel, partKey: key, text: suffix, fullText: snapshot }
          : { kind: 'noop', channel: update.channel, partKey: key, fullText: snapshot };
      }

      // A non-prefix snapshot represents an upstream correction/rewrite. Expose
      // an explicit replacement rather than appending corrupt duplicate text.
      this.setPart(key, update.channel, snapshot);
      return {
        kind: 'replace',
        channel: update.channel,
        partKey: key,
        text: snapshot,
        fullText: snapshot,
      };
    }

    if (!delta) {
      return { kind: 'noop', channel: update.channel, partKey: key, fullText: current };
    }
    const next = current + delta;
    this.setPart(key, update.channel, next);
    return { kind: 'delta', channel: update.channel, partKey: key, text: delta, fullText: next };
  }

  partText(update: Pick<OpenCodeTextPartUpdate, 'sessionId' | 'messageId' | 'partId' | 'channel'>): string {
    return this.#parts.get(partKey(update))?.text ?? '';
  }

  fullText(channel: OpenCodeTextChannel = 'text'): string {
    return [...this.#parts.values()]
      .filter((part) => part.channel === channel)
      .map((part) => part.text)
      .join('');
  }

  reset(): void {
    this.#parts.clear();
    this.#seenEventIds.clear();
    this.#eventOrder.length = 0;
    this.#totalChars = 0;
  }
}
