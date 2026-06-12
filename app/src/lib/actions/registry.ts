/**
 * Built-in action registry.
 *
 * Every entry here is a *real* action that mutates app state when run —
 * no placeholders. The runner (`runner.ts`) uses these definitions plus
 * any user-authored tools (`features/tools/toolStore.ts`) when looking
 * up an action id at invocation time.
 *
 * Adding a new action:
 *   1. Pick the most appropriate category from `ActionCategory`.
 *   2. Use a dotted id with the category as the prefix (e.g.
 *      `terminal.run`, `nav.chat`, `wellness.eyeBreak`).
 *   3. Define `params` carefully — the AI reads them from the prompt
 *      addendum (`promptAddendum.ts`) so the names and `help` text
 *      double as developer documentation.
 *   4. Keep `run()` side-effects predictable. Resolve every async
 *      operation before returning so the approval card flips from
 *      'running' to 'success' / 'error' atomically.
 */

import {
  type LucideIcon,
  MessageSquare,
  Terminal as TerminalIcon,
  KanbanSquare,
  Sparkles,
  BarChart3,
  History as HistoryIcon,
  Wrench,
  Cog,
  KeyRound,
  CreditCard,
  Sun,
  Moon,
  RotateCw,
  Mic,
  Layers,
  PlayCircle,
  Trash2,
  Eye,
  EyeOff,
  ExternalLink,
  Rocket,
  Maximize2,
  Bot,
  PlusCircle,
  Clock,
  AlarmClock,
  Plug,
} from 'lucide-react';

import { useUIStore, type Route } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import {
  enqueueTerminalCommand,
  requestTerminalSwarm,
} from '@/features/terminals/terminalCommandQueue';
import type { TerminalRef } from '@/features/terminals/terminalRefs';
import { taskRepo } from '@/lib/db/repositories';
import { openExternal } from '@/lib/tauri';
import {
  CLOCK_SOUNDS,
  formatClockRemaining,
  parseAlarmTime,
  useClockStore,
  type ClockSound,
} from '@/features/clock/clockStore';
import type { ActionDef, ActionResult } from './types';
import type { CustomToolStep } from '@/features/tools/toolStore';
import { getExplicitTerminalBlock } from '@/lib/ai/context';
import { PRESET_ACTIONS } from './registryPresets';

/* --------------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------------*/

/**
 * Defer a window event until after React commits the next render.
 * Use this whenever an action both opens a modal AND wants to drive its
 * inner state (e.g. open Settings then jump to a specific tab) — the
 * modal's effect-based listener has to attach before the event fires.
 */
function dispatchAfterCommit(name: string, detail?: unknown): void {
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }, 0);
}

/**
 * Switch the workspace canvas to the given route. Used by every
 * `nav.*` and any terminal-flavored action that needs the Terminals
 * page mounted before draining the command queue.
 */
function navigateTo(route: Route): void {
  useUIStore.getState().setRoute(route);
}

/** ok-shaped success helper. */
const ok = (summary: string, data?: unknown): ActionResult => ({
  ok: true,
  summary,
  data,
});

/** Error-shaped helper, also used when validation rejects a param. */
const fail = (error: string): ActionResult => ({ ok: false, error });

/**
 * Reject `cwd` / shell-context strings that contain characters which
 * would break out of the quoted segment in a shell command. We only
 * use these values for `cd "<value>"; <cmd>` interpolation; characters
 * that close the double quote (`"`) or chain another command (`;`,
 * `|`, `&`, `\n`, `\r`, backtick) get the action rejected before it
 * lands in the queue.
 *
 * We intentionally allow forward and back slashes, spaces, parens,
 * dots, hyphens, underscores, colons, plus the full range of
 * non-control unicode so legitimate Windows / macOS / Linux paths
 * (including ones with non-ASCII names) pass through untouched.
 */
function rejectShellMetaChars(value: string): string | null {
  // `\u0000-\u001F` covers null + control codes (CR, LF, etc.).
  // `"`, `\``, `;`, `|`, `&`, `$` close or chain the surrounding shell
  // context.
  if (/["`;|&$\u0000-\u001F]/.test(value)) {
    return 'Path contains shell metacharacters that could break the command. Remove `"` `;` `|` `&` `$` `` ` `` or control chars.';
  }
  return null;
}

function readClockSound(value: unknown): ClockSound {
  return typeof value === 'string' && CLOCK_SOUNDS.includes(value as ClockSound)
    ? (value as ClockSound)
    : 'chime';
}

function formatDurationMs(durationMs: number): string {
  const now = Date.now();
  return formatClockRemaining(now + durationMs, now);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseTerminalRefObject(raw: unknown): TerminalRef | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const paneId = readOptionalString(source.paneId);
  const sessionId = readOptionalString(source.sessionId);
  if (!paneId && !sessionId) return null;
  return {
    paneId,
    sessionId,
    projectId: readOptionalString(source.projectId) ?? null,
    label: readOptionalString(source.label),
    command: readOptionalString(source.command),
    agentSlug: readOptionalString(source.agentSlug) ?? null,
  };
}

function parseTerminalRefString(raw: string): TerminalRef | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith('terminal:')) return { sessionId: value.slice('terminal:'.length).trim() };
  if (!value.startsWith('{')) return { sessionId: value };
  try {
    return parseTerminalRefObject(JSON.parse(value));
  } catch {
    return null;
  }
}

function readTerminalRefs(
  params: Record<string, unknown>,
): { ok: true; refs: TerminalRef[] } | { ok: false; error: string } {
  const refs: TerminalRef[] = [];
  const refsJson = readOptionalString(params.refsJson);
  if (refsJson) {
    try {
      const parsed = JSON.parse(refsJson);
      const rawRefs = Array.isArray(parsed) ? parsed : [parsed];
      for (const rawRef of rawRefs) {
        const ref =
          typeof rawRef === 'string'
            ? parseTerminalRefString(rawRef)
            : parseTerminalRefObject(rawRef);
        if (ref) refs.push(ref);
      }
    } catch {
      return {
        ok: false,
        error: 'refsJson must be a terminal ref object or array encoded as JSON.',
      };
    }
  }

  const paneId = readOptionalString(params.paneId);
  const sessionId = readOptionalString(params.sessionId);
  if (paneId || sessionId) {
    refs.push({
      paneId,
      sessionId,
      projectId: readOptionalString(params.projectId) ?? null,
      label: readOptionalString(params.label),
      agentSlug: readOptionalString(params.agentSlug) ?? null,
    });
  }

  const seen = new Set<string>();
  const unique = refs.filter((ref) => {
    const key = ref.paneId || ref.sessionId;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) {
    return {
      ok: false,
      error: 'Provide at least one terminal paneId, sessionId, or refsJson value.',
    };
  }
  return { ok: true, refs: unique.slice(0, 8) };
}

/* --------------------------------------------------------------------------
 * Action defs
 * --------------------------------------------------------------------------*/

/**
 * Navigation actions. One per top-level route, all delegating to
 * `useUIStore.setRoute`. The boring uniformity is on purpose — Jarvis
 * needs every page reachable as an action so the prompt addendum can
 * advertise them all without per-route exceptions.
 */
const NAVIGATION_ACTIONS: ActionDef[] = (
  [
    ['nav.chat', 'Open Chat', 'chat', MessageSquare],
    ['nav.terminal', 'Open Terminals', 'terminal', TerminalIcon],
    ['nav.kanban', 'Open Kanban', 'kanban', KanbanSquare],
    ['nav.context', 'Open Context', 'context', Sparkles],
    ['nav.skills', 'Open Skills', 'skills', Sparkles],
    ['nav.benchmarks', 'Open Benchmarks', 'benchmarks', BarChart3],
    ['nav.history', 'Open History', 'history', HistoryIcon],
    ['nav.tools', 'Open Custom Tools', 'tools', Wrench],
  ] as const
).map<ActionDef>(([id, label, route, icon]) => ({
  id,
  category: 'navigation',
  label,
  description: `Switch the workspace canvas to the ${route} page.`,
  icon: icon as LucideIcon,
  params: [],
  run: async () => {
    navigateTo(route as Route);
    return ok(`Opened ${label.replace('Open ', '')}.`);
  },
}));

/**
 * Settings actions. Every entry opens the modal first; tab-targeted
 * variants then dispatch `jarvis:settings:tab` after the next commit
 * (the listener gates on `[open]` per `SettingsModal.tsx:86-94`).
 */
const SETTINGS_ACTIONS: ActionDef[] = [
  {
    id: 'settings.open',
    category: 'settings',
    label: 'Open Settings',
    description: 'Open the Settings modal at its default tab.',
    icon: Cog,
    params: [],
    run: async () => {
      useUIStore.getState().setSettingsOpen(true);
      return ok('Opened Settings.');
    },
  },
  {
    id: 'settings.providers',
    category: 'settings',
    label: 'Open Settings → Providers',
    description: 'Open Settings on the Providers tab so the user can paste API keys.',
    icon: KeyRound,
    params: [],
    run: async () => {
      useUIStore.getState().setSettingsOpen(true);
      dispatchAfterCommit('jarvis:settings:tab', { tab: 'providers' });
      return ok('Opened Providers.');
    },
  },
  {
    id: 'settings.plans',
    category: 'settings',
    label: 'Open Settings → Plans',
    description: 'Open Settings on the Plans tab (Free vs Pro $5).',
    icon: CreditCard,
    params: [],
    run: async () => {
      useUIStore.getState().setSettingsOpen(true);
      dispatchAfterCommit('jarvis:settings:tab', { tab: 'plans' });
      return ok('Opened Plans.');
    },
  },
];

/**
 * Theme actions. `setTheme` flips `data-theme` on `documentElement`
 * synchronously (see `stores/ui.ts:199-202`), so no follow-up is
 * needed.
 */
const THEME_ACTIONS: ActionDef[] = [
  {
    id: 'theme.jarvis',
    category: 'theme',
    label: 'Switch to Jarvis Core theme',
    description: 'Set the workspace to the black and orange command-center palette.',
    icon: Sparkles,
    params: [],
    run: async () => {
      useUIStore.getState().setTheme('jarvis');
      return ok('Theme: Jarvis Core.');
    },
  },
  {
    id: 'theme.dark',
    category: 'theme',
    label: 'Switch to Dark theme',
    description: 'Set the workspace to the warm wood (dark) palette.',
    icon: Moon,
    params: [],
    run: async () => {
      useUIStore.getState().setTheme('dark');
      return ok('Theme: Dark.');
    },
  },
  {
    id: 'theme.light',
    category: 'theme',
    label: 'Switch to Light theme',
    description: 'Set the workspace to the cream paper (light) palette.',
    icon: Sun,
    params: [],
    run: async () => {
      useUIStore.getState().setTheme('light');
      return ok('Theme: Light.');
    },
  },
  {
    id: 'theme.toggle',
    category: 'theme',
    label: 'Toggle theme',
    description: 'Flip between Dark and Light.',
    icon: RotateCw,
    params: [],
    run: async () => {
      const cur = useUIStore.getState().theme;
      const next = cur === 'dark' ? 'light' : 'dark';
      useUIStore.getState().setTheme(next);
      return ok(`Theme: ${next === 'dark' ? 'Dark' : 'Light'}.`);
    },
  },
];

/**
 * Voice action — opens the voice modal. The modal handles its own
 * lifecycle (mic permission, captions, end-of-utterance detection); we
 * just toggle the visibility flag.
 */
const VOICE_ACTIONS: ActionDef[] = [
  {
    id: 'voice.open',
    category: 'voice',
    label: 'Start a voice conversation',
    description: 'Open the in-app voice modal (push-to-talk).',
    icon: Mic,
    params: [],
    run: async () => {
      useUIStore.getState().setVoiceModalOpen(true);
      return ok('Opened the voice modal.');
    },
  },
];

/**
 * Terminal actions. Every command-launching action queues into the
 * terminal command queue (`terminalCommandQueue.ts`) and *then* sets
 * the route — TerminalsPage drains the queue on mount, so the order
 * (queue → navigate) guarantees nothing is dropped on a cold route.
 */
const TERMINAL_ACTIONS: ActionDef[] = [
  {
    id: 'terminal.open',
    category: 'terminal',
    label: 'Open Terminals',
    description: 'Switch the canvas to the Terminals page.',
    icon: TerminalIcon,
    params: [],
    run: async () => {
      navigateTo('terminal');
      return ok('Opened Terminals.');
    },
  },
  {
    id: 'terminal.inspect',
    category: 'terminal',
    label: 'Inspect terminal transcript',
    description:
      'Read the latest captured output from attached or referenced terminal pane(s). Use when the user asks to inspect a dragged terminal.',
    icon: Eye,
    params: [
      {
        key: 'paneId',
        label: 'Pane id',
        type: 'string',
        help: 'Pane id from the attached-terminal context.',
      },
      {
        key: 'sessionId',
        label: 'Session id',
        type: 'string',
        help: 'PTY session id from the attached-terminal context.',
      },
      {
        key: 'refsJson',
        label: 'Refs JSON',
        type: 'string',
        help: 'Optional JSON object or array of terminal refs.',
      },
    ],
    run: async (params) => {
      const parsedRefs = readTerminalRefs(params);
      if (!parsedRefs.ok) return fail(parsedRefs.error);
      const block = getExplicitTerminalBlock(parsedRefs.refs);
      if (!block.trim()) {
        return fail(
          'No terminal transcript captured yet. Ask the user to reopen the pane or wait for output.',
        );
      }
      return ok('Terminal transcript captured.', block);
    },
  },
  {
    id: 'terminal.bulkOpen',
    category: 'terminal',
    label: 'Open multiple terminal panes',
    description:
      'Open 1-10 new terminal panes. Optionally start the same command, such as opencode, in each new pane.',
    icon: Layers,
    destructive: true,
    params: [
      {
        key: 'count',
        label: 'Pane count',
        type: 'number',
        required: true,
        default: 1,
        help: 'How many new panes to open. Max 10.',
      },
      {
        key: 'command',
        label: 'Startup command',
        type: 'string',
        required: false,
        placeholder: 'opencode',
        help: 'Optional command typed into every new pane after the shell starts.',
      },
      {
        key: 'cwd',
        label: 'Working directory',
        type: 'string',
        required: false,
        help: 'Optional project folder for every pane. Omit to use the active chat project when known.',
      },
    ],
    run: async (params) => {
      const rawCount = typeof params.count === 'number' ? params.count : 1;
      const count = Math.min(10, Math.max(1, Math.floor(rawCount)));
      const command = typeof params.command === 'string' ? params.command.trim() : '';
      const cwd = typeof params.cwd === 'string' ? params.cwd.trim() : undefined;
      if (cwd) {
        const meta = rejectShellMetaChars(cwd);
        if (meta) return fail(meta);
      }
      for (let i = 0; i < count; i++) {
        enqueueTerminalCommand({
          command,
          label: command ? `${command} ${i + 1}` : `terminal ${i + 1}`,
          cwd,
        });
      }
      navigateTo('terminal');
      return ok(
        `Opening ${count} terminal pane${count === 1 ? '' : 's'}${command ? ` with ${command}` : ''}.`,
      );
    },
  },
  {
    id: 'terminal.swarm',
    category: 'terminal',
    label: 'Open Terminal swarm preset',
    description:
      'Open Terminals and lay out the 4-pane Builder / Scout / Reviewer / Jarvis swarm preset.',
    icon: Layers,
    params: [],
    run: async () => {
      // Queue first so the page picks the swarm up on its next drain
      // cycle, regardless of whether the route component is already
      // mounted or still loading its lazy chunk. Then navigate.
      requestTerminalSwarm();
      navigateTo('terminal');
      return ok('Opening swarm: Builder, Scout, Reviewer, Jarvis.');
    },
  },
  {
    id: 'terminal.claude',
    category: 'terminal',
    label: 'Run Claude Code in a new pane',
    description:
      'Open Terminals and start Claude Code (`claude`) in a new pane. Optionally `cd` into a project folder first.',
    icon: PlayCircle,
    destructive: true,
    params: [
      {
        key: 'cwd',
        label: 'Working directory',
        type: 'string',
        required: false,
        placeholder: 'C:\\Users\\you\\projects\\my-app',
        help: 'Optional. The pane will `cd` here before starting Claude.',
      },
    ],
    run: async (params) => {
      const cwd = typeof params.cwd === 'string' ? params.cwd : undefined;
      if (cwd) {
        const meta = rejectShellMetaChars(cwd);
        if (meta) return fail(meta);
      }
      enqueueTerminalCommand({ command: 'claude', label: 'claude', cwd });
      navigateTo('terminal');
      return ok(`Queued Claude Code${cwd ? ` in ${cwd}` : ''}.`);
    },
  },
  {
    id: 'terminal.opencode',
    category: 'terminal',
    label: 'Run OpenCode in a new pane',
    description:
      'Open Terminals and start OpenCode (`opencode`) in a new pane. Optionally `cd` into a project folder first.',
    icon: PlayCircle,
    destructive: true,
    params: [
      {
        key: 'cwd',
        label: 'Working directory',
        type: 'string',
        required: false,
        placeholder: 'C:\\Users\\you\\projects\\my-app',
        help: 'Optional. The pane will `cd` here before starting OpenCode.',
      },
    ],
    run: async (params) => {
      const cwd = typeof params.cwd === 'string' ? params.cwd : undefined;
      if (cwd) {
        const meta = rejectShellMetaChars(cwd);
        if (meta) return fail(meta);
      }
      enqueueTerminalCommand({ command: 'opencode', label: 'opencode', cwd });
      navigateTo('terminal');
      return ok(`Queued OpenCode${cwd ? ` in ${cwd}` : ''}.`);
    },
  },
  {
    id: 'terminal.run',
    category: 'terminal',
    label: 'Run a command in a new pane',
    description: 'Open Terminals and run an arbitrary shell command in a new pane.',
    icon: PlayCircle,
    destructive: true,
    params: [
      {
        key: 'command',
        label: 'Command',
        type: 'string',
        required: true,
        placeholder: 'npm run jarvis',
        help: 'Shell command to execute when the pane mounts.',
      },
      {
        key: 'label',
        label: 'Pane label',
        type: 'string',
        required: false,
        placeholder: 'dev server',
        help: 'Optional friendly label shown on the pane chrome.',
      },
      {
        key: 'cwd',
        label: 'Working directory',
        type: 'string',
        required: false,
        placeholder: 'C:\\Users\\you\\projects\\my-app',
        help: 'Optional. The pane will `cd` here before running.',
      },
    ],
    run: async (params) => {
      const command = typeof params.command === 'string' ? params.command.trim() : '';
      if (!command) return fail('Missing required parameter: command.');
      // The command itself is a free-form shell string by design (the
      // user explicitly approved it). The `cwd` value, however, is
      // interpolated *unquoted* between double quotes — `cd "<cwd>"` —
      // so we must reject anything that could close the quote and
      // chain a separate command.
      const label =
        typeof params.label === 'string' && params.label.trim() ? params.label.trim() : undefined;
      const cwd = typeof params.cwd === 'string' ? params.cwd : undefined;
      if (cwd) {
        const meta = rejectShellMetaChars(cwd);
        if (meta) return fail(meta);
      }
      enqueueTerminalCommand({ command, label, cwd });
      navigateTo('terminal');
      return ok(`Queued: ${command}`);
    },
  },
  {
    id: 'terminal.sendToRefs',
    category: 'terminal',
    label: 'Send command to attached terminal',
    description:
      'Send text or a command into existing terminal pane(s) using paneId/sessionId refs from an attached or dragged terminal.',
    icon: PlayCircle,
    destructive: true,
    params: [
      {
        key: 'command',
        label: 'Command text',
        type: 'string',
        required: true,
        placeholder: 'opencode',
        help: 'Text to type into the target terminal. A trailing Enter is added automatically.',
      },
      {
        key: 'paneId',
        label: 'Pane id',
        type: 'string',
        help: 'Optional pane id copied from the attached-terminal context.',
      },
      {
        key: 'sessionId',
        label: 'Session id',
        type: 'string',
        help: 'Optional PTY session id copied from the attached-terminal context.',
      },
      {
        key: 'refsJson',
        label: 'Refs JSON',
        type: 'string',
        help: 'Optional JSON object or array of terminal refs when targeting multiple attached terminals.',
      },
    ],
    run: async (params) => {
      const command = typeof params.command === 'string' ? params.command.trim() : '';
      if (!command) return fail('Command is required.');
      const parsedRefs = readTerminalRefs(params);
      if (!parsedRefs.ok) return fail(parsedRefs.error);
      enqueueTerminalCommand({
        command,
        label: `send: ${command.slice(0, 48)}`,
        target: 'refs',
        refs: parsedRefs.refs,
      });
      navigateTo('terminal');
      return ok(
        `Sent '${command}' to ${parsedRefs.refs.length} terminal${parsedRefs.refs.length === 1 ? '' : 's'}.`,
      );
    },
  },
  {
    id: 'terminal.sendAll',
    category: 'terminal',
    label: 'Send command to all terminals',
    description:
      'Send text or a command into every existing terminal pane without creating new panes.',
    icon: PlayCircle,
    destructive: true,
    params: [
      {
        key: 'command',
        label: 'Command text',
        type: 'string',
        required: true,
        placeholder: 'npm test',
        help: 'Text to type into all existing terminal panes. A trailing Enter is added automatically.',
      },
    ],
    run: async (params) => {
      const command = typeof params.command === 'string' ? params.command.trim() : '';
      if (!command) return fail('Command is required.');
      enqueueTerminalCommand({
        command,
        label: `all: ${command.slice(0, 48)}`,
        target: 'all',
      });
      navigateTo('terminal');
      return ok(`Sent '${command}' to all terminal panes.`);
    },
  },
];

/**
 * Chat-canvas actions. `chat.fullscreen` is the most-used composer
 * gesture; surfacing it as an action lets the AI propose distraction-
 * free mode for long writing tasks.
 */
const CHAT_ACTIONS: ActionDef[] = [
  {
    id: 'chat.fullscreen',
    category: 'chat',
    label: 'Toggle chat fullscreen',
    description:
      'Hide the nav pane + tasks rail to focus the chat canvas. Toggles back when invoked again.',
    icon: Maximize2,
    params: [],
    run: async () => {
      useUIStore.getState().toggleChatFullscreen();
      const now = useUIStore.getState().chatFullscreen;
      return ok(`Chat fullscreen: ${now ? 'on' : 'off'}.`);
    },
  },
];

/**
 * Wellness actions. The 20-20-20 eye break is the seed entry; future
 * wellness modalities (stretch, breath, hydration) plug in via the
 * `WellnessKind` union in `stores/ui.ts`.
 */
const WELLNESS_ACTIONS: ActionDef[] = [
  {
    id: 'wellness.eyeBreak',
    category: 'wellness',
    label: 'Start a 20-20-20 eye break',
    description:
      'Show a calm full-screen overlay for 20 seconds reminding the user to look 20 feet away. Reduces digital eye strain.',
    icon: Eye,
    params: [
      {
        key: 'durationSec',
        label: 'Duration (seconds)',
        type: 'number',
        required: false,
        default: 20,
        help: 'Defaults to 20 seconds (the 20-20-20 rule).',
      },
    ],
    run: async (params) => {
      const raw = params.durationSec;
      const sec = typeof raw === 'number' && raw > 0 && raw <= 600 ? raw : 20;
      useUIStore.getState().startWellness('eye-break-20-20-20', sec * 1000);
      return ok(`Eye break for ${sec}s.`);
    },
  },
  {
    id: 'wellness.endBreak',
    category: 'wellness',
    label: 'End the wellness break',
    description: 'Dismiss the active wellness break overlay if one is showing.',
    icon: EyeOff,
    params: [],
    run: async () => {
      useUIStore.getState().endWellness();
      return ok('Break ended.');
    },
  },
];

/**
 * Host actions — operations that touch something outside the React
 * tree (open a URL in the OS browser, summon the launcher, etc.).
 */
const HOST_ACTIONS: ActionDef[] = [
  {
    id: 'host.openUrl',
    category: 'host',
    label: 'Open URL in your browser',
    description:
      'Open a URL in the user\'s default browser. Useful for "show me the Groq dashboard" or "take me to docs".',
    icon: ExternalLink,
    params: [
      {
        key: 'url',
        label: 'URL',
        type: 'string',
        required: true,
        placeholder: 'https://aistudio.google.com/apikey',
        help: 'Must start with http:// or https://.',
      },
    ],
    run: async (params) => {
      const url = typeof params.url === 'string' ? params.url.trim() : '';
      if (!/^https?:\/\//i.test(url)) {
        return fail('URL must start with http:// or https://.');
      }
      try {
        // Route through the Tauri shell plugin in packaged builds so
        // the OS browser actually opens. `window.open` works in the
        // dev build but is a no-op (or worse, opens a blank WebView)
        // inside Tauri.
        await openExternal(url);
        return ok(`Opened ${url}`);
      } catch (err) {
        return fail(`Could not open URL: ${(err as Error).message}`);
      }
    },
  },
  {
    id: 'host.openLauncher',
    category: 'host',
    label: 'Open quick launcher',
    description: 'Pop the Quick Launcher tile grid (pinned apps and links). Same as Mod+Shift+L.',
    icon: Rocket,
    params: [],
    run: async () => {
      useUIStore.getState().setLauncherOpen(true);
      return ok('Opened the launcher.');
    },
  },
];

const PLUGIN_ACTIONS: ActionDef[] = [
  {
    id: 'plugin.call',
    category: 'custom',
    label: 'Call connected plugin tool',
    description:
      'Run a declared tool from a connected and terminal-enabled plugin. Credentials remain in the OS keychain.',
    icon: Plug,
    params: [
      {
        key: 'pluginId',
        label: 'Plugin id',
        type: 'string',
        required: true,
        help: 'Stable plugin id shown in the connected plugin capability context.',
      },
      {
        key: 'toolName',
        label: 'Tool name',
        type: 'string',
        required: true,
        help: 'A declared tool name from the plugin capability context.',
      },
    ],
    run: async (params) => {
      const pluginId = typeof params.pluginId === 'string' ? params.pluginId.trim() : '';
      const toolName = typeof params.toolName === 'string' ? params.toolName.trim() : '';
      if (!pluginId || !toolName) return fail('Plugin id and tool name are required.');

      const [{ getPluginManifest, callPluginTool }, { usePluginStore }] = await Promise.all([
        import('@/features/plugins'),
        import('@/features/plugins/store'),
      ]);
      const manifest = getPluginManifest(pluginId);
      const connection = usePluginStore.getState().connections[pluginId];
      if (
        !manifest ||
        (manifest.status !== 'implemented' && manifest.status !== 'configurable')
      ) {
        return fail(`Plugin ${pluginId} is not available for tool calls.`);
      }
      if (!connection || connection.state !== 'connected') {
        return fail(`${manifest.name} is not connected.`);
      }
      if (!connection.enabled) {
        return fail(`${manifest.name} terminal access is disabled.`);
      }
      const projectId = useAuthStore.getState().projectId;
      const availableHere =
        connection.enabledProjectIds.includes('*') ||
        Boolean(projectId && connection.enabledProjectIds.includes(projectId));
      if (!availableHere) {
        return fail(`${manifest.name} is not enabled for the active project.`);
      }
      const tool = manifest.tools.find((candidate) => candidate.name === toolName);
      if (!tool) return fail(`Unknown ${manifest.name} tool: ${toolName}.`);

      try {
        const data = await callPluginTool(pluginId, toolName);
        return ok(`${manifest.name}.${toolName} completed.`, data);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
];

const CLOCK_ACTIONS: ActionDef[] = [
  {
    id: 'clock.timer',
    category: 'clock',
    label: 'Start timer',
    description: 'Create a local Clock timer with sound and notification when it finishes.',
    icon: Clock,
    params: [
      {
        key: 'durationMinutes',
        label: 'Duration minutes',
        type: 'number',
        default: 25,
        help: 'Timer duration in minutes. Use 60 for a one-hour timer.',
      },
      {
        key: 'durationSeconds',
        label: 'Extra seconds',
        type: 'number',
        default: 0,
        help: 'Optional seconds added to the minute duration.',
      },
      { key: 'label', label: 'Label', type: 'string', placeholder: 'Focus timer' },
      {
        key: 'sound',
        label: 'Sound',
        type: 'select',
        default: 'chime',
        options: CLOCK_SOUNDS.map((sound) => ({ value: sound, label: sound })),
      },
    ],
    run: async (params) => {
      const minutes = typeof params.durationMinutes === 'number' ? params.durationMinutes : 25;
      const seconds = typeof params.durationSeconds === 'number' ? params.durationSeconds : 0;
      const durationMs = Math.round((minutes * 60 + seconds) * 1000);
      if (!Number.isFinite(durationMs) || durationMs <= 0)
        return fail('Timer duration must be greater than zero.');
      const entry = useClockStore.getState().createTimer({
        durationMs,
        label: typeof params.label === 'string' ? params.label : undefined,
        sound: readClockSound(params.sound),
      });
      return ok(`Timer set for ${formatDurationMs(entry.durationMs ?? durationMs)}.`, {
        id: entry.id,
        dueAt: entry.dueAt,
      });
    },
  },
  {
    id: 'clock.alarm',
    category: 'clock',
    label: 'Set alarm',
    description:
      'Create a local Clock alarm at a future time, such as 15:30, 3:30 PM, or an ISO timestamp.',
    icon: AlarmClock,
    params: [
      {
        key: 'time',
        label: 'Alarm time',
        type: 'string',
        required: true,
        placeholder: '3:30 PM',
        help: 'Local time like 15:30 or 3:30 PM. Past times roll to tomorrow.',
      },
      { key: 'label', label: 'Label', type: 'string', placeholder: 'Alarm' },
      {
        key: 'sound',
        label: 'Sound',
        type: 'select',
        default: 'chime',
        options: CLOCK_SOUNDS.map((sound) => ({ value: sound, label: sound })),
      },
    ],
    run: async (params) => {
      const time = typeof params.time === 'string' ? params.time.trim() : '';
      const dueAt = parseAlarmTime(time);
      if (!dueAt)
        return fail('Alarm time must be a future time like 15:30, 3:30 PM, or an ISO timestamp.');
      const entry = useClockStore.getState().createAlarm({
        dueAt,
        label: typeof params.label === 'string' ? params.label : undefined,
        sound: readClockSound(params.sound),
      });
      return ok(
        `Alarm set for ${new Date(entry.dueAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`,
        {
          id: entry.id,
          dueAt: entry.dueAt,
        },
      );
    },
  },
  {
    id: 'clock.cancelAll',
    category: 'clock',
    label: 'Cancel all timers and alarms',
    description: 'Cancel every active local Clock timer and alarm.',
    icon: AlarmClock,
    params: [],
    run: async () => {
      const count = useClockStore.getState().cancelAllScheduled();
      return ok(`Cancelled ${count} active clock item${count === 1 ? '' : 's'}.`);
    },
  },
];

const PRODUCTIVITY_ACTIONS: ActionDef[] = [
  {
    id: 'kanban.createTask',
    category: 'custom',
    label: 'Create Kanban task',
    description: 'Create a project-scoped Kanban task with optional notes, priority, and due time.',
    icon: PlusCircle,
    params: [
      { key: 'title', label: 'Task title', type: 'string', required: true },
      { key: 'notes', label: 'Notes', type: 'string', help: 'Optional task details.' },
      {
        key: 'priority',
        label: 'Priority',
        type: 'select',
        default: 'normal',
        options: [
          { value: 'urgent', label: 'Urgent' },
          { value: 'high', label: 'High' },
          { value: 'normal', label: 'Normal' },
          { value: 'low', label: 'Low' },
        ],
      },
      {
        key: 'due_at',
        label: 'Due timestamp',
        type: 'number',
        help: 'Unix milliseconds. Omit when no specific due time exists.',
      },
    ],
    run: async (params) => {
      const workspaceId = useAuthStore.getState().workspaceId;
      if (!workspaceId) return fail('No active workspace.');
      const title = typeof params.title === 'string' ? params.title.trim() : '';
      if (!title) return fail('Task title is required.');
      const notes =
        typeof params.notes === 'string' && params.notes.trim() ? params.notes.trim() : undefined;
      const priority = ['urgent', 'high', 'normal', 'low'].includes(String(params.priority))
        ? (String(params.priority) as 'urgent' | 'high' | 'normal' | 'low')
        : 'normal';
      const due_at =
        typeof params.due_at === 'number' && Number.isFinite(params.due_at)
          ? params.due_at
          : undefined;
      await taskRepo.create({
        workspace_id: workspaceId,
        project_id: useAuthStore.getState().projectId ?? undefined,
        title,
        notes,
        status: 'open',
        priority,
        due_at,
        created_by: 'agent',
      });
      navigateTo('kanban');
      return ok(`Created Kanban task: ${title}`);
    },
  },
  {
    id: 'custom.createTerminalCommand',
    category: 'custom',
    label: 'Create custom terminal command',
    description:
      'Save a named Jarvis command backed by terminal.run so it appears as custom.<slug> for future use.',
    icon: Wrench,
    params: [
      { key: 'name', label: 'Command name', type: 'string', required: true },
      { key: 'command', label: 'Shell command', type: 'string', required: true },
      {
        key: 'cwd',
        label: 'Working directory',
        type: 'string',
        help: 'Optional absolute project folder.',
      },
      {
        key: 'description',
        label: 'Description',
        type: 'string',
        help: 'Optional user-facing description.',
      },
    ],
    run: async (params) => {
      const name = typeof params.name === 'string' ? params.name.trim() : '';
      const command = typeof params.command === 'string' ? params.command.trim() : '';
      if (!name || !command) return fail('Name and command are required.');
      const { useToolStore } = await import('@/features/tools/toolStore');
      const tool = useToolStore.getState().create({
        name,
        description:
          typeof params.description === 'string' && params.description.trim()
            ? params.description.trim()
            : `Run ${command} in a new terminal pane.`,
        baseAction: 'terminal.run',
        params: {
          command,
          label: name,
          ...(typeof params.cwd === 'string' && params.cwd.trim()
            ? { cwd: params.cwd.trim() }
            : {}),
        },
      });
      return ok(`Created custom command custom.${tool.slug}.`);
    },
  },
  {
    id: 'custom.createWorkflowTool',
    category: 'custom',
    label: 'Create custom workflow tool',
    description:
      'Save a named custom tool that chains multiple built-in Jarvis actions. Use this for multi-step workflows Jarvis should be able to run later.',
    icon: Wrench,
    params: [
      { key: 'name', label: 'Tool name', type: 'string', required: true },
      {
        key: 'stepsJson',
        label: 'Workflow steps JSON',
        type: 'string',
        required: true,
        help: 'JSON array of steps like [{"action":"nav.terminal","params":{}},{"action":"terminal.run","params":{"command":"npm test"}}]. Built-in actions only.',
      },
      {
        key: 'description',
        label: 'Description',
        type: 'string',
        help: 'Optional user-facing description.',
      },
    ],
    run: async (params) => {
      const name = typeof params.name === 'string' ? params.name.trim() : '';
      const stepsJson = typeof params.stepsJson === 'string' ? params.stepsJson.trim() : '';
      if (!name || !stepsJson) return fail('Name and workflow steps JSON are required.');
      const { useToolStore, parseToolStepsJson } = await import('@/features/tools/toolStore');
      let steps: CustomToolStep[];
      try {
        steps = parseToolStepsJson(stepsJson);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      for (const step of steps) {
        if (!getBuiltinAction(step.action)) {
          return fail(`Workflow step references an unknown built-in action: ${step.action}.`);
        }
      }
      const tool = useToolStore.getState().create({
        name,
        description:
          typeof params.description === 'string' && params.description.trim()
            ? params.description.trim()
            : `Run ${steps.length} Jarvis action step${steps.length === 1 ? '' : 's'}.`,
        baseAction: 'workflow.run',
        params: {},
        steps,
      });
      return ok(`Created workflow tool custom.${tool.slug}.`);
    },
  },
];

/* --------------------------------------------------------------------------
 * Bundle + lookup
 * --------------------------------------------------------------------------*/

/** All built-in actions in canonical display order. */
export function getBuiltinActions(): ActionDef[] {
  return [
    ...NAVIGATION_ACTIONS,
    ...SETTINGS_ACTIONS,
    ...THEME_ACTIONS,
    ...VOICE_ACTIONS,
    ...TERMINAL_ACTIONS,
    ...CHAT_ACTIONS,
    ...WELLNESS_ACTIONS,
    ...HOST_ACTIONS,
    ...PLUGIN_ACTIONS,
    ...CLOCK_ACTIONS,
    ...PRODUCTIVITY_ACTIONS,
    ...PRESET_ACTIONS,
  ];
}

/**
 * Stable id mapping cache. Built lazily on first lookup so the icon
 * imports above don't pay the price on a cold module load.
 */
let cache: Map<string, ActionDef> | null = null;
function getBuiltinIndex(): Map<string, ActionDef> {
  if (cache) return cache;
  const m = new Map<string, ActionDef>();
  for (const a of getBuiltinActions()) m.set(a.id, a);
  cache = m;
  return m;
}

/** Lookup a built-in action by id. Returns undefined if none matches. */
export function getBuiltinAction(id: string): ActionDef | undefined {
  return getBuiltinIndex().get(id);
}

/** Stable count for tests + the prompt addendum's "N actions" header. */
export const BUILTIN_ACTION_COUNT = getBuiltinActions().length;

/** Expose category labels for the palette section dividers. */
export const CATEGORY_LABELS: Record<
  | 'navigation'
  | 'settings'
  | 'theme'
  | 'voice'
  | 'terminal'
  | 'clock'
  | 'chat'
  | 'wellness'
  | 'host'
  | 'custom',
  string
> = {
  navigation: 'Navigate',
  settings: 'Settings',
  theme: 'Appearance',
  voice: 'Voice',
  terminal: 'Terminal',
  clock: 'Clock',
  chat: 'Chat',
  wellness: 'Wellness',
  host: 'Host',
  custom: 'Your tools',
};

/** Optional category icon (palette section dividers). */
export const CATEGORY_ICON: Record<string, LucideIcon> = {
  navigation: MessageSquare,
  settings: Cog,
  theme: Sparkles,
  voice: Mic,
  terminal: TerminalIcon,
  clock: Clock,
  chat: Bot,
  wellness: Eye,
  host: Rocket,
  custom: Wrench,
};

/* Re-export so action-driven code paths can dump a clean delete.
 * Used by the action approval card on cancel. */
export { Trash2 as CancelIcon };
