/**
 * @file Built-in tool registrations.
 *
 * Imported for side effects from the barrel (`@/lib/mcp`). Each registration
 * is intentionally a thin wrapper around something the app already does so
 * tools fail fast (and friendly) outside their host environment — for
 * example, browser preview without Tauri, or web platforms without
 * SpeechSynthesis.
 *
 * Conventions:
 *  - Tool names are dot-namespaced (`fs.read`, `voice.speak`).
 *  - Validation errors throw inside `invoke`, which becomes a rejected
 *    promise. The registry wraps these with the tool name on the way out.
 *  - Backends (Tauri core, the UI store, the toast store) are imported
 *    lazily so non-Tauri / non-DOM environments don't blow up at module
 *    load time.
 */

import { isTauri } from '@/lib/utils';
import { speakText } from '@/features/voice/speechSynthesis';
import type { PersonaPreset } from '@/types/common';
import { toolRegistry } from './registry';

/**
 * Lazy `invoke()` shim. Mirrors `src/lib/tauri.ts` so the browser bundle
 * never pulls in `@tauri-apps/api/core` until a tool is actually called.
 */
async function tauriInvoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/* -------------------------------------------------------------------------- */
/*  fs.read                                                                   */
/* -------------------------------------------------------------------------- */

toolRegistry.register<{ path: string }, string>({
  name: 'fs.read',
  description: 'Read a UTF-8 text file from the workspace.',
  scope: 'workspace',
  tags: ['files', 'fs'],
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  invoke: async ({ path }) => {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('path must be a non-empty string');
    }
    if (!isTauri) throw new Error('Tauri fs not available');
    return tauriInvoke<string>('plugin:fs|read_text_file', { path });
  },
});

/* -------------------------------------------------------------------------- */
/*  fs.list                                                                   */
/* -------------------------------------------------------------------------- */

interface FsListEntry {
  name: string;
  isDir: boolean;
}

toolRegistry.register<{ path: string }, FsListEntry[]>({
  name: 'fs.list',
  description: 'List entries in a directory inside the workspace.',
  scope: 'workspace',
  tags: ['files', 'fs'],
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  invoke: async ({ path }) => {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('path must be a non-empty string');
    }
    if (!isTauri) throw new Error('Tauri fs not available');
    // Both Tauri v1 (children array) and v2 (isDirectory bool) shapes are
    // tolerated so this works across plugin generations.
    const raw = await tauriInvoke<
      Array<{ name: string; isDirectory?: boolean; children?: unknown }>
    >('plugin:fs|read_dir', { path });
    return raw.map((e) => ({
      name: e.name,
      isDir: e.isDirectory ?? Array.isArray(e.children),
    }));
  },
});

/* -------------------------------------------------------------------------- */
/*  shell.run                                                                 */
/* -------------------------------------------------------------------------- */

interface ShellRunInput {
  command: string;
  cwd?: string;
  rows?: number;
  cols?: number;
  env?: Record<string, string>;
}

toolRegistry.register<ShellRunInput, { sessionId: string }>({
  name: 'shell.run',
  description: 'Spawn a PTY shell session and return its session id.',
  scope: 'workspace',
  tags: ['terminal', 'shell'],
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      cwd: { type: 'string' },
      rows: { type: 'number' },
      cols: { type: 'number' },
      env: { type: 'object' },
    },
    required: ['command'],
  },
  invoke: async ({ command, cwd, rows = 30, cols = 100, env }) => {
    if (typeof command !== 'string' || command.length === 0) {
      throw new Error('command must be a non-empty string');
    }
    if (!isTauri) throw new Error('Terminal backend not available');
    return tauriInvoke<{ sessionId: string }>('terminal_spawn', {
      command,
      cwd,
      rows,
      cols,
      env,
    });
  },
});

/* -------------------------------------------------------------------------- */
/*  clipboard.copy                                                            */
/* -------------------------------------------------------------------------- */

toolRegistry.register<{ text: string }, void>({
  name: 'clipboard.copy',
  description: 'Copy text to the system clipboard.',
  tags: ['clipboard', 'system'],
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  invoke: async ({ text }) => {
    if (typeof text !== 'string') {
      throw new Error('text must be a string');
    }
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      throw new Error('Clipboard API not available');
    }
    await navigator.clipboard.writeText(text);
  },
});

/* -------------------------------------------------------------------------- */
/*  voice.speak                                                               */
/* -------------------------------------------------------------------------- */

interface VoiceSpeakInput {
  text: string;
  persona?: PersonaPreset;
  rate?: number;
  pitch?: number;
  volume?: number;
  lang?: string;
}

toolRegistry.register<VoiceSpeakInput, void>({
  name: 'voice.speak',
  description: 'Speak text via the platform speech synthesis API.',
  tags: ['voice', 'audio'],
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      persona: { type: 'string' },
      rate: { type: 'number' },
      pitch: { type: 'number' },
      volume: { type: 'number' },
      lang: { type: 'string' },
    },
    required: ['text'],
  },
  invoke: async ({ text, persona, rate, pitch, volume, lang }) => {
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('text must be a non-empty string');
    }
    await speakText(text, { persona, rate, pitch, volume, lang });
  },
});

/* -------------------------------------------------------------------------- */
/*  route.set                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Mirror of the Route enum in the Slice 13 contract. Kept local so this
 * module doesn't depend on slice-13 typing landing first.
 */
type Route =
  | 'chat'
  | 'terminal'
  | 'kanban'
  | 'schedule'
  | 'agents'
  | 'context'
  | 'skills'
  | 'benchmarks'
  | 'history'
  | 'tools'
  | 'files';

const VALID_ROUTES: ReadonlySet<string> = new Set<Route>([
  'chat',
  'terminal',
  'kanban',
  'schedule',
  'agents',
  'context',
  'skills',
  'benchmarks',
  'history',
  'tools',
  'files',
]);

toolRegistry.register<{ route: Route }, void>({
  name: 'route.set',
  description: 'Switch the main UI route (chat, terminal, kanban, skills, ...).',
  scope: 'workspace',
  tags: ['ui', 'navigation'],
  inputSchema: {
    type: 'object',
    properties: {
      route: { type: 'string', enum: Array.from(VALID_ROUTES) },
    },
    required: ['route'],
  },
  invoke: async ({ route }) => {
    if (typeof route !== 'string' || !VALID_ROUTES.has(route)) {
      throw new Error(`unknown route: ${String(route)}`);
    }
    const { useUIStore } = await import('@/stores/ui');
    // setRoute is added by Slice 13. Until that lands, surface a clear
    // error rather than crashing the caller.
    const state = useUIStore.getState() as unknown as {
      setRoute?: (r: Route) => void;
    };
    if (typeof state.setRoute !== 'function') {
      throw new Error('UI store does not expose setRoute yet');
    }
    state.setRoute(route);
  },
});

/* -------------------------------------------------------------------------- */
/*  notify                                                                    */
/* -------------------------------------------------------------------------- */

toolRegistry.register<{ title: string; description?: string }, void>({
  name: 'notify',
  description: 'Show a success toast in the app.',
  tags: ['ui', 'notifications'],
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
    },
    required: ['title'],
  },
  invoke: async ({ title, description }) => {
    if (typeof title !== 'string' || title.length === 0) {
      throw new Error('title must be a non-empty string');
    }
    const { toast } = await import('@/components/ui/toast');
    toast.success(title, description);
  },
});
