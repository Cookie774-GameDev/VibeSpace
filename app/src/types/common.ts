/**
 * Common shared types used across the entire app.
 */

export type ID = string;

/**
 * A reference to some piece of source content - a chat message, file, meeting, etc.
 * Lets us trace provenance from any output back to its origin.
 */
export type ContextRef = {
  kind: 'chat_message' | 'meeting' | 'file' | 'email' | 'calendar_event' | 'memory' | 'url' | 'task';
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
export type Theme = 'dark' | 'light' | 'system';

/**
 * Persona presets the user can pick for Jarvis.
 * Drives system prompt + voice persona.
 */
export type PersonaPreset = 'jarvis' | 'athena' | 'edge' | 'watson' | 'hal';

/**
 * Provider IDs we know about.
 */
export type ProviderId = 'anthropic' | 'openai' | 'google' | 'mock' | 'local';

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
