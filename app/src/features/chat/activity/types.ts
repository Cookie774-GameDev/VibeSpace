import type { AgentId, ChatId } from '@/types/common';

export type ChatActivityKind = 'agent' | 'subagent' | 'file' | 'url' | 'diff' | 'tool';
export type ChatActivityCategory =
  | 'thinking'
  | 'file'
  | 'writing'
  | 'coordination'
  | 'context'
  | 'learning'
  | 'response';
export type ChatActivityStatus = 'pending' | 'running' | 'done' | 'cancelled' | 'error';
export type ChatActivitySemanticIntent = 'mail' | 'ship';

export interface ChatActivityEvent {
  id: string;
  chatId: ChatId | string;
  kind: ChatActivityKind;
  /** Structured semantic used for truthful activity presentation. */
  category?: ChatActivityCategory;
  /** Narrow intent supplied by canonical tool identity, never inferred from display prose. */
  semanticIntent?: ChatActivitySemanticIntent;
  status: ChatActivityStatus;
  title: string;
  subtitle?: string;
  ts: number;
  /** When the work started (ms). Defaults to ts when omitted. */
  startedAt?: number;
  /** When the work finished (ms). */
  endedAt?: number;
  agentId?: AgentId;
  agentSlug?: string;
  filePath?: string;
  url?: string;
  addedLines?: number;
  removedLines?: number;
  inputTokens?: number;
  outputTokens?: number;
  detail?: string;
  diff?: string;
  /** Exact producer correlation, supplied only when the runtime owns both identities. */
  messageId?: string;
  providerCallId?: string;
  nativeTask?: import('@/lib/ai/openCodeNativeActivity').NativeTaskActivity;
}

export type ChatActivityPatch = Partial<Omit<ChatActivityEvent, 'id' | 'chatId'>>;
