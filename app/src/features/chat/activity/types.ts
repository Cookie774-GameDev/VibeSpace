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

export interface ChatActivityEvent {
  id: string;
  chatId: ChatId | string;
  kind: ChatActivityKind;
  /** Structured semantic used for truthful activity presentation. */
  category?: ChatActivityCategory;
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
}

export type ChatActivityPatch = Partial<Omit<ChatActivityEvent, 'id' | 'chatId'>>;
