/**
 * Tiny streaming SSE parser used by the cloud providers.
 *
 * The W3C EventSource spec is what we follow loosely. Each event is a block of
 * lines separated by `\n\n`; within a block, lines are `field: value`.
 * We care about `event:` and `data:`. Comments (`:`) are ignored, and BOMs at
 * the start are tolerated.
 *
 * Why we hand-roll: we want to plug straight into a `fetch` ReadableStream and
 * we want backpressure-friendly async iteration. EventSource (the browser API)
 * only supports GET, can't set headers, and doesn't expose readable streams.
 */

/** One parsed SSE event. */
export interface SSEEvent {
  /** Optional `event:` field. Anthropic emits these; OpenAI/Gemini don't. */
  event?: string;
  /**
   * The joined `data:` lines for this event. Multiple `data:` lines in one
   * event are concatenated with `\n` per the spec.
   */
  data: string;
}

/**
 * Async-iterate parsed events out of a fetch response body.
 * Stops cleanly on `signal.aborted` and releases the reader.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) return;

      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        // fetch will throw an AbortError when the signal fires mid-read; treat
        // it as a clean stop rather than letting it propagate.
        if (signal?.aborted) return;
        throw err;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      // Split on event delimiter. Both \n\n and \r\n\r\n are valid in the wild.
      let idx: number;
      // eslint-disable-next-line no-cond-assign
      while ((idx = findBlockEnd(buffer)) !== -1) {
        const block = buffer.slice(0, idx.valueOf());
        // skip past the delimiter (length depends on which one matched)
        const delim = buffer.startsWith('\r\n\r\n', idx) ? 4 : 2;
        buffer = buffer.slice(idx + delim);
        const evt = parseBlock(block);
        if (evt) yield evt;
      }
    }

    // Flush any trailing buffered data as a final block (some servers don't
    // close with a delimiter on the last event).
    if (buffer.trim().length > 0) {
      const evt = parseBlock(buffer);
      if (evt) yield evt;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

/**
 * Find the end of the next event block in the buffer; returns the index of the
 * delimiter or -1.
 */
function findBlockEnd(buf: string): number {
  const a = buf.indexOf('\n\n');
  const b = buf.indexOf('\r\n\r\n');
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

/** Parse one event block (no trailing delimiter) into an SSEEvent. */
function parseBlock(block: string): SSEEvent | null {
  let event: string | undefined;
  const dataParts: string[] = [];

  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, ''); // strip BOM
    if (line.length === 0) continue;
    if (line.startsWith(':')) continue; // comment

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    // The spec says strip exactly one leading space after the colon, if present.
    let value = line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') event = value;
    else if (field === 'data') dataParts.push(value);
    // ignore other fields (id, retry)
  }

  if (dataParts.length === 0 && event === undefined) return null;
  return { event, data: dataParts.join('\n') };
}
