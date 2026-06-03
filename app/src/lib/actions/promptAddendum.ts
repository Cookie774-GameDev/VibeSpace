/**
 * System-prompt addendum builder.
 *
 * Appends a structured "Available actions" section onto Jarvis's
 * system prompt at request time so the model knows the dotted ids,
 * params, and rationale convention.
 *
 * Why a per-request overlay rather than baking the catalogue into the
 * persisted prompt: the catalogue grows. Every new built-in action and
 * every user-authored custom tool changes it. Mutating the persisted
 * row in IndexedDB on every change would create migration churn; an
 * overlay is free.
 *
 * Pattern mirrors `applyPersona` in `features/agents/personas.ts`:
 *   - Pure function, returns a derived `Agent`.
 *   - Spreads the original (`...agent`) so other fields are untouched.
 *   - Concatenates onto `system_prompt` rather than replacing it.
 *
 * Token budget: ~80 tokens per action × 24 built-ins ≈ 2k tokens. Cheap
 * for Gemini 2.5 Flash Lite (1M context) and any modern LLM, but we
 * still keep the per-action description short because it's repeated in
 * every chat turn.
 */

import type { Agent } from '@/types';
import type { ActionDef, ActionParam } from './types';
import { getBuiltinActions, CATEGORY_LABELS } from './registry';
import { useToolStore } from '@/features/tools/toolStore';

/**
 * One concise line per action for the catalogue. Keep the line under
 * ~120 chars so the AI sees a tidy bullet list rather than a wall of
 * text.
 */
function formatAction(a: ActionDef): string {
  const params = a.params.length > 0 ? ` Params: ${formatParams(a.params)}` : '';
  return `- \`${a.id}\` — ${a.description}${params}`;
}

function formatParams(params: readonly ActionParam[]): string {
  return params
    .map((p) => {
      const required = p.required ? '' : '?';
      const help = p.help ? ` (${p.help})` : '';
      return `${p.key}${required}: ${p.type}${help}`;
    })
    .join(', ');
}

/**
 * Build the addendum text. Exported so tests / debug surfaces can
 * inspect it without instantiating an agent.
 */
export function buildAddendumText(): string {
  const builtins = getBuiltinActions().filter((a) => a.exposeToAI !== false);

  let customs: ActionDef[] = [];
  try {
    customs = useToolStore.getState().toActionDefs().filter((a) => a.exposeToAI !== false);
  } catch {
    customs = [];
  }

  const all = [...builtins, ...customs];
  if (all.length === 0) return '';

  const byCategory = new Map<string, ActionDef[]>();
  for (const a of all) {
    const list = byCategory.get(a.category) ?? [];
    list.push(a);
    byCategory.set(a.category, list);
  }

  const sections: string[] = [];
  for (const [cat, items] of byCategory) {
    const heading = CATEGORY_LABELS[cat as keyof typeof CATEGORY_LABELS] ?? cat;
    sections.push(`### ${heading}\n${items.map(formatAction).join('\n')}`);
  }

  return [
    '## Available actions',
    '',
    'You can request the user to approve any of the following actions by',
    'emitting a fenced code block tagged `action` somewhere in your reply:',
    '',
    '```action',
    '{ "id": "<dotted-id>", "params": { ... }, "rationale": "<one-sentence why>" }',
    '```',
    '',
    'Rules:',
    '- Use only ids from the list below; do not invent ids.',
    '- One action per fenced block. Multiple blocks per reply are fine.',
    '- If you need several actions, put them in the same reply so the UI can show one Approve all button.',
    '- Always provide a one-sentence `rationale` so the user sees why.',
    '- The user clicks **Approve** to actually run the action; until then,',
    '  treat the action as not yet executed. Do not assume side-effects.',
    '- Terminal basics: "open terminals" means create new panes. "run a command in all terminals" means send text into existing panes. Never reuse one existing pane when the user asked for multiple new panes.',
    '- Jarvis supports up to 10 terminal panes. Requests for 10 are valid and should not be rejected as too many.',
    '- For "open 10 terminals with opencode", use new terminal panes and start `opencode` in each new pane.',
    '- Avoid triple-backticks inside `params` values; they break the fence.',
    '',
    '## App Surfaces You Control',
    '',
    'You have full agency over the Jarvis app shell. You can navigate anywhere,',
    'toggle any panel, and invoke any feature. The app is structured as:',
    '',
    '- **Left Sidebar (NavPane)**: Project picker, file browser, context maps,',
    '  chat list, agent list. Files and context nodes are draggable into chat.',
    '- **Main Canvas**: The active route (chat, terminal, kanban, context map,',
    '  schedule, agents, benchmarks, history, tools, files). This is where the',
    '  user works.',
    '- **Right Inspector (Cmd+\\)**: A 320px slide-over panel with 6 tabs —',
    '  Jarvis chat, Today (schedule+tasks+links), Context, Tools, Trace, Refs. ',
    '  Route-aware: shows active terminal sessions on the terminal page,',
    '  kanban updates on the kanban page, etc.',
    '- **Command Palette (Cmd+K)**: Full global search with nested pages.',
    '- **Settings (Cmd+,)**: Providers, local models, plans, hotkeys, phone,',
    '  ambient, notifications.',
    '- **Voice Modal (Cmd+Space)**: Push-to-talk voice interface.',
    '- **Ambient Mode**: Idle takeover with procedural Web Audio soundscapes.',
    '- **Wellness Break**: 20-20-20 eye break overlay.',
    '- **To-Do Drawer (Cmd+Shift+T)**: Live task panel with reminders.',
    '- **Quick Launcher (Cmd+Shift+L)**: Pinned apps and links.',
    '- **Actions Palette (Cmd+Shift+A)**: Built-in and custom tool runner.',
    '',
    'When a user says something like "open terminals" or "show me the kanban",',
    'you should use the appropriate `nav.*` action to navigate. When they say',
    '"fullscreen" or "make the chat big", use `chat.fullscreen`. When they',
    'ask "what\'s scheduled today?", navigate to the schedule route so they can',
    'see it, or check the Inspector\'s Today tab.',
    '',
    sections.join('\n\n'),
    '',
  ].join('\n');
}

/**
 * Pure overlay — return a derived `Agent` whose `system_prompt` has the
 * actions catalogue appended. Original `Agent` is unchanged.
 *
 * `agent.system_prompt` is coerced to `''` when undefined so the
 * derived prompt never contains a literal `"undefined"` substring (the
 * failure mode the AI-router audit flagged on agents whose row is
 * missing the column).
 */
export function applyAvailableActions(agent: Agent): Agent {
  const addendum = buildAddendumText();
  if (!addendum) return agent;
  return {
    ...agent,
    system_prompt: (agent.system_prompt ?? '') + '\n\n' + addendum,
  };
}
