/**
 * Parametric OpenAI Chat Completions adapter.
 * Powers OpenRouter, DeepSeek, Mistral, Together, xAI, and custom endpoints.
 */
import type { ProviderId } from '@/types/common';
import { useAuthStore } from '@/stores/auth';
import type { LLMContentPart, LLMProvider, LLMRequest, LLMResponse } from '../types';
import {
  estimateCost,
  estimateInputTokens,
  llmContentToText,
  observeResponseBody,
  systemPromptForRequest,
} from '../types';
import { parseSSE } from './sse';
import { sanitizeReasoningProviderOptions } from '../reasoningControls';
import {
  getOpenRouterImageOutputCapabilities,
  isOpenRouterFreeImageOutputModel,
  type OpenRouterImageOutputModelMetadata,
} from '../openrouterImageOutput';
import { nativeFetch } from '@/lib/nativeFetch';

export interface OpenAICompatibleConfig {
  id: ProviderId;
  name: string;
  baseUrl: string | (() => string);
  apiKeyStoreKey: ProviderId;
  defaultModel: string;
  extraHeaders?: Record<string, string>;
  transport?: 'browser' | 'native';
}

const OPENROUTER_USER_MODELS_URL = 'https://openrouter.ai/api/v1/models/user';
const OPENROUTER_IMAGE_RESPONSE_MAX_BYTES = 24 * 1024 * 1024;
const OPENROUTER_IMAGE_MAX_COUNT = 4;
const OPENROUTER_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const OPENROUTER_IMAGE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const OPENROUTER_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Verify model access, output modality, and every listed price against the live
 * authenticated OpenRouter catalog. This deliberately has no cache: callers
 * can request forceRefresh for clarity, while every check already fetches fresh data.
 */
export async function assertOpenRouterFreeImageOutputAvailable(
  modelId: string,
  options: { signal?: AbortSignal; forceRefresh?: boolean } = {},
): Promise<void> {
  await fetchVerifiedOpenRouterFreeImageModel(modelId, options.signal);
}

async function fetchVerifiedOpenRouterFreeImageModel(
  modelId: string,
  signal?: AbortSignal,
): Promise<{ apiKey: string; model: OpenRouterImageOutputModelMetadata }> {
  const apiKey = useAuthStore.getState().apiKeys.openrouter?.trim();
  if (!apiKey) {
    throw new Error('OpenRouter API key is required. Add one in Settings before requesting image output.');
  }
  const selectedModelId = modelId.trim();
  if (!selectedModelId) throw new Error('Select an OpenRouter model that supports image output.');
  if (signal?.aborted) throw new DOMException('Aborted by user', 'AbortError');

  let response: Response;
  try {
    response = await nativeFetch(OPENROUTER_USER_MODELS_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
      timeoutMs: 8000,
    });
  } catch {
    if (signal?.aborted) throw new DOMException('Aborted by user', 'AbortError');
    throw new Error('Could not verify OpenRouter image model access. Check your connection and retry.');
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('OpenRouter rejected the configured API key. Check it in Settings and retry.');
    }
    if (response.status === 429) {
      throw new Error('OpenRouter rate-limited the model check. Wait briefly and retry.');
    }
    throw new Error(`OpenRouter model access check failed (HTTP ${response.status}). Retry shortly.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('OpenRouter returned an unreadable model catalog. Refresh models and retry.');
  }
  const rows = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
  const model = rows.find(
    (row): row is OpenRouterImageOutputModelMetadata =>
      isRecord(row) && typeof row.id === 'string' && row.id.trim() === selectedModelId,
  );
  if (!model) {
    throw new Error('This model is not listed for your OpenRouter account. Refresh models or select another model.');
  }
  if (!getOpenRouterImageOutputCapabilities(model).supportsImageOutput) {
    throw new Error('This OpenRouter model does not advertise both text and image output. Select another model.');
  }
  if (!isOpenRouterFreeImageOutputModel(model)) {
    throw new Error('OpenRouter image output requires a model with explicitly zero-priced image output.');
  }
  return { apiKey, model };
}

function sanitizedOpenRouterFailure(status: number): Error {
  if (status === 401 || status === 403) {
    return new Error('OpenRouter rejected the configured API key. Check it in Settings and retry.');
  }
  if (status === 402) {
    return new Error('OpenRouter rejected the image request as billable or unavailable; no image was returned.');
  }
  if (status === 429) return new Error('OpenRouter rate-limited image output. Wait briefly and retry.');
  if (status >= 500) return new Error(`OpenRouter image output is temporarily unavailable (HTTP ${status}). Retry shortly.`);
  return new Error(`OpenRouter image output failed (HTTP ${status}). Check the model and retry.`);
}

function normalizeOpenRouterImage(value: unknown): { mimeType: string; data: string; byteLength: number } {
  const image = isRecord(value) ? value : null;
  const imageUrl = image && isRecord(image.image_url) ? image.image_url.url : undefined;
  if (typeof imageUrl !== 'string') throw new Error('OpenRouter returned unsupported image output.');
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/iu.exec(imageUrl);
  if (!match || !OPENROUTER_IMAGE_MIME_TYPES.has(match[1]!.toLowerCase())) {
    throw new Error('OpenRouter returned unsupported image output. Only bounded PNG, JPEG, WebP, and GIF data is accepted.');
  }
  const data = match[2]!;
  if (data.length > Math.ceil(OPENROUTER_IMAGE_MAX_BYTES / 3) * 4) {
    throw new Error('OpenRouter image output exceeded the supported size limit. Try a smaller image request.');
  }
  if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) {
    throw new Error('OpenRouter returned malformed image output. Retry the request.');
  }
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const byteLength = (data.length / 4) * 3 - padding;
  if (byteLength <= 0 || byteLength > OPENROUTER_IMAGE_MAX_BYTES) {
    throw new Error('OpenRouter image output exceeded the supported size limit. Try a smaller image request.');
  }
  return { mimeType: match[1]!.toLowerCase(), data, byteLength };
}

async function readObservedBodyText(
  body: ReadableStream<Uint8Array>,
  onObservation: LLMRequest['onResponseObservation'],
  maxBytes: number,
): Promise<string> {
  const reader = observeResponseBody(body, onObservation).getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new Error('OpenRouter image response exceeded the supported size limit.');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .filter((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string')
    .map((part) => (part as { text: string }).text)
    .join('');
}

async function runOpenRouterImageRequest(
  cfg: OpenAICompatibleConfig,
  req: LLMRequest,
): Promise<LLMResponse> {
  if (cfg.id !== 'openrouter') {
    throw new Error('Image output requests are supported only through the OpenRouter provider.');
  }
  const model = req.agent.model.model || cfg.defaultModel;
  const { apiKey } = await fetchVerifiedOpenRouterFreeImageModel(model, req.signal);
  if (req.signal?.aborted) throw new DOMException('Aborted by user', 'AbortError');

  const reasoning = sanitizeReasoningProviderOptions(
    { providerId: cfg.id, modelId: model },
    req.provider_options,
  );
  const systemPrompt = systemPromptForRequest(req);
  const messages = [
    { role: 'system' as const, content: systemPrompt },
    ...req.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role, content: toOpenAiCompatibleContent(message.content) })),
  ];
  const body = {
    model,
    messages,
    stream: false,
    modalities: ['text', 'image'],
    temperature: req.temperature ?? req.agent.temperature ?? 0.7,
    max_tokens: req.max_output_tokens ?? req.agent.max_output_tokens ?? 4096,
    ...reasoning,
  };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...cfg.extraHeaders,
    Authorization: `Bearer ${apiKey}`,
  };
  const fetchImpl = cfg.transport === 'native' ? nativeFetch : globalThis.fetch;
  const baseUrl = typeof cfg.baseUrl === 'function' ? cfg.baseUrl() : cfg.baseUrl;
  req.onActionDispatch?.({ observedAt: Date.now() });
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
      ...(cfg.transport === 'native' ? { timeoutMs: 120_000 } : {}),
    });
  } catch {
    if (req.signal?.aborted) throw new DOMException('Aborted by user', 'AbortError');
    throw new Error('Could not reach OpenRouter image output. Check your connection and retry.');
  }
  if (!response.ok) throw sanitizedOpenRouterFailure(response.status);
  if (!response.body) throw new Error('OpenRouter returned an empty image response. Retry the request.');

  let responseText: string;
  try {
    responseText = await readObservedBodyText(
      response.body,
      req.onResponseObservation,
      OPENROUTER_IMAGE_RESPONSE_MAX_BYTES,
    );
  } catch (error) {
    if (req.signal?.aborted) throw new DOMException('Aborted by user', 'AbortError');
    if (error instanceof Error && error.message.includes('size limit')) throw error;
    throw new Error('Could not read the OpenRouter image response. Retry the request.');
  }
  const payload = safeJSON(responseText);
  if (!isRecord(payload)) throw new Error('OpenRouter returned an invalid image response. Retry the request.');
  if (isRecord(payload.error)) throw sanitizedOpenRouterFailure(response.status);
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : null;
  const message = choice && isRecord(choice.message) ? choice.message : null;
  const text = contentText(message?.content);
  const rawImages = Array.isArray(message?.images) ? message.images : [];
  if (rawImages.length === 0) {
    throw new Error('The selected OpenRouter model returned no image. Try a different image-output model.');
  }
  if (rawImages.length > OPENROUTER_IMAGE_MAX_COUNT) {
    throw new Error('OpenRouter returned too many images. Reduce the requested image count and retry.');
  }
  const images = rawImages.map(normalizeOpenRouterImage);
  const totalImageBytes = images.reduce((total, image) => total + image.byteLength, 0);
  if (totalImageBytes > OPENROUTER_IMAGE_MAX_TOTAL_BYTES) {
    throw new Error('OpenRouter image output exceeded the supported size limit. Try a smaller image request.');
  }
  let inputTokens = 0;
  let outputTokens = 0;
  const usage = isRecord(payload.usage) ? payload.usage : null;
  if (typeof usage?.prompt_tokens === 'number' && Number.isFinite(usage.prompt_tokens)) {
    inputTokens = usage.prompt_tokens;
  }
  if (typeof usage?.completion_tokens === 'number' && Number.isFinite(usage.completion_tokens)) {
    outputTokens = usage.completion_tokens;
  }
  let usageWasEstimated = false;
  if (inputTokens === 0) {
    inputTokens = estimateInputTokens(
      [systemPrompt, ...req.messages.map((message) => llmContentToText(message.content))].join('\n'),
    );
    usageWasEstimated = true;
  }
  if (outputTokens === 0) {
    outputTokens = estimateInputTokens(text);
    usageWasEstimated = true;
  }
  const first = true;
  if (text) {
    req.onChunk?.({ delta: text, first });
  }
  req.onChunk?.({ delta: '', done: true });
  return {
    text,
    images: images.map(({ mimeType, data }) => ({ mimeType, data })),
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: 0,
      ...(usageWasEstimated ? { provenance: 'estimated' as const } : {}),
    },
    provider: cfg.id,
    model,
    finish_reason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined,
  };
}

function safeJSON(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function toOpenAiCompatibleContent(content: string | LLMContentPart[]) {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text' as const, text: part.text };
    return {
      type: 'image_url' as const,
      image_url: { url: `data:${part.mimeType};base64,${part.data}` },
    };
  });
}

export function makeOpenAICompatibleProvider(cfg: OpenAICompatibleConfig): LLMProvider {
  return {
    id: cfg.id,
    name: cfg.name,

    isAvailable() {
      const key = useAuthStore.getState().apiKeys[cfg.apiKeyStoreKey];
      return typeof key === 'string' && key.trim().length > 0;
    },

    async run(req: LLMRequest): Promise<LLMResponse> {
      if (req.imageOutputRequested === true) {
        return runOpenRouterImageRequest(cfg, req);
      }
      const apiKey = useAuthStore.getState().apiKeys[cfg.apiKeyStoreKey];
      if (!apiKey?.trim()) throw new Error(`${cfg.name} API key not set`);

      const model = req.agent.model.model || cfg.defaultModel;
      const reasoning = sanitizeReasoningProviderOptions(
        { providerId: cfg.id, modelId: model },
        req.provider_options,
      );
      const systemPrompt = systemPromptForRequest(req);
      const messages = [
        { role: 'system' as const, content: systemPrompt },
        ...req.messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({
            role: m.role,
            content: toOpenAiCompatibleContent(m.content),
          })),
      ];

      const body = {
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: req.temperature ?? req.agent.temperature ?? 0.7,
        max_tokens: req.max_output_tokens ?? req.agent.max_output_tokens ?? 4096,
        ...reasoning,
      };

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`,
        ...cfg.extraHeaders,
      };

      const fetchImpl = cfg.transport === 'native' ? nativeFetch : globalThis.fetch;
      const baseUrl = typeof cfg.baseUrl === 'function' ? cfg.baseUrl() : cfg.baseUrl;
      const chatUrl = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
      const res = await fetchImpl(chatUrl, {
        method: 'POST',
        headers,
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
        throw new Error(`${cfg.name} ${res.status}: ${errText.slice(0, 300) || res.statusText}`);
      }
      if (!res.body) throw new Error(`${cfg.name} returned an empty body`);

      let acc = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let usageWasEstimated = false;
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
        inputTokens = estimateInputTokens(
          [systemPrompt, ...req.messages.map((m) => llmContentToText(m.content))].join('\n'),
        );
        usageWasEstimated = true;
      }
      if (outputTokens === 0) {
        outputTokens = estimateInputTokens(acc);
        usageWasEstimated = true;
      }

      req.onChunk?.({ delta: '', done: true });

      return {
        text: acc,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cost_usd: estimateCost(cfg.id, model, inputTokens, outputTokens),
          ...(usageWasEstimated ? { provenance: 'estimated' as const } : {}),
        },
        provider: cfg.id,
        model,
        finish_reason: finishReason,
      };
    },
  };
}
