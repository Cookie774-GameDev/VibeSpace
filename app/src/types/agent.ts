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
  /**
   * V2: Reasoning effort preset. Maps to provider-specific overrides
   * (temperature, max_tokens, OpenAI reasoning_effort, Anthropic thinking
   * budget, Google thinking budget). Defaults to 'medium' when omitted.
   */
  effort?: AgentEffort;
  /** When effort='custom', explicit override values. */
  effort_custom?: AgentEffortCustom;
  /** V2: Persona preset for voice/tone. Default 'jarvis'. */
  persona?: AgentPersona;
  /** V2: Skill ids granted to this agent. Built-ins typically empty. */
  skills?: string[];
  /** V2: Where the agent definition came from. Default 'builtin'. */
  source?: AgentSource;
} & Timestamped;

/**
 * V2 — Per-agent reasoning effort preset. Provider-agnostic dial that the
 * router maps to provider-specific knobs (see lib/ai/effort.ts). 'custom'
 * means the agent carries explicit `effort_custom` values instead.
 */
export type AgentEffort = 'minimal' | 'low' | 'medium' | 'high' | 'max' | 'custom';

export interface AgentEffortCustom {
  temperature: number;
  max_output_tokens: number;
  /** OpenAI o-class / gpt-5 only. Ignored on chat-completions models. */
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high';
  /** Anthropic / Google extended-thinking budget; 0 means off. */
  thinking_budget_tokens?: number;
}

/**
 * Persona preset for the agent's voice/tone. Built-in agents use 'jarvis';
 * user agents pick from the catalog. 'custom' means the agent's own
 * `system_prompt` body fully owns the voice (no addendum applied).
 */
export type AgentPersona = 'jarvis' | 'athena' | 'edge' | 'watson' | 'hal' | 'custom';

/**
 * Where the agent definition came from.
 *   builtin   — seeded from DEFAULT_AGENT_SEEDS in code
 *   user-md   — imported from a `.jarvis-agent.md` file
 *   user-form — created via Settings → Agents form
 */
export type AgentSource = 'builtin' | 'user-md' | 'user-form';

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
