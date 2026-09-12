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
  CalendarClock,
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
  FileText,
  Flower2,
} from 'lucide-react';

import { flushUiStatePersistence, useUIStore, type Route } from '@/stores/ui';
import { useFullscreenStore } from '@/features/fullscreen/fullscreenStore';
import { resolveDocumentTheme, THEME_STORAGE_KEY } from '@/features/appearance/themeContract';
import { useAuthStore } from '@/stores/auth';
import {
  enqueueTerminalCommand,
  requestTerminalSwarm,
  enqueueTerminalClose,
} from '@/features/terminals/terminalCommandQueue';
import { setTerminalRoleBriefing } from '@/features/terminals/terminalRoleBriefings';
import type { TerminalRef } from '@/features/terminals/terminalRefs';
import { eventRepo, taskRepo } from '@/lib/db/repositories';
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
import { formatUserTime } from '@/lib/timeFormat';
import { PRESET_ACTIONS } from './registryPresets';
import { APP_CONTROL_ACTIONS } from './registryAppControl';
import { FILE_ACTIONS } from './registryFiles';
import {
  buildJarvisScheduleEventInput,
  scheduleActionSummary,
  type JarvisScheduleRecurrence,
} from '@/features/schedule/jarvisSchedules';
import {
  formatChatModelSelectionLabel,
  modelSelectionContextFromAuth,
} from '@/lib/ai/modelSelection';
import { markTerminalExecution } from '@/features/terminals/terminalExecutionStore';
import { createJarvisCoreActions } from './registryJarvisCore';
import { createModelSelectionActions } from './registryModelSelection';

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

function encodePowerShellCommand(script: string): string {
  let bytes = '';
  for (let index = 0; index < script.length; index += 1) {
    const code = script.charCodeAt(index);
    bytes += String.fromCharCode(code & 0xff, code >>> 8);
  }
  return btoa(bytes);
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

export interface OrchestrationRoleGroup {
  count: number;
  agentSlug: string;
  prompt?: string;
}

const ORCHESTRATE_MAX_PANES = 10;
const ORCHESTRATE_MAX_PROMPT_CHARS = 4000;

/**
 * Validate the `terminal.orchestrate` roles payload. Fails closed on any
 * malformed group so a garbled model proposal can never open panes with
 * missing roles or oversized prompts.
 */
export function parseOrchestrationRoles(
  raw: unknown,
): { ok: true; groups: OrchestrationRoleGroup[] } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return {
      ok: false,
      error: 'rolesJson is required: a JSON array of {count, agentSlug, prompt?} groups.',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'rolesJson is not valid JSON.' };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, error: 'rolesJson must be a non-empty JSON array.' };
  }
  const groups: OrchestrationRoleGroup[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: 'Every roles entry must be an object with count and agentSlug.' };
    }
    const source = entry as Record<string, unknown>;
    const count = typeof source.count === 'number' ? Math.floor(source.count) : NaN;
    if (!Number.isFinite(count) || count < 1) {
      return { ok: false, error: 'Every roles entry needs a count of at least 1.' };
    }
    const agentSlug =
      typeof source.agentSlug === 'string'
        ? source.agentSlug
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '')
        : '';
    if (!agentSlug) {
      return { ok: false, error: 'Every roles entry needs a non-empty agentSlug.' };
    }
    const prompt =
      typeof source.prompt === 'string' && source.prompt.trim()
        ? source.prompt.trim().slice(0, ORCHESTRATE_MAX_PROMPT_CHARS)
        : undefined;
    groups.push({ count, agentSlug, prompt });
  }
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  if (total > ORCHESTRATE_MAX_PANES) {
    return {
      ok: false,
      error: `Role counts add up to ${total} panes; the maximum is ${ORCHESTRATE_MAX_PANES}.`,
    };
  }
  return { ok: true, groups };
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
    ['nav.canvas', 'Open Canvas', 'canvas', Layers],
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
 * Theme actions. `setTheme` applies the document attributes and publishes
 * synchronization synchronously. Actions that promise verified persistence
 * flush the store's existing debounced persistence boundary before success.
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
    id: 'theme.vibespace',
    category: 'theme',
    label: 'Switch to VibeSpace theme',
    description: 'Set the workspace to the pastel origami palette.',
    icon: Sparkles,
    params: [],
    run: async () => {
      useUIStore.getState().setTheme('vibespace');
      return ok('Theme: VibeSpace.');
    },
  },
  {
    id: 'theme.dark',
    category: 'theme',
    label: 'Switch to Default theme',
    description: 'Set the workspace to the established warm dark palette.',
    icon: Moon,
    params: [],
    run: async () => {
      useUIStore.getState().setTheme('default');
      return ok('Theme: Default.');
    },
  },
  {
    id: 'theme.monochrome',
    category: 'theme',
    label: 'Switch to MonoChrome theme',
    description: 'Set the workspace to the terminal-inspired developer console palette.',
    icon: TerminalIcon,
    params: [],
    run: async () => {
      useUIStore.getState().setTheme('monochrome');
      return ok('Theme: MonoChrome.');
    },
  },
  {
    id: 'theme.sakura',
    category: 'theme',
    label: 'Switch to Sakura theme',
    description: 'Set the workspace to the cel-painted dusk palette.',
    icon: Flower2,
    params: [],
    run: async () => {
      useUIStore.getState().setTheme('sakura');
      flushUiStatePersistence();

      const stateTheme = useUIStore.getState().theme;
      const documentTheme = document.documentElement.dataset.theme;
      const preference = document.documentElement.dataset.themePreference;
      let persistedTheme: unknown;
      try {
        const payload = JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? 'null');
        persistedTheme =
          payload && typeof payload === 'object' && !Array.isArray(payload)
            ? payload.state?.theme
            : undefined;
      } catch {
        persistedTheme = undefined;
      }

      if (
        stateTheme !== 'sakura' ||
        documentTheme !== resolveDocumentTheme('sakura') ||
        preference !== 'sakura' ||
        persistedTheme !== 'sakura'
      ) {
        return fail('Theme Sakura could not be verified.');
      }

      return ok('Theme: Sakura.', {
        theme: stateTheme,
        documentTheme,
        preference,
        persistedTheme,
      });
    },
  },
  {
    id: 'theme.toggle',
    category: 'theme',
    label: 'Toggle theme',
    description: 'Flip between Default and MonoChrome.',
    icon: RotateCw,
    params: [],
    run: async () => {
      const cur = useUIStore.getState().theme;
      const next = cur === 'default' ? 'monochrome' : 'default';
      useUIStore.getState().setTheme(next);
      return ok(`Theme: ${next === 'default' ? 'Default' : 'MonoChrome'}.`);
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
      const executionIds: string[] = [];
      for (let i = 0; i < count; i++) {
        const executionId = enqueueTerminalCommand({
          command,
          label: command ? `${command} ${i + 1}` : `terminal ${i + 1}`,
          cwd,
        });
        executionIds.push(executionId);
        markTerminalExecution(executionId, 'queued');
      }
      navigateTo('terminal');
      return ok(
        `Queued ${count} terminal pane${count === 1 ? '' : 's'}${command ? ` with ${command}` : ''}.`,
        { state: 'queued', executionId: executionIds[0], executionIds },
      );
    },
  },
  {
    id: 'terminal.bulkClose',
    category: 'terminal',
    label: 'Close terminal panes',
    description:
      'Close the N most recently opened terminal panes. Use when the user asks to close, remove, or kill terminals.',
    icon: Trash2,
    destructive: true,
    params: [
      {
        key: 'count',
        label: 'Pane count',
        type: 'number',
        required: true,
        default: 1,
        help: 'How many panes to close (most recently opened first). Max 10.',
      },
    ],
    run: async (params) => {
      const rawCount = typeof params.count === 'number' ? params.count : 1;
      const count = Math.min(10, Math.max(1, Math.floor(rawCount)));
      enqueueTerminalClose(count);
      navigateTo('terminal');
      return ok(`Closing ${count} terminal pane${count === 1 ? '' : 's'}.`);
    },
  },
  {
    id: 'terminal.orchestrate',
    category: 'terminal',
    label: 'Orchestrate terminal agents',
    description:
      'One approved plan: optionally close every existing project terminal, open a batch of new panes (max 10 total), start a CLI such as claude or opencode in each, assign agent roles per pane, and deliver each role\'s custom prompt through the AGENTS.md briefing files. Use for requests like "close all terminals, open 10, five as code agents and five as reviewers with these prompts".',
    icon: Layers,
    destructive: true,
    params: [
      {
        key: 'closeExisting',
        label: 'Close existing terminals first',
        type: 'boolean',
        default: false,
        help: 'When true, closes all current project panes before opening the new batch.',
      },
      {
        key: 'command',
        label: 'CLI command',
        type: 'string',
        required: false,
        placeholder: 'claude',
        help: "Command started in every new pane (e.g. claude, opencode). Leave empty for a plain shell. If the CLI is not installed, the pane shows the shell's error - nothing is faked.",
      },
      {
        key: 'rolesJson',
        label: 'Roles JSON',
        type: 'string',
        required: true,
        help: 'JSON array of role groups: [{"count":5,"agentSlug":"code-agent","prompt":"please find any security vulnerabilities"},{"count":5,"agentSlug":"code-reviewer","prompt":"you are a code reviewer"}]. Total count max 10. Prompts are delivered via AGENTS.md, never typed into the shell.',
      },
      {
        key: 'cwd',
        label: 'Working directory',
        type: 'string',
        required: false,
        help: 'Optional project folder for every pane.',
      },
    ],
    run: async (params) => {
      const roles = parseOrchestrationRoles(params.rolesJson);
      if (!roles.ok) return fail(roles.error);
      const command = typeof params.command === 'string' ? params.command.trim() : '';
      const cwd =
        typeof params.cwd === 'string' && params.cwd.trim() ? params.cwd.trim() : undefined;
      if (cwd) {
        const meta = rejectShellMetaChars(cwd);
        if (meta) return fail(meta);
      }
      if (command) {
        const meta = rejectShellMetaChars(command);
        if (meta) return fail(meta);
      }
      const closeExisting = params.closeExisting === true || params.closeExisting === 'true';

      if (closeExisting) enqueueTerminalClose(10);

      const projectId = useAuthStore.getState().projectId ?? null;
      const openedLabels: string[] = [];
      for (const role of roles.groups) {
        if (role.prompt) setTerminalRoleBriefing(projectId, role.agentSlug, role.prompt);
        for (let i = 0; i < role.count; i++) {
          enqueueTerminalCommand({
            command,
            label: `${role.agentSlug} ${i + 1}`,
            agentSlug: role.agentSlug,
            cwd,
          });
        }
        openedLabels.push(`${role.count} × ${role.agentSlug}`);
      }
      navigateTo('terminal');

      const total = roles.groups.reduce((sum, role) => sum + role.count, 0);
      const briefed = roles.groups.filter((role) => role.prompt).length;
      return ok(
        [
          closeExisting ? 'Closing all existing project terminals.' : null,
          `Opening ${total} terminal pane${total === 1 ? '' : 's'}${command ? ` running \`${command}\`` : ''}: ${openedLabels.join(', ')}.`,
          briefed > 0
            ? `${briefed} role prompt${briefed === 1 ? '' : 's'} will be delivered through the AGENTS.md briefing files when each pane starts.`
            : null,
          command
            ? `If \`${command}\` is not installed or configured, each pane will show the shell's own error - configure the CLI and rerun.`
            : null,
        ]
          .filter(Boolean)
          .join(' '),
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
    id: 'terminal.powershell',
    category: 'terminal',
    label: 'Run a PowerShell command',
    description:
      'Run an approved Windows PowerShell script in a new terminal pane using UTF-16LE encoded-command transport.',
    icon: PlayCircle,
    destructive: true,
    params: [
      {
        key: 'command',
        label: 'PowerShell command',
        type: 'string',
        required: true,
        help: 'PowerShell script body. It is encoded only after the user approves the action.',
      },
      {
        key: 'label',
        label: 'Pane label',
        type: 'string',
        required: false,
      },
      {
        key: 'cwd',
        label: 'Working directory',
        type: 'string',
        required: false,
        help: 'Optional active project folder for the PowerShell process.',
      },
      {
        key: 'timeoutMs',
        label: 'Timeout in milliseconds',
        type: 'number',
        required: false,
        help: 'Optional 1 second to 30 minute deadline. Omit for long-running commands.',
      },
    ],
    run: async (params) => {
      const script = typeof params.command === 'string' ? params.command.trim() : '';
      if (!script) return fail('Missing required parameter: command.');
      if (script.length > 10_000) {
        return fail(
          'The PowerShell command is too long to start safely. Save it as a script file instead.',
        );
      }
      const cwd =
        typeof params.cwd === 'string' && params.cwd.trim() ? params.cwd.trim() : undefined;
      if (cwd) {
        const meta = rejectShellMetaChars(cwd);
        if (meta) return fail(meta);
      }
      const label =
        typeof params.label === 'string' && params.label.trim()
          ? params.label.trim()
          : 'PowerShell';
      const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined;
      if (timeoutMs !== undefined && (timeoutMs < 1_000 || timeoutMs > 1_800_000)) {
        return fail('Timeout must be between 1,000 and 1,800,000 milliseconds.');
      }
      const encoded = encodePowerShellCommand(script);
      const command = `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
      const executionId = enqueueTerminalCommand({ command, label, cwd });
      markTerminalExecution(executionId, 'queued', { timeoutMs });
      navigateTo('terminal');
      return ok('PowerShell command queued in Terminal.', {
        state: 'queued',
        executionId,
      });
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
      {
        key: 'timeoutMs',
        label: 'Timeout in milliseconds',
        type: 'number',
        required: false,
        help: 'Optional 1 second to 30 minute deadline. Omit for long-running commands.',
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
      const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined;
      if (timeoutMs !== undefined && (timeoutMs < 1_000 || timeoutMs > 1_800_000)) {
        return fail('Timeout must be between 1,000 and 1,800,000 milliseconds.');
      }
      const executionId = enqueueTerminalCommand({ command, label, cwd });
      markTerminalExecution(executionId, 'queued', { timeoutMs });
      navigateTo('terminal');
      return ok('Command queued in Terminal.', { state: 'queued', executionId });
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
 * Chat-canvas actions. The stable `chat.fullscreen` ID now targets
 * workspace Focus Mode so integrations retain compatibility.
 */
const CHAT_ACTIONS: ActionDef[] = [
  {
    id: 'chat.fullscreen',
    category: 'chat',
    label: 'Toggle Workspace Focus Mode',
    description: 'Hide non-essential workspace chrome. Toggles back when invoked again.',
    icon: Maximize2,
    params: [],
    run: async () => {
      useFullscreenStore.getState().toggleFocus();
      const now = useFullscreenStore.getState().focusActive;
      return ok(`Workspace Focus Mode: ${now ? 'on' : 'off'}.`);
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
      return ok(`Alarm set for ${formatUserTime(entry.dueAt)}.`, {
        id: entry.id,
        dueAt: entry.dueAt,
      });
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

const SCHEDULE_ACTIONS: ActionDef[] = [
  {
    id: 'schedule.create',
    category: 'schedule',
    label: 'Create Jarvis schedule',
    description:
      'Create a real Jarvis scheduled task on the Schedule page using the current connected chat model selection.',
    icon: CalendarClock,
    destructive: true,
    params: [
      {
        key: 'title',
        label: 'Title',
        type: 'string',
        required: true,
        help: 'Short schedule title.',
      },
      {
        key: 'prompt',
        label: 'Prompt',
        type: 'string',
        required: true,
        help: 'The Jarvis prompt/instruction to run on schedule.',
      },
      {
        key: 'startAtMs',
        label: 'Start time',
        type: 'number',
        required: true,
        help: 'Unix milliseconds for the first run.',
      },
      {
        key: 'recurrence',
        label: 'Recurrence',
        type: 'select',
        default: 'once',
        // Only recurrences the expansion engine and runner actually execute.
        // custom_interval / custom_days were removed: they silently behaved
        // as one-shot schedules everywhere.
        options: [
          { value: 'once', label: 'Once' },
          { value: 'daily', label: 'Daily' },
          { value: 'weekly', label: 'Weekly' },
          { value: 'monthly', label: 'Monthly' },
          { value: 'weekdays', label: 'Weekdays' },
        ],
      },
      {
        key: 'agentId',
        label: 'Agent id',
        type: 'string',
        required: false,
        help: 'Real agent id to use. Omit to use Jarvis/default chat agent.',
      },
    ],
    run: async (params) => {
      const auth = useAuthStore.getState();
      if (!auth.workspaceId) return fail('No workspace is active.');
      const title = typeof params.title === 'string' ? params.title.trim() : '';
      const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : '';
      const startAtMs =
        typeof params.startAtMs === 'number' ? params.startAtMs : Number(params.startAtMs);
      if (!title) return fail('Schedule title is required.');
      if (!prompt) return fail('Schedule prompt is required.');
      if (!Number.isFinite(startAtMs)) return fail('A valid startAtMs time is required.');
      const recurrence = (
        typeof params.recurrence === 'string' && params.recurrence ? params.recurrence : 'once'
      ) as JarvisScheduleRecurrence;
      const modelLabel = formatChatModelSelectionLabel(
        auth.chatModelSelection,
        modelSelectionContextFromAuth(auth),
      );
      const event = await eventRepo.create(
        buildJarvisScheduleEventInput({
          workspaceId: auth.workspaceId,
          projectId: auth.projectId ?? undefined,
          createdBy: 'agent_jarvis',
          title,
          prompt,
          startAt: startAtMs,
          recurrence,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          modelSelection: auth.chatModelSelection,
          agentId:
            typeof params.agentId === 'string' && params.agentId.trim()
              ? params.agentId.trim()
              : 'agent_jarvis',
        }),
      );
      useUIStore.getState().setRoute('schedule');
      return ok(`${scheduleActionSummary('created', event)} Model: ${modelLabel}`, {
        eventId: event.id,
      });
    },
  },
  {
    id: 'schedule.list',
    category: 'schedule',
    label: 'List schedules',
    description: 'List upcoming scheduled events and Jarvis scheduled tasks.',
    icon: CalendarClock,
    params: [],
    run: async () => {
      const auth = useAuthStore.getState();
      if (!auth.workspaceId) return fail('No workspace is active.');
      const rows = await eventRepo.listUpcoming(auth.workspaceId, 20);
      return ok(
        `Found ${rows.length} upcoming schedule item${rows.length === 1 ? '' : 's'}.`,
        rows.map((event) => ({
          id: event.id,
          title: event.title,
          start_at: event.start_at,
          recurrence_rule: event.recurrence_rule,
          status: event.status,
        })),
      );
    },
  },
  {
    id: 'schedule.pause',
    category: 'schedule',
    label: 'Pause schedule',
    description: 'Pause a schedule by marking it cancelled without deleting history.',
    icon: CalendarClock,
    destructive: true,
    params: [{ key: 'eventId', label: 'Schedule id', type: 'string', required: true }],
    run: async (params) => {
      const eventId = typeof params.eventId === 'string' ? params.eventId.trim() : '';
      if (!eventId) return fail('eventId is required.');
      const event = await eventRepo.update(eventId as never, { status: 'cancelled' });
      return ok(scheduleActionSummary('paused', event), { eventId });
    },
  },
  {
    id: 'schedule.resume',
    category: 'schedule',
    label: 'Resume schedule',
    description: 'Resume a paused schedule.',
    icon: CalendarClock,
    params: [{ key: 'eventId', label: 'Schedule id', type: 'string', required: true }],
    run: async (params) => {
      const eventId = typeof params.eventId === 'string' ? params.eventId.trim() : '';
      if (!eventId) return fail('eventId is required.');
      const event = await eventRepo.update(eventId as never, { status: 'scheduled' });
      return ok(scheduleActionSummary('resumed', event), { eventId });
    },
  },
  {
    id: 'schedule.delete',
    category: 'schedule',
    label: 'Delete schedule',
    description: 'Delete a schedule permanently after approval.',
    icon: Trash2,
    destructive: true,
    params: [{ key: 'eventId', label: 'Schedule id', type: 'string', required: true }],
    run: async (params) => {
      const eventId = typeof params.eventId === 'string' ? params.eventId.trim() : '';
      if (!eventId) return fail('eventId is required.');
      const event = await eventRepo.getById(eventId as never);
      if (!event) return fail(`Schedule ${eventId} was not found.`);
      await eventRepo.delete(eventId as never);
      return ok(scheduleActionSummary('deleted', event), { eventId });
    },
  },
  {
    id: 'schedule.history',
    category: 'schedule',
    label: 'Schedule history',
    description: 'Show stored run and error history for a Jarvis schedule.',
    icon: HistoryIcon,
    params: [{ key: 'eventId', label: 'Schedule id', type: 'string', required: true }],
    run: async (params) => {
      const eventId = typeof params.eventId === 'string' ? params.eventId.trim() : '';
      if (!eventId) return fail('eventId is required.');
      const event = await eventRepo.getById(eventId as never);
      if (!event) return fail(`Schedule ${eventId} was not found.`);
      return ok(`History for ${event.title}.`, event.source_ref?.context ?? null);
    },
  },
];

const CREATOR_ACTIONS: ActionDef[] = [
  {
    id: 'creator.start',
    category: 'custom',
    label: 'Make with Jarvis',
    description:
      'Open the right-panel Make with Jarvis creator for an agent or skill. It drafts only after user approval; the user still applies and saves explicitly.',
    icon: Sparkles,
    destructive: true,
    params: [
      {
        key: 'kind',
        label: 'Creator type',
        type: 'select',
        required: true,
        default: 'agent',
        options: [
          { value: 'agent', label: 'Agent' },
          { value: 'skill', label: 'Skill' },
        ],
      },
    ],
    run: async (params) => {
      const kind = params.kind === 'skill' ? 'skill' : params.kind === 'agent' ? 'agent' : null;
      if (!kind) return fail('Creator kind must be either agent or skill.');
      const { startJarvisCreator } = await import('@/features/jarvis-creator/launcher');
      startJarvisCreator({ kind });
      return ok(`Opened Make with Jarvis for ${kind === 'agent' ? 'an agent' : 'a skill'}.`);
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
  const baseActions: ActionDef[] = [
    ...NAVIGATION_ACTIONS,
    ...SETTINGS_ACTIONS,
    ...THEME_ACTIONS,
    ...VOICE_ACTIONS,
    ...FILE_ACTIONS,
    ...TERMINAL_ACTIONS,
    ...SCHEDULE_ACTIONS,
    ...CHAT_ACTIONS,
    ...createModelSelectionActions(),
    ...HOST_ACTIONS,
    ...CREATOR_ACTIONS,
    ...PRODUCTIVITY_ACTIONS,
    ...APP_CONTROL_ACTIONS,
    ...PRESET_ACTIONS,
  ];
  const byId = new Map(baseActions.map((action) => [action.id, action]));
  return [...baseActions, ...createJarvisCoreActions((id) => byId.get(id))];
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
  | 'file'
  | 'terminal'
  | 'schedule'
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
  file: 'Files',
  terminal: 'Terminal',
  schedule: 'Schedule',
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
  file: FileText,
  terminal: TerminalIcon,
  schedule: CalendarClock,
  clock: Clock,
  chat: Bot,
  wellness: Eye,
  host: Rocket,
  custom: Wrench,
};

/* Re-export so action-driven code paths can dump a clean delete.
 * Used by the action approval card on cancel. */
export { Trash2 as CancelIcon };
