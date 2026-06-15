import type { ContextRef, Timestamped, ChatId, MessageId, AgentId, ProjectId, WorkspaceId, ProviderId } from './common';

export type Role = 'user' | 'assistant' | 'agent' | 'system' | 'tool';

/**
 * Lifecycle of an `action_proposal` part. The AI emits a proposal in
 * `pending` state; the user clicks Approve to flip it to `running` and
 * the runner moves it to `success` / `error`. `cancelled` is used when
 * the user explicitly dismisses without running.
 */
export type ActionStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'error'
  | 'cancelled';

/**
 * A part of a message - text, tool call, action proposal, image, etc.
 */
export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | {
      kind: 'stack_step';
      step_id: string;
      label: string;
      provider: ProviderId;
      model: string;
      text: string;
      status: 'running' | 'done' | 'error';
      input_tokens?: number;
      output_tokens?: number;
      cost_usd?: number;
      duration_ms?: number;
      credits_used?: number;
    }
  | { kind: 'tool_call'; tool: string; args: Record<string, unknown>; call_id: string }
  | { kind: 'tool_result'; call_id: string; result?: unknown; error?: string }
  | {
      /**
       * AI-proposed app-level action awaiting human approval. Distinct
       * from `tool_call` (which represents an LLM tool invocation) — an
       * action_proposal is a request for the user to click Approve so
       * Jarvis can drive the app on their behalf (open terminal,
       * navigate routes, change settings, run a wellness break, etc.).
       *
       * Field reference:
       *   call_id   stable id used to mutate this proposal in place
       *             without addressing it by parts-array index
       *   action_id registry key (e.g. 'terminal.claude', 'nav.goto')
       *   params    JSON args for the runner
       *   rationale one-sentence "why" the AI offers; rendered above
       *             the Approve/Cancel buttons
       *   status    lifecycle (see `ActionStatus`)
       *   result    arbitrary success payload (for actions that return)
       *   error     human-readable error string when status === 'error'
       */
      kind: 'action_proposal';
      call_id: string;
      action_id: string;
      params: Record<string, unknown>;
      rationale?: string;
      status: ActionStatus;
      result?: unknown;
      error?: string;
    }
  | { kind: 'image'; url: string; alt?: string }
  | { kind: 'file_ref'; ref: ContextRef };

/**
 * A single message in a chat thread.
 */
export type Message = {
  id: MessageId;
  chat_id: ChatId;
  role: Role;
  agent_id?: AgentId; // when role === 'assistant' or 'agent'
  parts: Part[];
  parent_id?: MessageId; // for branching
  created_at: number;
  updated_at: number;
  /** Token usage if known */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    cost_usd?: number;
    provider?: ProviderId;
    model?: string;
  };
};

/**
 * Mode the chat is being viewed in.
 */
export type ChatMode = 'chat' | 'council' | 'doc' | 'code';

/**
 * A chat thread - either single agent (chat mode) or multi (council mode).
 */
export type Chat = {
  id: ChatId;
  workspace_id: WorkspaceId;
  project_id?: ProjectId;
  title: string;
  mode: ChatMode;
  active_agent_ids: AgentId[]; // single in chat mode, n in council
  created_at: number;
  updated_at: number;
  archived?: boolean;
};

/**
 * Streaming events emitted by the runtime to the UI.
 * Mirrors Vercel AI SDK UI message stream protocol semantics.
 */
export type StreamEvent =
  | { type: 'agent_start'; agent_id: AgentId; ts: number }
  | { type: 'token'; agent_id: AgentId; delta: string }
  | { type: 'reasoning'; agent_id: AgentId; delta: string }
  | { type: 'tool_call'; agent_id: AgentId; tool: string; args: Record<string, unknown>; call_id: string }
  | { type: 'tool_result'; call_id: string; result?: unknown; error?: string }
  | { type: 'state_update'; key: string; value: unknown }
  | { type: 'agent_done'; agent_id: AgentId; usage?: Message['usage'] }
  | { type: 'workflow_done'; usage_total?: Message['usage'] }
  | { type: 'error'; message: string };
