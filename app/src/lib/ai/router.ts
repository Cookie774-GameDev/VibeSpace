/**
 * Provider router. One public entry point - `runAgent` - that:
 *   1. Picks the right provider based on the agent's model spec, with a
 *      transparent upgrade from `mock-default` to a real provider when keys
 *      are configured (Anthropic preferred, then OpenAI, then Google).
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
import { ollamaProvider, OLLAMA_DEFAULT_MODEL } from './providers/ollama';
import {
  openrouterProvider,
  deepseekProvider,
  mistralProvider,
  togetherProvider,
  xaiProvider,
} from './providers/compatibleInstances';
import { defaultModelForProvider, getDiscoveredOllamaModels, isRealChatProvider } from './models';
import {
  agentUsesDefaultProvider,
} from './agentProviderOptions';

export class NoModelSelectedError extends Error {
  constructor() {
    super('No model selected. Connect a provider key, use your subscription, or install a local model.');
    this.name = 'NoModelSelectedError';
  }
}

function localModelsAvailable(): boolean {
  return getDiscoveredOllamaModels().length > 0;
}

function resolveLocalFallback(auth: ReturnType<typeof useAuthStore.getState>): {
  provider: LLMProvider;
  model: string;
} | null {
  if (!localModelsAvailable() || !ollamaProvider.isAvailable()) return null;
  return {
    provider: ollamaProvider,
    model: defaultModelForProvider('ollama', auth.defaultLocalModel),
  };
}

function resolveDefaultProviderRoute(
  auth: ReturnType<typeof useAuthStore.getState>,
): { provider: LLMProvider; model: string } | null {
  const pref = auth.defaultProvider;
  if (pref === 'mock') {
    return mockProvider.isAvailable()
      ? { provider: mockProvider, model: 'mock-default' }
      : null;
  }
  if (pref === 'ollama' || pref === 'local') {
    return resolveLocalFallback(auth);
  }
  if (isRealChatProvider(pref)) {
    const p = providers[pref];
    if (p?.isAvailable()) {
      return { provider: p, model: selectedModelFor(pref) };
    }
  }
  return null;
}

/**
 * All providers, keyed by their id.
 *
 * `google` (Gemini 2.5 Flash Lite) is now the lead Free option Jarvis
 * nudges new users toward — sub-second responses on a generous free tier
 * with no card. `groq` (Llama 3.3 70B) is still wired and free, just
 * second in line. Other OpenAI-compatible providers (xai/openrouter/
 * deepseek/mistral/together) still alias to mock until their adapters
 * land; their saved keys persist in the meantime so flipping the alias
 * is a one-line change.
 */
const providers: Record<ProviderId, LLMProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  google: googleProvider,
  groq: groqProvider,
  mock: mockProvider,
  // 'local' aliases the real Ollama adapter so an agent pinned to the
  // generic 'local' provider also runs against the user's local daemon.
  local: ollamaProvider,
  xai: xaiProvider,
  openrouter: openrouterProvider,
  deepseek: deepseekProvider,
  mistral: mistralProvider,
  together: togetherProvider,
  // Local model daemon (no key, no internet). Real adapter.
  ollama: ollamaProvider,
  // V3 — placeholder routing. Saved keys persist; runs go through mock.
  cohere: mockProvider,
  perplexity: mockProvider,
  fireworks: mockProvider,
  replicate: mockProvider,
  hyperbolic: mockProvider,
  novita: mockProvider,
  lambda: mockProvider,
  // V4 — enterprise & specialized providers. Placeholder routing.
  azure: mockProvider,
  cerebras: mockProvider,
  huggingface: mockProvider,
  bedrock: mockProvider,
};

/** Default model name to use when promoting a mock-default agent to a real provider. */
function selectedModelFor(p: ProviderId): string {
  const auth = useAuthStore.getState();
  return auth.selectedModels[p] || defaultModelForProvider(p, auth.defaultLocalModel);
}

/**
 * Decide which provider + model actually handles this call.
 *
 * Rules:
 *  - If the agent specifies a real provider AND that provider is available, use it.
 *  - If the agent specifies a real provider that's NOT available, fall back to mock
 *    (with the original model name preserved on the response so cost tables work).
 *  - If the agent is mock-default, prefer (in order):
 *      defaultProvider from auth -> google -> groq -> anthropic -> openai,
 *    using the first one that has a key. Google leads because Gemini 2.5
 *    Flash Lite is the Free-plan default and has the lowest signup friction
 *    (one click at aistudio.google.com/apikey, no card). If none, stay on mock.
 */
export function resolveProviderAndModel(agent: Agent): { provider: LLMProvider; model: string } {
  const auth = useAuthStore.getState();

  // Offline mode wins over everything: route all chat through the local
  // Ollama daemon, no key, no internet. The model comes from the user's
  // configured default local model.
  if (auth.offlineMode) {
    return {
      provider: ollamaProvider,
      model: auth.defaultLocalModel || OLLAMA_DEFAULT_MODEL,
    };
  }

  const provId = agent.model.provider;
  const usesDefault =
    agentUsesDefaultProvider(provId, agent.model.model) ||
    (agent.builtin && provId === 'mock' && agent.model.model === 'mock-default');

  if (usesDefault) {
    const routed = resolveDefaultProviderRoute(auth);
    if (routed) return routed;

    const ordered: ProviderId[] = [];
    const pref = auth.defaultProvider;
    if (pref && pref !== 'mock' && pref !== 'local' && isRealChatProvider(pref)) {
      ordered.push(pref);
    }
    for (const p of ['google', 'groq', 'anthropic', 'openai'] as const) {
      if (!ordered.includes(p)) ordered.push(p);
    }
    for (const id of ordered) {
      const p = providers[id];
      if (p?.isAvailable()) {
        return { provider: p, model: selectedModelFor(id) };
      }
    }

    const local = resolveLocalFallback(auth);
    if (local) return local;
    throw new NoModelSelectedError();
  }

  if (provId === 'local' || provId === 'ollama') {
    const local = resolveLocalFallback(auth);
    if (local) return local;
    throw new NoModelSelectedError();
  }

  if (provId !== 'mock') {
    const p = providers[provId];
    if (p && p.isAvailable()) {
      return { provider: p, model: auth.selectedModels[provId] || agent.model.model };
    }
    const local = resolveLocalFallback(auth);
    if (local) return local;
    throw new NoModelSelectedError();
  }

  const ordered: ProviderId[] = [];
  const pref = auth.defaultProvider;
  if (pref && pref !== 'mock' && pref !== 'local' && isRealChatProvider(pref)) ordered.push(pref);
  for (const p of ['google', 'groq', 'anthropic', 'openai'] as const) {
    if (!ordered.includes(p)) ordered.push(p);
  }

  for (const id of ordered) {
    const p = providers[id];
    if (p?.isAvailable()) {
      return { provider: p, model: selectedModelFor(id) };
    }
  }
  const local = resolveLocalFallback(auth);
  if (local) return local;
  if (provId === 'mock' && mockProvider.isAvailable()) {
    return { provider: mockProvider, model: agent.model.model || 'mock-default' };
  }
  throw new NoModelSelectedError();
}

/**
 * Public entry point used by the runtime and any caller that wants a one-shot
 * agent invocation. The agent object is treated as immutable input; the router
 * may construct a derived agent for the call (e.g., when promoting from mock
 * to anthropic) but never mutates the original.
 */
export async function runAgent(req: {
  agent: Agent;
  messages: LLMMessage[];
  signal?: AbortSignal;
  onChunk?: (chunk: LLMStreamChunk) => void;
  temperature?: number;
  max_output_tokens?: number;
}): Promise<LLMResponse> {
  const { provider, model } = resolveProviderAndModel(req.agent);

  // Substitute resolved provider+model into the agent for the call so the
  // provider sees a consistent ModelSpec.
  const effectiveAgent: Agent =
    provider.id === req.agent.model.provider && model === req.agent.model.model
      ? req.agent
      : { ...req.agent, model: { ...req.agent.model, provider: provider.id, model } };

  // Track whether the provider has emitted any visible output. Fallback is
  // only safe when zero output has been emitted - otherwise we'd splice mock
  // text onto a partial real response and produce gibberish.
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
  };

  let response: LLMResponse;
  try {
    response = await provider.run(llmReq);
  } catch (err) {
    // Pass cancellation straight through.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    if ((err as Error)?.name === 'AbortError') throw err;

    // Mock failed - nothing to fall back to.
    if (provider.id === 'mock') throw err;

    // Already emitted partial output - cannot safely splice mock content in.
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

  // Update the per-agent token + cost meter. We do this once per completion,
  // not per chunk, to keep the UI from thrashing.
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
