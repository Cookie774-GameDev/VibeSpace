/**
 * Ollama (local model) client with streaming.
 *
 * Talks to a user-installed Ollama daemon over its OpenAI-compatible API:
 *   POST {base}/v1/chat/completions   (chat, SSE streaming)
 *   GET  {base}/api/tags              (list installed models)
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

/** Resolve the configured base URL, trimming any trailing slash. */
export function ollamaBaseUrl(): string {
  const raw = useAuthStore.getState().apiKeys.ollama?.trim();
  const base = raw && raw.length > 0 ? raw : OLLAMA_DEFAULT_BASE;
  return base.replace(/\/+$/, '');
}

/**
 * List the models currently installed in the local Ollama daemon.
 * Returns an empty array if Ollama isn't reachable (so the UI can show a
 * friendly "start Ollama" hint rather than throwing).
 */
export async function listOllamaModels(signal?: AbortSignal): Promise<string[]> {
  try {
    const res = await nativeFetch(`${ollamaBaseUrl()}/api/tags`, { signal });
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    const models = data?.models;
    if (!Array.isArray(models)) return [];
    return models
      .map((m: { name?: string }) => m?.name)
      .filter((n: unknown): n is string => typeof n === 'string' && n.length > 0);
  } catch {
    return [];
  }
}

/** Quick reachability probe for the local daemon. */
export async function isOllamaReachable(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await nativeFetch(`${ollamaBaseUrl()}/api/tags`, { signal });
    return res.ok;
  } catch {
    return false;
  }
}

export const ollamaProvider: LLMProvider = {
  id: 'ollama',
  name: 'Ollama (local)',

  // Available whenever a base URL is configured. We default the base to
  // localhost, so this is effectively always "available" — the actual
  // reachability is checked at request time (and the router falls back to
  // mock with a toast if the daemon isn't running).
  isAvailable() {
    return ollamaBaseUrl().length > 0;
  },

  async run(req: LLMRequest): Promise<LLMResponse> {
    const base = ollamaBaseUrl();
    const model =
      req.agent.model.model ||
      useAuthStore.getState().defaultLocalModel ||
      OLLAMA_DEFAULT_MODEL;

    // OpenAI-compatible message shape: system prompt as a leading system message.
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
      });
    } catch (err) {
      // Network/CORS failure: surface an actionable message.
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

    for await (const evt of parseSSE(res.body, req.signal)) {
      if (req.signal?.aborted) break;
      const raw = evt.data;
      if (raw === '[DONE]') break;
      if (!raw) continue;

      const data = safeJSON(raw);
      if (!data) continue;

      if (data.error) {
        const msg =
          typeof data.error === 'string' ? data.error : data.error?.message ?? 'unknown';
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
        // Local inference is free; estimateCost resolves ollama:* to 0/0.
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
