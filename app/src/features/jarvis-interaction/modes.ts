import type { JarvisInteractionMode } from './types';

const MODE_ORDER: JarvisInteractionMode[] = ['agent', 'plan', 'ask'];

/** User-facing permission tiers (composer + /permissions). */
export interface PermissionModeOption {
  id: JarvisInteractionMode;
  /** Short chip label */
  shortLabel: string;
  /** Panel title */
  title: string;
  /** One-line description */
  description: string;
  /** Accent token for theming */
  accent: 'cyan' | 'copper' | 'violet';
}

export const PERMISSION_MODE_OPTIONS: PermissionModeOption[] = [
  {
    id: 'agent',
    shortLabel: 'Agent Mode',
    title: 'Agent Mode',
    description: 'Full work mode — read/write files and run commands. Risky actions still need Approve.',
    accent: 'cyan',
  },
  {
    id: 'plan',
    shortLabel: 'Plan Mode',
    title: 'Plan Mode',
    description: 'Read-only planning. Inspect and plan first; build only when you approve the plan.',
    accent: 'copper',
  },
  {
    id: 'ask',
    shortLabel: 'Ask Mode',
    title: 'Ask Mode',
    description: 'Answers only. No edits, commands, plans, or action proposals.',
    accent: 'violet',
  },
];

export function cycleInteractionMode(mode: JarvisInteractionMode): JarvisInteractionMode {
  const index = MODE_ORDER.indexOf(mode);
  return MODE_ORDER[(index + 1) % MODE_ORDER.length] ?? 'agent';
}

export function interactionModeLabel(mode: JarvisInteractionMode): string {
  return permissionModeOption(mode).shortLabel;
}

export function interactionModeDescription(mode: JarvisInteractionMode): string {
  return permissionModeOption(mode).description;
}

export function permissionModeOption(mode: JarvisInteractionMode): PermissionModeOption {
  return PERMISSION_MODE_OPTIONS.find((o) => o.id === mode) ?? PERMISSION_MODE_OPTIONS[0]!;
}

/**
 * Map slash tokens to a mode.
 * Supports /ask, /plan, /permissions <mode>, /fullaccess, etc.
 */
export function modeFromSlashCommand(command: string): JarvisInteractionMode | null {
  const normalized = command.trim().toLowerCase().replace(/^\//, '');
  if (!normalized) return null;

  // /permissions full | read | ask | agent | plan
  if (normalized === 'permissions' || normalized.startsWith('permissions ')) {
    const arg = normalized.slice('permissions'.length).trim();
    if (!arg) return null; // open picker
    return parsePermissionModeArg(arg);
  }

  if (normalized === 'ask' || normalized === 'askonly' || normalized === 'ask-only') return 'ask';
  if (normalized === 'plan' || normalized === 'planning') return 'plan';
  if (normalized === 'agent' || normalized === 'multitask') return 'agent';
  return null;
}

export function parsePermissionModeArg(arg: string): JarvisInteractionMode | null {
  const a = arg.trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (!a) return null;
  if (a === 'agent') return 'agent';
  if (a === 'plan' || a === 'planning') return 'plan';
  if (a === 'ask' || a === 'ask only' || a === 'askonly') return 'ask';
  return null;
}

export function normalizeInteractionMode(value: unknown): JarvisInteractionMode {
  return value === 'ask' || value === 'plan' || value === 'agent' ? value : 'agent';
}
