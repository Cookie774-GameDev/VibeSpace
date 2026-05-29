import { nanoid } from 'nanoid';
import type {
  AgentId,
  ChatId,
  EventId,
  IntegrationId,
  MessageId,
  ProjectId,
  QuickLinkGroupId,
  QuickLinkId,
  ReminderId,
  TaskId,
  TerminalPresetId,
  TerminalSessionId,
  WorkspaceId,
} from '@/types/common';

/**
 * ID generators with prefixes - makes IDs scannable in logs and DBs.
 * Length ~21 chars (nanoid default).
 */
const make = <B extends string>(prefix: string): (() => string) => () => `${prefix}_${nanoid(16)}`;

export const newTaskId = make('tsk') as () => TaskId;
export const newReminderId = make('rem') as () => ReminderId;
export const newChatId = make('cht') as () => ChatId;
export const newMessageId = make('msg') as () => MessageId;
export const newAgentId = make('agt') as () => AgentId;
export const newProjectId = make('prj') as () => ProjectId;
export const newWorkspaceId = make('wks') as () => WorkspaceId;
export const newMemoryId = make('mem');
export const newCallId = make('call');

// V2 ids
export const newEventId = make('evt') as () => EventId;
export const newQuickLinkId = make('qlk') as () => QuickLinkId;
export const newQuickLinkGroupId = make('qlg') as () => QuickLinkGroupId;
export const newTerminalPresetId = make('tpr') as () => TerminalPresetId;
export const newTerminalSessionId = make('tss') as () => TerminalSessionId;
export const newIntegrationId = make('int') as () => IntegrationId;
