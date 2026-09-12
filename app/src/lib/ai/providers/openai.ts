/**
 * OpenAI Chat Completions client with streaming.
 *
 * Endpoint: POST https://api.openai.com/v1/chat/completions
 * Docs: https://platform.openai.com/docs/api-reference/chat
 *
 * We use chat.completions (not the newer Responses API) because it has the
 * widest compatibility across OpenAI-compatible providers (Together, Groq,
 * Anyscale, Ollama's compat layer). When OpenAI's Responses API stabilises
 * with streaming for tool calls we can swap.
 *
 * SSE shape: each event is `data: <json>`; the terminal sentinel is
 * `data: [DONE]`. With `stream_options.include_usage = true` the second-to-last
 * event carries the final usage block.
 */
import type { LLMContentPart, LLMProvider, LLMRequest, LLMResponse } from '../types';
import {
  estimateCost,
  estimateInputTokens,
  llmContentToText,
  observeResponseBody,
  systemPromptForRequest,
} from '../types';
import { useAuthStore } from '@/stores/auth';
import { nativeFetch } from '@/lib/nativeFetch';
import { parseSSE } from './sse';
import { sanitizeReasoningProviderOptions } from '../reasoningControls';

const API_URL = 'https://api.openai.com/v1/chat/completions';

/** Default OpenAI model used when promoting a mock-default agent. */
export const OPENAI_DEFAULT_MODEL = 'gpt-5.1';

function toOpenAiContent(content: string | LLMContentPart[]) {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text' as const, text: part.text };
    return {
      type: 'image_url' as const,
      image_url: { url: `data:${part.mimeType};base64,${part.data}` },
    };
  });
}

export function buildOpenAIRequestBody(req: LLMRequest) {
  const model = req.agent.model.model || OPENAI_DEFAULT_MODEL;
  const reasoning = sanitizeReasoningProviderOptions(
    { providerId: 'openai', modelId: model },
    req.provider_options,
  );
  const systemPrompt = systemPromptForRequest(req);
  const messages = [
    { role: 'system' as const, content: systemPrompt },
    ...req.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role,
        content: toOpenAiContent(message.content),
      })),
  ];
  return {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: req.temperature ?? req.agent.temperature ?? 0.7,
    max_tokens: req.max_output_tokens ?? req.agent.max_output_tokens ?? 4096,
    ...reasoning,
  };
}

export const openaiProvider: LLMProvider = {
  id: 'openai',
  name: 'OpenAI',

  isAvailable() {
    const key = useAuthStore.getState().apiKeys.openai;
    return typeof key === 'string' && key.length > 0;
  },

  async run(req: LLMRequest): Promise<LLMResponse> {
    const apiKey = useAuthStore.getState().apiKeys.openai;
    if (!apiKey) throw new Error('OpenAI API key not set');

    const model = req.agent.model.model || OPENAI_DEFAULT_MODEL;
    const body = buildOpenAIRequestBody(req);

    const res = await nativeFetch(API_URL, {
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
      if (errText.length > 0) {
        req.onResponseObservation?.({
          kind: 'bytes',
          byteLength: new TextEncoder().encode(errText).byteLength,
          observedAt: Date.now(),
        });
      }
      throw new Error(`OpenAI ${res.status}: ${errText.slice(0, 300) || res.statusText}`);
    }
    if (!res.body) throw new Error('OpenAI returned an empty body');

    let acc = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: string | undefined;
    let first = true;

    for await (const evt of parseSSE(
      observeResponseBody(res.body, req.onResponseObservation),
      req.signal,
    )) {
      if (req.signal?.aborted) break;
      const raw = evt.data;
      if (raw === '[DONE]') break;
      if (!raw) continue;

      const data = safeJSON(raw);
      if (!data) continue;

      // Errors come back as { error: { message, type, ... } } even mid-stream.
      if (data.error) {
        throw new Error(`OpenAI stream error: ${data.error.message ?? 'unknown'}`);
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
      // Final event with usage block (when stream_options.include_usage).
      if (data.usage) {
        if (data.usage.prompt_tokens) inputTokens = data.usage.prompt_tokens;
        if (data.usage.completion_tokens) outputTokens = data.usage.completion_tokens;
      }
    }

    if (req.signal?.aborted) {
      throw new DOMException('Aborted by user', 'AbortError');
    }

    if (inputTokens === 0) {
      const inputText = [
        systemPromptForRequest(req),
        ...req.messages.map((m) => llmContentToText(m.content)),
      ].join('\n');
      inputTokens = estimateInputTokens(inputText);
    }
    if (outputTokens === 0) outputTokens = estimateInputTokens(acc);

    req.onChunk?.({ delta: '', done: true });

    return {
      text: acc,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: estimateCost('openai', model, inputTokens, outputTokens),
      },
      provider: 'openai',
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
