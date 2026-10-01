import type { AgentId, ChatId, MessageId, ProviderId } from '@/types/common';
import type { ChatModelSelection } from '@/lib/ai/modelSelection';

export type JarvisInteractionMode = 'ask' | 'plan' | 'agent';

export type JarvisQuestionType = 'single' | 'multi' | 'text' | 'mixed';

export interface JarvisQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface JarvisQuestion {
  id: string;
  prompt: string;
  type: JarvisQuestionType;
  options?: JarvisQuestionOption[];
  required?: boolean;
  allowSkip?: boolean;
  placeholder?: string;
  allowCustomResponse?: true;
}

export interface JarvisQuestionAnswer {
  questionId: string;
  selectedOptionIds?: string[];
  text?: string;
  skipped?: boolean;
}

export interface JarvisQuestionBlock {
  id: string;
  title?: string;
  description?: string;
  originalRequest?: string;
  questions: JarvisQuestion[];
  answers?: JarvisQuestionAnswer[];
  status: 'pending' | 'answered' | 'skipped' | 'cancelled';
}

export interface JarvisPlanReview {
  id: string;
  title: string;
  summary: string;
  steps: string[];
  risks?: string[];
  executable?: boolean;
  status: 'pending' | 'building' | 'redone' | 'cancelled' | 'built';
  revisionOf?: string;
}

export type JarvisPermissionStatus = 'pending' | 'approved' | 'approved_plan' | 'denied' | 'edited';

export interface JarvisPermissionRequest {
  id: string;
  title: string;
  description: string;
  risk: 'low' | 'medium' | 'high';
  action:
    | 'write_file'
    | 'delete_file'
    | 'run_command'
    | 'apply_changes'
    | 'change_project'
    | 'launch_agents';
  targets?: string[];
  planId?: string;
  status: JarvisPermissionStatus;
  instruction?: string;
  harness?: {
    sessionId: string;
    approvalId: string;
    capability: string;
  };
}

export type JarvisAgentStatus =
  | 'queued'
  | 'thinking'
  | 'planning'
  | 'asking_question'
  | 'waiting_permission'
  | 'editing'
  | 'testing'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface JarvisChatAgent {
  agentId: AgentId | string;
  name: string;
  parentChatId: ChatId | string;
  childChatId: ChatId | string;
  /** Opaque OpenCode session bound to this VibeSpace child chat. */
  harnessSessionId?: string;
  /** Opaque OpenCode parent session bound to the supervising VibeSpace chat. */
  harnessParentSessionId?: string;
  task: string;
  modelLabel: string;
  modelSelection?: ChatModelSelection;
  status: JarvisAgentStatus;
  currentStep?: string;
  filesRead?: string[];
  filesEditing?: string[];
  diffSummary?: {
    addedLines: number;
    removedLines: number;
  };
  filesTouched: string[];
  lockedFiles: string[];
  createdAt: string;
  updatedAt: string;
  summary?: string;
  error?: string;
}

export type JarvisCoordinationAgent = Omit<
  JarvisChatAgent,
  'parentChatId' | 'modelSelection' | 'filesTouched' | 'createdAt' | 'updatedAt'
> & {
  chatId: ChatId | string;
  plannedChanges: string[];
  completedChanges: string[];
  conflicts: string[];
  errors: string[];
  startedAt: string;
  lastUpdatedAt: string;
};

export interface JarvisFileLock {
  filePath: string;
  lockedByAgentId: string;
  lockedByAgentName: string;
  reason?: string;
  lockedAt: string;
  releasedAt?: string;
  status: 'active' | 'released' | 'stale';
}

export interface JarvisCoordinationSnapshot {
  version: 1;
  projectRoot: string;
  generatedAt: string;
  agents: JarvisCoordinationAgent[];
  locks: JarvisFileLock[];
  events: Array<{
    id: string;
    ts: string;
    agentId?: string;
    type: string;
    summary: string;
    filePath?: string;
  }>;
}

export interface JarvisStructuredContext {
  kind:
    | 'question_answers'
    | 'plan_build'
    | 'plan_redo'
    | 'permission_response'
    | 'multitask'
    | 'subagents';
  sourceMessageId?: MessageId | string;
  payload: unknown;
}
