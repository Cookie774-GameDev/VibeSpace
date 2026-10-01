export interface OpenCodeSseEvent {
  id?: string;
  event?: string;
  data: string;
}

export interface OpenCodeSseLimits {
  maxBufferBytes: number;
  maxEventBytes: number;
}

const DEFAULT_LIMITS: OpenCodeSseLimits = {
  maxBufferBytes: 256 * 1024,
  maxEventBytes: 128 * 1024,
};

function delimiter(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) return undefined;
  if (lf < 0) return { index: crlf, length: 4 };
  if (crlf < 0 || lf < crlf) return { index: lf, length: 2 };
  return { index: crlf, length: 4 };
}

function parseBlock(block: string, maximumBytes: number): OpenCodeSseEvent | undefined {
  if (block.length > maximumBytes) throw new Error('OpenCode SSE event exceeded the safe limit.');

  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, '');
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id' && !value.includes('\0')) id = value.slice(0, 512);
    if (field === 'event') event = value.slice(0, 256);
    if (field === 'data') data.push(value);
  }
  if (data.length === 0) return undefined;
  return {
    ...(id ? { id } : {}),
    ...(event ? { event } : {}),
    data: data.join('\n'),
  };
}

export async function* parseOpenCodeSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  limits: OpenCodeSseLimits = DEFAULT_LIMITS,
): AsyncGenerator<OpenCodeSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!signal?.aborted) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (signal?.aborted) return;
        throw error;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      let end = delimiter(buffer);
      while (end) {
        const block = buffer.slice(0, end.index);
        buffer = buffer.slice(end.index + end.length);
        const parsed = parseBlock(block, limits.maxEventBytes);
        if (parsed) yield parsed;
        end = delimiter(buffer);
      }
      if (buffer.length > limits.maxBufferBytes) {
        throw new Error('OpenCode SSE event exceeded the safe limit.');
      }
    }

    if (!signal?.aborted) {
      buffer += decoder.decode();
      if (buffer.trim()) {
        const parsed = parseBlock(buffer, limits.maxEventBytes);
        if (parsed) yield parsed;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed or errored.
    }
    reader.releaseLock();
  }
}
