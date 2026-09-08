import type { OpenCodeRawEvent } from './OpenCodeSdkSessionClient';

interface NativeTransportResponse {
  status: number;
  statusText: string;
  body: string;
}

type NativeTransportRoute =
  | { kind: 'health' }
  | { kind: 'config' }
  | { kind: 'config_providers' }
  | { kind: 'provider_auth' }
  | { kind: 'provider_status' }
  | { kind: 'provider_authorize'; providerId: string }
  | { kind: 'provider_callback'; providerId: string }
  | { kind: 'mcp_status' }
  | { kind: 'mcp_add' }
  | { kind: 'mcp_connect'; name: string }
  | { kind: 'mcp_disconnect'; name: string }
  | { kind: 'mcp_authenticate'; name: string }
  | { kind: 'mcp_auth_remove'; name: string }
  | { kind: 'question_list' }
  | { kind: 'permission_list' }
  | { kind: 'question_reply'; requestId: string }
  | { kind: 'question_reject'; requestId: string }
  | { kind: 'session_create' }
  | { kind: 'session_get'; sessionId: string }
  | { kind: 'session_delete'; sessionId: string }
  | { kind: 'session_children'; sessionId: string }
  | { kind: 'session_messages'; sessionId: string; limit?: number }
  | { kind: 'session_diff'; sessionId: string }
  | { kind: 'session_prompt_async'; sessionId: string }
  | { kind: 'session_command'; sessionId: string }
  | { kind: 'session_abort'; sessionId: string }
  | { kind: 'session_permission'; sessionId: string; permissionId: string }
  | { kind: 'session_status' }
  | { kind: 'instance_dispose' };

type NativeStreamMessage =
  | { kind: 'event'; data: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

const MAX_QUEUED_NATIVE_EVENTS = 256;
const MAX_QUEUED_NATIVE_BYTES = 8 * 1024 * 1024;
const nativeStreamTextEncoder = new TextEncoder();

function nativeStreamMessageBytes(message: NativeStreamMessage): number {
  if (message.kind === 'event') return nativeStreamTextEncoder.encode(message.data).byteLength;
  if (message.kind === 'error') return nativeStreamTextEncoder.encode(message.message).byteLength;
  return 0;
}

interface NativeChannel {
  onmessage: (message: unknown) => void;
}

interface NativeTransportBridge {
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
  channel(onmessage: (message: unknown) => void): NativeChannel;
}

async function defaultBridge(): Promise<NativeTransportBridge> {
  const core = await import('@tauri-apps/api/core');
  return {
    invoke: (command, args) => core.invoke(command, args),
    channel: (onmessage) => new core.Channel(onmessage),
  };
}

function streamId(): string {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, '');
  if (random) return `opencode-stream-${random}`;
  const bytes = new Uint8Array(24);
  globalThis.crypto?.getRandomValues?.(bytes);
  const fallback = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (!fallback || /^0+$/u.test(fallback)) {
    throw new Error('OpenCode event stream identity could not be created.');
  }
  return `opencode-stream-${fallback}`;
}

function safeError(error: unknown, fallback: string): Error {
  const text =
    error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;
  const bounded = text
    .replace(/[\r\n\u0000-\u001f\u007f]+/gu, ' ')
    .trim()
    .slice(0, 512);
  return new Error(bounded || fallback);
}

function decodedIdentifier(value: string | undefined): string {
  if (!value) throw new Error('OpenCode native transport route is invalid.');
  const decoded = decodeURIComponent(value);
  if (decoded.length > 512 || /[\u0000-\u001f\u007f]/u.test(decoded)) {
    throw new Error('OpenCode native transport identifier is invalid.');
  }
  return decoded;
}

function nativeRoute(
  path: string,
  method: string,
): { route: NativeTransportRoute; directory?: string } {
  const url = new URL(path, 'http://127.0.0.1');
  if (url.origin !== 'http://127.0.0.1' || url.hash) {
    throw new Error('OpenCode native transport route is invalid.');
  }
  const directory = url.searchParams.get('directory') ?? undefined;
  const segments = url.pathname.split('/').filter(Boolean);
  const key = `${method} /${segments.join('/')}`;
  let route: NativeTransportRoute;
  if (key === 'GET /global/health') route = { kind: 'health' };
  else if (key === 'PATCH /config') route = { kind: 'config' };
  else if (key === 'GET /config/providers') route = { kind: 'config_providers' };
  else if (key === 'GET /provider/auth') route = { kind: 'provider_auth' };
  else if (key === 'GET /provider') route = { kind: 'provider_status' };
  else if (
    method === 'POST' &&
    segments.length === 4 &&
    segments[0] === 'provider' &&
    segments[2] === 'oauth'
  ) {
    const providerId = decodedIdentifier(segments[1]);
    if (segments[3] === 'authorize') route = { kind: 'provider_authorize', providerId };
    else if (segments[3] === 'callback') route = { kind: 'provider_callback', providerId };
    else throw new Error('OpenCode native transport route is invalid.');
  } else if (key === 'POST /session') route = { kind: 'session_create' };
  else if (key === 'GET /question') route = { kind: 'question_list' };
  else if (key === 'GET /permission') route = { kind: 'permission_list' };
  else if (segments[0] === 'question' && segments.length === 3 && method === 'POST') {
    const requestId = decodedIdentifier(segments[1]);
    if (segments[2] === 'reply') route = { kind: 'question_reply', requestId };
    else if (segments[2] === 'reject') route = { kind: 'question_reject', requestId };
    else throw new Error('OpenCode native transport route is invalid.');
  } else if (key === 'GET /mcp') route = { kind: 'mcp_status' };
  else if (key === 'POST /mcp') route = { kind: 'mcp_add' };
  else if (
    segments[0] === 'mcp' &&
    segments.length === 4 &&
    method === 'POST' &&
    segments[2] === 'auth' &&
    segments[3] === 'authenticate'
  )
    route = { kind: 'mcp_authenticate', name: decodedIdentifier(segments[1]) };
  else if (
    segments[0] === 'mcp' &&
    segments.length === 3 &&
    method === 'DELETE' &&
    segments[2] === 'auth'
  )
    route = { kind: 'mcp_auth_remove', name: decodedIdentifier(segments[1]) };
  else if (segments[0] === 'mcp' && segments.length === 3 && method === 'POST') {
    const name = decodedIdentifier(segments[1]);
    if (segments[2] === 'connect') route = { kind: 'mcp_connect', name };
    else if (segments[2] === 'disconnect') route = { kind: 'mcp_disconnect', name };
    else throw new Error('OpenCode native transport route is invalid.');
  } else if (key === 'GET /session/status') route = { kind: 'session_status' };
  else if (key === 'POST /instance/dispose') route = { kind: 'instance_dispose' };
  else if (segments[0] === 'session' && segments.length >= 2) {
    const sessionId = decodedIdentifier(segments[1]);
    if (segments.length === 2 && method === 'GET') route = { kind: 'session_get', sessionId };
    else if (segments.length === 2 && method === 'DELETE')
      route = { kind: 'session_delete', sessionId };
    else if (segments.length === 3 && segments[2] === 'children' && method === 'GET')
      route = { kind: 'session_children', sessionId };
    else if (segments.length === 3 && segments[2] === 'message' && method === 'GET') {
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? undefined : Number(rawLimit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 0 || limit > 65_535)) {
        throw new Error('OpenCode native transport message limit is invalid.');
      }
      route = { kind: 'session_messages', sessionId, ...(limit === undefined ? {} : { limit }) };
    } else if (segments.length === 3 && segments[2] === 'diff' && method === 'GET')
      route = { kind: 'session_diff', sessionId };
    else if (segments.length === 3 && segments[2] === 'prompt_async' && method === 'POST')
      route = { kind: 'session_prompt_async', sessionId };
    else if (segments.length === 3 && segments[2] === 'command' && method === 'POST')
      route = { kind: 'session_command', sessionId };
    else if (segments.length === 3 && segments[2] === 'abort' && method === 'POST')
      route = { kind: 'session_abort', sessionId };
    else if (segments.length === 4 && segments[2] === 'permissions' && method === 'POST')
      route = {
        kind: 'session_permission',
        sessionId,
        permissionId: decodedIdentifier(segments[3]),
      };
    else throw new Error('OpenCode native transport route is invalid.');
  } else throw new Error('OpenCode native transport route is invalid.');
  const allowedQueries = new Set(directory === undefined ? [] : ['directory']);
  if (route.kind === 'session_messages' && url.searchParams.has('limit'))
    allowedQueries.add('limit');
  for (const key of url.searchParams.keys()) {
    if (!allowedQueries.has(key)) throw new Error('OpenCode native transport query is invalid.');
  }
  return { route, ...(directory === undefined ? {} : { directory }) };
}

export async function nativeOpenCodeRequest(
  generation: string,
  path: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
  bridgeFactory: () => Promise<NativeTransportBridge> = defaultBridge,
): Promise<Response> {
  if (init.signal?.aborted) throw init.signal.reason;
  const bridge = await bridgeFactory();
  const method = (init.method ?? 'GET').toUpperCase();
  const mapped = nativeRoute(path, method);
  if (init.signal?.aborted) throw init.signal.reason;
  const nativeRequest = bridge.invoke('opencode_server_request', {
    request: {
      generation,
      ...mapped,
      body: typeof init.body === 'string' ? init.body : undefined,
      timeoutMs,
    },
  });
  // Native HTTP timeouts cannot bound a stalled IPC response. Stop waiting in
  // the renderer too; turn cancellation separately aborts the native session.
  // Never replay a timed-out mutation: its native outcome may be unknown.
  const result = await new Promise<unknown>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      init.signal?.removeEventListener('abort', abort);
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const abort = () => fail(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    if (timeoutMs > 0)
      timer = setTimeout(() => fail(new Error('OpenCode native request timed out.')), timeoutMs);
    init.signal?.addEventListener('abort', abort, { once: true });
    if (init.signal?.aborted) abort();
    void nativeRequest.then((value) => {
      cleanup();
      resolve(value);
    }, fail);
  });
  const response = result as NativeTransportResponse;
  const body = [204, 205, 304].includes(response.status) ? null : response.body;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: { 'content-type': 'application/json' },
  });
}

function parsedEvent(data: string): OpenCodeRawEvent | undefined {
  const parsed = JSON.parse(data) as unknown;
  const wrapped =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  const value = wrapped && 'data' in wrapped ? wrapped.data : parsed;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  if (typeof event.type !== 'string' || !event.type.trim()) return undefined;
  return {
    type: event.type,
    properties:
      event.properties && typeof event.properties === 'object' && !Array.isArray(event.properties)
        ? (event.properties as Record<string, unknown>)
        : undefined,
  };
}

export async function* nativeOpenCodeEvents(
  generation: string,
  path: string,
  signal?: AbortSignal,
  bridgeFactory: () => Promise<NativeTransportBridge> = defaultBridge,
): AsyncGenerator<OpenCodeRawEvent> {
  if (signal?.aborted) return;
  const eventUrl = new URL(path, 'http://127.0.0.1');
  if (eventUrl.pathname !== '/event' || eventUrl.hash) {
    throw new Error('OpenCode native event route is invalid.');
  }
  const directory = eventUrl.searchParams.get('directory') ?? undefined;
  for (const key of eventUrl.searchParams.keys()) {
    if (key !== 'directory') throw new Error('OpenCode native event query is invalid.');
  }
  const bridge = await bridgeFactory();
  const id = streamId();
  const queued: Array<{ message: NativeStreamMessage; bytes: number }> = [];
  let queuedBytes = 0;
  let wake: (() => void) | undefined;
  let terminal = false;
  let overflowed = false;
  const push = (message: NativeStreamMessage) => {
    if (terminal || overflowed) return;
    const bytes = nativeStreamMessageBytes(message);
    if (
      queued.length >= MAX_QUEUED_NATIVE_EVENTS ||
      queuedBytes + bytes > MAX_QUEUED_NATIVE_BYTES
    ) {
      overflowed = true;
      queued.length = 0;
      queuedBytes = 0;
      const error: NativeStreamMessage = {
        kind: 'error',
        message: 'OpenCode native event queue exceeded safe limits.',
      };
      const errorBytes = nativeStreamMessageBytes(error);
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
  const channel = bridge.channel((message) => push(message as NativeStreamMessage));
  const invocation = bridge
    .invoke('opencode_server_event_stream', {
      generation,
      directory,
      streamId: id,
      onEvent: channel,
    })
    .catch((error) =>
      push({ kind: 'error', message: safeError(error, 'OpenCode event stream failed.').message }),
    );
  const cancel = () => {
    void bridge
      .invoke('opencode_server_event_cancel', {
        generation,
        streamId: id,
      })
      .catch(() => undefined);
    push({ kind: 'done' });
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (queued.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const item = queued.shift();
      if (!item) continue;
      queuedBytes -= item.bytes;
      const { message } = item;
      if (message.kind === 'done') return;
      if (message.kind === 'error') throw new Error(message.message);
      const event = parsedEvent(message.data);
      if (event) yield event;
    }
  } finally {
    terminal = true;
    signal?.removeEventListener('abort', cancel);
    await bridge
      .invoke('opencode_server_event_cancel', {
        generation,
        streamId: id,
      })
      .catch(() => false);
    await invocation;
  }
}
