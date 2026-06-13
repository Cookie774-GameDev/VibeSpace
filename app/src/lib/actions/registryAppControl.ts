/**
 * Direct app mutations Jarvis can propose — voice engine, presets, prefs,
 * multi-step workflows, and missing shell shortcuts.
 */
import {
  Bot,
  Keyboard,
  Mic,
  Search,
  Settings2,
  Sparkles,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { parseToolStepsJson } from '@/features/tools/toolStore';
import type { VoiceEngine, VoicePresetId } from '@/types/common';
import type { SettingsTab } from '@/features/settings/settingsPrefetch';
import type { ActionDef, ActionRunContext } from './types';

const ok = (summary: string, data?: unknown) => ({ ok: true as const, summary, data });
const fail = (error: string) => ({ ok: false as const, error });

const VOICE_ENGINES: VoiceEngine[] = ['system', 'local', 'kokoro', 'deepgram'];
const VOICE_PRESET_IDS: VoicePresetId[] = ['jarvis-prime', 'aurora', 'atlas', 'nova', 'sentinel'];

function dispatchAfterCommit(name: string, detail?: unknown): void {
  setTimeout(() => window.dispatchEvent(new CustomEvent(name, { detail })), 0);
}

function openSettingsTab(tab: SettingsTab): void {
  useUIStore.getState().setSettingsOpen(true);
  dispatchAfterCommit('jarvis:settings:tab', { tab });
}

function normalizeEngine(value: unknown): VoiceEngine | null {
  if (typeof value !== 'string') return null;
  const engine = value.trim().toLowerCase() as VoiceEngine;
  return VOICE_ENGINES.includes(engine) ? engine : null;
}

function normalizePreset(value: unknown): VoicePresetId | null {
  if (typeof value !== 'string') return null;
  const preset = value.trim().toLowerCase() as VoicePresetId;
  return VOICE_PRESET_IDS.includes(preset) ? preset : null;
}

async function runWorkflowSteps(
  stepsJson: string,
  ctx: ActionRunContext,
): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  let steps;
  try {
    steps = parseToolStepsJson(stepsJson);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Invalid workflow steps JSON.');
  }

  const { getBuiltinAction } = await import('./registry');
  const summaries: string[] = [];

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    const def = getBuiltinAction(step.action);
    if (!def) {
      return fail(`Step ${index + 1} references an unknown built-in action: ${step.action}.`);
    }
    const result = await def.run(step.params ?? {}, ctx);
    if (!result.ok) {
      return fail(`Step ${index + 1} (${step.action}) failed: ${result.error}`);
    }
    if (result.summary) summaries.push(result.summary);
  }

  return ok(
    summaries.length > 0
      ? summaries.join(' ')
      : `Ran ${steps.length} workflow step${steps.length === 1 ? '' : 's'}.`,
  );
}

function makeSettingsTabAction(id: string, label: string, tab: SettingsTab, icon: LucideIcon): ActionDef {
  return {
    id,
    category: 'settings',
    label,
    description: `Open Settings on the ${label.replace(/^Open Settings → /, '')} tab.`,
    icon,
    params: [],
    run: async () => {
      openSettingsTab(tab);
      return ok(`Opened Settings → ${tab}.`);
    },
  };
}

export const APP_CONTROL_ACTIONS: ActionDef[] = [
  makeSettingsTabAction('settings.jarvisactions', 'Open Settings → Jarvis Actions', 'jarvisactions', Zap),

  {
    id: 'voice.setEngine',
    category: 'voice',
    label: 'Set voice engine',
    description:
      'Switch TTS/STT engine: system (OS voices), local (installed voices), kokoro (on-device), or deepgram (cloud).',
    icon: Mic,
    params: [
      {
        key: 'engine',
        label: 'Engine',
        type: 'select',
        required: true,
        options: VOICE_ENGINES.map((value) => ({ value, label: value })),
      },
      {
        key: 'openSettings',
        label: 'Open Settings → Voice',
        type: 'boolean',
        help: 'When true, also opens the Voice settings tab so the user can see the change.',
      },
    ],
    run: async (params) => {
      const engine = normalizeEngine(params.engine);
      if (!engine) return fail(`Engine must be one of: ${VOICE_ENGINES.join(', ')}.`);
      if (params.openSettings === true) openSettingsTab('voice');
      useAuthStore.getState().setVoiceEngine(engine);
      return ok(`Voice engine set to ${engine}.`);
    },
  },

  {
    id: 'voice.setPreset',
    category: 'voice',
    label: 'Set voice character',
    description: 'Switch the spoken voice preset (Jarvis Prime, Aurora/Friday, Atlas, Nova, Sentinel).',
    icon: Mic,
    params: [
      {
        key: 'preset',
        label: 'Preset',
        type: 'select',
        required: true,
        options: VOICE_PRESET_IDS.map((value) => ({ value, label: value })),
      },
      {
        key: 'openSettings',
        label: 'Open Settings → Voice',
        type: 'boolean',
      },
    ],
    run: async (params) => {
      const preset = normalizePreset(params.preset);
      if (!preset) return fail(`Preset must be one of: ${VOICE_PRESET_IDS.join(', ')}.`);
      if (params.openSettings === true) openSettingsTab('voice');
      useAuthStore.getState().setVoicePreset(preset);
      return ok(`Voice preset set to ${preset}.`);
    },
  },

  {
    id: 'voice.configure',
    category: 'voice',
    label: 'Configure voice (engine + preset)',
    description:
      'One-shot voice setup. Use for requests like "switch voice to Deepgram" or "use Friday voice with Kokoro".',
    icon: Settings2,
    params: [
      {
        key: 'engine',
        label: 'Engine',
        type: 'select',
        options: VOICE_ENGINES.map((value) => ({ value, label: value })),
      },
      {
        key: 'preset',
        label: 'Preset',
        type: 'select',
        options: VOICE_PRESET_IDS.map((value) => ({ value, label: value })),
      },
      {
        key: 'openSettings',
        label: 'Open Settings → Voice',
        type: 'boolean',
        default: true,
        help: 'Opens the Voice tab so the user can review keys and previews.',
      },
    ],
    run: async (params) => {
      const engine = params.engine !== undefined ? normalizeEngine(params.engine) : null;
      const preset = params.preset !== undefined ? normalizePreset(params.preset) : null;
      if (!engine && !preset) {
        return fail('Provide at least one of engine or preset.');
      }
      if (params.openSettings !== false) openSettingsTab('voice');
      if (engine) useAuthStore.getState().setVoiceEngine(engine);
      if (preset) useAuthStore.getState().setVoicePreset(preset);
      const parts = [
        engine ? `engine=${engine}` : null,
        preset ? `preset=${preset}` : null,
      ].filter(Boolean);
      return ok(`Voice updated (${parts.join(', ')}).`);
    },
  },

  {
    id: 'voice.setHandsFree',
    category: 'voice',
    label: 'Set hands-free listening',
    description: 'Toggle whether the voice panel listens continuously between turns.',
    icon: Mic,
    params: [
      {
        key: 'enabled',
        label: 'Hands-free',
        type: 'boolean',
        required: true,
      },
    ],
    run: async (params) => {
      const enabled = params.enabled === true;
      useAuthStore.getState().setVoiceAutoListenOnOpen(enabled);
      return ok(enabled ? 'Hands-free voice on.' : 'Click-to-talk voice on.');
    },
  },

  {
    id: 'voice.setAutoApprove',
    category: 'voice',
    label: 'Set voice auto-approve',
    description: 'When on, Jarvis runs proposed app commands from voice without Approve cards.',
    icon: Zap,
    params: [
      {
        key: 'enabled',
        label: 'Auto-approve voice commands',
        type: 'boolean',
        required: true,
      },
    ],
    run: async (params) => {
      const enabled = params.enabled === true;
      useAuthStore.getState().setVoiceAutoApproveActions(enabled);
      return ok(enabled ? 'Voice auto-approve on.' : 'Voice auto-approve off.');
    },
  },

  {
    id: 'preferences.setChatAutoApprove',
    category: 'chat',
    label: 'Set chat auto-approve',
    description: 'When on, typed chat runs Jarvis action proposals without Approve cards (Shift+Tab toggles).',
    icon: Zap,
    params: [
      {
        key: 'enabled',
        label: 'Auto-approve chat commands',
        type: 'boolean',
        required: true,
      },
    ],
    run: async (params) => {
      const enabled = params.enabled === true;
      useAuthStore.getState().setJarvisAutoApprove(enabled);
      return ok(enabled ? 'Chat auto-approve on.' : 'Chat auto-approve off.');
    },
  },

  {
    id: 'host.openCommandPalette',
    category: 'host',
    label: 'Open command palette',
    description: 'Open the global command palette (same as Cmd+K).',
    icon: Search,
    params: [],
    run: async () => {
      useUIStore.getState().setPaletteOpen(true);
      return ok('Opened command palette.');
    },
  },

  {
    id: 'host.openAssistant',
    category: 'host',
    label: 'Open Jarvis Assistant bar',
    description: 'Open the deterministic Jarvis Assistant command bar (same as Mod+J).',
    icon: Bot,
    params: [],
    run: async () => {
      useUIStore.getState().setAssistantOpen(true);
      return ok('Opened Jarvis Assistant.');
    },
  },

  {
    id: 'workflow.run',
    category: 'host',
    label: 'Run multi-step workflow',
    description:
      'Run several built-in actions in order. Use for complex requests in one approval, e.g. open Settings → Voice then switch engine to deepgram.',
    icon: Workflow,
    params: [
      {
        key: 'stepsJson',
        label: 'Steps JSON',
        type: 'string',
        required: true,
        help: 'JSON array: [{"action":"settings.voice","params":{}},{"action":"voice.setEngine","params":{"engine":"deepgram"}}]',
      },
    ],
    run: async (params, ctx) => {
      const stepsJson = typeof params.stepsJson === 'string' ? params.stepsJson.trim() : '';
      if (!stepsJson) return fail('stepsJson is required.');
      return runWorkflowSteps(stepsJson, ctx);
    },
  },
];

export const APP_CONTROL_ACTION_COUNT = APP_CONTROL_ACTIONS.length;
