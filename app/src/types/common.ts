/**
 * Common shared types used across the entire app.
 */

export type ID = string;

/**
 * A reference to some piece of source content - a chat message, file, meeting, etc.
 * Lets us trace provenance from any output back to its origin.
 */
export type ContextRef = {
  kind:
    | 'chat_message'
    | 'meeting'
    | 'file'
    | 'email'
    | 'calendar_event'
    | 'memory'
    | 'url'
    | 'task';
  id: string;
  excerpt?: string;
  ts?: number;
};

/**
 * Generic timestamped record marker used by storage adapters.
 */
export type Timestamped = {
  created_at: number;
  updated_at: number;
};

/**
 * Result envelope for service calls. Cleaner than throwing at every boundary.
 */
export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/**
 * Theme variants. V1 ships dark only but the hook is here.
 */
export type Theme = 'dark' | 'light' | 'system' | 'jarvis';

/**
 * Persona presets the user can pick for Jarvis.
 * Drives system prompt + voice persona.
 */
export type PersonaPreset = 'jarvis' | 'athena' | 'edge' | 'watson' | 'hal';

/** Persisted spoken-voice profiles. Independent from the conversational persona. */
export type VoicePresetId = 'jarvis-prime' | 'aurora' | 'atlas' | 'nova' | 'sentinel';

/**
 * Spoken voice engine:
 *  - 'system': any OS/browser voice (Windows Natural / online enhanced) — default.
 *  - 'local':  restricts playback to locally-installed system voices.
 *  - 'kokoro': local Kokoro-82M neural TTS (downloads once); falls back to
 *              the Windows Natural system voice if unavailable.
 */
export type VoiceEngine = 'system' | 'local' | 'kokoro' | 'deepgram';

/**
 * Provider IDs we know about.
 */
/**
 * Identifier of a model provider.
 *
 * V1 shipped the four cloud majors plus the local stub; V2 adds the OpenAI-
 * compatible providers users keep asking for. The router only ships real
 * implementations for `anthropic`, `openai`, `google`, and `mock`/`local`;
 * every new V2 entry currently routes through the OpenAI-compatible adapter
 * (which transparently mocks if no key is set) so the UI surface — the
 * picker, BYOK form, persisted keys — works end-to-end immediately.
 */
export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'mock'
  | 'local'
  // V2 — OpenAI-compatible providers.
  | 'xai'
  | 'openrouter'
  | 'groq'
  | 'deepseek'
  | 'mistral'
  | 'together'
  | 'ollama'
  // V3 — additional OpenAI-compatible providers.
  | 'cohere'
  | 'perplexity'
  | 'fireworks'
  | 'replicate'
  | 'hyperbolic'
  | 'novita'
  | 'lambda'
  // V4 — enterprise and specialized providers.
  | 'azure'
  | 'cerebras'
  | 'huggingface'
  | 'bedrock';

/**
 * Branded type helpers - useful when we want compile-time distinction
 * between (e.g.) TaskId and ChatId without runtime cost.
 */
export type Brand<T, B extends string> = T & { __brand: B };

export type TaskId = Brand<string, 'TaskId'>;
export type ReminderId = Brand<string, 'ReminderId'>;
export type ChatId = Brand<string, 'ChatId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type AgentId = Brand<string, 'AgentId'>;
export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type ProjectId = Brand<string, 'ProjectId'>;

// V2 branded ids
export type EventId = Brand<string, 'EventId'>;
export type QuickLinkId = Brand<string, 'QuickLinkId'>;
export type QuickLinkGroupId = Brand<string, 'QuickLinkGroupId'>;
export type TerminalPresetId = Brand<string, 'TerminalPresetId'>;
export type TerminalSessionId = Brand<string, 'TerminalSessionId'>;
export type IntegrationId = Brand<string, 'IntegrationId'>;
