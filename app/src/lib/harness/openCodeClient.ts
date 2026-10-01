import { redactHarnessText } from './errors';
import { QWEN_COMPATIBLE_BASE_URLS } from '@/lib/ai/nativeConnectionProbe';
import type { OpenCodeServerConnection } from './runtimeManager';
import { parseOpenCodeSse, type OpenCodeSseEvent } from './sseParser';

type JsonRecord = Record<string, unknown>;

export interface OpenCodeSession extends JsonRecord {
  id: string;
  title?: string;
  parentID?: string;
}

export interface OpenCodePrompt {
  model: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
  parts: readonly unknown[];
  system?: string;
  tools?: Readonly<Record<string, boolean>>;
}

export type OpenCodeAuthPrompt =
  | {
      type: 'text';
      key: string;
      message: string;
      placeholder?: string;
      when?: { key: string; op: 'eq' | 'neq'; value: string };
    }
  | {
      type: 'select';
      key: string;
      message: string;
      options: readonly { label: string; value: string; hint?: string }[];
      when?: { key: string; op: 'eq' | 'neq'; value: string };
    };

export interface OpenCodeProviderAuthMethod {
  type: 'oauth' | 'api';
  label: string;
  prompts?: readonly OpenCodeAuthPrompt[];
}

export interface OpenCodeProviderAuthorization {
  url: string;
  method: 'auto' | 'code';
  instructions: string;
}

export interface OpenCodeHttpClient {
  health(): Promise<{ healthy: true; version: string }>;
  configureQwenEndpoint(baseUrl: string): Promise<void>;
  configProviders(): Promise<unknown>;
  providerAuthMethods(): Promise<Readonly<Record<string, readonly OpenCodeProviderAuthMethod[]>>>;
  providerStatus(): Promise<{ connected: readonly string[] }>;
  authorizeProvider(
    providerId: string,
    method: number,
    inputs?: Readonly<Record<string, string>>,
  ): Promise<OpenCodeProviderAuthorization>;
  callbackProvider(providerId: string, method: number, code?: string): Promise<boolean>;
  createSession(
    input: { title?: string; parentID?: string },
    directory?: string,
  ): Promise<OpenCodeSession>;
  getSession(sessionId: string, directory?: string): Promise<OpenCodeSession>;
  deleteSession(sessionId: string, directory?: string): Promise<boolean>;
  children(sessionId: string, directory?: string): Promise<readonly unknown[]>;
  messages(sessionId: string, directory?: string): Promise<readonly unknown[]>;
  diff(sessionId: string, directory?: string): Promise<readonly unknown[]>;
  promptAsync(
    sessionId: string,
    input: OpenCodePrompt,
    signal?: AbortSignal,
    directory?: string,
  ): Promise<void>;
  command(sessionId: string, input: unknown, directory?: string): Promise<unknown>;
  shell(sessionId: string, input: unknown, directory?: string): Promise<unknown>;
  abortSession(sessionId: string, directory?: string): Promise<boolean>;
  replyPermission(
    sessionId: string,
    permissionId: string,
    response: 'once' | 'always' | 'reject',
    directory?: string,
  ): Promise<boolean>;
  events(signal?: AbortSignal, directory?: string): AsyncIterable<OpenCodeSseEvent>;
  disposeInstance(): Promise<boolean>;
}

interface ClientOptions {
  fetch?: typeof globalThis.fetch;
}

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PROVIDER_JSON_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_BYTES = 2_048;
const MAX_AUTH_PROVIDERS = 256;
const MAX_AUTH_METHODS = 32;
const MAX_AUTH_PROMPTS = 16;
const MAX_AUTH_OPTIONS = 64;
const MAX_AUTH_COPY = 4_096;
const MAX_AUTH_URL = 2_048;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readBounded(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let value = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      value += decoder.decode(chunk.value, { stream: true });
      if (value.length > maximumBytes) {
        value = value.slice(0, maximumBytes);
        break;
      }
    }
    return value + decoder.decode();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The body may already be closed.
    }
    reader.releaseLock();
  }
}

function requireSession(value: unknown): OpenCodeSession {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) {
    throw new Error('OpenCode returned an invalid session.');
  }
  return value as OpenCodeSession;
}

function boundedAuthString(value: unknown, maximum = MAX_AUTH_COPY): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (!normalized || normalized.length > maximum || normalized.includes('\u0000')) return undefined;
  return normalized;
}

function parseWhen(value: unknown): OpenCodeAuthPrompt['when'] | undefined {
  if (value === undefined) return undefined;
  const record = isRecord(value) ? value : undefined;
  const key = record && boundedAuthString(record.key, 256);
  const condition = record && (record.op === 'eq' || record.op === 'neq' ? record.op : undefined);
  const expected = record && boundedAuthString(record.value, 512);
  return key && condition && expected ? { key, op: condition, value: expected } : undefined;
}

function parseAuthPrompt(value: unknown): OpenCodeAuthPrompt | undefined {
  const prompt = isRecord(value) ? value : undefined;
  const key = prompt && boundedAuthString(prompt.key, 256);
  const message = prompt && boundedAuthString(prompt.message, 1_024);
  if (!prompt || !key || !message) return undefined;
  const when = parseWhen(prompt.when);
  if (prompt.when !== undefined && !when) return undefined;
  if (prompt.type === 'text') {
    const placeholder =
      prompt.placeholder === undefined ? undefined : boundedAuthString(prompt.placeholder, 512);
    if (prompt.placeholder !== undefined && !placeholder) return undefined;
    return {
      type: 'text',
      key,
      message,
      ...(placeholder ? { placeholder } : {}),
      ...(when ? { when } : {}),
    };
  }
  if (prompt.type !== 'select' || !Array.isArray(prompt.options)) return undefined;
  const options = prompt.options.slice(0, MAX_AUTH_OPTIONS).map((candidate) => {
    const option = isRecord(candidate) ? candidate : undefined;
    const label = option && boundedAuthString(option.label, 512);
    const optionValue = option && boundedAuthString(option.value, 512);
    const hint = option?.hint === undefined ? undefined : boundedAuthString(option.hint, 1_024);
    return option && label && optionValue && (option.hint === undefined || hint)
      ? { label, value: optionValue, ...(hint ? { hint } : {}) }
      : undefined;
  });
  if (options.length !== prompt.options.length || options.some((option) => !option))
    return undefined;
  return {
    type: 'select',
    key,
    message,
    options: options as Array<{ label: string; value: string; hint?: string }>,
    ...(when ? { when } : {}),
  };
}

function requireProviderAuthMethods(
  value: unknown,
): Readonly<Record<string, readonly OpenCodeProviderAuthMethod[]>> {
  if (!isRecord(value) || Object.keys(value).length > MAX_AUTH_PROVIDERS) {
    throw new Error('OpenCode returned invalid provider auth methods.');
  }
  const result: Record<string, readonly OpenCodeProviderAuthMethod[]> = {};
  for (const [providerId, rawMethods] of Object.entries(value)) {
    const id = boundedAuthString(providerId, 256);
    if (!id || !Array.isArray(rawMethods) || rawMethods.length > MAX_AUTH_METHODS) {
      throw new Error('OpenCode returned invalid provider auth methods.');
    }
    const methods = rawMethods.map((candidate) => {
      const method = isRecord(candidate) ? candidate : undefined;
      const type =
        method && (method.type === 'oauth' || method.type === 'api' ? method.type : undefined);
      const label = method && boundedAuthString(method.label, 512);
      if (!method || !type || !label) return undefined;
      if (method.prompts === undefined) return { type, label };
      if (!Array.isArray(method.prompts) || method.prompts.length > MAX_AUTH_PROMPTS)
        return undefined;
      const prompts = method.prompts.map(parseAuthPrompt);
      if (prompts.some((prompt) => !prompt)) return undefined;
      return { type, label, prompts: prompts as OpenCodeAuthPrompt[] };
    });
    if (methods.some((method) => !method)) {
      throw new Error('OpenCode returned invalid provider auth methods.');
    }
    result[id] = methods as OpenCodeProviderAuthMethod[];
  }
  return result;
}

function requireProviderStatus(value: unknown): { connected: readonly string[] } {
  const response = isRecord(value) ? value : undefined;
  if (
    !response ||
    !Array.isArray(response.connected) ||
    response.connected.length > MAX_AUTH_PROVIDERS
  ) {
    throw new Error('OpenCode returned invalid provider status.');
  }
  const connected = response.connected.map((id) => boundedAuthString(id, 256));
  if (connected.some((id) => !id) || new Set(connected).size !== connected.length) {
    throw new Error('OpenCode returned invalid provider status.');
  }
  return { connected: connected as string[] };
}

function requireProviderAuthorization(value: unknown): OpenCodeProviderAuthorization {
  const authorization = isRecord(value) ? value : undefined;
  const url = authorization && boundedAuthString(authorization.url, MAX_AUTH_URL);
  const method =
    authorization &&
    (authorization.method === 'auto' || authorization.method === 'code'
      ? authorization.method
      : undefined);
  const instructions = authorization && boundedAuthString(authorization.instructions);
  if (!authorization || !url || !method || !instructions) {
    throw new Error('OpenCode returned an invalid authorization response.');
  }
  return { url, method, instructions };
}

export function createOpenCodeHttpClient(
  connection: OpenCodeServerConnection,
  options: ClientOptions = {},
): OpenCodeHttpClient {
  const connectionUrl = new URL(connection.baseUrl);
  if (
    connectionUrl.protocol !== 'http:' ||
    connectionUrl.hostname !== '127.0.0.1' ||
    connectionUrl.username ||
    connectionUrl.password ||
    connectionUrl.pathname !== '/' ||
    connectionUrl.search ||
    connectionUrl.hash ||
    connection.username !== 'vibespace' ||
    !/^[A-Za-z0-9_-]{64}$/.test(connection.password)
  ) {
    throw new Error('OpenCode client requires a validated private loopback connection.');
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const authorization = `Basic ${btoa(`${connection.username}:${connection.password}`)}`;
  const baseUrl = connection.baseUrl;

  const sanitize = (value: string): string =>
    redactHarnessText(value.split(connection.password).join('[REDACTED]')).slice(
      0,
      MAX_ERROR_BYTES,
    );

  const requestUrl = (path: string, directory?: string): string => {
    const url = new URL(path, baseUrl);
    if (directory !== undefined) {
      if (
        !directory ||
        directory.length > 4_096 ||
        directory.includes('\u0000') ||
        /[\r\n]/.test(directory)
      ) {
        throw new Error('OpenCode working directory is invalid.');
      }
      url.searchParams.set('directory', directory);
    }
    return url.toString();
  };

  const request = async (
    path: string,
    init: RequestInit = {},
    expected: 'json' | 'void' = 'json',
    maximumBytes = MAX_JSON_BYTES,
    directory?: string,
  ): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(requestUrl(path, directory), {
        ...init,
        credentials: 'omit',
        redirect: 'error',
        headers: {
          accept: expected === 'json' ? 'application/json' : '*/*',
          authorization,
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
      });
    } catch (error) {
      throw new Error(
        sanitize(error instanceof Error ? error.message : 'OpenCode request failed.'),
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new Error('OpenCode refused an unsafe redirect.');
    }
    if (!response.ok) {
      const detail = sanitize(await readBounded(response, MAX_ERROR_BYTES));
      throw new Error(`OpenCode request failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }
    if (expected === 'void' || response.status === 204) return undefined;
    const text = await readBounded(response, maximumBytes);
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error('OpenCode returned malformed JSON.');
    }
  };

  const sessionPath = (sessionId: string, suffix = '') =>
    `/session/${encodeURIComponent(sessionId)}${suffix}`;
  const booleanRequest = async (
    path: string,
    init: RequestInit,
    directory?: string,
  ): Promise<boolean> => (await request(path, init, 'json', MAX_JSON_BYTES, directory)) === true;

  return {
    async health() {
      const value = await request('/global/health');
      if (
        !isRecord(value) ||
        value.healthy !== true ||
        typeof value.version !== 'string' ||
        !value.version
      ) {
        throw new Error('OpenCode returned an invalid health response.');
      }
      return { healthy: true, version: value.version };
    },
    async configureQwenEndpoint(qwenBaseUrl) {
      if (!(QWEN_COMPATIBLE_BASE_URLS as readonly string[]).includes(qwenBaseUrl)) {
        throw new Error('OpenCode requires a verified Qwen endpoint.');
      }
      await request('/config', {
        method: 'PATCH',
        body: JSON.stringify({
          provider: {
            qwen: {
              options: {
                baseURL: qwenBaseUrl,
              },
            },
          },
        }),
      });
    },
    configProviders: () => request('/config/providers', {}, 'json', MAX_PROVIDER_JSON_BYTES),
    async providerAuthMethods() {
      return requireProviderAuthMethods(await request('/provider/auth'));
    },
    async providerStatus() {
      return requireProviderStatus(await request('/provider', {}, 'json', MAX_PROVIDER_JSON_BYTES));
    },
    async authorizeProvider(providerId, method, inputs) {
      return requireProviderAuthorization(
        await request(`/provider/${encodeURIComponent(providerId)}/oauth/authorize`, {
          method: 'POST',
          body: JSON.stringify({ method, ...(inputs ? { inputs } : {}) }),
        }),
      );
    },
    callbackProvider: (providerId, method, code) =>
      booleanRequest(`/provider/${encodeURIComponent(providerId)}/oauth/callback`, {
        method: 'POST',
        body: JSON.stringify({ method, ...(code ? { code } : {}) }),
      }),
    async createSession(input, directory) {
      return requireSession(
        await request(
          '/session',
          { method: 'POST', body: JSON.stringify(input) },
          'json',
          MAX_JSON_BYTES,
          directory,
        ),
      );
    },
    async getSession(sessionId, directory) {
      return requireSession(
        await request(sessionPath(sessionId), {}, 'json', MAX_JSON_BYTES, directory),
      );
    },
    deleteSession: (sessionId, directory) =>
      booleanRequest(sessionPath(sessionId), { method: 'DELETE' }, directory),
    async children(sessionId, directory) {
      const value = await request(
        sessionPath(sessionId, '/children'),
        {},
        'json',
        MAX_JSON_BYTES,
        directory,
      );
      if (!Array.isArray(value)) throw new Error('OpenCode returned invalid child sessions.');
      return value;
    },
    async messages(sessionId, directory) {
      const value = await request(
        sessionPath(sessionId, '/message'),
        {},
        'json',
        MAX_JSON_BYTES,
        directory,
      );
      if (!Array.isArray(value)) throw new Error('OpenCode returned invalid messages.');
      return value;
    },
    async diff(sessionId, directory) {
      const value = await request(
        sessionPath(sessionId, '/diff'),
        {},
        'json',
        MAX_JSON_BYTES,
        directory,
      );
      if (!Array.isArray(value)) throw new Error('OpenCode returned an invalid session diff.');
      return value;
    },
    async promptAsync(sessionId, input, signal, directory) {
      await request(
        sessionPath(sessionId, '/prompt_async'),
        { method: 'POST', body: JSON.stringify(input), signal },
        'void',
        MAX_JSON_BYTES,
        directory,
      );
    },
    command: (sessionId, input, directory) =>
      request(
        sessionPath(sessionId, '/command'),
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
        'json',
        MAX_JSON_BYTES,
        directory,
      ),
    shell: (sessionId, input, directory) =>
      request(
        sessionPath(sessionId, '/shell'),
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
        'json',
        MAX_JSON_BYTES,
        directory,
      ),
    abortSession: (sessionId, directory) =>
      booleanRequest(sessionPath(sessionId, '/abort'), { method: 'POST' }, directory),
    replyPermission: (sessionId, permissionId, response, directory) =>
      booleanRequest(
        `${sessionPath(sessionId)}/permissions/${encodeURIComponent(permissionId)}`,
        {
          method: 'POST',
          body: JSON.stringify({ response }),
        },
        directory,
      ),
    async *events(signal, directory) {
      let response: Response;
      try {
        response = await fetchImpl(requestUrl('/event', directory), {
          method: 'GET',
          credentials: 'omit',
          redirect: 'error',
          signal,
          headers: {
            accept: 'text/event-stream',
            authorization,
            'cache-control': 'no-cache',
          },
        });
      } catch (error) {
        if (signal?.aborted) return;
        throw new Error(
          sanitize(error instanceof Error ? error.message : 'OpenCode event stream failed.'),
        );
      }
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (
        (response.status >= 300 && response.status < 400) ||
        !response.ok ||
        !contentType.includes('text/event-stream') ||
        !response.body
      ) {
        throw new Error('OpenCode returned an invalid event stream.');
      }
      yield* parseOpenCodeSse(response.body, signal);
    },
    disposeInstance: () => booleanRequest('/instance/dispose', { method: 'POST' }),
  };
}
