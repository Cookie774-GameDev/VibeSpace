/**
 * Parametric OpenAI Chat Completions adapter.
 * Powers OpenRouter, DeepSeek, Mistral, Together, xAI, and custom endpoints.
 */
import type { ProviderId } from '@/types/common';
import { useAuthStore } from '@/stores/auth';
import type { LLMProvider, LLMRequest, LLMResponse } from '../types';
import { estimateCost, estimateInputTokens } from '../types';
import { parseSSE } from './sse';

export interface OpenAICompatibleConfig {
  id: ProviderId;
  name: string;
  baseUrl: string;
  apiKeyStoreKey: ProviderId;
  defaultModel: string;
  extraHeaders?: Record<string, string>;
}

function safeJSON(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function makeOpenAICompatibleProvider(cfg: OpenAICompatibleConfig): LLMProvider {
  const chatUrl = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  return {
    id: cfg.id,
    name: cfg.name,

    isAvailable() {
      const key = useAuthStore.getState().apiKeys[cfg.apiKeyStoreKey];
      return typeof key === 'string' && key.trim().length > 0;
    },

    async run(req: LLMRequest): Promise<LLMResponse> {
      const apiKey = useAuthStore.getState().apiKeys[cfg.apiKeyStoreKey];
      if (!apiKey?.trim()) throw new Error(`${cfg.name} API key not set`);

      const model = req.agent.model.model || cfg.defaultModel;
      const messages = [
        { role: 'system' as const, content: req.agent.system_prompt },
        ...req.messages.filter((m) => m.role !== 'system'),
      ];

      const body = {
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: req.temperature ?? req.agent.temperature ?? 0.7,
        max_tokens: req.max_output_tokens ?? req.agent.max_output_tokens ?? 4096,
      };

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`,
        ...cfg.extraHeaders,
      };

      const res = await fetch(chatUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: req.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`${cfg.name} ${res.status}: ${errText.slice(0, 300) || res.statusText}`);
      }
      if (!res.body) throw new Error(`${cfg.name} returned an empty body`);

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

        const data = safeJSON(raw) as {
          error?: { message?: string };
          choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        } | null;
        if (!data) continue;

        if (data.error) {
          throw new Error(`${cfg.name} stream error: ${data.error.message ?? 'unknown'}`);
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
        inputTokens = estimateInputTokens(messages.map((m) => m.content).join('\n'));
      }
      if (outputTokens === 0) outputTokens = estimateInputTokens(acc);

      req.onChunk?.({ delta: '', done: true });

      return {
        text: acc,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cost_usd: estimateCost(cfg.id, model, inputTokens, outputTokens),
        },
        provider: cfg.id,
        model,
        finish_reason: finishReason,
      };
    },
  };
}
