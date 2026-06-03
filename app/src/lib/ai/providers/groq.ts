/**
 * Groq Chat Completions client with streaming.
 *
 * Endpoint: POST https://api.groq.com/openai/v1/chat/completions
 * Docs: https://console.groq.com/docs/api-reference#chat
 *
 * Groq exposes an OpenAI-compatible chat-completions API, so this adapter
 * is a near-clone of `providers/openai.ts` with three differences:
 *   - the API URL points at api.groq.com,
 *   - the API key is read from `apiKeys.groq`,
 *   - the default model is Llama-3.3-70B-Versatile, which Groq serves on
 *     its free tier at sub-second TTFT.
 *
 * Why this matters for Jarvis: the user can sign up at
 * `https://console.groq.com/keys` for free (no card), paste the
 * `gsk_...` key into Settings → Providers, and immediately have a
 * production-grade Llama running the main Jarvis agent. That's the "free
 * AI for Jarvis" path the user asked about — without us needing to host
 * a backend or bundle a 2GB local model in the installer.
 */
import type { LLMProvider, LLMRequest, LLMResponse } from '../types';
import { estimateCost, estimateInputTokens } from '../types';
import { useAuthStore } from '@/stores/auth';
import { parseSSE } from './sse';

const API_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Default Groq model. Llama-3.3-70B-Versatile is the highest-quality
 * model on Groq's free tier today; if it's deprecated upstream, callers
 * pin a different value via `agent.model.model`.
 */
export const GROQ_DEFAULT_MODEL = 'llama-3.3-70b-versatile';

export const groqProvider: LLMProvider = {
  id: 'groq',
  name: 'Groq',

  isAvailable() {
    const key = useAuthStore.getState().apiKeys.groq;
    return typeof key === 'string' && key.length > 0;
  },

  async run(req: LLMRequest): Promise<LLMResponse> {
    const apiKey = useAuthStore.getState().apiKeys.groq;
    if (!apiKey) throw new Error('Groq API key not set');

    const model = req.agent.model.model || GROQ_DEFAULT_MODEL;

    // Same shape as OpenAI: system prompt as a leading system message,
    // user/assistant messages follow. Strip any pre-existing system
    // entries from the user list so we don't end up with duplicates.
    const messages = [
      { role: 'system' as const, content: req.agent.system_prompt },
      ...req.messages.filter((m) => m.role !== 'system'),
    ];

    const body = {
      model,
      messages,
      stream: true,
      // Groq honours stream_options.include_usage just like OpenAI.
      stream_options: { include_usage: true },
      temperature: req.temperature ?? req.agent.temperature ?? 0.7,
      max_tokens: req.max_output_tokens ?? req.agent.max_output_tokens ?? 4096,
    };

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(
        `Groq ${res.status}: ${errText.slice(0, 300) || res.statusText}`,
      );
    }
    if (!res.body) throw new Error('Groq returned an empty body');

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

      // Errors come back as { error: { message, type, ... } } even mid-stream.
      if (data.error) {
        throw new Error(
          `Groq stream error: ${data.error.message ?? 'unknown'}`,
        );
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

      // Final usage block. Groq sometimes inlines a custom `x_groq` key
      // alongside `usage`; we only read the standard one for portability.
      if (data.usage) {
        if (data.usage.prompt_tokens) inputTokens = data.usage.prompt_tokens;
        if (data.usage.completion_tokens) {
          outputTokens = data.usage.completion_tokens;
        }
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
        // Free tier today; cost rate table maps groq:* to 0/0 so this
        // always evaluates to 0. Kept for parity with other providers.
        cost_usd: estimateCost('groq', model, inputTokens, outputTokens),
      },
      provider: 'groq',
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
