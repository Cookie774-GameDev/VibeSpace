import type { Timestamped, AgentId, ProviderId } from './common';

/**
 * Capability tag used by the orchestrator to pick agents per task.
 */
export type AgentCapability =
  | 'research'
  | 'code'
  | 'writing'
  | 'reasoning'
  | 'math'
  | 'design'
  | 'voice_supervision'
  | 'memory_keeping'
  | 'action_extraction'
  | 'critique'
  | 'planning';

/**
 * The model spec used by an agent.
 */
export type ModelSpec = {
  provider: ProviderId;
  model: string; // e.g. 'claude-3-5-sonnet-20241022'
  /** Optional override of context window */
  max_tokens?: number;
};

/**
 * Memory scope - how broadly an agent reads from memory.
 */
export type MemoryScope = 'agent' | 'project' | 'workspace';

/**
 * Tool name allowlist for an agent. '*' means all tools the user has installed.
 */
export type ToolAllowlist = string[] | ['*'];

/**
 * The full agent definition.
 *
 * Agents are bundles of:
 * - persona (system prompt)
 * - model (provider + name)
 * - tools (allowlist)
 * - color (for UI identification)
 * - capability tags (for orchestrator routing)
 */
export type Agent = {
  id: AgentId;
  /** Internal slug like 'jarvis', 'researcher' */
  slug: string;
  /** Display name */
  name: string;
  /** Short blurb shown in pickers */
  description: string;
  /** System prompt */
  system_prompt: string;
  /** Model config */
  model: ModelSpec;
  /** Tool allowlist */
  tools_allowed: ToolAllowlist;
  /** Memory scope */
  memory_scope: MemoryScope;
  /** Temperature 0..2 */
  temperature?: number;
  /** Max output tokens */
  max_output_tokens?: number;
  /**
   * UI color hue (HSL hue 0..359). If omitted, derived deterministically from slug hash.
   */
  color_hue?: number;
  /** Capability tags */
  capabilities: AgentCapability[];
  /** Built-in agents shipped with the app cannot be deleted */
  builtin?: boolean;
} & Timestamped;

/**
 * State an agent is in during a workflow.
 */
export type AgentRunState =
  | 'idle'
  | 'queued'
  | 'thinking'
  | 'reading'
  | 'tool_calling'
  | 'streaming'
  | 'waiting_for_user'
  | 'done'
  | 'error';
