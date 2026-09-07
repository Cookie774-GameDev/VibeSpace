export type JarvisMemoryCategory =
  | 'response-style'
  | 'workflow'
  | 'tool'
  | 'project'
  | 'personal'
  | 'avoid';

export interface JarvisMemorySource {
  kind: 'explicit' | 'inferred';
  chatId?: string;
  messageId?: string;
}

export interface JarvisMemoryScope {
  kind: 'account' | 'workspace' | 'project';
  id: string;
}

export interface JarvisMemoryItem {
  id: string;
  category: JarvisMemoryCategory;
  value: string;
  confidence: number;
  source: JarvisMemorySource;
  scope: JarvisMemoryScope;
  createdAt: number;
  updatedAt: number;
}

export interface JarvisLearningProfile {
  caoGuidance?: import('./caoGuidance').CaoGuidance;
  accountId: string;
  enabled: boolean;
  items: JarvisMemoryItem[];
  meaningfulMessageCount: number;
  lastEvaluationCount: number;
  updatedAt: number;
}

export type MemoryEvidenceCategory =
  | 'user_preference'
  | 'user_goal'
  | 'environment'
  | 'project_convention'
  | 'workflow_lesson'
  | 'successful_command'
  | 'failed_approach'
  | 'correction'
  | 'milestone'
  | 'relationship_preference';

export type MemoryEvidenceSourceType =
  | 'chat'
  | 'voice'
  | 'call'
  | 'sms'
  | 'gateway'
  | 'terminal'
  | 'file'
  | 'context_map'
  | 'manual'
  | 'skill_run';

export type MemorySensitivity = 'normal' | 'personal' | 'sensitive' | 'prohibited';

export type MemoryEvidenceStatus =
  | 'candidate'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'superseded'
  | 'archived';

export type MemoryLearningPolicy = 'off' | 'manual_only' | 'ask_first' | 'auto_safe';

export interface MemorySourceReference {
  kind: string;
  id: string;
  label: string;
  occurredAt: number;
  uri?: string;
  startOffset?: number;
  endOffset?: number;
}

export interface MemoryEvidenceItem {
  id: string;
  ownerId: string;
  profileId?: string;
  workspaceId: string;
  projectId?: string;
  category: MemoryEvidenceCategory;
  content: string;
  sourceType: MemoryEvidenceSourceType;
  sourceRef: MemorySourceReference;
  confidence: number;
  durabilityScore: number;
  sensitivity: MemorySensitivity;
  status: MemoryEvidenceStatus;
  reinforcedCount: number;
  contradictedBy?: string[];
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}
