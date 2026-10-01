import type { JarvisIssuedActionExecution } from '@/lib/jarvis/approvalEngine';
import {
  assertNativeGitIntent,
  assertNativeTerminalCommand,
  hashNativeGitIntent,
  hashNativeTerminalCommand,
  type NativeCommandBounds,
  type NativeExecutionScope,
  type NativeGitIntent,
  type NativeTerminalCommand,
  type NativeTerminalGitCapabilityBroker,
} from '@/lib/jarvis/nativeTerminalGitCapabilityBroker';
import type { BrowserChatApprovalBroker } from './approvalBroker';
import type { BrowserChatCapabilityLease } from './permissionRegistry';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const READ_GIT_OPERATIONS = new Set<NativeGitIntent['operation']>(['git.status', 'git.diff']);
const CHECKPOINT_GIT_OPERATIONS = new Set<NativeGitIntent['operation']>([
  'git.worktree',
  'git.index',
  'git.commit',
  'git.ref',
]);

export type BrowserChatTerminalGitErrorCode =
  | 'scope_invalid'
  | 'capability_mismatch'
  | 'request_invalid'
  | 'operation_unsupported'
  | 'operation_cancelled'
  | 'authority_denied'
  | 'runtime_denied'
  | 'result_invalid';

export class BrowserChatTerminalGitError extends Error {
  constructor(readonly code: BrowserChatTerminalGitErrorCode) {
    super(`Browser Chat terminal/Git operation rejected: ${code}.`);
    this.name = 'BrowserChatTerminalGitError';
  }
}

type AuthorizedExecution = Readonly<{
  scope: NativeExecutionScope;
  execution: JarvisIssuedActionExecution;
}>;

export interface BrowserChatTerminalGitAuthority {
  authorizeTerminal(
    input: Readonly<{
      accountId: string;
      workspaceId: string;
      projectId: string;
      taskId: string;
      workspaceRoot: string;
      command: NativeTerminalCommand;
      commandHash: `sha256:${string}`;
      now: number;
      signal: AbortSignal;
    }>,
  ): Promise<AuthorizedExecution | null>;
  authorizeGit(
    input: Readonly<{
      accountId: string;
      workspaceId: string;
      projectId: string;
      taskId: string;
      workspaceRoot: string;
      intent: NativeGitIntent;
      bounds: NativeCommandBounds;
      intentHash: `sha256:${string}`;
      now: number;
      signal: AbortSignal;
    }>,
  ): Promise<AuthorizedExecution | null>;
}

type AdapterOptions = Readonly<{
  accountId: string;
  workspaceId: string;
  projectId: string;
  workspaceRoot: string;
  approvalBroker: BrowserChatApprovalBroker;
  nativeBroker: NativeTerminalGitCapabilityBroker;
  authority: BrowserChatTerminalGitAuthority;
}>;

function validAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 2 &&
    value.length <= 2_000 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    (/^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\]+\\[^\\]+/u.test(value) || value.startsWith('/'))
  );
}

function validateOptions(options: AdapterOptions): void {
  if (
    !SAFE_ID.test(options.accountId) ||
    !SAFE_ID.test(options.workspaceId) ||
    !SAFE_ID.test(options.projectId) ||
    !validAbsolutePath(options.workspaceRoot)
  ) {
    throw new BrowserChatTerminalGitError('scope_invalid');
  }
}

function validateBounds(bounds: NativeCommandBounds): void {
  if (
    !bounds ||
    typeof bounds !== 'object' ||
    !Number.isSafeInteger(bounds.timeoutMs) ||
    bounds.timeoutMs < 1 ||
    bounds.timeoutMs > MAX_TIMEOUT_MS ||
    !Number.isSafeInteger(bounds.outputLimitBytes) ||
    bounds.outputLimitBytes < 1 ||
    bounds.outputLimitBytes > MAX_OUTPUT_BYTES ||
    !Number.isSafeInteger(bounds.maxMemoryBytes) ||
    bounds.maxMemoryBytes < 16 * 1024 * 1024 ||
    bounds.maxMemoryBytes > MAX_MEMORY_BYTES ||
    !Number.isSafeInteger(bounds.maxProcesses) ||
    bounds.maxProcesses < 1 ||
    bounds.maxProcesses > 32 ||
    !Number.isSafeInteger(bounds.maxCpuTimeMs) ||
    bounds.maxCpuTimeMs < 1 ||
    bounds.maxCpuTimeMs > bounds.timeoutMs
  ) {
    throw new BrowserChatTerminalGitError('request_invalid');
  }
}

function begin(
  options: AdapterOptions,
  lease: BrowserChatCapabilityLease,
  capabilityId: 'terminal.execute' | 'git.status' | 'git.checkpoint',
  now: number,
) {
  if (lease.capabilityId !== capabilityId) {
    throw new BrowserChatTerminalGitError('capability_mismatch');
  }
  if (lease.accountId !== options.accountId || lease.workspaceId !== options.workspaceId) {
    throw new BrowserChatTerminalGitError('scope_invalid');
  }
  return options.approvalBroker.begin(lease, { now });
}

function validateTaskAndNow(taskId: string, now: number): void {
  if (!SAFE_ID.test(taskId) || !Number.isSafeInteger(now) || now < 0) {
    throw new BrowserChatTerminalGitError('request_invalid');
  }
}

function validateAuthorizedExecution(
  authorized: AuthorizedExecution | null,
  options: AdapterOptions,
  taskId: string,
  parameterHash: string,
  now: number,
): asserts authorized is AuthorizedExecution {
  if (!authorized) throw new BrowserChatTerminalGitError('authority_denied');
  const { scope } = authorized;
  if (
    !scope ||
    scope.accountId !== options.accountId ||
    scope.projectId !== options.projectId ||
    scope.runId !== taskId ||
    scope.workspaceRoot !== options.workspaceRoot ||
    scope.parameterHash !== parameterHash ||
    scope.now !== now ||
    !SAFE_ID.test(scope.requestId) ||
    !Number.isSafeInteger(scope.attemptNumber) ||
    scope.attemptNumber < 1 ||
    !HASH.test(scope.parameterHash) ||
    !authorized.execution ||
    typeof authorized.execution !== 'object'
  ) {
    throw new BrowserChatTerminalGitError('authority_denied');
  }
}

function gitCapability(intent: NativeGitIntent): 'git.status' | 'git.checkpoint' {
  if (READ_GIT_OPERATIONS.has(intent.operation)) return 'git.status';
  if (CHECKPOINT_GIT_OPERATIONS.has(intent.operation)) return 'git.checkpoint';
  throw new BrowserChatTerminalGitError('operation_unsupported');
}

export function createBrowserChatTerminalGitAdapter(options: AdapterOptions) {
  validateOptions(options);

  return Object.freeze({
    async executeTerminal(input: {
      lease: BrowserChatCapabilityLease;
      taskId: string;
      command: NativeTerminalCommand;
      now?: number;
    }) {
      const now = input.now ?? Date.now();
      validateTaskAndNow(input.taskId, now);
      try {
        validateBounds(input.command.bounds);
        assertNativeTerminalCommand(input.command, options.workspaceRoot);
      } catch (error) {
        if (error instanceof BrowserChatTerminalGitError) throw error;
        throw new BrowserChatTerminalGitError('request_invalid');
      }
      const operation = begin(options, input.lease, 'terminal.execute', now);
      try {
        const commandHash = await hashNativeTerminalCommand(input.command);
        if (operation.signal.aborted) {
          throw new BrowserChatTerminalGitError('operation_cancelled');
        }
        const authorized = await options.authority.authorizeTerminal({
          accountId: options.accountId,
          workspaceId: options.workspaceId,
          projectId: options.projectId,
          taskId: input.taskId,
          workspaceRoot: options.workspaceRoot,
          command: input.command,
          commandHash,
          now,
          signal: operation.signal,
        });
        validateAuthorizedExecution(authorized, options, input.taskId, commandHash, now);
        const receipt = await options.nativeBroker.executeTerminal({
          scope: authorized.scope,
          command: input.command,
          execution: authorized.execution,
        });
        if (
          operation.signal.aborted ||
          receipt.commandHash !== commandHash ||
          receipt.stdoutBytes + receipt.stderrBytes > input.command.bounds.outputLimitBytes
        ) {
          throw new BrowserChatTerminalGitError(
            operation.signal.aborted ? 'operation_cancelled' : 'result_invalid',
          );
        }
        return receipt;
      } catch (error) {
        if (error instanceof BrowserChatTerminalGitError) throw error;
        throw new BrowserChatTerminalGitError(
          operation.signal.aborted ? 'operation_cancelled' : 'runtime_denied',
        );
      } finally {
        operation.finish();
      }
    },

    async executeGit(input: {
      lease: BrowserChatCapabilityLease;
      taskId: string;
      intent: NativeGitIntent;
      bounds: NativeCommandBounds;
      now?: number;
    }) {
      const now = input.now ?? Date.now();
      validateTaskAndNow(input.taskId, now);
      validateBounds(input.bounds);
      if (!input.intent || typeof input.intent !== 'object') {
        throw new BrowserChatTerminalGitError('request_invalid');
      }
      const capabilityId = gitCapability(input.intent);
      try {
        assertNativeGitIntent(input.intent);
      } catch {
        throw new BrowserChatTerminalGitError('request_invalid');
      }
      const operation = begin(options, input.lease, capabilityId, now);
      try {
        const intentHash = await hashNativeGitIntent(input.intent, input.bounds);
        if (operation.signal.aborted) {
          throw new BrowserChatTerminalGitError('operation_cancelled');
        }
        const authorized = await options.authority.authorizeGit({
          accountId: options.accountId,
          workspaceId: options.workspaceId,
          projectId: options.projectId,
          taskId: input.taskId,
          workspaceRoot: options.workspaceRoot,
          intent: input.intent,
          bounds: input.bounds,
          intentHash,
          now,
          signal: operation.signal,
        });
        validateAuthorizedExecution(authorized, options, input.taskId, intentHash, now);
        const receipt = await options.nativeBroker.executeGit({
          scope: authorized.scope,
          intent: input.intent,
          bounds: input.bounds,
          execution: authorized.execution,
        });
        if (
          operation.signal.aborted ||
          receipt.intentHash !== intentHash ||
          receipt.operation !== input.intent.operation ||
          receipt.stdoutBytes + receipt.stderrBytes > input.bounds.outputLimitBytes
        ) {
          throw new BrowserChatTerminalGitError(
            operation.signal.aborted ? 'operation_cancelled' : 'result_invalid',
          );
        }
        return receipt;
      } catch (error) {
        if (error instanceof BrowserChatTerminalGitError) throw error;
        throw new BrowserChatTerminalGitError(
          operation.signal.aborted ? 'operation_cancelled' : 'runtime_denied',
        );
      } finally {
        operation.finish();
      }
    },
  });
}
