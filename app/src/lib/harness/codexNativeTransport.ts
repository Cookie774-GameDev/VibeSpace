const MAX_QUEUED_FRAMES = 256;
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const MAX_WRITE_BYTES = 4 * 1024 * 1024;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const encoder = new TextEncoder();

type NativeCodexStreamMessage =
  | { kind: 'frame'; frame: Record<string, unknown> }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

interface NativeChannel {
  onmessage: (message: unknown) => void;
}

export interface CodexNativeBridge {
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
  channel(onmessage: (message: unknown) => void): NativeChannel;
}

export type CodexNativeBridgeFactory = () => Promise<CodexNativeBridge>;

async function defaultBridge(): Promise<CodexNativeBridge> {
  const core = await import('@tauri-apps/api/core');
  return {
    invoke: (command, args) => core.invoke(command, args),
    channel: (onmessage) => new core.Channel(onmessage),
  };
}

function requireIdentifier(value: string, label: string): string {
  if (!SAFE_IDENTIFIER.test(value)) throw new Error('Codex native ' + label + ' is invalid.');
  return value;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeError(value: unknown, fallback: string): Error {
  const raw = value instanceof Error ? value.message : typeof value === 'string' ? value : fallback;
  const message = raw
    .replace(/[\r\n\u0000-\u001f\u007f]+/gu, ' ')
    .trim()
    .slice(0, 512);
  return new Error(message || fallback);
}

function streamId(): string {
  const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '');
  if (random) return 'codex-stream-' + random;
  const bytes = new Uint8Array(24);
  globalThis.crypto?.getRandomValues?.(bytes);
  const fallback = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (!fallback || /^0+$/u.test(fallback)) {
    throw new Error('Codex native stream identity could not be created.');
  }
  return 'codex-stream-' + fallback;
}

export async function startNativeCodexAppServer(
  executableId: string,
  ownerId: string,
  modelId: string,
  bridgeFactory: CodexNativeBridgeFactory = defaultBridge,
): Promise<Readonly<{ generation: string }>> {
  const bridge = await bridgeFactory();
  const value = recordOf(
    await bridge
      .invoke('codex_app_server_start', {
        request: {
          executableId: requireIdentifier(executableId, 'executable identity'),
          ownerId: requireIdentifier(ownerId, 'owner identity'),
          modelId: requireIdentifier(modelId, 'model identity'),
        },
      })
      .catch((error: unknown) => {
        throw safeError(error, 'Codex native startup failed.');
      }),
  );
  const generation = typeof value?.generation === 'string' ? value.generation : '';
  return { generation: requireIdentifier(generation, 'generation') };
}

export async function writeNativeCodexFrame(
  generation: string,
  message: unknown,
  bridgeFactory: CodexNativeBridgeFactory = defaultBridge,
): Promise<void> {
  const record = recordOf(message);
  if (!record) throw new Error('Codex native protocol message must be an object.');
  const size = encoder.encode(JSON.stringify(record)).byteLength;
  if (size === 0 || size > MAX_WRITE_BYTES) {
    throw new Error('Codex native protocol message exceeds its safe bound.');
  }
  const bridge = await bridgeFactory();
  await bridge.invoke('codex_app_server_write', {
    generation: requireIdentifier(generation, 'generation'),
    message: record,
  });
}

export async function stopNativeCodexAppServer(
  generation: string,
  bridgeFactory: CodexNativeBridgeFactory = defaultBridge,
): Promise<boolean> {
  const bridge = await bridgeFactory();
  return Boolean(
    await bridge.invoke('codex_app_server_stop', {
      generation: requireIdentifier(generation, 'generation'),
    }),
  );
}

function messageBytes(message: NativeCodexStreamMessage): number {
  if (message.kind === 'frame') return encoder.encode(JSON.stringify(message.frame)).byteLength;
  if (message.kind === 'error') return encoder.encode(message.message).byteLength;
  return 0;
}

// Preserve text and ordering during a slow renderer without increasing queue limits.
// Never combine RPC replies, controls, different items, or differently scoped notifications.
function adjacentDelta(
  previous: NativeCodexStreamMessage | undefined,
  next: NativeCodexStreamMessage,
): NativeCodexStreamMessage | undefined {
  if (
    previous?.kind !== 'frame' ||
    next.kind !== 'frame' ||
    'id' in previous.frame ||
    'id' in next.frame
  )
    return;
  const methods = [
    'item/agentMessage/delta',
    'item/reasoning/summaryTextDelta',
    'item/reasoning/textDelta',
    'item/commandExecution/outputDelta',
  ];
  if (!methods.includes(String(next.frame.method)) || previous.frame.method !== next.frame.method)
    return;
  const before = recordOf(previous.frame.params);
  const after = recordOf(next.frame.params);
  if (
    typeof before?.delta !== 'string' ||
    typeof after?.delta !== 'string' ||
    before.delta.length + after.delta.length > 32_768
  )
    return;
  if (!before.threadId || !before.turnId || !before.itemId) return;
  const { delta: beforeText, ...beforeScope } = before;
  const { delta: afterText, ...afterScope } = after;
  if (
    JSON.stringify({ ...previous.frame, params: beforeScope }) !==
    JSON.stringify({ ...next.frame, params: afterScope })
  )
    return;
  return {
    kind: 'frame',
    frame: { ...previous.frame, params: { ...before, delta: beforeText + afterText } },
  };
}

export async function* nativeCodexFrames(
  generation: string,
  signal?: AbortSignal,
  bridgeFactory: CodexNativeBridgeFactory = defaultBridge,
  onSubscribed?: () => void,
): AsyncGenerator<Record<string, unknown>> {
  if (signal?.aborted) return;
  const exactGeneration = requireIdentifier(generation, 'generation');
  const bridge = await bridgeFactory();
  if (signal?.aborted) return;
  const id = streamId();
  const queued: Array<{ message: NativeCodexStreamMessage; bytes: number }> = [];
  let queuedBytes = 0;
  let wake: (() => void) | undefined;
  let terminal = false;
  let overflowed = false;
  const push = (message: NativeCodexStreamMessage) => {
    if (terminal || overflowed) return;
    const last = queued.at(-1);
    const combined = adjacentDelta(last?.message, message);
    if (last && combined) {
      const bytes = messageBytes(combined);
      if (queuedBytes - last.bytes + bytes <= MAX_QUEUED_BYTES) {
        queuedBytes += bytes - last.bytes;
        last.message = combined;
        last.bytes = bytes;
        return;
      }
    }
    const bytes = messageBytes(message);
    if (queued.length >= MAX_QUEUED_FRAMES || queuedBytes + bytes > MAX_QUEUED_BYTES) {
      overflowed = true;
      queued.length = 0;
      queuedBytes = 0;
      const error: NativeCodexStreamMessage = {
        kind: 'error',
        message: 'Codex native event queue exceeded safe limits.',
      };
      const errorBytes = messageBytes(error);
      queued.push({ message: error, bytes: errorBytes });
      queuedBytes = errorBytes;
      wake?.();
      wake = undefined;
      return;
    }
    queued.push({ message, bytes });
    queuedBytes += bytes;
    wake?.();
    wake = undefined;
  };
  const onmessage = (value: unknown) => {
    const message = recordOf(value);
    if (message?.kind === 'frame' && recordOf(message.frame)) {
      push({ kind: 'frame', frame: recordOf(message.frame)! });
    } else if (message?.kind === 'done') {
      push({ kind: 'done' });
    } else if (message?.kind === 'error') {
      push({
        kind: 'error',
        message: safeError(message.message, 'Codex native stream failed.').message,
      });
    } else {
      push({ kind: 'error', message: 'Codex native stream returned an invalid message.' });
    }
  };
  // Install cancellation before bridge setup: a channel factory or a synchronous
  // native registration can abort this consumer before invoke returns.
  let stopPromise: Promise<boolean> | undefined;
  const stopOnce = () =>
    (stopPromise ??= stopNativeCodexAppServer(exactGeneration, bridgeFactory).catch(() => false));
  const abort = () => {
    void stopOnce();
    push({ kind: 'done' });
  };
  let invocation: Promise<void> = Promise.resolve();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) {
      abort();
      return;
    }
    const channel = bridge.channel(onmessage);
    if (signal?.aborted) return;
    invocation = bridge
      .invoke('codex_app_server_stream', {
        generation: exactGeneration,
        streamId: id,
        onEvent: channel,
      })
      .then(() => {
        // Native registration is asynchronous; writes require its acknowledgement.
        if (!terminal && !overflowed && !signal?.aborted) onSubscribed?.();
      })
      .catch((error) =>
        push({ kind: 'error', message: safeError(error, 'Codex native stream failed.').message }),
      );
    while (true) {
      if (queued.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const item = queued.shift();
      if (!item) continue;
      queuedBytes -= item.bytes;
      if (item.message.kind === 'done') return;
      if (item.message.kind === 'error') throw new Error(item.message.message);
      yield item.message.frame;
    }
  } finally {
    terminal = true;
    signal?.removeEventListener('abort', abort);
    if (overflowed || signal?.aborted) {
      await stopOnce();
    }
    await invocation;
  }
}
