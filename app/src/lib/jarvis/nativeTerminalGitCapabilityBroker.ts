import type { JarvisIssuedActionExecution } from './approvalEngine';
import { createNativeCapabilityBroker, type NativeCapabilityRequest } from './nativeCapabilityBroker';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u;
const ENVIRONMENT_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/u;
const RESULT_REF = /^jresult_[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const MAX_ARGUMENTS = 100;
const MAX_ARGUMENT_BYTES = 32 * 1024;
const MAX_TIMEOUT_MS = 15 * 60 * 1_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_MEMORY_BYTES = 4 * 1024 * 1024 * 1024;
const FORBIDDEN_ENVIRONMENT = /(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH|COOKIE|KEY)$/u;

export type NativeExecutionScope = Readonly<{
  accountId: string;
  projectId: string;
  runId: string;
  requestId: string;
  attemptNumber: number;
  workspaceRoot: string;
  parameterHash: `sha256:${string}`;
  now: number;
}>;

export type NativeCommandBounds = Readonly<{
  timeoutMs: number;
  outputLimitBytes: number;
  maxMemoryBytes: number;
  maxProcesses: number;
  maxCpuTimeMs: number;
}>;

export type NativeTerminalCommand = Readonly<{
  executable: string;
  arguments: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  environmentAllowlist: readonly string[];
  network: 'denied' | 'loopback' | 'unrestricted';
  bounds: NativeCommandBounds;
}>;

export type NativeTerminalHostReceipt = Readonly<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  startedAt: number;
  finishedAt: number;
  resultRef: `jresult_${string}`;
}>;

export type NativeTerminalReceipt = NativeTerminalHostReceipt &
  Readonly<{
    commandHash: `sha256:${string}`;
    evidenceRef: `jlive_${string}`;
  }>;

export type NativeGitOperation =
  | 'git.status'
  | 'git.diff'
  | 'git.worktree'
  | 'git.index'
  | 'git.commit'
  | 'git.fetch'
  | 'git.push'
  | 'git.ref';

export type NativeGitIntent =
  | Readonly<{ operation: 'git.status'; includeUntracked: boolean }>
  | Readonly<{ operation: 'git.diff'; staged: boolean; paths: readonly string[] }>
  | Readonly<{ operation: 'git.worktree'; action: 'apply_patch'; patchRef: string }>
  | Readonly<{ operation: 'git.index'; action: 'add' | 'remove'; paths: readonly string[] }>
  | Readonly<{ operation: 'git.commit'; message: string; allowEmpty: boolean }>
  | Readonly<{
      operation: 'git.fetch';
      remoteName: string;
      remoteUrl: string;
      refspecs: readonly string[];
    }>
  | Readonly<{
      operation: 'git.push';
      remoteName: string;
      remoteUrl: string;
      refspecs: readonly string[];
      force: false;
    }>
  | Readonly<{ operation: 'git.ref'; action: 'create'; name: string; target: string }>;

export type NativeGitRepositoryLease = Readonly<{
  accountId: string;
  projectId: string;
  repositoryRoot: string;
  repositoryHandle: string;
  ownerId: string;
  issuedAt: number;
  expiresAt: number;
  allowedOperations: readonly NativeGitOperation[];
  remotes: Readonly<Record<string, string>>;
}>;

export type NativeGitHostReceipt = Readonly<{
  operation: NativeGitOperation;
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  startedAt: number;
  finishedAt: number;
  headBefore: string;
  headAfter: string;
  indexBefore: string;
  indexAfter: string;
  changedPaths: readonly string[];
  resultRef: `jresult_${string}`;
}>;

export type NativeGitReceipt = NativeGitHostReceipt &
  Readonly<{ intentHash: `sha256:${string}`; evidenceRef: `jlive_${string}` }>;

export interface NativeTerminalGitExecutionPort {
  executeTerminal(input: {
    accountId: string;
    projectId: string;
    runId: string;
    command: NativeTerminalCommand;
    signal: AbortSignal;
  }): Promise<NativeTerminalHostReceipt>;
  resolveGitRepository(input: {
    accountId: string;
    projectId: string;
    repositoryRoot: string;
    ownerId: string;
    now: number;
  }): Promise<NativeGitRepositoryLease | null>;
  executeGit(input: {
    repositoryHandle: string;
    intent: NativeGitIntent;
    bounds: NativeCommandBounds;
    environment: Readonly<Record<string, never>>;
    disableHooks: true;
    disableCredentialHelpers: true;
    signal: AbortSignal;
  }): Promise<NativeGitHostReceipt>;
}

export interface NativeTerminalGitCapabilityBroker {
  executeTerminal(input: {
    scope: NativeExecutionScope;
    command: NativeTerminalCommand;
    execution: JarvisIssuedActionExecution;
  }): Promise<NativeTerminalReceipt>;
  executeGit(input: {
    scope: NativeExecutionScope;
    intent: NativeGitIntent;
    bounds: NativeCommandBounds;
    execution: JarvisIssuedActionExecution;
  }): Promise<NativeGitReceipt>;
}

function stableText(value: unknown, maximum = 8_192): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !CONTROL.test(value)
  );
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function hash(value: unknown): Promise<`sha256:${string}`> {
  const canonicalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(canonicalize);
    if (candidate && typeof candidate === 'object') {
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonicalize(child)]),
      );
    }
    return candidate;
  };
  const text = JSON.stringify(canonicalize(value));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

function normalizedAbsolute(path: string): string {
  if (!stableText(path, 2_000)) throw new Error('Invalid native execution path.');
  const windows = /^[A-Za-z]:[\\/]/u.test(path);
  const unc = /^\\\\[^\\]+\\[^\\]+/u.test(path);
  if (!windows && !unc && !path.startsWith('/')) {
    throw new Error('Native execution path must be absolute.');
  }
  const portable = path.replace(/\\/gu, '/');
  const prefix = windows ? portable.slice(0, 3) : unc ? '//' : '/';
  const rest = windows ? portable.slice(3) : unc ? portable.slice(2) : portable.slice(1);
  const segments: string[] = [];
  for (const segment of rest.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) throw new Error('Native execution path escapes its root.');
      segments.pop();
      continue;
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      throw new Error('Invalid native execution path segment.');
    }
    segments.push(segment);
  }
  const result = `${prefix}${segments.join('/')}`;
  return windows || unc ? result.toLocaleLowerCase('en-US') : result;
}

function assertInsideRoot(path: string, root: string): void {
  const canonicalPath = normalizedAbsolute(path);
  const canonicalRoot = normalizedAbsolute(root).replace(/\/+$/u, '');
  if (
    canonicalPath !== canonicalRoot &&
    !canonicalPath.startsWith(`${canonicalRoot}/`)
  ) {
    throw new Error('Native execution cwd is outside its workspace root.');
  }
}

function validateBounds(bounds: NativeCommandBounds): void {
  if (
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
    bounds.maxProcesses > 64 ||
    !Number.isSafeInteger(bounds.maxCpuTimeMs) ||
    bounds.maxCpuTimeMs < 1 ||
    bounds.maxCpuTimeMs > bounds.timeoutMs
  ) {
    throw new Error('Invalid native execution resource bounds.');
  }
}

function validateCommand(command: NativeTerminalCommand, workspaceRoot: string): void {
  if (
    !stableText(command.executable, 1_024) ||
    command.executable.includes('\n') ||
    /^(?:git(?:\.exe)?|(?:ba|z|fi)?sh|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)$/iu.test(
      command.executable.replace(/^.*[\\/]/u, ''),
    ) ||
    !Array.isArray(command.arguments) ||
    command.arguments.length > MAX_ARGUMENTS ||
    command.arguments.some(
      (argument) =>
        typeof argument !== 'string' ||
        argument.length > 8_192 ||
        CONTROL.test(argument),
    ) ||
    utf8Bytes(command.arguments.join('\u0000')) > MAX_ARGUMENT_BYTES
  ) {
    throw new Error('Invalid typed terminal executable or arguments.');
  }
  assertInsideRoot(command.cwd, workspaceRoot);
  validateBounds(command.bounds);
  if (!['denied', 'loopback', 'unrestricted'].includes(command.network)) {
    throw new Error('Invalid native terminal network scope.');
  }
  if (
    !Array.isArray(command.environmentAllowlist) ||
    new Set(command.environmentAllowlist).size !== command.environmentAllowlist.length ||
    command.environmentAllowlist.some(
      (key) => !ENVIRONMENT_KEY.test(key) || FORBIDDEN_ENVIRONMENT.test(key),
    )
  ) {
    throw new Error('Invalid native terminal environment allowlist.');
  }
  const entries = Object.entries(command.environment);
  if (
    entries.length > command.environmentAllowlist.length ||
    entries.some(
      ([key, value]) =>
        !command.environmentAllowlist.includes(key) ||
        !ENVIRONMENT_KEY.test(key) ||
        FORBIDDEN_ENVIRONMENT.test(key) ||
        typeof value !== 'string' ||
        value.length > 8_192 ||
        CONTROL.test(value),
    )
  ) {
    throw new Error('Native terminal environment exceeds its allowlist.');
  }
}

function validateScope(scope: NativeExecutionScope): void {
  if (
    !SAFE_ID.test(scope.accountId) ||
    !SAFE_ID.test(scope.projectId) ||
    !SAFE_ID.test(scope.runId) ||
    !SAFE_ID.test(scope.requestId) ||
    !Number.isSafeInteger(scope.attemptNumber) ||
    scope.attemptNumber < 1 ||
    !stableText(scope.workspaceRoot, 2_000) ||
    !SHA256.test(scope.parameterHash) ||
    !Number.isSafeInteger(scope.now) ||
    scope.now < 0
  ) {
    throw new Error('Invalid terminal or Git execution scope.');
  }
  normalizedAbsolute(scope.workspaceRoot);
}

function requestFor(
  scope: NativeExecutionScope,
  kind: 'terminal' | 'git',
  operation: string,
): NativeCapabilityRequest {
  validateScope(scope);
  return {
    capabilityId: kind === 'terminal' ? 'terminal.execution' : `git.${operation.slice(4)}`,
    capabilityVersion: 1,
    kind,
    operation,
    accountId: scope.accountId,
    runId: scope.runId,
    requestId: scope.requestId,
    attemptNumber: scope.attemptNumber,
    workspaceRoot: scope.workspaceRoot,
    parameterHash: scope.parameterHash,
  };
}

function validateHostReceipt(
  receipt: NativeTerminalHostReceipt,
  bounds: NativeCommandBounds,
): void {
  if (
    (receipt.exitCode !== null && !Number.isSafeInteger(receipt.exitCode)) ||
    typeof receipt.stdout !== 'string' ||
    typeof receipt.stderr !== 'string' ||
    !Number.isSafeInteger(receipt.stdoutBytes) ||
    !Number.isSafeInteger(receipt.stderrBytes) ||
    receipt.stdoutBytes !== utf8Bytes(receipt.stdout) ||
    receipt.stderrBytes !== utf8Bytes(receipt.stderr) ||
    receipt.stdoutBytes + receipt.stderrBytes > bounds.outputLimitBytes ||
    typeof receipt.truncated !== 'boolean' ||
    typeof receipt.timedOut !== 'boolean' ||
    typeof receipt.cancelled !== 'boolean' ||
    !Number.isSafeInteger(receipt.startedAt) ||
    !Number.isSafeInteger(receipt.finishedAt) ||
    receipt.startedAt < 0 ||
    receipt.finishedAt < receipt.startedAt ||
    receipt.finishedAt - receipt.startedAt > bounds.timeoutMs ||
    !RESULT_REF.test(receipt.resultRef) ||
    (receipt.timedOut && receipt.exitCode !== null) ||
    (receipt.cancelled && receipt.exitCode !== null)
  ) {
    throw new Error('Native execution returned invalid canonical evidence.');
  }
}

function relativePath(path: string): boolean {
  if (
    !stableText(path, 1_024) ||
    path.startsWith('/') ||
    path.startsWith('-') ||
    /^[A-Za-z]:/u.test(path)
  ) {
    return false;
  }
  const segments = path.replace(/\\/gu, '/').split('/');
  return segments.every(
    (segment) =>
      segment &&
      segment !== '.' &&
      segment !== '..' &&
      !segment.includes(':') &&
      !segment.endsWith('.') &&
      !segment.endsWith(' '),
  );
}

function validateGitIntent(intent: NativeGitIntent): void {
  if (intent.operation === 'git.status' && typeof intent.includeUntracked !== 'boolean') {
    throw new Error('Invalid Git status intent.');
  }
  if (intent.operation === 'git.diff' && typeof intent.staged !== 'boolean') {
    throw new Error('Invalid Git diff intent.');
  }
  if (intent.operation === 'git.diff' || intent.operation === 'git.index') {
    if (
      intent.paths.length > 500 ||
      new Set(intent.paths).size !== intent.paths.length ||
      intent.paths.some((path) => !relativePath(path))
    ) {
      throw new Error('Invalid Git path scope.');
    }
  }
  if (
    intent.operation === 'git.index' &&
    intent.action !== 'add' &&
    intent.action !== 'remove'
  ) {
    throw new Error('Invalid Git index intent.');
  }
  if (
    intent.operation === 'git.worktree' &&
    (intent.action !== 'apply_patch' ||
      !/^jartifact_[A-Za-z0-9_.:-]+$/u.test(intent.patchRef))
  ) {
    throw new Error('Git worktree mutation requires an immutable patch artifact.');
  }
  if (
    intent.operation === 'git.commit' &&
    (typeof intent.allowEmpty !== 'boolean' ||
      !stableText(intent.message, 10_000) ||
      /(?:^|\n)\s*(?:exec|hook|credential)\s*=/iu.test(intent.message))
  ) {
    throw new Error('Invalid Git commit intent.');
  }
  if (intent.operation === 'git.fetch' || intent.operation === 'git.push') {
    let remoteUrl: URL | null = null;
    try {
      remoteUrl = new URL(intent.remoteUrl);
    } catch {
      remoteUrl = null;
    }
    if (
      !SAFE_ID.test(intent.remoteName) ||
      !stableText(intent.remoteUrl, 2_000) ||
      !remoteUrl ||
      !['https:', 'ssh:'].includes(remoteUrl.protocol) ||
      Boolean(remoteUrl.password) ||
      Boolean(remoteUrl.search) ||
      Boolean(remoteUrl.hash) ||
      intent.refspecs.length === 0 ||
      intent.refspecs.length > 50 ||
      intent.refspecs.some(
        (refspec) =>
          !stableText(refspec, 1_024) ||
          refspec.startsWith('+') ||
          refspec.startsWith(':') ||
          refspec.startsWith('-') ||
          /\s/u.test(refspec) ||
          /(?:--force|--exec|credential|upload-pack|receive-pack)/iu.test(refspec),
      ) ||
      (intent.operation === 'git.push' && intent.force !== false)
    ) {
      throw new Error('Unsafe Git remote intent.');
    }
  }
  if (
    intent.operation === 'git.ref' &&
    (intent.action !== 'create' ||
      !/^(?!-)(?!.*\.\.)(?!.*@\{)(?!.*[~^:?*[\\\s])[\w./-]{1,255}$/u.test(intent.name) ||
      !GIT_OBJECT.test(intent.target))
  ) {
    throw new Error('Unsafe Git ref mutation.');
  }
}

function validateGitReceipt(
  receipt: NativeGitHostReceipt,
  intent: NativeGitIntent,
  bounds: NativeCommandBounds,
): void {
  validateHostReceipt(receipt, bounds);
  if (
    receipt.exitCode === null ||
    receipt.operation !== intent.operation ||
    !GIT_OBJECT.test(receipt.headBefore) ||
    !GIT_OBJECT.test(receipt.headAfter) ||
    !GIT_OBJECT.test(receipt.indexBefore) ||
    !GIT_OBJECT.test(receipt.indexAfter) ||
    receipt.changedPaths.length > 500 ||
    new Set(receipt.changedPaths).size !== receipt.changedPaths.length ||
    receipt.changedPaths.some((path) => !relativePath(path)) ||
    ((intent.operation === 'git.status' ||
      intent.operation === 'git.diff' ||
      intent.operation === 'git.fetch' ||
      intent.operation === 'git.push' ||
      intent.operation === 'git.worktree' ||
      intent.operation === 'git.ref') &&
      (receipt.headBefore !== receipt.headAfter || receipt.indexBefore !== receipt.indexAfter)) ||
    (intent.operation === 'git.index' && receipt.headBefore !== receipt.headAfter) ||
    (intent.operation === 'git.index' &&
      receipt.changedPaths.some((path) => !intent.paths.includes(path))) ||
    (intent.operation === 'git.commit' &&
      receipt.exitCode === 0 &&
      !intent.allowEmpty &&
      receipt.headBefore === receipt.headAfter)
  ) {
    throw new Error('Git host returned mismatched canonical evidence.');
  }
}

function immutableCommand(command: NativeTerminalCommand): NativeTerminalCommand {
  return Object.freeze({
    ...command,
    arguments: Object.freeze([...command.arguments]),
    environment: Object.freeze({ ...command.environment }),
    environmentAllowlist: Object.freeze([...command.environmentAllowlist]),
    bounds: Object.freeze({ ...command.bounds }),
  });
}

function immutableGitIntent(intent: NativeGitIntent): NativeGitIntent {
  if (intent.operation === 'git.diff' || intent.operation === 'git.index') {
    return Object.freeze({ ...intent, paths: Object.freeze([...intent.paths]) });
  }
  if (intent.operation === 'git.fetch' || intent.operation === 'git.push') {
    return Object.freeze({ ...intent, refspecs: Object.freeze([...intent.refspecs]) });
  }
  return Object.freeze({ ...intent });
}

function brokerFor(
  request: NativeCapabilityRequest,
  execution: JarvisIssuedActionExecution,
  risk: 'read-only' | 'safe-write' | 'external-side-effect' | 'credential-sensitive',
  producer: JarvisIssuedActionExecution['producerKind'],
  execute: (
    signal: AbortSignal,
  ) => Promise<{ resultRef: `jresult_${string}`; state?: 'completed' | 'degraded' }>,
) {
  const broker = createNativeCapabilityBroker({
    verifyIssuedRequest: (candidate, issued) =>
      issued === execution &&
      candidate.accountId === request.accountId &&
      candidate.runId === request.runId &&
      candidate.requestId === request.requestId &&
      candidate.attemptNumber === request.attemptNumber,
  });
  broker.register({
    id: request.capabilityId,
    version: 1,
    kind: request.kind,
    operations: [request.operation],
    risk,
    approval: risk === 'read-only' ? 'never' : 'always',
    producerKinds: [producer],
    async execute({ signal }) {
      const receipt = await execute(signal);
      return { state: receipt.state ?? 'completed', resultRef: receipt.resultRef };
    },
  });
  return broker;
}

export function createNativeTerminalGitCapabilityBroker(
  port: NativeTerminalGitExecutionPort,
): NativeTerminalGitCapabilityBroker {
  const claimedExecutions = new WeakSet<object>();
  const claim = (execution: JarvisIssuedActionExecution): void => {
    if (claimedExecutions.has(execution as object)) {
      throw new Error('Issued terminal or Git execution has already been claimed.');
    }
    claimedExecutions.add(execution as object);
  };
  const capabilityBroker: NativeTerminalGitCapabilityBroker = {
    async executeTerminal(input) {
      validateCommand(input.command, input.scope.workspaceRoot);
      const command = immutableCommand(input.command);
      validateCommand(command, input.scope.workspaceRoot);
      const commandHash = await hash(command);
      if (commandHash !== input.scope.parameterHash) {
        throw new Error('Terminal command does not match its approved parameter hash.');
      }
      const request = requestFor(input.scope, 'terminal', 'terminal.spawn');
      claim(input.execution);
      let captured: NativeTerminalHostReceipt | undefined;
      const broker = brokerFor(
        request,
        input.execution,
        command.network === 'unrestricted'
          ? 'external-side-effect'
          : 'safe-write',
        'terminal',
        async (signal) => {
          captured = await port.executeTerminal({
            accountId: input.scope.accountId,
            projectId: input.scope.projectId,
            runId: input.scope.runId,
            command,
            signal,
          });
          validateHostReceipt(captured, command.bounds);
          return {
            resultRef: captured.resultRef,
            state:
              captured.cancelled || captured.timedOut || captured.exitCode !== 0
                ? 'degraded'
                : 'completed',
          };
        },
      );
      const outcome = await broker.execute(request, input.execution);
      if (!captured) throw new Error('Native terminal evidence was not captured.');
      validateHostReceipt(captured, command.bounds);
      return Object.freeze({ ...captured, commandHash, evidenceRef: outcome.evidenceRef });
    },

    async executeGit(input) {
      const intent = immutableGitIntent(input.intent);
      const bounds = Object.freeze({ ...input.bounds });
      validateBounds(bounds);
      validateGitIntent(intent);
      const intentHash = await hash({ intent, bounds });
      if (intentHash !== input.scope.parameterHash) {
        throw new Error('Git intent does not match its approved parameter hash.');
      }
      const request = requestFor(input.scope, 'git', intent.operation);
      const lease = await port.resolveGitRepository({
        accountId: input.scope.accountId,
        projectId: input.scope.projectId,
        repositoryRoot: input.scope.workspaceRoot,
        ownerId: input.execution.ownerId,
        now: input.scope.now,
      });
      if (
        !lease ||
        lease.accountId !== input.scope.accountId ||
        lease.projectId !== input.scope.projectId ||
        lease.repositoryRoot !== input.scope.workspaceRoot ||
        lease.ownerId !== input.execution.ownerId ||
        !stableText(lease.repositoryHandle) ||
        !Number.isSafeInteger(lease.issuedAt) ||
        !Number.isSafeInteger(lease.expiresAt) ||
        lease.issuedAt < 0 ||
        lease.expiresAt <= lease.issuedAt ||
        !Array.isArray(lease.allowedOperations) ||
        lease.allowedOperations.length > 8 ||
        new Set(lease.allowedOperations).size !== lease.allowedOperations.length ||
        input.scope.now < lease.issuedAt ||
        input.scope.now >= lease.expiresAt ||
        !lease.allowedOperations.includes(intent.operation)
      ) {
        throw new Error('Matching live Git repository authority is required.');
      }
      if (intent.operation === 'git.fetch' || intent.operation === 'git.push') {
        if (lease.remotes[intent.remoteName] !== intent.remoteUrl) {
          throw new Error('Git remote substitution is forbidden.');
        }
      }
      claim(input.execution);
      let captured: NativeGitHostReceipt | undefined;
      const readOnly =
        intent.operation === 'git.status' || intent.operation === 'git.diff';
      const remote =
        intent.operation === 'git.fetch' || intent.operation === 'git.push';
      const broker = brokerFor(
        request,
        input.execution,
        remote ? 'credential-sensitive' : readOnly ? 'read-only' : 'safe-write',
        'terminal',
        async (signal) => {
          captured = await port.executeGit({
            repositoryHandle: lease.repositoryHandle,
            intent,
            bounds,
            environment: Object.freeze({}),
            disableHooks: true,
            disableCredentialHelpers: true,
            signal,
          });
          validateGitReceipt(captured, intent, bounds);
          return {
            resultRef: captured.resultRef,
            state: captured.exitCode === 0 ? 'completed' : 'degraded',
          };
        },
      );
      const outcome = await broker.execute(request, input.execution);
      if (!captured) throw new Error('Native Git evidence was not captured.');
      validateGitReceipt(captured, intent, bounds);
      return Object.freeze({ ...captured, intentHash, evidenceRef: outcome.evidenceRef });
    },
  };
  return Object.freeze(capabilityBroker);
}

export async function hashNativeTerminalCommand(
  command: NativeTerminalCommand,
): Promise<`sha256:${string}`> {
  return hash(command);
}

export async function hashNativeArguments(
  arguments_: readonly string[],
): Promise<`sha256:${string}`> {
  return hash(arguments_);
}

export function assertNativeTerminalCommand(
  command: NativeTerminalCommand,
  workspaceRoot: string,
): void {
  validateCommand(command, workspaceRoot);
}

export function assertNativeTerminalHostReceipt(
  receipt: NativeTerminalHostReceipt,
  bounds: NativeCommandBounds,
): void {
  validateHostReceipt(receipt, bounds);
}

export async function hashNativeGitIntent(
  intent: NativeGitIntent,
  bounds: NativeCommandBounds,
): Promise<`sha256:${string}`> {
  return hash({ intent, bounds });
}
