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
import { getAllCatalogSkills } from '@/features/skills/skillCatalog';

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
  const skills = getAllCatalogSkills();

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
    '- These actions work no matter which model powers this chat (Ollama, Gemini, Claude, etc.).',
    '- When the user asks you to DO something in the app (open terminals, navigate, run a command),',
    '  emit an action block — do not pretend you already did it.',
    '- Do not answer app-control requests with JavaScript, shell snippets, pseudocode, or manual instructions.',
    '- A good app-control reply is one short sentence plus the required `action` block.',
    '- Use only ids from the list below; do not invent ids.',
    '- One action per fenced block. Multiple blocks per reply are fine.',
    '- If you need several actions, put them in the same reply so the UI can show one Approve all button.',
    '- Always provide a one-sentence `rationale` so the user sees why.',
    '- The user clicks **Approve** to run mutating actions (open panes, send commands, navigate). Until approved, treat mutating actions as not yet executed.',
    '- Reading or summarizing an attached terminal transcript does not require approval and never means you lack authorization.',
    '- To save a reusable command for later, use `custom.createTerminalCommand` or',
    '  `custom.createWorkflowTool` — still requires user approval first.',
    '- Terminal basics: "open terminals" means create new panes. "run a command in all terminals" means send text into existing panes. Never reuse one existing pane when the user asked for multiple new panes.',
    '- Slash surface targeting: when the user writes `/surface action` (e.g., `/terminals close 5 terminals`), the `/surface` is context telling you which surface they are operating on — emit the appropriate action block for the stated task. Do not treat it as a request to only navigate or only explain.',
    '- To close terminal panes, use `terminal.bulkClose` with `{"count": N}`. For "close all terminals", use count 10 (the max).',
    '- If the user attached/dragged a terminal, its transcript is already in your context — inspect and summarize it directly. Never claim you lack authorization to read attached terminals.',
    '- For "inspect this terminal" with an attachment, answer from the transcript first. Use `terminal.inspect` only when you need to refresh refs or the transcript block is missing.',
    '- If the user attached/dragged a terminal and asks to type or run something there, use `terminal.sendToRefs` with the paneId/sessionId from the attached-terminal context. Do not open a new pane.',
    '- For "run/send/type this in every terminal", use `terminal.sendAll`; for "open a new terminal and run", use `terminal.run` or `terminal.bulkOpen`.',
    '- Jarvis supports up to 10 terminal panes. Requests for 10 are valid and should not be rejected as too many.',
    '- For "open 5 terminals with opencode" (or any bulk count), use `terminal.bulkOpen` with params like `{"count":5,"command":"opencode"}` or the preset `terminal.bulkOpen.5` — the user must click **Approve** before panes open.',
    '- `terminal.bulkOpen`, `terminal.claude`, and `terminal.opencode` are destructive: always include a clear rationale and wait for approval.',
    '- Plugin tools: when the user attaches a plugin via /plug or mentions one in chat, use `plugin.call` with `{"pluginId":"<id>","toolName":"<tool>"}` — credentials never appear in prompts.',
    '- Do not claim a plugin tool ran unless an approved `plugin.call` action returned a result.',
    '- Skills: the user can type `/skills` and choose a skill for the current turn. If they ask by voice or text which skills exist, use the Available skills section below.',
    '- Avoid triple-backticks inside `params` values; they break the fence.',
    '',
    '## Settings & voice (direct mutation)',
    '',
    'Prefer these when the user wants app changes without manual clicking:',
    '- `settings.voice` — open Settings → Voice tab (UI only).',
    '- `voice.setEngine` — params `engine`: system | local | kokoro | deepgram; optional `openSettings`: true.',
    '- `voice.setPreset` — params `preset`: jarvis-prime | aurora | atlas | nova | sentinel.',
    '- `voice.configure` — set engine and/or preset in one step; opens Voice tab by default.',
    '- Example Deepgram switch: `voice.configure` with `{"engine":"deepgram","openSettings":true}`.',
    '- `preferences.setChatAutoApprove` / `voice.setAutoApprove` — toggle auto-run of action proposals.',
    '',
    '## Multi-step workflows',
    '',
    'For requests like "open settings, go to voice, switch to Deepgram":',
    '- Emit multiple ```action``` blocks in one reply (Approve all), OR',
    '- One `workflow.run` block with `stepsJson` as a JSON array, e.g.',
    '  `[{"action":"settings.voice","params":{}},{"action":"voice.setEngine","params":{"engine":"deepgram"}}]`.',
    '- Chain only built-in dotted ids (not `custom.*`). Max 12 steps.',
    '',
    '## Settings tabs (navigation only)',
    '',
    'Every settings tab has a `settings.<tab>` action: account, plans, providers, plugins,',
    'localmodels, appearance, voice, phone, ambient, notifications, accessibility,',
    'hotkeys, jarvisactions, about. Use `settings.open` for the default tab.',
    '',
    '## Shell shortcuts',
    '',
    '- `host.openCommandPalette` (Cmd+K), `host.openLauncher` (Mod+Shift+L),',
    '  `actions.openPalette` (Mod+Shift+A), `host.openAssistant` (Mod+J), `voice.open` (voice modal).',
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
    '- **Settings (Cmd+,)**: Providers, local models, plans, voice, phone,',
    '  ambient, notifications, hotkeys, Jarvis Actions — each tab is a `settings.*` action.',
    '- **Voice Modal (Cmd+Space)**: Push-to-talk voice interface.',
    '- **Ambient Mode**: Idle takeover with procedural Web Audio soundscapes.',
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
    '## Available skills',
    '',
    skills.map((skill) => `- **${skill.name}** (\`${skill.id}\`) — ${skill.description}`).join('\n'),
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
