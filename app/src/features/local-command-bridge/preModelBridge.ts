import { executeInstantCommandWithReceipt } from '@/features/instant-command/execute';
import {
  createInstantCommandReceipt,
  type InstantCommandReceipt,
} from '@/features/instant-command/receipt';
import type {
  InstantCommand,
  InstantCommandExecutionContext,
} from '@/features/instant-command/types';
import { adaptLocalCommand } from './vibespaceAdapter';
import { cleanupResidual, routeLocalCommand } from './router';
import { buildLocalActionContext } from './modelContext';
import type {
  LocalBridgeExecution,
  LocalBridgeExecutionContext,
  LocalBridgeInput,
  LocalBridgeResult,
  LocalCommandAdaptation,
  LocalDetectedCommand,
  LocalRouteResult,
  LocalTextSpan,
} from './types';

const SAFE_IDENTITY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SUCCESS_STATUSES = new Set(['completed', 'queued']);
const MAX_CACHE_ENTRIES = 256;

function needsLocalClarification(route: LocalRouteResult): boolean {
  return (
    route.classification === 'ambiguous' ||
    route.ambiguous.some(
      ({ reason }) => reason === 'typo-intent-conflict' || reason === 'provider-conflict',
    )
  );
}

export type LocalCommandExecutor = (
  command: InstantCommand,
  context: InstantCommandExecutionContext,
) => Promise<InstantCommandReceipt>;

export type LocalCommandBridgeDependencies = Readonly<{
  route?: (text: string) => LocalRouteResult;
  adapt?: (command: LocalDetectedCommand) => LocalCommandAdaptation;
  execute?: LocalCommandExecutor;
  now?: () => number;
}>;

type CacheBinding = Readonly<{
  interactionId: string;
  originalText: string;
  accountId: string;
  workspaceId: string;
  projectId: string;
}>;

type CacheEntry = {
  readonly binding: CacheBinding;
  readonly promise: Promise<LocalBridgeResult>;
  readonly resolve: (result: LocalBridgeResult) => void;
  settled: boolean;
};

type CacheLookup =
  | Readonly<{ status: 'owner'; settle: (result: LocalBridgeResult) => void }>
  | Readonly<{ status: 'hit'; promise: Promise<LocalBridgeResult> }>
  | Readonly<{ status: 'mismatch' | 'capacity' }>;

function safeIdentity(value: unknown): value is string {
  return typeof value === 'string' && SAFE_IDENTITY.test(value);
}

function commandId(command: InstantCommand): string {
  if (command.kind === 'catalog') return command.id;
  if (command.kind === 'open-agent-cli') return 'terminal.open';
  if (command.kind === 'open-model-picker') return 'model.picker.open';
  if (command.kind === 'agent-message') return 'agent.message';
  if (command.kind === 'terminal-message') return 'terminal.message';
  if (command.kind === 'terminal-broadcast') return 'terminal.broadcast';
  return `legacy.${command.intent.kind}`;
}

function rejectedReceipt(
  command: InstantCommand,
  correlationId: string,
  now: () => number,
): InstantCommandReceipt {
  return createInstantCommandReceipt({
    commandId: commandId(command),
    correlationId,
    status: 'rejected',
    acceptedAtMs: now(),
    targetIds: [],
  });
}

function validExecutionContext(input: LocalBridgeInput): boolean {
  return (
    safeIdentity(input.interactionId) &&
    input.context.correlationId === input.interactionId &&
    safeIdentity(input.context.accountId) &&
    safeIdentity(input.context.workspaceId) &&
    safeIdentity(input.context.projectId)
  );
}

function correlationIdFor(interactionId: string, index: number, total: number): string {
  return total === 1 ? interactionId : `${interactionId}:cmd-${index + 1}`;
}

function freezeResult(result: LocalBridgeResult): LocalBridgeResult {
  return Object.freeze({
    ...result,
    detectedCommands: Object.freeze([...result.detectedCommands]),
    executableCommands: Object.freeze([...result.executableCommands]),
    unsupportedCommands: Object.freeze([...result.unsupportedCommands]),
    unexecutedCommands: Object.freeze([...result.unexecutedCommands]),
    receipts: Object.freeze([...result.receipts]),
    executions: Object.freeze([...result.executions]),
  });
}

function baseResult(input: LocalBridgeInput, route: LocalRouteResult): LocalBridgeResult {
  return freezeResult({
    originalText: input.text,
    modelText: input.text,
    detectedCommands: route.commands,
    executableCommands: [],
    unsupportedCommands: [],
    unexecutedCommands: [],
    receipts: [],
    executions: [],
    commandOnly: false,
    holdModel: false,
    classification: route.classification,
    interactionId: input.interactionId,
  });
}

export class LocalCommandBridgeCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #interactionKeys = new Map<string, string>();

  acquire(input: LocalBridgeInput): CacheLookup {
    const binding: CacheBinding = Object.freeze({
      interactionId: input.interactionId,
      originalText: input.text,
      accountId: input.context.accountId,
      workspaceId: input.context.workspaceId,
      projectId: input.context.projectId,
    });
    const key = JSON.stringify([
      binding.interactionId,
      binding.originalText,
      binding.accountId,
      binding.workspaceId,
      binding.projectId,
    ]);
    const priorKey = this.#interactionKeys.get(binding.interactionId);
    if (priorKey && priorKey !== key) return { status: 'mismatch' };
    const prior = this.#entries.get(key);
    if (prior) return { status: 'hit', promise: prior.promise };

    if (this.#entries.size >= MAX_CACHE_ENTRIES) {
      const removable = [...this.#entries.entries()].find(([, entry]) => entry.settled);
      if (!removable) return { status: 'capacity' };
      this.#entries.delete(removable[0]);
      this.#interactionKeys.delete(removable[1].binding.interactionId);
    }

    let resolve!: (result: LocalBridgeResult) => void;
    const promise = new Promise<LocalBridgeResult>((settle) => {
      resolve = settle;
    });
    const entry: CacheEntry = { binding, promise, resolve, settled: false };
    this.#entries.set(key, entry);
    this.#interactionKeys.set(binding.interactionId, key);
    return {
      status: 'owner',
      settle: (result) => {
        if (entry.settled) return;
        entry.settled = true;
        entry.resolve(result);
      },
    };
  }

  clear(interactionId?: string): void {
    if (!interactionId) {
      this.#entries.clear();
      this.#interactionKeys.clear();
      return;
    }
    const key = this.#interactionKeys.get(interactionId);
    if (key) this.#entries.delete(key);
    this.#interactionKeys.delete(interactionId);
  }
}

export class LocalCommandPreModelBridge {
  readonly #dependencies: Required<
    Pick<LocalCommandBridgeDependencies, 'route' | 'adapt' | 'execute' | 'now'>
  >;
  readonly #cache: LocalCommandBridgeCache;

  constructor(
    dependencies: LocalCommandBridgeDependencies = {},
    cache = new LocalCommandBridgeCache(),
  ) {
    this.#dependencies = {
      route: dependencies.route ?? routeLocalCommand,
      adapt: dependencies.adapt ?? adaptLocalCommand,
      execute: dependencies.execute ?? executeInstantCommandWithReceipt,
      now: dependencies.now ?? Date.now,
    };
    this.#cache = cache;
  }

  clear(interactionId?: string): void {
    this.#cache.clear(interactionId);
  }

  async process(input: LocalBridgeInput): Promise<LocalBridgeResult> {
    const boundInput: LocalBridgeInput = Object.freeze({
      ...input,
      context: Object.freeze({ ...input.context }),
    });
    if (typeof boundInput.text !== 'string' || !boundInput.text.trim()) {
      const emptyRoute = this.#dependencies.route(
        typeof boundInput.text === 'string' ? boundInput.text : '',
      );
      return baseResult(
        { ...boundInput, text: typeof boundInput.text === 'string' ? boundInput.text : '' },
        emptyRoute,
      );
    }

    const route = this.#dependencies.route(boundInput.text);
    if (needsLocalClarification(route)) {
      return freezeResult({
        ...baseResult(boundInput, route),
        holdModel: true,
        unexecutedCommands: route.commands,
        receipts: [
          createInstantCommandReceipt({
            commandId: 'local.ambiguous',
            correlationId: boundInput.interactionId,
            status: 'needs_clarification',
            acceptedAtMs: this.#dependencies.now(),
            targetIds: [],
            followUp: {
              kind: 'clarification',
              prompt: 'Specify the exact local action or provider before continuing.',
            },
          }),
        ],
      });
    }
    if (route.commands.length === 0) return baseResult(boundInput, route);

    const cache = this.#cache.acquire(boundInput);
    if (cache.status === 'hit') return cache.promise;
    if (cache.status === 'mismatch' || cache.status === 'capacity') {
      return freezeResult({
        ...baseResult(boundInput, route),
        holdModel: true,
        unexecutedCommands: route.commands,
      });
    }
    const settleOwner = (result: LocalBridgeResult): void => {
      if (cache.status === 'owner') cache.settle(result);
    };

    try {
      const mapped: Array<Readonly<{ detected: LocalDetectedCommand; command: InstantCommand }>> =
        [];
      const unsupported: LocalDetectedCommand[] = [];
      for (const detected of route.commands) {
        const adaptation = this.#dependencies.adapt(detected);
        if (adaptation.status === 'mapped') mapped.push({ detected, command: adaptation.command });
        else unsupported.push(detected);
      }

      if (!validExecutionContext(boundInput)) {
        const result = freezeResult({
          ...baseResult(boundInput, route),
          executableCommands: mapped.map(({ detected }) => detected),
          unsupportedCommands: unsupported,
          unexecutedCommands: mapped.map(({ detected }) => detected),
          holdModel: mapped.length > 0,
        });
        settleOwner(result);
        return result;
      }

      const executions: LocalBridgeExecution[] = [];
      const receipts: InstantCommandReceipt[] = [];
      const successfulSpans: LocalTextSpan[] = [];
      const unexecuted: LocalDetectedCommand[] = [];
      let holdModel = false;

      for (let index = 0; index < mapped.length; index += 1) {
        const current = mapped[index]!;
        const correlationId = correlationIdFor(boundInput.interactionId, index, mapped.length);
        const context: LocalBridgeExecutionContext = Object.freeze({
          ...boundInput.context,
          correlationId,
        });
        let receipt: InstantCommandReceipt;
        try {
          receipt = await this.#dependencies.execute(current.command, context);
        } catch {
          receipt = rejectedReceipt(current.command, correlationId, this.#dependencies.now);
        }
        const execution = Object.freeze({
          detected: current.detected,
          command: current.command,
          correlationId,
          receipt,
        });
        executions.push(execution);
        receipts.push(receipt);
        if (SUCCESS_STATUSES.has(receipt.status)) {
          successfulSpans.push({
            start: current.detected.sourceStart,
            end: current.detected.sourceEnd,
          });
          continue;
        }
        holdModel = true;
        unexecuted.push(...mapped.slice(index + 1).map(({ detected }) => detected));
        break;
      }

      const modelText = successfulSpans.length
        ? cleanupResidual(boundInput.text, successfulSpans)
        : boundInput.text;
      const localActionContext = buildLocalActionContext(executions);
      const commandOnly =
        !holdModel &&
        unsupported.length === 0 &&
        unexecuted.length === 0 &&
        route.classification === 'command_only' &&
        modelText.trim().length === 0;
      const result = freezeResult({
        originalText: boundInput.text,
        modelText,
        detectedCommands: route.commands,
        executableCommands: mapped.map(({ detected }) => detected),
        unsupportedCommands: unsupported,
        unexecutedCommands: unexecuted,
        receipts,
        executions,
        ...(localActionContext ? { localActionContext } : {}),
        commandOnly,
        holdModel,
        classification: route.classification,
        interactionId: boundInput.interactionId,
      });
      settleOwner(result);
      return result;
    } catch {
      const result = freezeResult({
        ...baseResult(boundInput, route),
        unexecutedCommands: route.commands,
        holdModel: true,
      });
      settleOwner(result);
      return result;
    }
  }
}

/** Model dispatch and raw steering must not skip local actions or clarification. */
export function requiresLocalCommandPreflight(text: string): boolean {
  try {
    const route = routeLocalCommand(text);
    return (
      needsLocalClarification(route) ||
      route.commands.some((command) => adaptLocalCommand(command).status === 'mapped')
    );
  } catch {
    // A parsing failure must use the normal fail-closed bridge, not raw steering.
    return true;
  }
}

/** Pure readiness check only; never executes or queues an action. */
export function canRunLocalCommandWithoutModel(text: string): boolean {
  try {
    const routed = routeLocalCommand(text);
    // The bridge removes only executable spans, never negated controls or
    // quoted text that the parser may omit from its standalone residual.
    const modelText = cleanupResidual(
      text,
      routed.commands.map((command) => ({
        start: command.sourceStart,
        end: command.sourceEnd,
      })),
    );
    return (
      routed.classification === 'command_only' &&
      modelText.trim().length === 0 &&
      routed.commands.length > 0 &&
      routed.commands.every((command) => adaptLocalCommand(command).status === 'mapped')
    );
  } catch {
    return false;
  }
}

export const sharedLocalCommandPreModelBridge = new LocalCommandPreModelBridge();

export async function runLocalCommandPreModelBridge(
  input: LocalBridgeInput,
  dependencies: LocalCommandBridgeDependencies = {},
): Promise<LocalBridgeResult> {
  if (Object.keys(dependencies).length > 0) {
    return new LocalCommandPreModelBridge(dependencies).process(input);
  }
  return sharedLocalCommandPreModelBridge.process(input);
}
