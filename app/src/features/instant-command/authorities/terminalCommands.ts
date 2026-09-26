import { resolveTerminalTarget } from '../terminalTargetResolver';
import type { InstantResult, LiveTerminalTarget, TerminalSelector } from '../types';

export type TerminalCommandRequest = Readonly<{
  id: string;
  slots: Readonly<Record<string, unknown>>;
  promptState?: 'ready' | 'approval' | 'question' | 'password' | 'ssh' | 'unknown';
  confirmation?: Readonly<{ commandId: string; targetId: string; nonce: string }>;
}>;

export type TerminalCommandAuthorityPort = Readonly<{
  readTargets: () => Promise<LiveTerminalTarget[]>;
  consumeConfirmation?: (
    confirmation: NonNullable<TerminalCommandRequest['confirmation']>,
  ) => Promise<boolean>;
  dispatch: (
    request: TerminalCommandRequest,
    targets: readonly LiveTerminalTarget[],
  ) => Promise<InstantResult>;
}>;

function failure(code: InstantResult['code'], message: string): InstantResult {
  return { ok: false, code, message };
}

const MAX_TARGETS = 1_024;
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_RECEIPT_MESSAGE_LENGTH = 500;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const PROMPT_INTERLOCKS = new Set(['approval', 'question', 'password', 'ssh', 'unknown']);
const PROMPT_STATES = new Set(['ready', ...PROMPT_INTERLOCKS]);
const CONFIRM_COMMANDS = new Set([
  'terminal.restart',
  'terminal.stop',
  'terminal.close',
  'agent.stop',
]);
const TERMINAL_COMMANDS = new Set([
  'terminal.focus',
  'terminal.list',
  'terminal.status',
  'terminal.split',
  'terminal.rename',
  'terminal.move_project',
  'terminal.restart',
  'terminal.clear',
  'terminal.stop',
  'terminal.close',
  'terminal.cancel_queued',
  'agent.message',
  'agent.broadcast',
  'agent.status',
  'agent.continue',
  'agent.stop',
  'agent.assign_role',
  'agent.give_context',
]);
const FAILURE_CODES = new Set<InstantResult['code']>([
  'target_missing',
  'target_ambiguous',
  'target_not_ready',
  'confirmation_required',
  'queue_failed',
]);

function boundedText(value: unknown, maximum = MAX_IDENTIFIER_LENGTH): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function validTarget(target: unknown): target is LiveTerminalTarget {
  if (!target || typeof target !== 'object') return false;
  const candidate = target as LiveTerminalTarget;
  const identity = candidate.processIdentity;
  return (
    boundedText(candidate.sessionId) &&
    boundedText(candidate.paneId) &&
    (candidate.projectId === null || boundedText(candidate.projectId)) &&
    Number.isSafeInteger(candidate.ordinal) &&
    candidate.ordinal > 0 &&
    candidate.ordinal <= MAX_TARGETS &&
    [candidate.label, candidate.agentSlug, candidate.provider, candidate.command].every(
      (value) => value === undefined || boundedText(value, 512),
    ) &&
    Boolean(identity) &&
    identity.projectId === candidate.projectId &&
    boundedText(identity.processInstanceId) &&
    Number.isSafeInteger(identity.pid) &&
    identity.pid > 0 &&
    Number.isSafeInteger(identity.processStartedAt) &&
    identity.processStartedAt > 0 &&
    boundedText(identity.runtimeGeneration)
  );
}

function validTargetSnapshot(targets: unknown): targets is LiveTerminalTarget[] {
  if (!Array.isArray(targets) || targets.length > MAX_TARGETS || !targets.every(validTarget)) {
    return false;
  }
  return (
    new Set(targets.map((target) => target.sessionId)).size === targets.length &&
    new Set(targets.map((target) => target.paneId)).size === targets.length
  );
}

function validDispatchResult(result: unknown): result is InstantResult {
  if (!result || typeof result !== 'object') return false;
  const receipt = result as InstantResult;
  if (!boundedText(receipt.message, MAX_RECEIPT_MESSAGE_LENGTH)) return false;
  if (receipt.ok) return receipt.code === 'queued' || receipt.code === 'opened';
  return FAILURE_CODES.has(receipt.code);
}

export async function executeTerminalCommand(
  request: TerminalCommandRequest,
  port: TerminalCommandAuthorityPort,
  signal?: AbortSignal,
): Promise<InstantResult> {
  try {
    if (signal?.aborted) return failure('queue_failed', 'The instant command deadline elapsed.');
    if (!boundedText(request.id, 64) || !TERMINAL_COMMANDS.has(request.id)) {
      return failure('queue_failed', 'Unknown terminal command.');
    }
    if (
      request.promptState !== undefined &&
      (typeof request.promptState !== 'string' || !PROMPT_STATES.has(request.promptState))
    ) {
      return failure('target_not_ready', 'Terminal prompt state is unavailable.');
    }
    if (!request.slots || typeof request.slots !== 'object' || Array.isArray(request.slots)) {
      return failure('queue_failed', 'Terminal command input is invalid.');
    }
    const targets = await port.readTargets();
    if (signal?.aborted) return failure('queue_failed', 'The instant command deadline elapsed.');
    if (!validTargetSnapshot(targets)) {
      return failure('queue_failed', 'Terminal snapshot is unavailable.');
    }

    if (request.id === 'terminal.list') {
      return {
        ok: true,
        code: 'opened',
        message:
          targets.length === 1
            ? '1 terminal is available.'
            : `${targets.length} terminals are available.`,
      };
    }

    const selector = request.slots.selector as TerminalSelector | undefined;
    if (!selector) return failure('target_missing', 'Name one exact terminal.');
    const resolution = resolveTerminalTarget(selector, targets);
    if (resolution.kind === 'missing')
      return failure('target_missing', 'No matching terminal is available.');
    if (resolution.kind === 'ambiguous') {
      return failure('target_ambiguous', 'That terminal selector matches more than one terminal.');
    }
    const selected = resolution.kind === 'many' ? resolution.targets : [resolution.target];

    if (request.id === 'terminal.status' || request.id === 'agent.status') {
      if (selected.length !== 1)
        return failure('target_ambiguous', 'Name one terminal for status.');
      const target = selected[0]!;
      const provider = target.provider
        ? ` (${target.provider[0]!.toUpperCase()}${target.provider.slice(1)},`
        : ' (';
      return {
        ok: true,
        code: 'opened',
        message: `Terminal ${target.ordinal} is available${provider} pane ${target.paneId}, session ${target.sessionId}).`,
      };
    }

    if (request.promptState && PROMPT_INTERLOCKS.has(request.promptState)) {
      return failure(
        'target_not_ready',
        `Terminal input is blocked by a ${request.promptState} prompt.`,
      );
    }
    if (CONFIRM_COMMANDS.has(request.id)) {
      const targetId = selected[0]?.sessionId;
      const confirmation = request.confirmation;
      if (
        selected.length !== 1 ||
        !confirmation ||
        confirmation.commandId !== request.id ||
        confirmation.targetId !== targetId ||
        typeof confirmation.nonce !== 'string' ||
        !confirmation.nonce.trim() ||
        confirmation.nonce.length > 200 ||
        /[\u0000-\u001f\u007f]/u.test(confirmation.nonce)
      ) {
        return failure(
          'confirmation_required',
          'Confirm this exact terminal action before it runs.',
        );
      }
      if (!port.consumeConfirmation || !(await port.consumeConfirmation(confirmation))) {
        return failure(
          'confirmation_required',
          'That terminal confirmation is expired or already used.',
        );
      }
      if (signal?.aborted) return failure('queue_failed', 'The instant command deadline elapsed.');
    }
    if (signal?.aborted) return failure('queue_failed', 'The instant command deadline elapsed.');
    const result = await port.dispatch(request, selected);
    return validDispatchResult(result)
      ? result
      : failure('queue_failed', 'Terminal authority receipt is unavailable.');
  } catch {
    return failure('queue_failed', 'Terminal command failed.');
  }
}
