/**
 * Database types for Jarvis on Supabase.
 *
 * Mirrors `supabase/migrations/00*.sql`. Regenerate via the Supabase MCP
 * `generate_typescript_types` tool when the schema changes, then port the
 * convenience aliases below.
 *
 * PostgREST serialisation notes:
 *   - `numeric` is returned as a string
 *   - `timestamptz` is returned as an ISO string
 *   - `jsonb` columns are typed as `Json` (the recursive JSON value type)
 */

import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

/**
 * Tier values that may appear in `profiles.tier`.
 *
 * The frontend's canonical 4-tier model lives in `lib/entitlements.ts` as
 * `PlanId` (`free | starter | pro | ultra`). `'plus'` and `'byok-only'`
 * are kept as legacy values so older rows and the existing
 * `HostedJarvis.tsx` toggle still type-check; the DB check constraint
 * permits all of them.
 */
export type Tier = 'free' | 'starter' | 'pro' | 'ultra' | 'plus' | 'byok-only';
export type UsageStatus = 'ok' | 'rate_limit' | 'error';
export type SubscriptionPlan = 'free' | 'starter' | 'pro' | 'ultra';
export type ChatMode = 'chat' | 'council' | 'doc' | 'code';
export type MessageRole = 'user' | 'assistant' | 'agent' | 'system' | 'tool';
export type TaskStatus =
  | 'open'
  | 'in_progress'
  | 'blocked'
  | 'done'
  | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type EnergyLevel = 'low' | 'medium' | 'high';
export type ReminderStatus =
  | 'scheduled'
  | 'fired'
  | 'snoozed'
  | 'dismissed'
  | 'completed';
export type MemoryScope = 'agent' | 'project' | 'workspace' | 'global';
export type IntegrationKind =
  | 'supabase'
  | 'github'
  | 'google'
  | 'opencode'
  | 'ollama';
export type CallTransport = 'twilio' | 'livekit';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export type Profile = {
  id: string;
  display_name: string | null;
  email: string | null;
  tier: Tier;
  monthly_quota: number;
  stripe_customer_id: string | null;
  persona_preset: string;
  default_provider: string;
  telemetry_opt_in: boolean;
  offline_mode: boolean;
  default_local_model: string;
  created_at: string;
  updated_at: string;
};

export type ApiKey = {
  id: string;
  user_id: string;
  provider: string;
  label: string | null;
  encrypted: string;
  last_used_at: string | null;
  created_at: string;
};

export type UsageLog = {
  id: string;
  user_id: string;
  ts: string;
  provider: string;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  /** numeric(12, 6) - PostgREST returns it as a string. */
  cost_usd: string | null;
  status: UsageStatus;
  latency_ms: number | null;
};

export type UsageMonthRow = {
  user_id: string;
  ok_count: number;
  /** ISO timestamp at the start of the month. */
  month: string;
};

export type Subscription = {
  id: string;
  user_id: string;
  stripe_customer_id: string | null;
  status: string;
  plan: SubscriptionPlan;
  price_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  trial_end: string | null;
  metadata: Json;
  created_at: string;
  updated_at: string;
};

export type StripeEvent = {
  id: string;
  type: string;
  payload: Json;
  processed_at: string | null;
  error: string | null;
  created_at: string;
};

export type ModelCatalogEntry = {
  id: string;
  provider: string;
  display_name: string;
  family: string | null;
  context_window: number | null;
  max_output_tokens: number | null;
  /** numeric returned as string */
  input_price_per_million: string | null;
  /** numeric returned as string */
  output_price_per_million: string | null;
  capabilities: string[];
  supports_streaming: boolean;
  supports_tools: boolean;
  supports_vision: boolean;
  supports_reasoning: boolean;
  available_in_tiers: string[];
  byok_supported: boolean;
  enabled: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type Workspace = {
  id: string;
  user_id: string;
  name: string;
  metadata: Json;
  created_at: string;
  updated_at: string;
};

export type Project = {
  id: string;
  user_id: string;
  workspace_id: string | null;
  name: string;
  description: string | null;
  metadata: Json;
  created_at: string;
  updated_at: string;
};

export type AgentRow = {
  id: string;
  user_id: string;
  slug: string;
  name: string;
  description: string | null;
  system_prompt: string | null;
  /** Serialised ModelSpec (see types/agent.ts). */
  model: Json;
  /** Serialised ToolAllowlist. */
  tools_allowed: Json;
  memory_scope: 'agent' | 'project' | 'workspace' | null;
  temperature: number | null;
  max_output_tokens: number | null;
  color_hue: number | null;
  capabilities: Json;
  builtin: boolean;
  effort: string | null;
  effort_custom: Json | null;
  persona: string | null;
  skills: Json | null;
  source: string | null;
  created_at: string;
  updated_at: string;
};

export type ChatRow = {
  id: string;
  user_id: string;
  workspace_id: string | null;
  project_id: string | null;
  title: string;
  mode: ChatMode;
  active_agent_ids: string[];
  archived: boolean;
  metadata: Json;
  created_at: string;
  updated_at: string;
};

export type MessageRow = {
  id: string;
  user_id: string;
  chat_id: string;
  role: MessageRole;
  agent_id: string | null;
  /** Serialised Part[] (see types/chat.ts). */
  parts: Json;
  parent_id: string | null;
  /** Serialised usage telemetry, may be null. */
  usage: Json | null;
  created_at: string;
  updated_at: string;
};

export type TaskRow = {
  id: string;
  user_id: string;
  workspace_id: string | null;
  project_id: string | null;
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_at: string | null;
  scheduled_for: string | null;
  estimated_duration_min: number | null;
  effort: number | null;
  context_tags: string[];
  location: string | null;
  energy_required: EnergyLevel | null;
  blocked_by_task_ids: string[];
  created_by: string | null;
  source_refs: Json;
  agent_owner: string | null;
  external_ids: Json | null;
  done_at: string | null;
  completion_evidence: Json | null;
  created_at: string;
  updated_at: string;
};

export type ReminderRow = {
  id: string;
  user_id: string;
  task_id: string;
  fires_at: string;
  channels: string[];
  message_override: string | null;
  status: ReminderStatus;
  snooze_history: Json;
  smart_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type MemoryRow = {
  id: string;
  user_id: string;
  workspace_id: string | null;
  project_id: string | null;
  agent_id: string | null;
  scope: MemoryScope;
  content: string;
  metadata: Json;
  embedding: string | null;
  created_at: string;
  updated_at: string;
};

export type EventRow = {
  id: string;
  user_id: string;
  workspace_id: string | null;
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  location: string | null;
  metadata: Json;
  created_at: string;
  updated_at: string;
};

export type IntegrationRow = {
  id: string;
  user_id: string;
  kind: IntegrationKind;
  label: string | null;
  config: Json;
  encrypted_secret: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type QuickLinkRow = {
  id: string;
  user_id: string;
  group_id: string | null;
  label: string;
  url: string;
  icon: string | null;
  position: number;
  created_at: string;
  updated_at: string;
};

export type TerminalSessionRow = {
  id: string;
  user_id: string;
  preset_id: string | null;
  title: string | null;
  cwd: string | null;
  command: string | null;
  status: string;
  metadata: Json;
  created_at: string;
  updated_at: string;
};

export type PhoneSettings = {
  user_id: string;
  user_phone_number: string | null;
  twilio_phone_number: string | null;
  persona: string;
  pin_length: number;
  pin_salt: string | null;
  pin_hash: string | null;
  caller_allowlist: string[];
  byok_provider_keys: Json;
  outbound_triggers: Json;
  unlock_phrase: string;
  cost_cap_per_call: number;
  cost_cap_per_month: number;
  created_at: string;
  updated_at: string;
};

export type OutboundPending = {
  call_sid: string;
  user_id: string;
  reason: string;
  context: Json;
  created_at: string;
};

export type CallAudit = {
  call_id: string;
  user_id: string;
  transport: CallTransport;
  caller_number: string | null;
  persona: string;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  duration_ms: number;
  turn_count: number;
  tool_call_count: number;
  pin_attempts: number;
  pin_passed: boolean;
  cost_estimate_usd: number;
};

// ---------------------------------------------------------------------------
// Database type for `SupabaseClient<Database>`
// ---------------------------------------------------------------------------

/**
 * Helper: standard CRUD shape for a table where `Required` lists the
 * columns that don't have defaults. Everything else becomes optional on
 * Insert; everything is optional on Update.
 */
type Crud<Row, Required extends keyof Row> = {
  Row: Row;
  Insert: Pick<Row, Required> & Partial<Omit<Row, Required>>;
  Update: Partial<Row>;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      profiles: Crud<Profile, 'id'>;
      api_keys: Crud<ApiKey, 'user_id' | 'provider' | 'encrypted'>;
      usage_log: Crud<UsageLog, 'user_id' | 'provider' | 'model' | 'status'>;
      subscriptions: Crud<
        Subscription,
        'id' | 'user_id' | 'plan' | 'status'
      >;
      stripe_events: Crud<StripeEvent, 'id' | 'type' | 'payload'>;
      models_catalog: Crud<
        ModelCatalogEntry,
        'id' | 'provider' | 'display_name'
      >;
      workspaces: Crud<Workspace, 'id' | 'user_id' | 'name'>;
      projects: Crud<Project, 'id' | 'user_id' | 'name'>;
      agents: Crud<
        AgentRow,
        'id' | 'user_id' | 'slug' | 'name' | 'model'
      >;
      chats: Crud<ChatRow, 'id' | 'user_id' | 'title'>;
      messages: Crud<
        MessageRow,
        'id' | 'user_id' | 'chat_id' | 'role'
      >;
      tasks: Crud<TaskRow, 'id' | 'user_id' | 'title'>;
      reminders: Crud<
        ReminderRow,
        'id' | 'user_id' | 'task_id' | 'fires_at'
      >;
      memories: Crud<MemoryRow, 'id' | 'user_id' | 'content'>;
      events: Crud<
        EventRow,
        'id' | 'user_id' | 'title' | 'starts_at'
      >;
      integrations: Crud<
        IntegrationRow,
        'id' | 'user_id' | 'kind'
      >;
      quick_links: Crud<
        QuickLinkRow,
        'id' | 'user_id' | 'label' | 'url'
      >;
      terminal_sessions: Crud<TerminalSessionRow, 'id' | 'user_id'>;
      phone_settings: Crud<PhoneSettings, 'user_id'>;
      outbound_pending: Crud<
        OutboundPending,
        'call_sid' | 'user_id' | 'reason'
      >;
      call_audit: Crud<
        CallAudit,
        'call_id' | 'user_id' | 'transport' | 'started_at'
      >;
    };
    Views: {
      usage_month: { Row: UsageMonthRow; Relationships: [] };
    };
    Functions: {
      set_phone_pin: {
        Args: { p_user_id: string; p_pin: string };
        Returns: void;
      };
      prune_outbound_pending: { Args: Record<string, never>; Returns: number };
      prune_call_audit: { Args: { p_days?: number }; Returns: number };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

/** Re-export to keep call sites tidy. */
export type SupabaseClient = SupabaseClientGeneric<Database>;
export type { SupabaseClientGeneric };
