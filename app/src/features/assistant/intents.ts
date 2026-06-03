/**
 * Jarvis Assistant — intent shapes.
 *
 * The assistant is a deterministic, local "command bar" — natural-language
 * commands are parsed into one of these intents by `parse.ts` and dispatched
 * to repositories / stores by `execute.ts`. There is no remote AI call.
 *
 * Adding a new command:
 *   1. Add a new variant to `AssistantIntent`.
 *   2. Add a regex pattern in `parse.ts` (most-specific first).
 *   3. Add a `case` branch in `execute.ts`.
 *   4. Add a preview line in `AssistantBar.previewIntent`.
 */
export type AssistantIntent =
  /** "create project tiger" */
  | { kind: 'create_project'; name: string; color_hue?: number }
  /** "switch to project tiger" */
  | { kind: 'switch_project'; name: string }
  /** "create chat called planning [in tiger]" */
  | { kind: 'create_chat'; title?: string; project?: string }
  /** "open 4 terminals with claude code in tiger" */
  | { kind: 'open_terminals'; count: number; command?: string; project?: string }
  /** "run opencode in all terminals" */
  | { kind: 'run_in_terminals'; command: string; target: 'all' }
  /** "create command dev server to run npm run dev" */
  | { kind: 'create_custom_command'; name: string; command: string; cwd?: string }
  /** "run command dev server" */
  | { kind: 'run_custom_command'; name: string }
  /** "ask opencode to fix the tests" */
  | { kind: 'ask_provider'; provider: string; prompt: string }
  /** "give all terminals all context" */
  | { kind: 'give_terminals_context' }
  /** "create context map" */
  | { kind: 'create_context_map' }
  /** "recenter context map" */
  | { kind: 'recenter_context_map' }
  /** "make a todo: ship the launcher tomorrow" */
  | { kind: 'create_task'; title: string; due_at?: number }
  /** "schedule lunch with sam friday at 1pm" — raw delegated to parseEventInput */
  | { kind: 'create_event'; raw: string }
  /** "call me at 3pm" — creates a scheduled outbound-call event */
  | { kind: 'schedule_call'; raw: string }
  /** "message me: build is done" — sends an outbound SMS through phone-jarvis */
  | { kind: 'send_phone_message'; text: string }
  /** "ambient mode on" / "ambient off" */
  | { kind: 'set_ambient'; on: boolean }
  /** "fullscreen" / "exit fullscreen". `on` undefined = toggle. */
  | { kind: 'set_fullscreen'; on?: boolean }
  /** "open settings" */
  | { kind: 'open_settings' }
  /** "open palette" */
  | { kind: 'open_palette' }
  /** "open launcher" */
  | { kind: 'open_launcher' }
  /** "open schedule" */
  | { kind: 'open_schedule' }
  /**
   * "open terminals" / "show benchmarks" / "switch to kanban" — V3 top-level
   * route navigation. `route` is one of `useUIStore`'s Route enum values
   * (defined in the Wave 4 contract; landed via the route-store slice).
   *
   * Suggested example hints to add to `AssistantBar.EXAMPLE_HINTS` once the
   * integrator wires them up:
   *   - "open terminals"
   *   - "open kanban"
   *   - "show benchmarks"
   */
  | {
      kind: 'navigate';
      route: 'chat' | 'terminal' | 'kanban' | 'schedule' | 'agents' | 'context' | 'skills' | 'benchmarks' | 'history' | 'tools' | 'files';
    }
  /** "create project tiger then open 4 terminals" */
  | { kind: 'multi_step'; steps: AssistantIntent[] }
  /** Anything that didn't match. Carries the raw text for the UI hint. */
  | { kind: 'unknown'; raw: string; suggestions?: string[] };

/** Result returned by `executeIntent`. Wraps both branches in one envelope. */
export interface AssistantResult {
  ok: boolean;
  message: string;
}
