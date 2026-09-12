import {
  MAX_PANES,
  isReusableTerminalLeaf,
  type PaneNode,
  type TerminalLeafRuntimeEvidence,
} from './paneTree';
import {
  getTerminalCliPreset,
  type TerminalCliPresetId,
} from './terminalCliPresets';

type TerminalLeaf = Extract<PaneNode, { kind: 'leaf' }>;

export type TerminalFleetSelection =
  | { kind: 'preset'; presetId: TerminalCliPresetId }
  | { kind: 'custom'; command: string };

export interface TerminalFleetPlanInput {
  targetTotal: number;
  leaves: readonly TerminalLeaf[];
  runtimeByPaneId: Readonly<Record<string, TerminalLeafRuntimeEvidence | undefined>>;
  selection: TerminalFleetSelection;
  availableExecutables: ReadonlySet<string>;
  maxPanes?: number;
}

export type TerminalFleetAssignment =
  | { source: 'reuse'; paneId: string; command: string }
  | { source: 'append'; command: string };

export type TerminalFleetPlanResult =
  | {
      kind: 'ready';
      targetTotal: number;
      currentTotal: number;
      requestedSlots: number;
      reusedCount: number;
      appendedCount: number;
      skippedCount: number;
      capacityLimited: boolean;
      assignments: TerminalFleetAssignment[];
    }
  | {
      kind: 'unavailable';
      presetId: TerminalCliPresetId;
      executable: string;
      reason: 'executable-missing';
    }
  | {
      kind: 'invalid';
      reason: 'unknown-preset' | 'invalid-custom-command';
      detail: string;
    };

export type TerminalFleetCustomCommandValidation =
  | { ok: true; command: string }
  | {
      ok: false;
      reason: 'empty' | 'too-long' | 'control-character' | 'shell-control';
    };

export const MAX_TERMINAL_FLEET_CUSTOM_COMMAND_LENGTH = 512;

// Fleet custom commands are typed into a shell. Permit ordinary executable
// arguments and quoted paths, but reject chaining, redirects, substitution,
// and control characters so one requested launch cannot become a script.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;
const SHELL_CONTROL = /[;&|<>`]|\$\(|\$\{/;

export function validateTerminalFleetCustomCommand(
  input: string,
): TerminalFleetCustomCommandValidation {
  const command = input.trim();
  if (!command) return { ok: false, reason: 'empty' };
  if (command.length > MAX_TERMINAL_FLEET_CUSTOM_COMMAND_LENGTH) {
    return { ok: false, reason: 'too-long' };
  }
  if (CONTROL_CHARACTER.test(command)) {
    return { ok: false, reason: 'control-character' };
  }
  if (SHELL_CONTROL.test(command)) {
    return { ok: false, reason: 'shell-control' };
  }
  return { ok: true, command };
}

function normalizedNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function resolveFleetCommand(
  input: TerminalFleetPlanInput,
):
  | { ok: true; command: string }
  | Extract<TerminalFleetPlanResult, { kind: 'unavailable' | 'invalid' }> {
  if (input.selection.kind === 'preset') {
    const preset = getTerminalCliPreset(input.selection.presetId);
    if (!preset) {
      return {
        kind: 'invalid',
        reason: 'unknown-preset',
        detail: input.selection.presetId,
      };
    }
    if (!input.availableExecutables.has(preset.executable)) {
      return {
        kind: 'unavailable',
        presetId: preset.id,
        executable: preset.executable,
        reason: 'executable-missing',
      };
    }
    return { ok: true, command: preset.startupText };
  }

  const custom = validateTerminalFleetCustomCommand(input.selection.command);
  if (!custom.ok) {
    return {
      kind: 'invalid',
      reason: 'invalid-custom-command',
      detail: custom.reason,
    };
  }
  return custom;
}

export function planTerminalFleet(
  input: TerminalFleetPlanInput,
): TerminalFleetPlanResult {
  const commandResult = resolveFleetCommand(input);
  if (!('ok' in commandResult)) return commandResult;

  const reusable = input.leaves.filter((leaf) =>
    isReusableTerminalLeaf(leaf, input.runtimeByPaneId[leaf.id]),
  );
  const currentTotal = input.leaves.length - reusable.length;
  const targetTotal = normalizedNonNegativeInteger(input.targetTotal);
  const requestedSlots = Math.max(0, targetTotal - currentTotal);
  const reusedCount = Math.min(requestedSlots, reusable.length);
  const paneCap = Math.max(
    0,
    normalizedNonNegativeInteger(input.maxPanes ?? MAX_PANES),
  );
  const appendCapacity = Math.max(0, paneCap - input.leaves.length);
  const appendedCount = Math.min(
    Math.max(0, requestedSlots - reusedCount),
    appendCapacity,
  );
  const skippedCount = requestedSlots - reusedCount - appendedCount;
  const command = commandResult.command;
  const assignments: TerminalFleetAssignment[] = [
    ...reusable.slice(0, reusedCount).map((leaf) => ({
      source: 'reuse' as const,
      paneId: leaf.id,
      command,
    })),
    ...Array.from({ length: appendedCount }, () => ({
      source: 'append' as const,
      command,
    })),
  ];

  return {
    kind: 'ready',
    targetTotal,
    currentTotal,
    requestedSlots,
    reusedCount,
    appendedCount,
    skippedCount,
    capacityLimited: skippedCount > 0,
    assignments,
  };
}
