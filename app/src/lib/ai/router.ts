/**
 * Provider router. One public entry point - `runAgent` - that:
 *   1. Picks the right provider based on the agent's model spec, with a
 *      transparent upgrade from `mock-default` to a real provider when keys
 *      are configured (Anthropic preferred, then OpenAI, then Google).
 *   2. Streams chunks through to the caller's onChunk.
 *   3. Falls back to the mock provider when a real provider errors *before*
 *      emitting any output, with a toast explaining the fallback.
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
import type { LLMProvider, LLMRequest, LLMResponse, LLMStreamChunk, LLMMessage } from './types';
import { mockProvider } from './providers/mock';
import { anthropicProvider, ANTHROPIC_DEFAULT_MODEL } from './providers/anthropic';
import { openaiProvider, OPENAI_DEFAULT_MODEL } from './providers/openai';
import { googleProvider, GOOGLE_DEFAULT_MODEL } from './providers/google';

/**
 * All providers, keyed by their id.
 *
 * V2 OpenAI-compatible providers (xai/openrouter/groq/deepseek/mistral/
 * together) currently route through the openai-compatible adapter when keys
 * are set. Until that lands they alias to mock so type safety is preserved
 * and saved keys persist; switching the alias to `openaiCompatProvider({...})`
 * is a one-line flip when the adapter ships.
 */
const providers: Record<ProviderId, LLMProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  google: googleProvider,
  mock: mockProvider,
  // 'local' is reserved for a future local-Ollama-style provider; alias to mock for now.
  local: mockProvider,
  // V2 — placeholder routing. Saved keys persist; runs go through mock.
  xai: mockProvider,
  openrouter: mockProvider,
  groq: mockProvider,
  deepseek: mockProvider,
  mistral: mockProvider,
  together: mockProvider,
  ollama: mockProvider,
  // V3 — placeholder routing. Saved keys persist; runs go through mock.
  cohere: mockProvider,
  perplexity: mockProvider,
  fireworks: mockProvider,
  replicate: mockProvider,
  hyperbolic: mockProvider,
  novita: mockProvider,
  lambda: mockProvider,
};

/** Default model name to use when promoting a mock-default agent to a real provider. */
function defaultModelFor(p: ProviderId): string {
  switch (p) {
    case 'anthropic':
      return ANTHROPIC_DEFAULT_MODEL;
    case 'openai':
      return OPENAI_DEFAULT_MODEL;
    case 'google':
      return GOOGLE_DEFAULT_MODEL;
    default:
      return 'mock-default';
  }
}

/**
 * Decide which provider + model actually handles this call.
 *
 * Rules:
 *  - If the agent specifies a real provider AND that provider is available, use it.
 *  - If the agent specifies a real provider that's NOT available, fall back to mock
 *    (with the original model name preserved on the response so cost tables work).
 *  - If the agent is mock-default, prefer (in order):
 *      defaultProvider from auth -> anthropic -> openai -> google,
 *    using the first one that has a key. If none, stay on mock.
 */
function resolveProviderAndModel(agent: Agent): { provider: LLMProvider; model: string } {
  const provId = agent.model.provider;

  if (provId !== 'mock' && provId !== 'local') {
    const p = providers[provId];
    if (p && p.isAvailable()) {
      return { provider: p, model: agent.model.model };
    }
    // Configured for a real provider but key not set - quietly mock.
    return { provider: mockProvider, model: agent.model.model || 'mock-default' };
  }

  const pref = useAuthStore.getState().defaultProvider;
  const ordered: ProviderId[] = [];
  if (pref && pref !== 'mock' && pref !== 'local') ordered.push(pref);
  for (const p of ['anthropic', 'openai', 'google'] as const) {
    if (!ordered.includes(p)) ordered.push(p);
  }

  for (const id of ordered) {
    const p = providers[id];
    if (p?.isAvailable()) {
      return { provider: p, model: defaultModelFor(id) };
    }
  }
  return { provider: mockProvider, model: 'mock-default' };
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
    toast.warning(
      `Provider ${provider.name} failed`,
      `${reason.slice(0, 200)}. Using mock fallback.`,
    );

    const fallbackAgent: Agent = {
      ...req.agent,
      model: { ...req.agent.model, provider: 'mock', model: 'mock-default' },
    };
    response = await mockProvider.run({
      agent: fallbackAgent,
      messages: req.messages,
      signal: req.signal,
      onChunk: wrappedOnChunk,
      temperature: req.temperature,
      max_output_tokens: req.max_output_tokens,
    });
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
