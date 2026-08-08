/**
 * Ollama (local model) client with streaming.
 *
 * Talks to a user-installed Ollama daemon over its OpenAI-compatible API:
 *   POST {base}/v1/chat/completions   (chat, SSE streaming)
 *   GET  {base}/api/tags              (list installed models)
 *   POST {base}/api/pull              (download model, NDJSON progress)
 *   DELETE {base}/api/delete          (remove model)
 * Default base: http://localhost:11434  (override in Settings → Local Models).
 *
 * This is the "no key, no internet" path. Inference runs entirely on the
 * user's machine, so there is no API key and cost is always zero. The SSE
 * shape is identical to OpenAI's (`data: <json>` lines, `data: [DONE]`
 * sentinel), so we reuse the shared parser.
 *
 * CORS: in `npm run jarvis` the page origin is http://localhost:5173 and
 * Ollama accepts it. In a packaged Tauri build the origin is
 * `tauri://localhost`, which Ollama rejects on preflight. Rather than
 * asking every user to export `OLLAMA_ORIGINS=*`, we route every call
 * through `nativeFetch`, which uses `@tauri-apps/plugin-http` (reqwest
 * in the Rust core) when available and falls back to browser fetch in
 * the dev build. The plugin scope in `capabilities/default.json`
 * whitelists localhost on every port so the IPC layer is happy.
 *
 * SECURITY: model names are validated against a strict pattern that
 * rejects path traversal, shell metacharacters, and other injection
 * vectors before any network call is made.
 */
import type { LLMContentPart, LLMMessage, LLMProvider, LLMRequest, LLMResponse } from '../types';
import { estimateCost, estimateInputTokens, llmContentToText, observeResponseBody } from '../types';
import { useAuthStore } from '@/stores/auth';
import { parseSSE } from './sse';
import { nativeFetch } from '@/lib/nativeFetch';
import { isTauri } from '@/lib/utils';
import { ollamaModelSupportsVision } from '../vision';
import {
  localAgentSystemInstruction,
  localOllamaRequestPolicy,
  readLocalAgentPreferences,
  type LocalAgentMode,
} from '../localAgentRuntime';

/** Default Ollama base URL. Configurable via auth store `apiKeys.ollama`. */
export const OLLAMA_DEFAULT_BASE = 'http://127.0.0.1:11434';

const ALLOWED_OLLAMA_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Default local model used when promoting a mock/local-default agent. */
export const OLLAMA_DEFAULT_MODEL = 'llama3.2';

/** Prepended to every Ollama request so local models answer like Jarvis. */
export const OLLAMA_JARVIS_STYLE_PROMPT = `You are Jarvis — the user's personal AI assistant. Keep every reply short, direct, and natural (usually 1–3 sentences unless they ask for more). No filler, no long intros, no unnecessary markdown. Sound calm, capable, and conversational, as if speaking aloud. If the user asks you to do something in VibeSpace, emit the real fenced action block from the system instructions and never claim it already happened before approval.`;

type NativeOllamaInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type NativeOllamaListen = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
) => Promise<() => void>;

function isMissingNativeOllamaChatCommand(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:unknown|not found|does not exist|not registered).*ollama_chat|ollama_chat.*(?:unknown|not found|does not exist|not registered)/i.test(
    message,
  );
}

/** llama3.2 and other non-thinking tags reject `think: true` with HTTP 400. */
function isThinkUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /status_400|does not support think|unknown field ["']?think|invalid.*\bthink\b/i.test(
    message,
  );
}

export async function runNativeOllamaChat(
  invoke: NativeOllamaInvoke,
  args: {
    model: string;
    messages: readonly { role: string; content: string }[];
    options: Record<string, number>;
    think: boolean;
    baseUrl: string;
  },
): Promise<{ text: string; inputTokens?: number; outputTokens?: number }> {
  const result = await invoke<{
    text: string;
    inputTokens?: number;
    outputTokens?: number;
  }>('ollama_chat', args);
  const text = result.text?.trim();
  if (!text) throw new Error('Ollama returned an empty response.');
  return { ...result, text };
}

/**
 * Compatibility bridge for an already-running desktop process that predates
 * the reliable `ollama_chat` IPC command. Remove only after all supported
 * desktop builds include that command.
 */
export async function runLegacyNativeOllamaChat(
  invoke: NativeOllamaInvoke,
  listen: NativeOllamaListen,
  args: {
    requestId: string;
    model: string;
    messages: readonly { role: string; content: string }[];
    temperature: number;
    baseUrl: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    firstResponseTimeoutMs?: number;
    onDelta?: (delta: string) => void;
    options?: Record<string, number>;
    think?: boolean;
  },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let text = '';
    let unlisten: (() => void) | undefined;
    let overallTimeout = 0;
    let firstResponseTimeout = 0;
    let settled = false;

    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(overallTimeout);
      window.clearTimeout(firstResponseTimeout);
      args.signal?.removeEventListener('abort', onAbort);
      unlisten?.();
      if (error) {
        reject(error);
        return;
      }
      const trimmed = text.trim();
      if (!trimmed) {
        reject(new Error('Ollama returned an empty response.'));
        return;
      }
      resolve(trimmed);
    };
    const onAbort = () => finish(new DOMException('Aborted by user', 'AbortError'));

    if (args.signal?.aborted) {
      finish(new DOMException('Aborted by user', 'AbortError'));
      return;
    }
    args.signal?.addEventListener('abort', onAbort, { once: true });
    firstResponseTimeout = window.setTimeout(
      () =>
        finish(
          new Error(
            'Ollama did not begin responding in time. The model may be too large for the available RAM/VRAM or still warming up.',
          ),
        ),
      // Cold local models can spend close to a minute loading and ingesting
      // the protected project context before the authoritative IPC result is
      // available. Keep this below the bounded overall deadline while avoiding
      // a false transport failure during a healthy cold start.
      args.firstResponseTimeoutMs ?? 120_000,
    );
    overallTimeout = window.setTimeout(
      () => finish(new Error('Ollama response timed out.')),
      args.timeoutMs ?? 180_000,
    );

    void listen<{ delta: string; done: boolean; error?: string | null }>(
      `ollama:chat:${args.requestId}`,
      (event) => {
        if (event.payload.error) {
          finish(new Error(event.payload.error));
          return;
        }
        const delta = event.payload.delta ?? '';
        if (delta) {
          window.clearTimeout(firstResponseTimeout);
          text += delta;
          args.onDelta?.(delta);
        }
        if (event.payload.done) finish();
      },
    )
      .then((stopListening) => {
        unlisten = stopListening;
        if (settled) {
          stopListening();
          return;
        }
        return invoke<{
          text?: string;
          inputTokens?: number;
          outputTokens?: number;
        } | void>('ollama_chat_stream', {
          requestId: args.requestId,
          model: args.model,
          messages: args.messages,
          temperature: args.temperature,
          options: args.options,
          think: args.think,
          baseUrl: args.baseUrl,
        }).then((result) => {
          if (settled || !result?.text?.trim()) return;
          text = result.text;
          finish();
        });
      })
      .catch(finish);
  });
}

function isTransientOllamaTransportError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:connect|connection|reset|refused|timed? ?out|timeout|transport|broken pipe|empty response|unavailable)\b/i.test(
    message,
  );
}

export async function runReliableNativeOllamaChat(
  invoke: NativeOllamaInvoke,
  listen: NativeOllamaListen,
  args: {
    requestId: string;
    model: string;
    messages: readonly { role: string; content: string }[];
    options: Record<string, number>;
    think: boolean;
    baseUrl: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    firstResponseTimeoutMs?: number;
    maxAttempts?: number;
    onDelta?: (delta: string) => void;
  },
): Promise<string> {
  if (args.signal?.aborted) {
    throw new DOMException('Aborted by user', 'AbortError');
  }
  const maxAttempts = Math.max(1, Math.min(args.maxAttempts ?? 2, 2));
  let lastError: unknown;
  let effectiveThink = args.think;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let emittedAny = false;
    try {
      return await runLegacyNativeOllamaChat(invoke, listen, {
        requestId: `${args.requestId}-${attempt}`,
        model: args.model,
        messages: args.messages,
        temperature: args.options.temperature ?? OLLAMA_CHAT_DEFAULT_TEMPERATURE,
        options: args.options,
        think: effectiveThink,
        baseUrl: args.baseUrl,
        signal: args.signal,
        timeoutMs: args.timeoutMs,
        firstResponseTimeoutMs: args.firstResponseTimeoutMs,
        onDelta: (delta) => {
          emittedAny = true;
          args.onDelta?.(delta);
        },
      });
    } catch (error) {
      lastError = error;
      if (
        effectiveThink &&
        attempt < maxAttempts &&
        !emittedAny &&
        isThinkUnsupportedError(error) &&
        !args.signal?.aborted
      ) {
        effectiveThink = false;
        continue;
      }
      if (
        attempt >= maxAttempts ||
        emittedAny ||
        !isTransientOllamaTransportError(error) ||
        args.signal?.aborted
      ) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Ollama inference failed.');
}

const OLLAMA_CHAT_KEEP_ALIVE = '15m';
const OLLAMA_CHAT_NUM_CTX = 4096;
// Match the token optimizer's conservative fallback context window. Final
// Boss can reserve 8K output tokens and still retain its broader protected
// evidence instead of silently forcing Ollama back into a truncated 16K turn.
const OLLAMA_CHAT_MAX_NUM_CTX = 32_768;
const OLLAMA_CHAT_MAX_NUM_PREDICT = 8_192;
const OLLAMA_CHAT_REPEAT_PENALTY = 1.18;
const OLLAMA_CHAT_TOP_P = 0.9;
const OLLAMA_CHAT_DEFAULT_TEMPERATURE = 0.45;
const OLLAMA_CHAT_HISTORY_TURNS = 12;
const OLLAMA_CHAT_HISTORY_CHARS = 14_000;

function ollamaChatTemperature(req: LLMRequest): number {
  return req.temperature ?? req.agent.temperature ?? OLLAMA_CHAT_DEFAULT_TEMPERATURE;
}

function ollamaChatOptions(req: LLMRequest, mode: LocalAgentMode): Record<string, number> {
  const policy = localOllamaRequestPolicy(mode);
  const numPredict =
    req.max_output_tokens === undefined
      ? policy.numPredict
      : Math.min(req.max_output_tokens, OLLAMA_CHAT_MAX_NUM_PREDICT);
  const numCtx =
    numPredict <= 512 ? OLLAMA_CHAT_NUM_CTX : numPredict <= 2_048 ? 8_192 : OLLAMA_CHAT_MAX_NUM_CTX;
  return {
    temperature: ollamaChatTemperature(req),
    num_ctx: numCtx,
    num_predict: numPredict,
    repeat_penalty: OLLAMA_CHAT_REPEAT_PENALTY,
    top_p: OLLAMA_CHAT_TOP_P,
  };
}

function compactOllamaMessages(messages: LLMRequest['messages']): LLMRequest['messages'] {
  const nonSystem = messages.filter((m) => m.role !== 'system');
  const tail = nonSystem.slice(-OLLAMA_CHAT_HISTORY_TURNS);
  let totalChars = 0;
  const compacted: LLMRequest['messages'] = [];

  for (let i = tail.length - 1; i >= 0; i--) {
    const message = tail[i]!;
    const nextTotal = totalChars + llmContentToText(message.content).length;
    if (compacted.length > 0 && nextTotal > OLLAMA_CHAT_HISTORY_CHARS) break;
    compacted.unshift(message);
    totalChars = nextTotal;
  }

  return compacted;
}

export function buildOllamaSystemPrompt(agentPrompt: string | undefined): string {
  const base = (agentPrompt ?? '').trim();
  return base ? `${OLLAMA_JARVIS_STYLE_PROMPT}\n\n${base}` : OLLAMA_JARVIS_STYLE_PROMPT;
}

export type OllamaNativeChatMessage = {
  role: string;
  content: string;
  /** Raw base64 images without data: prefix — Ollama /api/chat schema. */
  images?: string[];
};

export type OllamaOpenAiChatMessage = {
  role: string;
  content:
    | string
    | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
};

function stripDataUrlBase64(data: string): string {
  const trimmed = data.trim();
  const comma = trimmed.indexOf(',');
  if (trimmed.startsWith('data:') && comma !== -1) return trimmed.slice(comma + 1);
  return trimmed;
}

function collectImageParts(
  content: LLMMessage['content'],
): Extract<LLMContentPart, { type: 'image' }>[] {
  if (typeof content === 'string') return [];
  return content.filter(
    (part): part is Extract<LLMContentPart, { type: 'image' }> =>
      part.type === 'image' && part.mimeType.startsWith('image/'),
  );
}

/**
 * Pure Ollama /api/chat message builder.
 * Vision models get real base64 `images[]`; text-only models never claim sight.
 */
export function toOllamaNativeMessages(
  messages: readonly LLMMessage[],
  options: { vision: boolean },
): OllamaNativeChatMessage[] {
  return messages.map((message) => {
    if (!options.vision) {
      return {
        role: message.role,
        content: llmContentToText(message.content),
      };
    }
    const images = collectImageParts(message.content)
      .map((part) => stripDataUrlBase64(part.data))
      .filter(Boolean);
    const text = llmContentToText(
      typeof message.content === 'string'
        ? message.content
        : message.content.filter((part) => part.type === 'text'),
    );
    if (images.length === 0) {
      return { role: message.role, content: text || llmContentToText(message.content) };
    }
    return {
      role: message.role,
      content: text.trim() || 'Describe the attached image(s).',
      images,
    };
  });
}

/** OpenAI-compatible multimodal shape for Ollama's `/v1/chat/completions`. */
export function toOllamaOpenAiMessages(
  messages: readonly LLMMessage[],
  options: { vision: boolean },
): OllamaOpenAiChatMessage[] {
  return messages.map((message) => {
    if (!options.vision || typeof message.content === 'string') {
      return {
        role: message.role,
        content:
          typeof message.content === 'string' ? message.content : llmContentToText(message.content),
      };
    }
    const images = collectImageParts(message.content);
    if (images.length === 0) {
      return { role: message.role, content: llmContentToText(message.content) };
    }
    const parts: Array<
      { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
    > = [];
    for (const part of message.content) {
      if (part.type === 'text' && part.text.trim()) {
        parts.push({ type: 'text', text: part.text });
      } else if (part.type === 'image') {
        const data = stripDataUrlBase64(part.data);
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${part.mimeType};base64,${data}` },
        });
      }
    }
    if (!parts.some((part) => part.type === 'text')) {
      parts.unshift({ type: 'text', text: 'Describe the attached image(s).' });
    }
    return { role: message.role, content: parts };
  });
}

export function buildOllamaRequestBody(
  req: LLMRequest,
  model = req.agent.model.model || OLLAMA_DEFAULT_MODEL,
) {
  const mode = readLocalAgentPreferences().mode;
  const policy = localOllamaRequestPolicy(mode);
  const vision = ollamaModelSupportsVision(model);
  const baseSystemPrompt = req.systemPrompt ?? buildOllamaSystemPrompt(req.agent.system_prompt);
  const systemPrompt =
    req.systemPrompt === undefined
      ? `${baseSystemPrompt}\n\n${localAgentSystemInstruction(mode)}`
      : baseSystemPrompt;
  const history = compactOllamaMessages(req.messages);
  return {
    model,
    messages: [
      { role: 'system' as const, content: systemPrompt },
      ...toOllamaNativeMessages(history, { vision }),
    ] as OllamaNativeChatMessage[],
    openAiMessages: [
      { role: 'system' as const, content: systemPrompt },
      ...toOllamaOpenAiMessages(history, { vision }),
    ] as OllamaOpenAiChatMessage[],
    vision,
    stream: true,
    think: policy.think,
    keep_alive: OLLAMA_CHAT_KEEP_ALIVE,
    options: ollamaChatOptions(req, mode),
  };
}

/** Maximum response size for a single chat completion (10 MB). */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Maximum allowed download size for a model (50 GB). */
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024 * 1024;

/** Download timeout (30 minutes). */
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Model names follow Ollama's convention: name[:tag]
 * Allows: letters, digits, underscore, hyphen, dot, forward-slash.
 * Rejects: path traversal (..), shell metacharacters, newlines, spaces.
 */
const SANE_MODEL_RE = /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*(?::[a-zA-Z0-9_.-]+)?$/;

export interface OllamaModelInfo {
  name: string;
  size?: number;
  modifiedAt?: string;
}

export interface OllamaPullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  percent?: number;
  done?: boolean;
}

export interface OllamaPullOptions {
  /** Re-download an installed tag for repair or update. */
  force?: boolean;
}

export interface OllamaChatVerification {
  ok: true;
  response: string;
}

export interface OllamaEnsureStatus {
  ready: boolean;
  apiReachable: boolean;
  installed: boolean;
  version?: string | null;
  phase: string;
  detail?: string | null;
  statusMsg: string;
}

/** Resolve the configured base URL, trimming any trailing slash. */
export function normalizeStoredOllamaEndpoint(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) return OLLAMA_DEFAULT_BASE;
  // Users sometimes paste API keys into the Ollama URL field in Providers.
  if (/^(sk-|AIza|xai-|gsk_)/i.test(trimmed)) return OLLAMA_DEFAULT_BASE;
  try {
    assertAllowedOllamaEndpoint(trimmed);
    return trimmed.replace(/\/+$/, '');
  } catch {
    return OLLAMA_DEFAULT_BASE;
  }
}

/** Resolve the configured base URL, trimming any trailing slash. */
export function ollamaBaseUrl(): string {
  return normalizeStoredOllamaEndpoint(useAuthStore.getState().apiKeys.ollama);
}

/** Restrict Ollama endpoints to loopback hosts unless advanced mode is added later. */
export function assertAllowedOllamaEndpoint(base: string): void {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error('Invalid Ollama URL.');
  }

  if (url.protocol !== 'http:') {
    throw new Error('Ollama must use http on localhost.');
  }

  if (!ALLOWED_OLLAMA_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('Only localhost Ollama endpoints are allowed by default.');
  }
}

function resolvedOllamaBaseUrl(): string {
  const base = ollamaBaseUrl();
  assertAllowedOllamaEndpoint(base);
  return base;
}

/**
 * Headers for every Ollama request.
 *
 * We pin an `Origin` that Ollama accepts (loopback). In a packaged Tauri
 * build the WebView origin is `tauri://localhost` (or `tauri.localhost` on
 * macOS), which Ollama's default origin allow-list rejects with a blanket
 * `403 Forbidden` on every route — breaking pulls, `/api/tags`, and chat.
 * The native HTTP bridge (reqwest) forwards that origin, so we override it
 * here with a loopback origin Ollama always permits. This keeps local models
 * fully silent — no `OLLAMA_ORIGINS` env var or user setup required.
 *
 * Browser `fetch` (the dev build) treats `Origin` as a forbidden header and
 * silently ignores it, so setting it unconditionally is safe in both paths.
 */
function ollamaHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Origin: 'http://127.0.0.1:11434', ...(extra ?? {}) };
}

/**
 * Validate a model name against the allowed pattern. Must be called
 * before any Ollama API call that uses a user-provided model name.
 * Throws with a user-friendly message on rejection.
 */
export function validateModelName(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Model name is empty.');
  if (trimmed.length > 128) throw new Error('Model name is too long (max 128 characters).');
  if (!SANE_MODEL_RE.test(trimmed))
    throw new Error(
      `Invalid model name "${trimmed}". Use format like "llama3.2" or "library/model:tag".`,
    );
}

/**
 * List the models currently installed in the local Ollama daemon.
 * Returns an empty array if Ollama isn't reachable (so the UI can show a
 * friendly "start Ollama" hint rather than throwing).
 */
export async function listOllamaModels(signal?: AbortSignal): Promise<string[]> {
  const models = await listOllamaModelInfo(signal);
  return models.map((model) => model.name);
}

function mapInvokeModels(
  models: Array<{ name: string; size?: number; modifiedAt?: string }>,
): OllamaModelInfo[] {
  return (models ?? []).map((m) => ({
    name: m.name,
    size: typeof m.size === 'number' ? m.size : undefined,
    modifiedAt: typeof m.modifiedAt === 'string' ? m.modifiedAt : undefined,
  }));
}

async function listOllamaModelsViaInvoke(signal?: AbortSignal): Promise<OllamaModelInfo[]> {
  if (signal?.aborted) return [];
  const { invoke } = await import('@tauri-apps/api/core');
  const models = await invoke<Array<{ name: string; size?: number; modifiedAt?: string }>>(
    'ollama_list_models',
    { baseUrl: resolvedOllamaBaseUrl() },
  );
  return mapInvokeModels(models);
}

async function listOllamaModelsViaInvokeWithRetry(
  signal?: AbortSignal,
  attempts = 3,
): Promise<OllamaModelInfo[]> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) return [];
    try {
      return await listOllamaModelsViaInvoke(signal);
    } catch (err) {
      lastError = err;
      if (attempt < attempts - 1) {
        await sleepMs(400 * (attempt + 1), signal);
      }
    }
  }
  if (lastError) throw lastError;
  return [];
}

export async function listOllamaModelInfo(signal?: AbortSignal): Promise<OllamaModelInfo[]> {
  // Packaged Tauri: reqwest in Rust (no WebView Origin → no Ollama 403).
  if (isTauri) {
    try {
      return await listOllamaModelsViaInvokeWithRetry(signal);
    } catch {
      const ready = await ensureOllamaReadySilent(signal);
      if (!ready.ready) return [];
      try {
        return await listOllamaModelsViaInvokeWithRetry(signal);
      } catch {
        return [];
      }
    }
  }
  try {
    const res = await nativeFetch(`${resolvedOllamaBaseUrl()}/api/tags`, {
      signal,
      timeoutMs: 15_000,
      headers: ollamaHeaders(),
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    const models = data?.models;
    if (!Array.isArray(models)) return [];
    return models
      .map((m: { name?: string; size?: number; modified_at?: string }): OllamaModelInfo | null => {
        if (!m?.name || typeof m.name !== 'string') return null;
        return {
          name: m.name,
          size: typeof m.size === 'number' ? m.size : undefined,
          modifiedAt: typeof m.modified_at === 'string' ? m.modified_at : undefined,
        };
      })
      .filter((model: OllamaModelInfo | null): model is OllamaModelInfo => Boolean(model));
  } catch {
    return [];
  }
}

const OLLAMA_PING_TIMEOUT_MS = 5_000;
const OLLAMA_PING_ATTEMPTS = 4;
const OLLAMA_PING_BASE_INTERVAL_MS = 500;

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      finish();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function probeOllamaApiOnce(baseUrl: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;

  if (isTauri) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<boolean>('ollama_ping', { baseUrl });
    } catch {
      return false;
    }
  }

  try {
    const res = await nativeFetch(`${baseUrl}/api/version`, {
      signal,
      timeoutMs: OLLAMA_PING_TIMEOUT_MS,
      headers: ollamaHeaders(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Loopback fallbacks when the stored host does not answer (127.0.0.1 vs localhost). */
function loopbackProbeUrls(): string[] {
  const primary = resolvedOllamaBaseUrl();
  const urls = [primary];
  try {
    const parsed = new URL(primary);
    const altHost = parsed.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
    const alt = `${parsed.protocol}//${altHost}${parsed.port ? `:${parsed.port}` : ''}`;
    if (alt !== primary) urls.push(alt);
  } catch {
    // resolvedOllamaBaseUrl already validated the primary URL.
  }
  return urls;
}

/**
 * Quick reachability probe for the local daemon via /api/version.
 * Retries with backoff so a cold-started background serve has time to bind.
 */
export async function isOllamaReachable(
  signal?: AbortSignal,
  options?: { attempts?: number },
): Promise<boolean> {
  const attempts = Math.max(1, options?.attempts ?? OLLAMA_PING_ATTEMPTS);
  const bases = loopbackProbeUrls();

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) return false;
    for (const base of bases) {
      if (await probeOllamaApiOnce(base, signal)) return true;
    }
    if (attempt < attempts - 1) {
      await sleepMs(OLLAMA_PING_BASE_INTERVAL_MS * (attempt + 1), signal);
    }
  }
  return false;
}

export async function waitForOllamaReachable(
  timeoutMs = 120_000,
  intervalMs = 1500,
  signal?: AbortSignal,
  onStatus?: (msg: string) => void,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let lastMsg = '';
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    const elapsed = timeoutMs - (deadline - Date.now());
    const elapsedSec = Math.round(elapsed / 1000);
    const msg = `Waiting for Ollama… (${elapsedSec}s / ${Math.round(timeoutMs / 1000)}s)`;
    if (msg !== lastMsg && onStatus) {
      lastMsg = msg;
      onStatus(msg);
    }
    if (await isOllamaReachable(signal)) return true;
    await new Promise<void>((resolve) => window.setTimeout(resolve, intervalMs));
  }
  return false;
}

let readyCache: { at: number; status: OllamaEnsureStatus } | null = null;
const READY_CACHE_MS = 20_000;

export function invalidateOllamaReadyCache(): void {
  readyCache = null;
}

function bootstrapStatusMessage(phase: string, detail?: string | null): string {
  switch (phase) {
    case 'ready':
      return 'Ollama ready';
    case 'installing':
      return 'Installing Ollama silently…';
    case 'starting':
      return 'Starting Ollama silently…';
    case 'waiting':
      return detail || 'Waiting for Ollama API…';
    case 'not_installed':
      return 'Preparing Ollama for local models…';
    case 'error':
      return detail || 'Could not connect to Ollama';
    default:
      return detail || 'Checking Ollama…';
  }
}

export interface EnsureOllamaOptions {
  /** Max time to poll /api/version when the daemon is not up yet (web dev). */
  waitTimeoutMs?: number;
}

/**
 * Ensure Ollama is installed, the background server is running, and the API
 * responds on /api/version. Uses the native backend in Tauri for silent
 * `ollama serve` startup; falls back to API polling on web.
 */
export async function ensureOllamaReadySilent(
  signal?: AbortSignal,
  onStatus?: (status: OllamaEnsureStatus) => void,
  options?: EnsureOllamaOptions,
): Promise<OllamaEnsureStatus> {
  if (readyCache && readyCache.status.ready && Date.now() - readyCache.at < READY_CACHE_MS) {
    onStatus?.(readyCache.status);
    return readyCache.status;
  }

  if (signal?.aborted) {
    const aborted: OllamaEnsureStatus = {
      ready: false,
      apiReachable: false,
      installed: false,
      phase: 'error',
      detail: 'Cancelled.',
      statusMsg: 'Cancelled.',
    };
    onStatus?.(aborted);
    return aborted;
  }

  const emit = (status: OllamaEnsureStatus) => {
    onStatus?.(status);
  };

  const initiallyReachable = await isOllamaReachable(signal);
  if (initiallyReachable) {
    const ready: OllamaEnsureStatus = {
      ready: true,
      apiReachable: true,
      installed: true,
      phase: 'ready',
      detail: 'Ollama API is reachable.',
      statusMsg: bootstrapStatusMessage('ready'),
    };
    readyCache = { at: Date.now(), status: ready };
    emit(ready);
    return ready;
  }

  const { isTauri, ensureNativeOllamaReady, getNativeOllamaStatus } = await import('@/lib/tauri');

  if (isTauri) {
    const installStatus = await getNativeOllamaStatus();
    emit({
      ready: false,
      apiReachable: false,
      installed: installStatus.installed ?? false,
      phase: installStatus.installed ? 'starting' : 'not_installed',
      statusMsg: bootstrapStatusMessage(installStatus.installed ? 'starting' : 'not_installed'),
    });

    const native = await ensureNativeOllamaReady(resolvedOllamaBaseUrl());
    if (native.ready) {
      const ready: OllamaEnsureStatus = {
        ready: true,
        apiReachable: true,
        installed: native.installed,
        version: native.version,
        phase: 'ready',
        detail: native.detail,
        statusMsg: bootstrapStatusMessage('ready', native.detail),
      };
      readyCache = { at: Date.now(), status: ready };
      emit(ready);
      return ready;
    }

    if (signal?.aborted) {
      const aborted: OllamaEnsureStatus = {
        ready: false,
        apiReachable: false,
        installed: native.installed,
        phase: 'error',
        detail: 'Cancelled.',
        statusMsg: 'Cancelled.',
      };
      emit(aborted);
      return aborted;
    }

    // Native startup can fail while an externally started background serve is still
    // warming up (no tray icon). Poll the API directly before surfacing an error.
    const waitTimeoutMs = options?.waitTimeoutMs ?? 90_000;
    const polled = await waitForOllamaReachable(waitTimeoutMs, 1_500, signal, (msg) => {
      emit({
        ready: false,
        apiReachable: false,
        installed: native.installed,
        phase: 'waiting',
        detail: msg,
        statusMsg: msg,
      });
    });

    const status: OllamaEnsureStatus = polled
      ? {
          ready: true,
          apiReachable: true,
          installed: native.installed,
          version: native.version,
          phase: 'ready',
          detail: 'Ollama API is reachable.',
          statusMsg: bootstrapStatusMessage('ready'),
        }
      : {
          ready: false,
          apiReachable: false,
          installed: native.installed,
          version: native.version,
          phase: native.phase === 'not_installed' ? 'not_installed' : 'error',
          detail:
            native.detail ??
            `Could not reach Ollama at ${resolvedOllamaBaseUrl()} after ${Math.round(waitTimeoutMs / 1000)} seconds.`,
          statusMsg: bootstrapStatusMessage(
            native.phase === 'not_installed' ? 'not_installed' : 'error',
            native.detail,
          ),
        };
    if (status.ready) readyCache = { at: Date.now(), status };
    emit(status);
    return status;
  }

  const installStatus = await getNativeOllamaStatus();
  emit({
    ready: false,
    apiReachable: false,
    installed: installStatus.installed ?? false,
    phase: 'waiting',
    statusMsg: bootstrapStatusMessage('waiting'),
  });

  const waitTimeoutMs = options?.waitTimeoutMs ?? 120_000;
  const ready = await waitForOllamaReachable(waitTimeoutMs, 1500, signal, (msg) => {
    emit({
      ready: false,
      apiReachable: false,
      installed: installStatus.installed ?? false,
      phase: 'waiting',
      detail: msg,
      statusMsg: msg,
    });
  });

  const finalStatus: OllamaEnsureStatus = ready
    ? {
        ready: true,
        apiReachable: true,
        installed: true,
        phase: 'ready',
        detail: 'Ollama API is reachable.',
        statusMsg: bootstrapStatusMessage('ready'),
      }
    : {
        ready: false,
        apiReachable: false,
        installed: installStatus.installed ?? false,
        phase: 'error',
        detail: `Could not reach Ollama at ${resolvedOllamaBaseUrl()} after ${Math.round(waitTimeoutMs / 1000)} seconds.`,
        statusMsg: bootstrapStatusMessage('error'),
      };

  if (finalStatus.ready) readyCache = { at: Date.now(), status: finalStatus };
  emit(finalStatus);
  return finalStatus;
}

/**
 * Best-effort cleanup: asks Ollama to delete a model. Used to remove
 * partially-downloaded or corrupt models after a failed pull.
 * Never throws — failures are silently ignored (the user can retry).
 */
async function cleanupPartialModel(name: string): Promise<void> {
  try {
    await nativeFetch(`${resolvedOllamaBaseUrl()}/api/delete`, {
      method: 'DELETE',
      headers: ollamaHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name }),
      timeoutMs: 30_000,
    });
  } catch {
    // best-effort, ignore
  }
}

/**
 * Retry a function with exponential backoff. Only retries on network
 * errors (TypeError, 'Failed to fetch') and 5xx server errors.
 * Does NOT retry on aborts, 4xx, or validation errors.
 */
async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  maxRetries = 2,
  baseDelayMs = 2000,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Never retry cancellations or validation errors
      if (lastError.name === 'AbortError') throw lastError;
      if (
        lastError.message.includes('Invalid model name') ||
        lastError.message.includes('not found') ||
        lastError.message.includes('401') ||
        lastError.message.includes('403') ||
        lastError.message.includes('404')
      ) {
        throw lastError;
      }

      if (attempt >= maxRetries) throw lastError;

      const delay = baseDelayMs * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError!;
}

/**
 * Download (pull) a model from the Ollama registry.
 *
 * Security:
 * - Model name is validated before any network call.
 * - Max download size enforced (50 GB).
 *
 * Resilience:
 * - 30-minute timeout with automatic cleanup.
 * - Up to 2 retries on transient failures (network errors, 5xx).
 * - Partial model cleaned up on failure.
 * - Verified after completion: model must appear in the installed list.
 * - Event loop yielded every 16 chunks so the UI stays responsive.
 *
 * @param model   Model name to download (e.g. "llama3.2", "qwen3:4b")
 * @param onProgress  Callback for live progress updates
 * @param signal  AbortSignal for user-initiated cancellation
 */
export async function pullOllamaModel(
  model: string,
  onProgress?: (progress: OllamaPullProgress) => void,
  signal?: AbortSignal,
  options: OllamaPullOptions = {},
): Promise<void> {
  validateModelName(model);
  const name = model.trim();

  const alreadyInstalled = await listOllamaModels(signal);
  const normalized = name.trim().toLowerCase();
  if (
    !options.force &&
    alreadyInstalled.some(
      (installedName) =>
        installedName.trim().toLowerCase() === normalized ||
        installedName.trim().toLowerCase().startsWith(`${normalized}:`),
    )
  ) {
    onProgress?.({ status: 'success', done: true, percent: 100 });
    return;
  }

  // Packaged Tauri build: pull through the Rust reqwest command (no Origin
  // header → Ollama never 403s). Progress arrives via 'ollama:pull-progress'.
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let unlisten: (() => void) | null = null;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (unlisten) unlisten();
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = () => finish(() => reject(new DOMException('Aborted by user', 'AbortError')));
      signal?.addEventListener('abort', onAbort, { once: true });
      void listen<{
        status: string;
        total?: number;
        completed?: number;
        percent?: number;
        done: boolean;
        error?: string;
      }>('ollama:pull-progress', (event) => {
        if (settled) return;
        const p = event.payload;
        if (p.error) {
          finish(() => reject(new Error(`Ollama pull failed: ${p.error}`)));
          return;
        }
        onProgress?.({
          status: p.status,
          total: p.total ?? undefined,
          completed: p.completed ?? undefined,
          percent: p.percent ?? undefined,
          done: p.done,
        });
        if (p.done) finish(() => resolve());
      }).then((un) => {
        if (settled) {
          un();
          return;
        }
        unlisten = un;
        // Start the pull only after the listener is attached (no missed events).
        invoke('ollama_pull_model', { model: name, baseUrl: resolvedOllamaBaseUrl() }).catch(
          (err) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))),
        );
      });
    });

    // Verification: confirm the model now appears installed.
    const installedNow = await listOllamaModels();
    const norm = name.trim().toLowerCase();
    if (
      !installedNow.some(
        (n) => n.trim().toLowerCase() === norm || n.trim().toLowerCase().startsWith(`${norm}:`),
      )
    ) {
      throw new Error(
        `Download completed but "${name}" was not found in the installed list. Try re-scanning or re-downloading.`,
      );
    }
    return;
  }

  // Create a composite abort controller that combines user signal + timeout
  const composite = new AbortController();
  const timeoutId = setTimeout(
    () => composite.abort(new Error('Download timed out after 30 minutes.')),
    DOWNLOAD_TIMEOUT_MS,
  );

  // Forward user signal to composite
  const onUserAbort = () => composite.abort();
  signal?.addEventListener('abort', onUserAbort, { once: true });

  const cleanupComposite = () => {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onUserAbort);
  };

  try {
    await withRetry(
      async (attempt) => {
        if (composite.signal.aborted) throw new DOMException('Aborted by user', 'AbortError');

        const res = await nativeFetch(`${resolvedOllamaBaseUrl()}/api/pull`, {
          method: 'POST',
          headers: ollamaHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify({ name, stream: true }),
          signal: composite.signal,
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(
            `Ollama pull failed (${res.status}): ${errText.slice(0, 300) || res.statusText}`,
          );
        }

        if (!res.body) {
          const data = await res.json().catch(() => null);
          if (data?.error) throw new Error(String(data.error));
          onProgress?.({ status: 'success', done: true, percent: 100 });
          return;
        }

        const decoder = new TextDecoder();
        const reader = res.body.getReader();
        let buffer = '';
        let sawSuccess = false;
        let bytesReceived = 0;
        let chunksProcessed = 0;

        const processLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          const data = safeJSON(trimmed);
          if (!data)
            throw new Error(`Ollama returned invalid pull progress: ${trimmed.slice(0, 120)}`);
          if (data.error) throw new Error(`Ollama pull failed: ${String(data.error)}`);

          const total = typeof data.total === 'number' && data.total > 0 ? data.total : undefined;
          const completed =
            typeof data.completed === 'number' && data.completed >= 0 ? data.completed : undefined;
          const percent =
            total && completed !== undefined
              ? Math.min(100, Math.max(0, Math.round((completed / total) * 100)))
              : undefined;
          const status = typeof data.status === 'string' ? data.status : 'downloading';
          const done = status === 'success';
          if (done) sawSuccess = true;

          onProgress?.({
            status,
            digest: typeof data.digest === 'string' ? data.digest : undefined,
            total,
            completed,
            percent,
            done,
          });
        };

        try {
          for (;;) {
            if (composite.signal.aborted) throw new DOMException('Aborted by user', 'AbortError');

            const { done, value } = await reader.read();
            if (done) break;

            bytesReceived += value ? value.byteLength : 0;
            if (bytesReceived > MAX_DOWNLOAD_BYTES) {
              composite.abort(
                new Error(
                  `Download exceeds maximum allowed size (${Math.round(MAX_DOWNLOAD_BYTES / 1e9)} GB).`,
                ),
              );
              throw new Error(
                `Download exceeds maximum allowed size (${Math.round(MAX_DOWNLOAD_BYTES / 1e9)} GB).`,
              );
            }

            buffer += decoder.decode(value, { stream: true });
            chunksProcessed++;

            let newline = buffer.indexOf('\n');
            while (newline >= 0) {
              processLine(buffer.slice(0, newline));
              buffer = buffer.slice(newline + 1);
              newline = buffer.indexOf('\n');
            }

            // Yield to the event loop every 16 chunks so the UI stays responsive
            if (chunksProcessed % 16 === 0) {
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
            }
          }

          // Flush remaining buffer
          const remainder = decoder.decode();
          if (remainder.trim()) processLine(remainder);
        } finally {
          // Always release the reader lock
          try {
            reader.releaseLock();
          } catch {
            // already released
          }
        }

        if (!sawSuccess) {
          onProgress?.({ status: 'success', done: true, percent: 100 });
        }
      },
      2,
      2000,
    );
  } catch (err) {
    // Best-effort cleanup: tell Ollama to delete partial download
    void cleanupPartialModel(name);

    // Re-throw with user-friendly message
    if (err instanceof DOMException && err.name === 'AbortError') {
      if (signal?.aborted) throw err; // user-initiated cancel
      throw new Error(err.message || 'Download timed out. Check your connection and try again.');
    }
    throw err;
  } finally {
    cleanupComposite();
  }

  // Verification: confirm the model appears in the installed list
  try {
    const installed = await listOllamaModels();
    const normalized = name.trim().toLowerCase();
    const found = installed.some(
      (n) =>
        n.trim().toLowerCase() === normalized ||
        n
          .trim()
          .toLowerCase()
          .startsWith(normalized + ':'),
    );
    if (!found) {
      throw new Error(
        `Download completed but model verification failed. "${name}" was not found in the installed model list. Try re-scanning or re-downloading.`,
      );
    }
  } catch (err) {
    // If verification itself fails (e.g., Ollama unreachable), don't
    // hide the successful download — but do warn if it's a real verify error
    if (err instanceof Error && err.message.includes('verification failed')) {
      throw err;
    }
  }
}

/** Remove an installed Ollama model and verify that the tag is no longer listed. */
export async function removeOllamaModel(model: string, signal?: AbortSignal): Promise<void> {
  validateModelName(model);
  const name = model.trim();
  const normalized = name.toLowerCase();
  const installed = await listOllamaModels(signal);
  const present = installed.some(
    (installedName) =>
      installedName.trim().toLowerCase() === normalized ||
      installedName.trim().toLowerCase().startsWith(`${normalized}:`),
  );
  if (!present) return;

  const response = await nativeFetch(`${resolvedOllamaBaseUrl()}/api/delete`, {
    method: 'DELETE',
    headers: ollamaHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ name }),
    signal,
    timeoutMs: 30_000,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Ollama remove failed (${response.status}): ${detail.slice(0, 300) || response.statusText}`,
    );
  }

  const remaining = await listOllamaModels(signal);
  if (
    remaining.some(
      (installedName) =>
        installedName.trim().toLowerCase() === normalized ||
        installedName.trim().toLowerCase().startsWith(`${normalized}:`),
    )
  ) {
    throw new Error(`Ollama reported success but "${name}" is still installed.`);
  }
}

/** Run a tiny real inference to prove an installed tag can produce a local chat response. */
export async function verifyOllamaModelChat(
  model: string,
  signal?: AbortSignal,
): Promise<OllamaChatVerification> {
  validateModelName(model);
  const response = await nativeFetch(`${resolvedOllamaBaseUrl()}/api/chat`, {
    method: 'POST',
    headers: ollamaHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      model: model.trim(),
      messages: [{ role: 'user', content: 'Reply with READY.' }],
      stream: false,
      think: false,
      keep_alive: 0,
      options: { temperature: 0, num_predict: 8 },
    }),
    signal,
    timeoutMs: 60_000,
  });
  const raw = await response.text();
  if (raw.length > MAX_RESPONSE_BYTES) {
    throw new Error('Ollama verification response exceeded the safe size limit.');
  }
  if (!response.ok) {
    throw new Error(
      `Ollama chat verification failed (${response.status}): ${raw.slice(0, 300) || response.statusText}`,
    );
  }
  const parsed = safeJSON(raw);
  const content =
    parsed &&
    typeof parsed.message === 'object' &&
    parsed.message !== null &&
    typeof (parsed.message as Record<string, unknown>).content === 'string'
      ? String((parsed.message as Record<string, unknown>).content).trim()
      : '';
  if (!content) {
    throw new Error('Ollama chat verification failed: the model returned no text.');
  }
  return { ok: true, response: content.slice(0, 160) };
}

export const ollamaProvider: LLMProvider = {
  id: 'ollama',
  name: 'Ollama (local)',

  isAvailable() {
    return ollamaBaseUrl().length > 0;
  },

  async run(req: LLMRequest): Promise<LLMResponse> {
    const base = resolvedOllamaBaseUrl();
    const model =
      req.agent.model.model || useAuthStore.getState().defaultLocalModel || OLLAMA_DEFAULT_MODEL;

    validateModelName(model);

    const ready = await ensureOllamaReadySilent(req.signal);
    if (!ready.ready) {
      throw new Error(
        ready.detail ||
          'Could not connect to Ollama. Open Local Models to download a model or start the service.',
      );
    }

    const installed = await listOllamaModels(req.signal);
    const normalized = model.trim().toLowerCase();
    const modelExists = installed.some((name) => {
      const installedName = name.trim().toLowerCase();
      return (
        installedName === normalized ||
        installedName.startsWith(`${normalized}:`) ||
        normalized.startsWith(`${installedName}:`)
      );
    });
    if (!modelExists) {
      throw new Error(
        `Local model "${model}" is not installed. Open Settings → Local Models and download it.`,
      );
    }

    const body = buildOllamaRequestBody(req, model);
    const { messages } = body;

    // Packaged Tauri build: listen before invoking the registered Rust stream
    // command. This preserves CORS-free reqwest transport while delivering
    // tokens immediately instead of making a connected model appear idle until
    // a full stream:false completion settles.
    if (isTauri) {
      const { invoke } = await import('@tauri-apps/api/core');
      const { listen } = await import('@tauri-apps/api/event');
      const baseUrl = resolvedOllamaBaseUrl();
      let first = true;
      const text = await runReliableNativeOllamaChat(invoke, listen, {
        requestId: crypto.randomUUID(),
        model,
        messages,
        options: body.options,
        think: body.think,
        baseUrl,
        signal: req.signal,
        onDelta: (delta) => {
          req.onResponseObservation?.({
            kind: 'sdk_chunk',
            observedAt: Date.now(),
          });
          req.onChunk?.({ delta, first });
          first = false;
        },
      }).catch(async (error) => {
        // An already-running pre-upgrade binary may not expose the stream
        // command. Preserve the proven result-returning command as a bounded
        // compatibility fallback until the next app restart.
        if (!isMissingNativeOllamaChatCommand(error)) throw error;
        let result;
        try {
          result = await runNativeOllamaChat(invoke, {
            model,
            messages,
            options: body.options,
            think: body.think,
            baseUrl,
          });
        } catch (fallbackError) {
          if (!body.think || !isThinkUnsupportedError(fallbackError)) throw fallbackError;
          result = await runNativeOllamaChat(invoke, {
            model,
            messages,
            options: body.options,
            think: false,
            baseUrl,
          });
        }
        req.onChunk?.({ delta: result.text, first: true });
        return result.text;
      });
      if (req.signal?.aborted) throw new DOMException('Aborted by user', 'AbortError');
      req.onChunk?.({ delta: '', done: true });
      const inTok = estimateInputTokens(messages.map((message) => message.content).join('\n'));
      const outTok = estimateInputTokens(text);
      return {
        text,
        usage: {
          input_tokens: inTok,
          output_tokens: outTok,
          cost_usd: estimateCost('ollama', model, inTok, outTok),
        },
        provider: 'ollama',
        model,
        finish_reason: undefined,
      };
    }

    // Browser / OpenAI-compatible path: multimodal uses content parts, not
    // Ollama's native `images[]` field alone.
    const openAiBody = {
      model: body.model,
      messages: body.openAiMessages,
      stream: true,
      temperature: body.options.temperature,
      max_tokens: body.options.num_predict,
    };

    let res: Response;
    try {
      res = await nativeFetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: ollamaHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(openAiBody),
        signal: req.signal,
        timeoutMs: 120_000,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not reach Ollama at ${base}. Is it running? (ollama serve). ${reason}`,
      );
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      if (errText.length > 0) {
        req.onResponseObservation?.({
          kind: 'bytes',
          byteLength: new TextEncoder().encode(errText).byteLength,
          observedAt: Date.now(),
        });
      }
      throw new Error(`Ollama ${res.status}: ${errText.slice(0, 300) || res.statusText}`);
    }
    if (!res.body) throw new Error('Ollama returned an empty body');

    let acc = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: string | undefined;
    let first = true;
    let totalResponseBytes = 0;

    for await (const evt of parseSSE(
      observeResponseBody(res.body, req.onResponseObservation),
      req.signal,
    )) {
      if (req.signal?.aborted) break;
      const raw = evt.data;
      if (raw === '[DONE]') break;
      if (!raw) continue;

      totalResponseBytes += raw.length;
      if (totalResponseBytes > MAX_RESPONSE_BYTES) {
        throw new Error(
          `Response exceeds maximum size (${Math.round(MAX_RESPONSE_BYTES / 1e6)} MB). Try a smaller query.`,
        );
      }

      const data = safeJSON(raw);
      if (!data) continue;

      if (data.error) {
        const msg =
          typeof data.error === 'string' ? data.error : (data.error?.message ?? 'unknown');
        throw new Error(`Ollama stream error: ${msg}`);
      }

      const choice = data.choices?.[0];
      if (choice) {
        const delta = choice.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          acc += delta;
          req.onChunk?.({ delta, first });
          first = false;
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
      if (data.usage) {
        if (data.usage.prompt_tokens) inputTokens = data.usage.prompt_tokens;
        if (data.usage.completion_tokens) outputTokens = data.usage.completion_tokens;
      }
    }

    if (req.signal?.aborted) {
      throw new DOMException('Aborted by user', 'AbortError');
    }

    if (inputTokens === 0) {
      const inputText = messages.map((m) => m.content).join('\n');
      inputTokens = estimateInputTokens(inputText);
    }
    if (outputTokens === 0) outputTokens = estimateInputTokens(acc);

    req.onChunk?.({ delta: '', done: true });

    return {
      text: acc,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: estimateCost('ollama', model, inputTokens, outputTokens),
      },
      provider: 'ollama',
      model,
      finish_reason: finishReason,
    };
  },
};

function safeJSON(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
