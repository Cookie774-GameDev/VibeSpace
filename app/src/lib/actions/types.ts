/**
 * Action system — type definitions.
 *
 * An "action" is an app-level operation Jarvis (or the user via the
 * actions palette / Mod+Shift+A) can invoke: open the Terminal page,
 * start a wellness break, switch theme, queue a `claude` command in a
 * new pane, run a user-authored custom tool, etc.
 *
 * Why this exists in addition to MCP tools (`lib/mcp/`):
 *   - MCP tools are the LLM's invocation protocol — they're called
 *     directly by the model and run without a confirmation step.
 *   - Actions are an *approval-gated* layer. The AI proposes an action
 *     by emitting a fenced ```action {…}``` block in its message; the
 *     user clicks Approve to run it. This keeps the AI honest (no
 *     pretending it took an action it didn't) and gives the user the
 *     final word on anything that mutates app state.
 *
 * The contract is intentionally narrow: an action maps a stable id +
 * JSON params to a side-effecting `run()` function returning a result.
 * Anything more elaborate (multi-step flows, branching) is the AI's
 * job to compose by chaining proposals.
 */

import type { LucideIcon } from 'lucide-react';

/**
 * Top-level grouping. Drives palette section headings + AI prompt
 * addendum ordering. Add a new category when none of the existing ones
 * fit; don't fan out for every new action.
 */
export type ActionCategory =
  | 'navigation' // jump between top-level pages
  | 'settings' // open / configure settings panes
  | 'theme' // dark/light/density
  | 'voice' // voice modal, captions
  | 'terminal' // terminal pane operations
  | 'clock' // timers and alarms
  | 'chat' // new chat, fullscreen, nav toggle
  | 'wellness' // 20-20-20 break, etc.
  | 'host' // OS / app-launch (open URL, palette, launcher)
  | 'custom'; // user-authored tools registered at runtime

/**
 * Lifecycle of an action proposal in the chat thread. Mirrors
 * `ActionStatus` in `types/chat.ts`; kept in lock-step.
 */
export type ActionStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'error'
  | 'cancelled';

/** Field type for a single parameter on an action. */
export type ActionParamType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'select'
  | 'route';

/**
 * Parameter spec. The palette form renders an input per param; the AI
 * receives the param list in the system-prompt addendum so it knows
 * what to populate when proposing.
 */
export interface ActionParam {
  /** JSON key inside the proposal's `params` object. */
  key: string;
  /** Label for the form + AI documentation. */
  label: string;
  type: ActionParamType;
  /** Required defaults to false; required params block Approve until set. */
  required?: boolean;
  /** Default value used when the AI omits the field. */
  default?: unknown;
  /** For `type: 'select'` — fixed allowed values. */
  options?: { value: string; label: string }[];
  /** Hint shown beneath the input in the palette form. */
  help?: string;
  /** Placeholder text in the form input. */
  placeholder?: string;
}

/**
 * Information the runner exposes to a registered action. Most actions
 * never need it; included so a future action can know whether the user
 * or the AI invoked it (for telemetry, undo stacks, etc.).
 */
export interface ActionRunContext {
  /** Who triggered this run. */
  source: 'user' | 'ai';
  /** Chat thread id when source === 'ai'. Undefined for user-driven runs. */
  chatId?: string;
  /** Assistant message id when source === 'ai'. */
  messageId?: string;
  /** Stable proposal id — handy for surfacing per-action toasts. */
  callId?: string;
}

/** Discriminated result. Every runner must return one of these. */
export type ActionResult =
  | {
      ok: true;
      /** One-line summary stamped on the proposal + shown as a toast. */
      summary?: string;
      /** Optional structured payload, surfaced to the proposal's `result`. */
      data?: unknown;
    }
  | {
      ok: false;
      /** Human-readable error. Stamped on the proposal and toast. */
      error: string;
    };

/**
 * Full registry entry. Every action lives in `registry.ts` (built-ins)
 * or is contributed at runtime by the Custom Tools store
 * (`features/tools/toolStore.ts`).
 */
export interface ActionDef {
  /** Stable dotted id, e.g. `'terminal.claude'` or `'custom.my-tool'`. */
  id: string;
  category: ActionCategory;
  /** Short human label (palette + approval card title). */
  label: string;
  /** One-sentence description used in tooltips + AI prompt addendum. */
  description: string;
  /** Optional lucide icon name for palette + approval card. */
  icon?: LucideIcon;
  /** Ordered param spec. Empty array = no parameters. */
  params: ActionParam[];
  /**
   * Marks an action that mutates global / shared state (closing the app,
   * deleting data, etc.). The approval card shows a stronger warning;
   * the AI is told to use them sparingly. Defaults to false.
   */
  destructive?: boolean;
  /**
   * If true, AI invocations bypass the approval card and run inline.
   * Default false (every AI-proposed action requires a click). Reserved
   * for future non-destructive read-only actions; not used today.
   */
  autoApprove?: boolean;
  /**
   * Should this action be advertised to the AI in the prompt addendum?
   * Defaults to true. False is useful for actions that exist purely for
   * user-driven invocation (e.g. internal palette utilities).
   */
  exposeToAI?: boolean;
  /** Runner. Side-effecting; returns a result. */
  run: (
    params: Record<string, unknown>,
    ctx: ActionRunContext,
  ) => Promise<ActionResult>;
}

/**
 * AI-proposed action, parsed from a fenced block in assistant text.
 * Validation errors surface as `{ ok: false, ... }` on the parse step
 * rather than dropping the proposal silently — the user sees what went
 * wrong.
 */
export interface ParsedActionProposal {
  /** Stable id we generate so the proposal can be addressed later. */
  call_id: string;
  /** Action registry id the AI named. May not exist in the registry. */
  action_id: string;
  /** Raw params from the AI. */
  params: Record<string, unknown>;
  /** Optional rationale string the AI provided. */
  rationale?: string;
}
