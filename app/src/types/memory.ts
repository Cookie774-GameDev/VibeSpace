import type { ContextRef, Timestamped, AgentId, ProjectId, WorkspaceId } from './common';

/**
 * One indexed memory item. Surfaces to retrieval by similarity + recency + tags.
 */
export type MemoryItem = {
  id: string;
  workspace_id: WorkspaceId;
  project_id?: ProjectId;
  agent_id?: AgentId; // null = workspace-shared

  /** Where this memory came from */
  source: 'chat' | 'voice' | 'meeting' | 'web' | 'file' | 'task' | 'manual';
  /** Where in source this came from */
  source_ref: ContextRef;
  /** The actual remembered content */
  content: string;
  /** Optional embedding; not always set client-side (server may compute later) */
  embedding?: number[];
  /** Free-form tags */
  tags: string[];
  /** Confidence score (decays over time, bumps when reinforced) */
  confidence: number; // 0..1
  /** Last time something retrieved this */
  last_accessed_at?: number;
} & Timestamped;
