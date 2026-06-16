/**
 * Hosted stack step — uses Supabase edge `stack-complete` when the user
 * has a paid plan but no BYOK key for the requested provider.
 */
import { getSupabaseClient } from '@/lib/supabase';
import type { ProviderId } from '@/types/common';
import type { LLMMessage, LLMStreamChunk } from '../types';
import { estimateCost, estimateInputTokens } from '../types';

export interface HostedStackRequest {
  provider: ProviderId;
  model: string;
  systemPrompt: string;
  messages: LLMMessage[];
  temperature?: number;
  max_output_tokens?: number;
  provider_options?: Record<string, unknown>;
  signal?: AbortSignal;
  onChunk?: (chunk: LLMStreamChunk) => void;
}

export interface HostedStackResponse {
  text: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  provider: ProviderId;
  model: string;
}

export function canUseHostedStack(plan: string): boolean {
  return plan !== 'free' && plan !== 'byok-only';
}

export async function runHostedStackStep(req: HostedStackRequest): Promise<HostedStackResponse> {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error('Cloud sync not configured — connect a provider key or enable subscription.');
  }

  const { data: sessionData } = await client.auth.getSession();
  const jwt = sessionData.session?.access_token;
  if (!jwt) {
    throw new Error('Sign in to use subscription-hosted models.');
  }

  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stack-complete`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${jwt}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? '',
    },
    body: JSON.stringify({
      provider: req.provider,
      model: req.model,
      system: req.systemPrompt,
      messages: req.messages,
      temperature: req.temperature,
      max_tokens: req.max_output_tokens,
      provider_options: req.provider_options,
      stream: true,
    }),
    signal: req.signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const code = (err as { error?: string }).error ?? `http_${res.status}`;
    throw new Error(`Hosted stack failed: ${code}`);
  }
  if (!res.body) throw new Error('Hosted stack returned empty body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let acc = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let first = true;
  let buffer = '';

  while (true) {
    if (req.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        const evt = JSON.parse(raw) as {
          delta?: string;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          done?: boolean;
        };
        if (evt.delta) {
          acc += evt.delta;
          req.onChunk?.({ delta: evt.delta, first });
          first = false;
        }
        if (evt.usage) {
          inputTokens = evt.usage.prompt_tokens ?? inputTokens;
          outputTokens = evt.usage.completion_tokens ?? outputTokens;
        }
        if (evt.done) req.onChunk?.({ delta: '', done: true });
      } catch {
        // skip malformed SSE lines
      }
    }
  }

  if (inputTokens === 0) {
    inputTokens = estimateInputTokens(
      [req.systemPrompt, ...req.messages.map((m) => m.content)].join('\n'),
    );
  }
  if (outputTokens === 0) outputTokens = estimateInputTokens(acc);

  return {
    text: acc,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: estimateCost(req.provider, req.model, inputTokens, outputTokens),
    provider: req.provider,
    model: req.model,
  };
}
