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
export const OLLAMA_DEFAULT_BASE = 'http://localhost:11434';

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

/** Resolve the configured base URL, trimming any trailing slash. */
export function ollamaBaseUrl(): string {
  const raw = useAuthStore.getState().apiKeys.ollama?.trim();
  const base = raw && raw.length > 0 ? raw : OLLAMA_DEFAULT_BASE;
  return base.replace(/\/+$/, '');
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
    const res = await nativeFetch(`${ollamaBaseUrl()}/api/tags`, { signal, timeoutMs: 15_000 });
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

/** Quick reachability probe for the local daemon. */
export async function isOllamaReachable(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await nativeFetch(`${ollamaBaseUrl()}/api/tags`, { signal, timeoutMs: 10_000 });
    return res.ok;
  } catch {
    return false;
  }
}

export async function waitForOllamaReachable(
  timeoutMs = 12_000,
  intervalMs = 600,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    if (await isOllamaReachable(signal)) return true;
    await new Promise<void>((resolve) => window.setTimeout(resolve, intervalMs));
  }
  return false;
}

/**
 * Best-effort cleanup: asks Ollama to delete a model. Used to remove
 * partially-downloaded or corrupt models after a failed pull.
 * Never throws — failures are silently ignored (the user can retry).
 */
async function cleanupPartialModel(name: string): Promise<void> {
  try {
    await nativeFetch(`${ollamaBaseUrl()}/api/delete`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
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

      const res = await nativeFetch(`${ollamaBaseUrl()}/api/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
    const base = ollamaBaseUrl();
    const model =
      req.agent.model.model || useAuthStore.getState().defaultLocalModel || OLLAMA_DEFAULT_MODEL;

    validateModelName(model);

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
        headers: { 'content-type': 'application/json' },
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
