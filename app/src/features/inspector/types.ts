export type VibeSpaceTaskStatus = 'open' | 'working' | 'blocked' | 'done';

export type VibeSpaceTaskSource =
  | 'terminal'
  | 'chat'
  | 'tool'
  | 'milestone'
  | 'schedule'
  | 'system'
  | 'kanban';

export type VibeSpaceTask = {
  id: string;
  title: string;
  source: VibeSpaceTaskSource;
  status: VibeSpaceTaskStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  relatedTerminalId?: string;
  relatedChatId?: string;
  relatedToolId?: string;
  relatedFilePath?: string;
};

export type MilestoneStatus = 'todo' | 'working' | 'done';

/**
 * `todo`      — short-lived daily checklist item (Kanban "To-do" list).
 * `milestone` — long-running goal that persists across days/weeks/months.
 *
 * Items created before this field existed are treated as `todo`.
 */
export type MilestoneKind = 'todo' | 'milestone';

export type MilestoneScope = Readonly<{ accountId: string; workspaceId: string; projectId: string; requestId: string }>;

export type MilestoneItem = {
  scope?: MilestoneScope;
  id: string;
  title: string;
  description?: string;
  status: MilestoneStatus;
  kind?: MilestoneKind;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  /** Optional target date/time for long-running milestones or daily to-dos. */
  deadlineAt?: number;
  relatedTerminalId?: string;
  relatedChatId?: string;
  relatedFilePath?: string;
};

/** True when an item is a long-running milestone (not a daily to-do). */
export function isMilestoneKind(item: Pick<MilestoneItem, 'kind'>): boolean {
  return item.kind === 'milestone';
}

export type LiveWorkStatus = 'working' | 'stationary';

export type LiveTerminalStatus = {
  terminalId: string;
  sessionId: string;
  paneId?: string;
  terminalName: string;
  agentName?: string;
  modelName?: string;
  status: LiveWorkStatus;
  lastOutputAt?: number;
  lastActivitySummary?: string;
};

export type LiveChatStatus = {
  chatId: string;
  title: string;
  providerName?: string;
  modelName?: string;
  status: LiveWorkStatus;
  lastMessagePreview?: string;
  lastActivityAt?: number;
  totalTokens?: number;
};

export type ToolRunStatus = 'queued' | 'running' | 'success' | 'error';

export type ToolRunRecord = {
  id: string;
  toolId: string;
  toolName: string;
  status: ToolRunStatus;
  error?: string;
  startedAt: number;
  completedAt?: number;
};
