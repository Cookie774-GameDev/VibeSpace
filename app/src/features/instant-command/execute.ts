import type { AssistantIntent, AssistantResult } from '@/features/assistant/intents';
import { executeIntent } from '@/features/assistant/execute';
import {
  enqueueTerminalCommandBatch,
  type TerminalCommand,
} from '@/features/terminals/terminalCommandQueue';
import { getTerminalCliPreset } from '@/features/terminals/terminalCliPresets';
import { openCodeLaunchCommand } from './openCodeLaunch';
import type { TerminalRef } from '@/features/terminals/terminalRefs';
import { useUIStore } from '@/stores/ui';
import { readLiveTargetSnapshot } from './targetSnapshot';
import { resolveTerminalTarget } from './terminalTargetResolver';
import { InstantCommandLedger, type InstantCommandBinding } from './commandLedger';
import { runWithInstantCommandDeadline } from './deadline';
import { createInstantCommandReceipt, type InstantCommandReceipt } from './receipt';
import {
  executeNavigationCommand,
  type NavigationCommandRequest,
} from './authorities/navigationCommands';
import {
  executeTerminalCommand,
  type TerminalCommandRequest,
} from './authorities/terminalCommands';
import { executeMediaCommand, type MediaCommandRequest } from './authorities/mediaCommands';
import {
  executeFabricCommand,
  isTerminalPeerFabricReady,
  type FabricAuthorityRequest,
} from './authorities/terminalPeerFabric';
import type {
  InstantCommand,
  InstantCommandExecutionContext,
  InstantResult,
  LiveTerminalTarget,
} from './types';

type ShellCommandInput = Omit<Extract<TerminalCommand, { kind: 'shell' }>, 'id' | 'kind'>;

export type InstantCommandDependencies = Readonly<{
  executeLegacy: (intent: AssistantIntent) => Promise<AssistantResult>;
  enqueueBatch: (commands: readonly ShellCommandInput[]) => readonly string[];
  routeToTerminal: () => void;
  openModelPicker: () => void;
  readTargets: () => Promise<LiveTerminalTarget[]>;
  executeNavigation: (
    request: NavigationCommandRequest,
    signal?: AbortSignal,
  ) => Promise<InstantResult>;
  executeTerminal?: (
    request: TerminalCommandRequest,
    signal?: AbortSignal,
  ) => Promise<InstantResult>;
  executeMedia?: (request: MediaCommandRequest, signal?: AbortSignal) => Promise<InstantResult>;
  openFabricSetup?: () => void;
  isFabricReady?: () => Promise<boolean>;
  executeFabric?: (request: FabricAuthorityRequest) => Promise<InstantResult>;
}>;

const defaultDependencies: InstantCommandDependencies = {
  executeLegacy: executeIntent,
  enqueueBatch: enqueueTerminalCommandBatch,
  routeToTerminal: () => useUIStore.getState().setRoute('terminal'),
  openModelPicker: () => {
    useUIStore.getState().setSettingsOpen(true);
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('jarvis:settings:tab', { detail: { tab: 'providers' } }),
      );
    }, 0);
  },
  readTargets: readLiveTargetSnapshot,
  executeNavigation: (request, signal) => executeNavigationCommand(request, undefined, signal),
  executeTerminal: (request, signal) =>
    executeTerminalCommand(
      request,
      {
        readTargets: readLiveTargetSnapshot,
        dispatch: async () => ({
          ok: false,
          code: 'queue_failed',
          message: 'That Instant Command is not available yet.',
        }),
      },
      signal,
    ),
  executeMedia: (request, signal) => executeMediaCommand(request, undefined, signal),
  openFabricSetup: () => {
    useUIStore.getState().setRoute('tools');
    setTimeout(() => window.dispatchEvent(new Event('jarvis:terminal-peer-fabric:open')), 0);
  },
  isFabricReady: () => isTerminalPeerFabricReady(),
  executeFabric: (request) => executeFabricCommand(request),
};

function targetRef(target: LiveTerminalTarget): TerminalRef {
  return {
    paneId: target.paneId,
    sessionId: target.sessionId,
    projectId: target.projectId,
    ...(target.label ? { label: target.label } : {}),
    ...(target.provider || target.command ? { command: target.provider ?? target.command } : {}),
    ...(target.agentSlug ? { agentSlug: target.agentSlug } : {}),
    expectedProcess: target.processIdentity,
  };
}

export async function executeInstantCommand(
  command: InstantCommand,
  dependencies: InstantCommandDependencies = defaultDependencies,
  signal?: AbortSignal,
  context?: InstantCommandExecutionContext,
): Promise<InstantResult> {
  if (signal?.aborted) {
    return { ok: false, code: 'queue_failed', message: 'The instant command deadline elapsed.' };
  }
  if (command.kind === 'legacy') {
    const result = await dependencies.executeLegacy(command.intent);
    return { ok: result.ok, code: result.ok ? 'legacy' : 'legacy_failed', message: result.message };
  }
  if (command.kind === 'catalog') {
    if (command.family === 'navigation') {
      return dependencies.executeNavigation({ id: command.id, slots: command.slots }, signal);
    }
    if (command.family === 'terminal' || command.family === 'agent') {
      const executeTerminalDependency =
        dependencies.executeTerminal ?? defaultDependencies.executeTerminal!;
      return executeTerminalDependency({ id: command.id, slots: command.slots }, signal);
    }
    if (command.family === 'media') {
      const executeMediaDependency = dependencies.executeMedia ?? defaultDependencies.executeMedia!;
      return executeMediaDependency({ ...command.slots, id: command.id }, signal);
    }
    if (command.family === 'team') {
      const ready = await (dependencies.isFabricReady ?? defaultDependencies.isFabricReady!)();
      if (!ready) {
        return {
          ok: false,
          code: 'queue_failed',
          message: 'Terminal Peer Fabric requires the compatible bundled native capability.',
        };
      }
      if (command.id === 'team.connect') {
        (dependencies.openFabricSetup ?? defaultDependencies.openFabricSetup!)();
        return { ok: true, code: 'opened', message: 'Opened Terminal Peer Fabric setup.' };
      }
      if (command.id === 'team.message' || command.id === 'team.broadcast') {
        return {
          ok: false,
          code: 'confirmation_required',
          message: 'Approve this exact team prompt from Terminal Peer Fabric before delivery.',
        };
      }
      if (!context) {
        return { ok: false, code: 'queue_failed', message: 'Team command scope is unavailable.' };
      }
      const executeFabricDependency =
        dependencies.executeFabric ?? defaultDependencies.executeFabric!;
      return executeFabricDependency({
        id: command.id,
        correlationId: context.correlationId,
        accountId: context.accountId,
        targetIds: [],
      });
    }
    {
      return {
        ok: false,
        code: 'queue_failed',
        message: 'That Instant Command is not available yet.',
      };
    }
  }
  if (command.kind === 'open-model-picker') {
    if (signal?.aborted) {
      return { ok: false, code: 'queue_failed', message: 'The instant command deadline elapsed.' };
    }
    dependencies.openModelPicker();
    return { ok: true, code: 'opened', message: 'Opened provider and model selection.' };
  }
  try {
    if (command.kind === 'open-agent-cli') {
      const preset = getTerminalCliPreset(command.provider);
      if (!preset || !Number.isInteger(command.count) || command.count < 1 || command.count > 10) {
        return { ok: false, code: 'queue_failed', message: 'That terminal CLI is not supported.' };
      }
      if (signal?.aborted) {
        return {
          ok: false,
          code: 'queue_failed',
          message: 'The instant command deadline elapsed.',
        };
      }
      const configured = command.modelId !== undefined || command.prompt !== undefined;
      const startupText =
        configured &&
        command.provider === 'opencode' &&
        command.count === 1 &&
        typeof command.modelId === 'string' &&
        (command.prompt === undefined || typeof command.prompt === 'string')
          ? openCodeLaunchCommand(command.modelId, command.prompt)
          : configured
            ? null
            : preset.startupText;
      if (!startupText)
        return {
          ok: false,
          code: 'queue_failed',
          message: 'An exact OpenCode model and a valid optional message are required.',
        };
      dependencies.enqueueBatch(
        Array.from({ length: command.count }, (_, index) => ({
          command: startupText,
          ...(configured ? { preserveExisting: true } : {}),
          label: index === 0 ? command.provider : `${command.provider} ${index + 1}`,
          target: 'new' as const,
        })),
      );
      dependencies.routeToTerminal();
      return {
        ok: true,
        code: 'queued',
        message: `Queued ${command.count} ${command.provider} terminal${command.count === 1 ? '' : 's'}.`,
      };
    }

    const liveTargets = await dependencies.readTargets();
    if (signal?.aborted) {
      return { ok: false, code: 'queue_failed', message: 'The instant command deadline elapsed.' };
    }
    const resolution = resolveTerminalTarget(command.target, liveTargets);
    if (resolution.kind === 'missing') {
      return {
        ok: false,
        code: 'target_missing',
        message: 'No verified live terminal matches that target.',
      };
    }
    if (resolution.kind === 'ambiguous') {
      return {
        ok: false,
        code: 'target_ambiguous',
        message: 'More than one live terminal matches that target.',
      };
    }
    const targets = resolution.kind === 'one' ? [resolution.target] : resolution.targets;
    dependencies.enqueueBatch([
      { command: command.payload, target: 'refs', refs: targets.map(targetRef) },
    ]);
    dependencies.routeToTerminal();
    return {
      ok: true,
      code: 'queued',
      message: `Queued command for ${targets.length} terminal${targets.length === 1 ? '' : 's'}.`,
    };
  } catch {
    return {
      ok: false,
      code: 'queue_failed',
      message: 'The terminal command could not be queued.',
    };
  }
}

const sharedLedger = new InstantCommandLedger();

function commandId(command: InstantCommand): string {
  if (command.kind === 'catalog') return command.id;
  if (command.kind === 'legacy') return `legacy.${command.intent.kind}`;
  if (command.kind === 'open-agent-cli') return 'terminal.open';
  if (command.kind === 'open-model-picker') return 'model.picker.open';
  if (command.kind === 'agent-message') return 'agent.message';
  if (command.kind === 'terminal-broadcast') return 'terminal.broadcast';
  return 'terminal.message';
}

function digestCommand(command: InstantCommand): string {
  const source = JSON.stringify(command);
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function targetIds(command: InstantCommand): readonly string[] {
  if (command.kind === 'catalog') {
    const target = command.slots.route ?? command.slots.section;
    return typeof target === 'string' ? Object.freeze([target]) : Object.freeze([]);
  }
  if (command.kind === 'open-agent-cli') return Object.freeze([command.provider]);
  if (
    command.kind === 'agent-message' ||
    command.kind === 'terminal-message' ||
    command.kind === 'terminal-broadcast'
  ) {
    return Object.freeze(
      [command.target.sessionId, command.target.paneId, command.target.agentSlug]
        .filter((value): value is string => Boolean(value))
        .sort(),
    );
  }
  return Object.freeze([]);
}

function resultStatus(result: InstantResult): InstantCommandReceipt['status'] {
  if (result.code === 'queued') return 'queued';
  if (result.code === 'confirmation_required') return 'needs_confirmation';
  if (result.code === 'target_missing' || result.code === 'target_ambiguous') {
    return 'needs_clarification';
  }
  if (result.ok) return 'completed';
  return 'rejected';
}

function safeFollowUpPrompt(message: string, fallback: string): string {
  return message.trim() && message.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(message)
    ? message
    : fallback;
}

function receiptFor(
  id: string,
  context: InstantCommandExecutionContext,
  result: InstantResult,
  targets: readonly string[],
  acceptedAtMs: number,
): InstantCommandReceipt {
  const status = resultStatus(result);
  return createInstantCommandReceipt({
    commandId: id,
    correlationId: context.correlationId,
    status,
    acceptedAtMs,
    targetIds: targets,
    ...(status === 'needs_confirmation'
      ? {
          followUp: {
            kind: 'confirmation' as const,
            prompt: safeFollowUpPrompt(result.message, 'Confirm this exact Instant Command.'),
          },
        }
      : status === 'needs_clarification'
        ? {
            followUp: {
              kind: 'clarification' as const,
              prompt: safeFollowUpPrompt(result.message, 'Clarify the exact command target.'),
            },
          }
        : {}),
  });
}

export async function executeInstantCommandWithReceipt(
  command: InstantCommand,
  context: InstantCommandExecutionContext,
  dependencies: InstantCommandDependencies = defaultDependencies,
  ledger: InstantCommandLedger = sharedLedger,
): Promise<InstantCommandReceipt> {
  const id = commandId(command);
  const targets = targetIds(command);
  const acceptedAtMs = Date.now();
  const binding: InstantCommandBinding = {
    accountId: context.accountId,
    workspaceId: context.workspaceId,
    projectId: context.projectId,
    commandId: id,
    targetIds: targets,
    argumentDigest: digestCommand(command),
  };
  try {
    return await ledger.runOnce(context.correlationId, binding, async () => {
      const deadline = await runWithInstantCommandDeadline(
        (signal) => executeInstantCommand(command, dependencies, signal, context),
        500,
      );
      if (deadline.status === 'timed_out') {
        return createInstantCommandReceipt({
          commandId: id,
          correlationId: context.correlationId,
          status: 'timed_out',
          acceptedAtMs,
          targetIds: targets,
        });
      }
      return receiptFor(id, context, deadline.value, targets, acceptedAtMs);
    });
  } catch {
    return createInstantCommandReceipt({
      commandId: id,
      correlationId: context.correlationId,
      status: 'rejected',
      acceptedAtMs,
      targetIds: targets,
    });
  }
}
