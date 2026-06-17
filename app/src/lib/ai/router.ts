/**
 * Provider router. One public entry point - `runAgent` - that:
 *   1. Picks the right provider based on the agent's model spec and the
 *      user's explicit chat model selection (no hidden fallbacks).
 *   2. Streams chunks through to the caller's onChunk.
 *   3. Surfaces real-provider errors instead of disguising them as mock output.
 *   4. Updates the per-agent token + cost meter via `useAgentStore.addTokens`.
 *
 * Cancellation is honored throughout - if the caller's signal aborts mid-run,
 * the provider stops streaming and the router rethrows AbortError without
 * trying to fall back.
 */
import type { Agent, ProviderId } from '@/types';
import { useAuthStore } from '@/stores/auth';
import { useAgentStore } from '@/stores/agents';
import { toast } from '@/components/ui/toast';
import { devConsole } from '@/features/dev-console';
import type { LLMProvider, LLMRequest, LLMResponse, LLMStreamChunk, LLMMessage } from './types';
import { mockProvider } from './providers/mock';
import { anthropicProvider } from './providers/anthropic';
import { openaiProvider } from './providers/openai';
import { googleProvider } from './providers/google';
import { groqProvider } from './providers/groq';
import { ollamaProvider } from './providers/ollama';
import {
  openrouterProvider,
  deepseekProvider,
  mistralProvider,
  togetherProvider,
  xaiProvider,
} from './providers/compatibleInstances';
import { agentUsesDefaultProvider } from './agentProviderOptions';
import { EMPTY_CHAT_MODEL_SELECTION } from './modelSelection';

export class NoModelSelectedError extends Error {
  constructor() {
    super('No model selected. Choose a model before sending.');
    this.name = 'NoModelSelectedError';
  }
}

const providers: Record<ProviderId, LLMProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  google: googleProvider,
  groq: groqProvider,
  mock: mockProvider,
  local: ollamaProvider,
  xai: xaiProvider,
  openrouter: openrouterProvider,
  deepseek: deepseekProvider,
  mistral: mistralProvider,
  together: togetherProvider,
  ollama: ollamaProvider,
  cohere: mockProvider,
  perplexity: mockProvider,
  fireworks: mockProvider,
  replicate: mockProvider,
  hyperbolic: mockProvider,
  novita: mockProvider,
  lambda: mockProvider,
  azure: mockProvider,
  cerebras: mockProvider,
  huggingface: mockProvider,
  bedrock: mockProvider,
};

function resolveExplicitSingleSelection(
  auth: ReturnType<typeof useAuthStore.getState>,
): { provider: LLMProvider; model: string } {
  const sel = auth.chatModelSelection ?? EMPTY_CHAT_MODEL_SELECTION;
  if (sel.mode !== 'single') throw new NoModelSelectedError();
  const p = providers[sel.providerId];
  if (!p?.isAvailable()) throw new NoModelSelectedError();
  return { provider: p, model: sel.modelId };
}

function resolveLocalSelection(
  auth: ReturnType<typeof useAuthStore.getState>,
): { provider: LLMProvider; model: string } {
  const sel = auth.chatModelSelection ?? EMPTY_CHAT_MODEL_SELECTION;
  if (sel.mode !== 'single') throw new NoModelSelectedError();
  if (sel.providerId !== 'ollama' && sel.providerId !== 'local') {
    throw new NoModelSelectedError();
  }
  if (!ollamaProvider.isAvailable()) throw new NoModelSelectedError();
  return { provider: ollamaProvider, model: sel.modelId };
}

/**
 * Decide which provider + model actually handles this call.
 *
 * The agent's model spec is authoritative for pinned agents. Jarvis and
 * default-provider agents are overridden at runtime via `applyChatModelSelectionToAgent`
 * before this is called. No silent provider fallbacks — missing selection throws.
 */
export function resolveProviderAndModel(agent: Agent): { provider: LLMProvider; model: string } {
  const auth = useAuthStore.getState();

  if (auth.offlineMode) {
    return resolveLocalSelection(auth);
  }

  const provId = agent.model.provider;
  const usesDefault =
    agentUsesDefaultProvider(provId, agent.model.model) ||
    (agent.builtin && provId === 'mock' && agent.model.model === 'mock-default');

  if (usesDefault) {
    return resolveExplicitSingleSelection(auth);
  }

  if (provId === 'local' || provId === 'ollama') {
    return resolveLocalSelection(auth);
  }

  if (provId !== 'mock') {
    const p = providers[provId];
    if (p?.isAvailable()) {
      return { provider: p, model: agent.model.model };
    }
    throw new NoModelSelectedError();
  }

  if (mockProvider.isAvailable()) {
    return { provider: mockProvider, model: agent.model.model || 'mock-default' };
  }
  throw new NoModelSelectedError();
}

/**
 * Public entry point used by the runtime and any caller that wants a one-shot
 * agent invocation. The agent object is treated as immutable input; the router
 * may construct a derived agent for the call but never mutates the original.
 */
export async function runAgent(req: {
  agent: Agent;
  messages: LLMMessage[];
  signal?: AbortSignal;
  onChunk?: (chunk: LLMStreamChunk) => void;
  temperature?: number;
  max_output_tokens?: number;
  provider_options?: Record<string, unknown>;
}): Promise<LLMResponse> {
  const { provider, model } = resolveProviderAndModel(req.agent);

  const effectiveAgent: Agent =
    provider.id === req.agent.model.provider && model === req.agent.model.model
      ? req.agent
      : { ...req.agent, model: { ...req.agent.model, provider: provider.id, model } };

  let emittedAny = false;
  const wrappedOnChunk = req.onChunk
    ? (chunk: LLMStreamChunk) => {
        if (chunk.delta && chunk.delta.length > 0) emittedAny = true;
        req.onChunk!(chunk);
      }
    : undefined;

  const llmReq: LLMRequest = {
    agent: effectiveAgent,
    messages: req.messages,
    signal: req.signal,
    onChunk: wrappedOnChunk,
    temperature: req.temperature,
    max_output_tokens: req.max_output_tokens,
    provider_options: req.provider_options,
  };

  let response: LLMResponse;
  try {
    response = await provider.run(llmReq);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    if ((err as Error)?.name === 'AbortError') throw err;

    if (provider.id === 'mock') throw err;
    if (emittedAny) throw err;

    const reason = err instanceof Error ? err.message : String(err);
    toast.warning(`Provider ${provider.name} failed`, reason.slice(0, 240));
    devConsole.log({
      channel: 'ai',
      level: 'warn',
      message: `AI provider failed: ${provider.id}`,
      detail: {
        agent: req.agent.slug,
        provider: provider.id,
        model,
        reason: reason.slice(0, 500),
      },
    });

    throw err;
  }

  useAgentStore
    .getState()
    .addTokens(
      req.agent.id,
      response.usage.input_tokens,
      response.usage.output_tokens,
      response.usage.cost_usd,
    );

  return response;
}
