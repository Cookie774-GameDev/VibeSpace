/**
 * Provider-agnostic LLM contract. Every provider (anthropic / openai / google /
 * mock / local) implements `LLMProvider`. The router picks one and calls `run`.
 *
 * This file owns:
 * - The request/response/stream-chunk shapes
 * - The provider interface
 * - Cost rate tables and helpers
 *
 * Nothing else in `lib/ai/` should redefine these.
 */
import type { Agent, ProviderId } from '@/types';

/**
 * Role of a message as far as the LLM is concerned.
 * 'system' is hoisted to the agent.system_prompt by the router; callers usually
 * pass only 'user' / 'assistant' here.
 */
export type LLMRole = 'system' | 'user' | 'assistant';

/**
 * One message in the conversation passed to the model. We deliberately keep this
 * a flat string so providers don't have to negotiate part schemas. The runtime
 * is responsible for flattening Message[] -> LLMMessage[].
 */
export interface LLMMessage {
  role: LLMRole;
  content: string;
}

/**
 * A request to a provider. The agent carries the system prompt, model, and
 * preferences; messages are the chat turns; the rest are per-call overrides.
 */
export interface LLMRequest {
  /** The agent making this call. Drives model + system prompt + temperature. */
  agent: Agent;
  /** Messages so far. System prompt is on the agent, not in this list. */
  messages: LLMMessage[];
  /** Per-call override of the agent's max output tokens. */
  max_output_tokens?: number;
  /** Per-call override of the agent's temperature. */
  temperature?: number;
  /** Cancellation. Provider must honor this and stop streaming. */
  signal?: AbortSignal;
  /**
   * Stream callback. Called with each chunk of output as it arrives.
   * The chunk's `delta` is appended to the running output; the consumer is
   * responsible for any throttling / batching.
   */
  onChunk?: (chunk: LLMStreamChunk) => void;
}

/**
 * One chunk emitted during streaming. Most chunks carry a `delta`; the first
 * chunk is marked `first` and the terminal chunk is marked `done` (with empty
 * delta). Providers may emit zero or one of each.
 */
export interface LLMStreamChunk {
  /** Text delta to append. Empty string is allowed (e.g., on the final chunk). */
  delta: string;
  /** True only on the very first text chunk in a stream. */
  first?: boolean;
  /** True only on the terminal chunk. Implies the run is finished. */
  done?: boolean;
}

/**
 * Token + cost accounting for one call. Cost is in USD and may be approximated
 * when the provider doesn't return a usage block.
 */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

/**
 * Final response from a provider. The router uses this to update the agent
 * store's per-agent token totals.
 */
export interface LLMResponse {
  /** The full accumulated text. Equal to the concatenation of all chunk deltas. */
  text: string;
  /** Token + dollar usage. */
  usage: TokenUsage;
  /** The provider that actually handled this. May differ from request agent's
   *  provider if the router upgraded a mock-default agent. */
  provider: ProviderId;
  /** The model that actually handled this. */
  model: string;
  /** Provider-reported reason the stream ended ('stop' / 'length' / 'cancelled' / etc.) */
  finish_reason?: string;
}

/**
 * One LLM provider implementation. All providers must:
 * - Stream chunks to `req.onChunk` as text arrives.
 * - Honor `req.signal` for cancellation (stop streaming, release resources).
 * - Throw on unrecoverable errors so the router can fall back to mock.
 * - Return a final `LLMResponse` with usage when the stream completes.
 */
export interface LLMProvider {
  /** Stable id matching the ProviderId union. */
  id: ProviderId;
  /** Human-readable label used in toasts and the UI. */
  name: string;
  /**
   * Run a request. Streaming happens via `req.onChunk`; the resolved promise
   * carries the final aggregated response.
   */
  run(req: LLMRequest): Promise<LLMResponse>;
  /**
   * True when this provider has the credentials and config it needs. Used by
   * the router to decide whether to upgrade mock-default agents.
   */
  isAvailable(): boolean;
}

/**
 * Per-million-token pricing. Used to estimate cost when the provider doesn't
 * report it. All numbers in USD.
 */
export interface CostRates {
  input_per_m: number;
  output_per_m: number;
}

/**
 * Static rate table keyed by `provider:model`. Falls through to a `provider:default`
 * row if a specific model isn't listed. Numbers are intentionally rough; the
 * meter is for the user's awareness, not billing.
 */
export const COST_RATES: Record<string, CostRates> = {
  // Anthropic
  'anthropic:claude-3-5-sonnet-20241022': { input_per_m: 3, output_per_m: 15 },
  'anthropic:claude-3-5-sonnet-latest': { input_per_m: 3, output_per_m: 15 },
  'anthropic:claude-3-5-haiku-20241022': { input_per_m: 0.8, output_per_m: 4 },
  'anthropic:claude-3-opus-20240229': { input_per_m: 15, output_per_m: 75 },
  'anthropic:default': { input_per_m: 3, output_per_m: 15 },

  // OpenAI
  'openai:gpt-4o': { input_per_m: 2.5, output_per_m: 10 },
  'openai:gpt-4o-mini': { input_per_m: 0.15, output_per_m: 0.6 },
  'openai:gpt-4-turbo': { input_per_m: 10, output_per_m: 30 },
  'openai:default': { input_per_m: 0.15, output_per_m: 0.6 },

  // Google
  'google:gemini-2.5-flash-lite': { input_per_m: 0, output_per_m: 0 },
  'google:gemini-2.5-flash': { input_per_m: 0, output_per_m: 0 },
  'google:gemini-2.5-pro': { input_per_m: 0, output_per_m: 0 },
  'google:gemini-1.5-flash': { input_per_m: 0.075, output_per_m: 0.3 },
  'google:gemini-1.5-flash-latest': { input_per_m: 0.075, output_per_m: 0.3 },
  'google:gemini-1.5-pro': { input_per_m: 1.25, output_per_m: 5 },
  // Free tier on AI Studio is generous; we list 2.5 models at 0/0 so the
  // in-app meter doesn't pretend the user is being charged. The legacy
  // 1.5 entries keep their published rates for users on the paid tier.
  'google:default': { input_per_m: 0, output_per_m: 0 },

  // Groq — free tier today (user's own key, no Jarvis billing). Listed at
  // 0/0 so the in-app meter doesn't pretend the user is being charged.
  'groq:llama-3.3-70b-versatile': { input_per_m: 0, output_per_m: 0 },
  'groq:llama-3.1-8b-instant': { input_per_m: 0, output_per_m: 0 },
  'groq:default': { input_per_m: 0, output_per_m: 0 },

  // Mock + local cost nothing (runs on the user's own machine).
  'mock:default': { input_per_m: 0, output_per_m: 0 },
  'local:default': { input_per_m: 0, output_per_m: 0 },
  'ollama:default': { input_per_m: 0, output_per_m: 0 },
};

/** Look up cost rates for a (provider, model) pair, falling back to provider default then 0. */
export function ratesFor(provider: ProviderId, model: string): CostRates {
  return (
    COST_RATES[`${provider}:${model}`] ??
    COST_RATES[`${provider}:default`] ?? { input_per_m: 0, output_per_m: 0 }
  );
}

/** Estimate USD cost for a (provider, model) call given token counts. */
export function estimateCost(
  provider: ProviderId,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const r = ratesFor(provider, model);
  return (inputTokens / 1_000_000) * r.input_per_m + (outputTokens / 1_000_000) * r.output_per_m;
}

/**
 * Approximate token count for a string of text. We use the rough 4-chars-per-token
 * rule used by every public estimator. Not a substitute for real tokenizers but
 * it's accurate to within ~15% across English prose.
 */
export function estimateInputTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
