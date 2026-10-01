import { describe, expect, it, vi } from 'vitest';
import type { JarvisIssuedActionExecution } from '@/lib/jarvis/approvalEngine';
import {
  createNativeTerminalGitCapabilityBroker,
  type NativeCommandBounds,
  type NativeGitHostReceipt,
  type NativeGitIntent,
  type NativeTerminalCommand,
  type NativeTerminalGitExecutionPort,
} from '@/lib/jarvis/nativeTerminalGitCapabilityBroker';
import { BrowserChatApprovalBroker } from './approvalBroker';
import {
  createBrowserChatTerminalGitAdapter,
  type BrowserChatTerminalGitAuthority,
  type BrowserChatTerminalGitError,
} from './browserChatTerminalGitAdapter';
import type {
  BrowserChatCapabilityId,
  BrowserChatCapabilityLease,
  BrowserChatPermissionProfile,
} from './permissionRegistry';

const ACCOUNT = 'account-a';
const WORKSPACE = 'workspace-a';
const PROJECT = 'project-a';
const ROOT = 'C:\\fixture';

const BOUNDS: NativeCommandBounds = Object.freeze({
  timeoutMs: 5_000,
  outputLimitBytes: 16 * 1024,
  maxMemoryBytes: 256 * 1024 * 1024,
  maxProcesses: 4,
  maxCpuTimeMs: 4_000,
});

const COMMAND: NativeTerminalCommand = Object.freeze({
  executable: 'npm',
  arguments: Object.freeze(['test', '--', 'fixture.test.ts']),
  cwd: ROOT,
  environment: Object.freeze({ CI: '1' }),
  environmentAllowlist: Object.freeze(['CI']),
  network: 'denied',
  bounds: BOUNDS,
});

function browserBroker(): BrowserChatApprovalBroker {
  const capabilities = new Set<BrowserChatCapabilityId>([
    'terminal.execute',
    'git.status',
    'git.checkpoint',
  ]);
  const profile: BrowserChatPermissionProfile = {
    version: 1,
    accountId: ACCOUNT,
    workspaceId: WORKSPACE,
    plan: 'full_local_developer',
    overrides: {},
    updatedAt: 1,
  };
  let sequence = 0;
  return new BrowserChatApprovalBroker({
    profile,
    grantedCapabilities: capabilities,
    availableCapabilities: capabilities,
    providerCapabilities: capabilities,
    providerBridgeAvailable: true,
    leaseIdFactory: () => `native-lease-${++sequence}`,
    requestIdFactory: () => `native-request-${++sequence}`,
  });
}

function lease(
  approvalBroker: BrowserChatApprovalBroker,
  capabilityId: BrowserChatCapabilityId,
  now = 100,
): BrowserChatCapabilityLease {
  const decision = approvalBroker.authorize(capabilityId, {
    now,
    ttlMs: 5_000,
    approvalTimeoutMs: 5_000,
  });
  if (decision.kind === 'granted') return decision.lease;
  if (decision.kind === 'approval_required') {
    return approvalBroker.approve(decision.request.id, { now: now + 1, ttlMs: 5_000 });
  }
  throw new Error(`expected ${capabilityId} authority`);
}

function issuedExecution(input: {
  capabilityId: string;
  actionId: string;
  runId: string;
  requestId: string;
  parameterHash: string;
  signal: AbortSignal;
}): JarvisIssuedActionExecution {
  return {
    approval: {
      id: `approval-${input.requestId}`,
      runId: input.runId,
      requestId: input.requestId,
      attemptNumber: 1,
      capabilityId: input.capabilityId,
      actionId: input.actionId,
      actionVersion: 1,
      paramsHash: input.parameterHash,
      status: 'consumed',
    },
    producerKind: 'terminal',
    ownerId: 'browser-chat',
    initialLiveProof: {
      accountId: ACCOUNT,
      runId: input.runId,
      requestId: input.requestId,
      attemptNumber: 1,
      proofRef: `jlive_start-${input.requestId}`,
    },
    beginExternalEffect: (begin) => ({
      kind: 'committed',
      value: begin(input.signal),
    }),
    recordResult: async ({ resultRef }) => ({
      kind: 'committed',
      value: { proofRef: `jlive_${resultRef.slice('jresult_'.length)}` },
    }),
  } as JarvisIssuedActionExecution;
}

function authority(): BrowserChatTerminalGitAuthority {
  let sequence = 0;
  return {
    async authorizeTerminal(input) {
      const requestId = `terminal-${++sequence}`;
      return {
        scope: {
          accountId: input.accountId,
          projectId: input.projectId,
          runId: input.taskId,
          requestId,
          attemptNumber: 1,
          workspaceRoot: ROOT,
          parameterHash: input.commandHash,
          now: input.now,
        },
        execution: issuedExecution({
          capabilityId: 'terminal.execution',
          actionId: 'terminal.spawn',
          runId: input.taskId,
          requestId,
          parameterHash: input.commandHash,
          signal: input.signal,
        }),
      };
    },
    async authorizeGit(input) {
      const requestId = `git-${++sequence}`;
      return {
        scope: {
          accountId: input.accountId,
          projectId: input.projectId,
          runId: input.taskId,
          requestId,
          attemptNumber: 1,
          workspaceRoot: ROOT,
          parameterHash: input.intentHash,
          now: input.now,
        },
        execution: issuedExecution({
          capabilityId: input.intent.operation,
          actionId: input.intent.operation,
          runId: input.taskId,
          requestId,
          parameterHash: input.intentHash,
          signal: input.signal,
        }),
      };
    },
  };
}

function nativePort() {
  const executeTerminal = vi.fn<NativeTerminalGitExecutionPort['executeTerminal']>(
    async ({ signal }) => {
      if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
      return {
        exitCode: 0,
        stdout: 'passed\n',
        stderr: '',
        stdoutBytes: 7,
        stderrBytes: 0,
        truncated: false,
        timedOut: false,
        cancelled: false,
        startedAt: 100,
        finishedAt: 110,
        resultRef: 'jresult_terminal-fixture',
      };
    },
  );
  const resolveGitRepository = vi.fn<NativeTerminalGitExecutionPort['resolveGitRepository']>(
    async ({ accountId, projectId, repositoryRoot, ownerId }) => ({
      accountId,
      projectId,
      repositoryRoot,
      repositoryHandle: 'repository-handle',
      ownerId,
      issuedAt: 1,
      expiresAt: 5_000,
      allowedOperations: ['git.status', 'git.commit'],
      remotes: {},
    }),
  );
  const executeGit = vi.fn<NativeTerminalGitExecutionPort['executeGit']>(
    async ({ intent, signal }) => {
      if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
      const mutates = intent.operation === 'git.commit';
      const receipt: NativeGitHostReceipt = {
        operation: intent.operation,
        exitCode: 0,
        stdout: mutates ? '[main abc1234] checkpoint\n' : 'clean\n',
        stderr: '',
        stdoutBytes: mutates ? 26 : 6,
        stderrBytes: 0,
        truncated: false,
        timedOut: false,
        cancelled: false,
        startedAt: 120,
        finishedAt: 130,
        headBefore: 'a'.repeat(40),
        headAfter: (mutates ? 'b' : 'a').repeat(40),
        indexBefore: 'c'.repeat(64),
        indexAfter: 'c'.repeat(64),
        changedPaths: [],
        resultRef: `jresult_${mutates ? 'git-commit' : 'git-status'}`,
      };
      return receipt;
    },
  );
  const port: NativeTerminalGitExecutionPort = {
    executeTerminal,
    resolveGitRepository,
    executeGit,
  };
  return { port, executeTerminal, resolveGitRepository, executeGit };
}

function adapterFixture() {
  const approvalBroker = browserBroker();
  const native = nativePort();
  const executionAuthority = authority();
  const adapter = createBrowserChatTerminalGitAdapter({
    accountId: ACCOUNT,
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    workspaceRoot: ROOT,
    approvalBroker,
    nativeBroker: createNativeTerminalGitCapabilityBroker(native.port),
    authority: executionAuthority,
  });
  return { adapter, approvalBroker, native, executionAuthority };
}

function errorCode(error: unknown): string | undefined {
  return (error as BrowserChatTerminalGitError | undefined)?.code;
}

describe('Browser Chat terminal/Git adapter', () => {
  it('executes one exact typed terminal command through the canonical native broker', async () => {
    const { adapter, approvalBroker } = adapterFixture();

    const receipt = await adapter.executeTerminal({
      lease: lease(approvalBroker, 'terminal.execute'),
      taskId: 'task-terminal',
      command: COMMAND,
      now: 100,
    });

    expect(receipt).toMatchObject({
      exitCode: 0,
      stdout: 'passed\n',
      cancelled: false,
      timedOut: false,
      commandHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      evidenceRef: 'jlive_terminal-fixture',
    });
    expect(JSON.stringify(receipt)).not.toContain(ROOT);
  });

  it('separates Git read authority from checkpoint mutation authority', async () => {
    const { adapter, approvalBroker, native } = adapterFixture();
    const status: NativeGitIntent = { operation: 'git.status', includeUntracked: true };

    await expect(
      adapter.executeGit({
        lease: lease(approvalBroker, 'git.status'),
        taskId: 'task-status',
        intent: status,
        bounds: BOUNDS,
        now: 100,
      }),
    ).resolves.toMatchObject({
      operation: 'git.status',
      stdout: 'clean\n',
      headBefore: 'a'.repeat(40),
      headAfter: 'a'.repeat(40),
    });

    const commit: NativeGitIntent = {
      operation: 'git.commit',
      message: 'Browser Chat checkpoint',
      allowEmpty: false,
    };
    await expect(
      adapter.executeGit({
        lease: lease(approvalBroker, 'git.status', 200),
        taskId: 'task-commit',
        intent: commit,
        bounds: BOUNDS,
        now: 200,
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === 'capability_mismatch');
    expect(native.executeGit).toHaveBeenCalledTimes(1);

    await expect(
      adapter.executeGit({
        lease: lease(approvalBroker, 'git.checkpoint', 300),
        taskId: 'task-commit',
        intent: commit,
        bounds: BOUNDS,
        now: 300,
      }),
    ).resolves.toMatchObject({
      operation: 'git.commit',
      headBefore: 'a'.repeat(40),
      headAfter: 'b'.repeat(40),
    });
    expect(native.executeGit).toHaveBeenCalledTimes(2);
  });

  it('rejects network Git operations that have no dedicated Browser Chat capability', async () => {
    const { adapter, approvalBroker, native } = adapterFixture();
    const push: NativeGitIntent = {
      operation: 'git.push',
      remoteName: 'origin',
      remoteUrl: 'https://example.test/repository.git',
      refspecs: ['refs/heads/main:refs/heads/main'],
      force: false,
    };

    await expect(
      adapter.executeGit({
        lease: lease(approvalBroker, 'git.checkpoint'),
        taskId: 'task-push',
        intent: push,
        bounds: BOUNDS,
        now: 100,
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === 'operation_unsupported');
    expect(native.resolveGitRepository).not.toHaveBeenCalled();
    expect(native.executeGit).not.toHaveBeenCalled();
  });

  it('rejects unsafe Git paths before requesting local execution authority', async () => {
    const { adapter, approvalBroker, executionAuthority } = adapterFixture();
    const authorizeGit = vi.spyOn(executionAuthority, 'authorizeGit');
    const unsafe: NativeGitIntent = {
      operation: 'git.diff',
      staged: false,
      paths: ['../private.txt'],
    };

    await expect(
      adapter.executeGit({
        lease: lease(approvalBroker, 'git.status'),
        taskId: 'task-unsafe',
        intent: unsafe,
        bounds: BOUNDS,
        now: 100,
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === 'request_invalid');
    expect(authorizeGit).not.toHaveBeenCalled();
  });

  it('cancels a live native terminal operation when Browser Chat authority is revoked', async () => {
    const { adapter, approvalBroker, native } = adapterFixture();
    native.executeTerminal.mockImplementationOnce(
      ({ signal }) =>
        new Promise((_, reject) => {
          const abort = () => reject(new DOMException('cancelled', 'AbortError'));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        }),
    );
    const pending = adapter.executeTerminal({
      lease: lease(approvalBroker, 'terminal.execute'),
      taskId: 'task-cancel',
      command: COMMAND,
      now: 100,
    });

    await vi.waitFor(() => expect(native.executeTerminal).toHaveBeenCalledTimes(1));
    approvalBroker.revoke();

    await expect(pending).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === 'operation_cancelled',
    );
  });
});
