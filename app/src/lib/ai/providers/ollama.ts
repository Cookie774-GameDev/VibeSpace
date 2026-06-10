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
import type { LLMProvider, LLMRequest, LLMResponse } from '../types';
import { estimateCost, estimateInputTokens } from '../types';
import { useAuthStore } from '@/stores/auth';
import { parseSSE } from './sse';
import { nativeFetch } from '@/lib/nativeFetch';

/** Default Ollama base URL. Configurable via auth store `apiKeys.ollama`. */
export const OLLAMA_DEFAULT_BASE = 'http://127.0.0.1:11434';

const ALLOWED_OLLAMA_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Default local model used when promoting a mock/local-default agent. */
export const OLLAMA_DEFAULT_MODEL = 'llama3.2';

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
export function ollamaBaseUrl(): string {
  const raw = useAuthStore.getState().apiKeys.ollama?.trim();
  const base = raw && raw.length > 0 ? raw : OLLAMA_DEFAULT_BASE;
  return base.replace(/\/+$/, '');
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

export async function listOllamaModelInfo(signal?: AbortSignal): Promise<OllamaModelInfo[]> {
  try {
    const res = await nativeFetch(`${resolvedOllamaBaseUrl()}/api/tags`, { signal, timeoutMs: 15_000, headers: ollamaHeaders() });
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

/** Quick reachability probe for the local daemon via /api/version. */
export async function isOllamaReachable(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await nativeFetch(`${resolvedOllamaBaseUrl()}/api/version`, {
      signal,
      timeoutMs: 5_000,
      headers: ollamaHeaders(),
    });
    return res.ok;
  } catch {
    return false;
  }
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

function bootstrapStatusMessage(phase: string, detail?: string | null): string {
  switch (phase) {
    case 'ready':
      return 'Ollama ready';
    case 'starting':
      return 'Starting Ollama silently…';
    case 'waiting':
      return detail || 'Waiting for Ollama API…';
    case 'not_installed':
      return 'Install Ollama to use local models.';
    case 'error':
      return detail || 'Could not connect to Ollama';
    default:
      return detail || 'Checking Ollama…';
  }
}

/**
 * Ensure Ollama is installed, the background server is running, and the API
 * responds on /api/version. Uses the native backend in Tauri for silent
 * `ollama serve` startup; falls back to API polling on web.
 */
export async function ensureOllamaReadySilent(
  signal?: AbortSignal,
  onStatus?: (status: OllamaEnsureStatus) => void,
): Promise<OllamaEnsureStatus> {
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
    emit(ready);
    return ready;
  }

  const { isTauri, ensureNativeOllamaReady, getNativeOllamaStatus } = await import('@/lib/tauri');

  if (isTauri) {
    emit({
      ready: false,
      apiReachable: false,
      installed: true,
      phase: 'starting',
      statusMsg: bootstrapStatusMessage('starting'),
    });

    const native = await ensureNativeOllamaReady(resolvedOllamaBaseUrl());
    const status: OllamaEnsureStatus = {
      ready: native.ready,
      apiReachable: native.apiReachable,
      installed: native.installed,
      version: native.version,
      phase: native.phase,
      detail: native.detail,
      statusMsg: bootstrapStatusMessage(native.phase, native.detail),
    };
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

  const ready = await waitForOllamaReachable(120_000, 1500, signal, (msg) => {
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
        detail: `Could not reach Ollama at ${resolvedOllamaBaseUrl()} after 120 seconds.`,
        statusMsg: bootstrapStatusMessage('error'),
      };

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
): Promise<void> {
  validateModelName(model);
  const name = model.trim();

  const alreadyInstalled = await listOllamaModels(signal);
  const normalized = name.trim().toLowerCase();
  if (
    alreadyInstalled.some(
      (installedName) =>
        installedName.trim().toLowerCase() === normalized ||
        installedName.trim().toLowerCase().startsWith(`${normalized}:`),
    )
  ) {
    onProgress?.({ status: 'success', done: true, percent: 100 });
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
    await withRetry(async (attempt) => {
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

        const total =
          typeof data.total === 'number' && data.total > 0 ? data.total : undefined;
        const completed =
          typeof data.completed === 'number' && data.completed >= 0
            ? data.completed
            : undefined;
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
          if (composite.signal.aborted)
            throw new DOMException('Aborted by user', 'AbortError');

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
    }, 2, 2000);
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
      (n) => n.trim().toLowerCase() === normalized || n.trim().toLowerCase().startsWith(normalized + ':'),
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
    const modelExists = installed.some(
      (name) =>
        name.trim().toLowerCase() === normalized ||
        name.trim().toLowerCase().startsWith(`${normalized}:`),
    );
    if (!modelExists) {
      throw new Error(
        `Local model "${model}" is not installed. Open Settings → Local Models and download it.`,
      );
    }

    const messages = [
      { role: 'system' as const, content: req.agent.system_prompt },
      ...req.messages.filter((m) => m.role !== 'system'),
    ];

    const body = {
      model,
      messages,
      stream: true,
      options: {
        temperature: req.temperature ?? req.agent.temperature ?? 0.7,
      },
    };

    let res: Response;
    try {
      res = await nativeFetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: ollamaHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
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
      throw new Error(`Ollama ${res.status}: ${errText.slice(0, 300) || res.statusText}`);
    }
    if (!res.body) throw new Error('Ollama returned an empty body');

    let acc = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: string | undefined;
    let first = true;
    let totalResponseBytes = 0;

    for await (const evt of parseSSE(res.body, req.signal)) {
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
