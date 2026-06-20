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

export type MilestoneItem = {
  id: string;
  title: string;
  description?: string;
  status: MilestoneStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  relatedTerminalId?: string;
  relatedChatId?: string;
  relatedFilePath?: string;
};

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
