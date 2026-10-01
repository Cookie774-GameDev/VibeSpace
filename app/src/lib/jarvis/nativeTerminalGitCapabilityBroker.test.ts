import { describe, expect, it, vi } from 'vitest';
import {
  createNativeTerminalGitCapabilityBroker,
  hashNativeGitIntent,
  hashNativeTerminalCommand,
  type NativeCommandBounds,
  type NativeExecutionScope,
  type NativeGitHostReceipt,
  type NativeGitIntent,
  type NativeTerminalCommand,
  type NativeTerminalGitExecutionPort,
} from './nativeTerminalGitCapabilityBroker';

const bounds: NativeCommandBounds = {
  timeoutMs: 10_000,
  outputLimitBytes: 64 * 1024,
  maxMemoryBytes: 256 * 1024 * 1024,
  maxProcesses: 4,
  maxCpuTimeMs: 8_000,
};

const command: NativeTerminalCommand = {
  executable: 'npm',
  arguments: ['test', '--', 'auth.test.ts'],
  cwd: 'C:\\fixture',
  environment: { CI: '1' },
  environmentAllowlist: ['CI'],
  network: 'denied',
  bounds,
};

function execution(
  capabilityId: string,
  actionId: string,
  requestId: string,
  paramsHash: string,
) {
  const signal = new AbortController().signal;
  return {
    approval: {
      id: `approval-${requestId}`,
      runId: 'run-1',
      requestId,
      attemptNumber: 1,
      capabilityId,
      actionId,
      actionVersion: 1,
      paramsHash,
      status: 'consumed',
    },
    producerKind: 'terminal',
    ownerId: 'agent-1',
    initialLiveProof: {
      accountId: 'account-1',
      runId: 'run-1',
      requestId,
      attemptNumber: 1,
      proofRef: `jlive_start-${requestId}`,
    },
    beginExternalEffect: vi.fn((begin) => ({
      kind: 'committed',
      value: begin(signal),
    })),
    recordResult: vi.fn(async ({ resultRef }) => ({
      kind: 'committed',
      value: { proofRef: `jlive_${resultRef.slice('jresult_'.length)}` },
    })),
  } as never;
}

async function fixture() {
  const terminalReceipt = {
    exitCode: 0,
    stdout: 'passed\n',
    stderr: '',
    stdoutBytes: 7,
    stderrBytes: 0,
    truncated: false,
    timedOut: false,
    cancelled: false,
    startedAt: 100,
    finishedAt: 200,
    resultRef: 'jresult_terminal-1',
  } as const;
  const gitReceipt: NativeGitHostReceipt = {
    operation: 'git.status',
    exitCode: 0,
    stdout: 'clean\n',
    stderr: '',
    stdoutBytes: 6,
    stderrBytes: 0,
    truncated: false,
    timedOut: false,
    cancelled: false,
    startedAt: 100,
    finishedAt: 150,
    headBefore: 'a'.repeat(40),
    headAfter: 'a'.repeat(40),
    indexBefore: 'b'.repeat(64),
    indexAfter: 'b'.repeat(64),
    changedPaths: [],
    resultRef: 'jresult_git-status-1',
  };
  const port: NativeTerminalGitExecutionPort = {
    executeTerminal: vi.fn(async () => terminalReceipt),
    resolveGitRepository: vi.fn<NativeTerminalGitExecutionPort['resolveGitRepository']>(
      async ({ accountId, projectId, repositoryRoot, ownerId }) => ({
      accountId,
      projectId,
      repositoryRoot,
      repositoryHandle: 'repo-handle-1',
      ownerId,
      issuedAt: 1,
      expiresAt: 1_000,
      allowedOperations: ['git.status', 'git.push'],
      remotes: { origin: 'https://example.com/acme/repo.git' },
      }),
    ),
    executeGit: vi.fn(async () => gitReceipt),
  };
  return { broker: createNativeTerminalGitCapabilityBroker(port), port, terminalReceipt };
}

function scope(requestId: string, parameterHash: `sha256:${string}`): NativeExecutionScope {
  return {
    accountId: 'account-1',
    projectId: 'project-1',
    runId: 'run-1',
    requestId,
    attemptNumber: 1,
    workspaceRoot: 'C:\\fixture',
    parameterHash,
    now: 100,
  };
}

describe('native terminal and Git capability broker', () => {
  it('executes only an exact typed bounded command and rejects replay', async () => {
    const { broker, port } = await fixture();
    const parameterHash = await hashNativeTerminalCommand(command);
    const issued = execution(
      'terminal.execution',
      'terminal.spawn',
      'request-terminal',
      parameterHash,
    );
    const receipt = await broker.executeTerminal({
      scope: scope('request-terminal', parameterHash),
      command,
      execution: issued,
    });
    expect(receipt).toMatchObject({
      exitCode: 0,
      commandHash: parameterHash,
      evidenceRef: 'jlive_terminal-1',
    });
    expect(port.executeTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'account-1',
        projectId: 'project-1',
        command: expect.objectContaining({ executable: 'npm', arguments: command.arguments }),
        signal: expect.any(AbortSignal),
      }),
    );
    await expect(
      broker.executeTerminal({
        scope: scope('request-terminal', parameterHash),
        command,
        execution: issued,
      }),
    ).rejects.toThrow(/claimed|already/i);
  });

  it('blocks parameter drift, secret environment variables, escaping cwd, and false receipts', async () => {
    const { broker, port } = await fixture();
    const parameterHash = await hashNativeTerminalCommand(command);
    await expect(
      broker.executeTerminal({
        scope: scope('request-drift', `sha256:${'d'.repeat(64)}`),
        command,
        execution: execution(
          'terminal.execution',
          'terminal.spawn',
          'request-drift',
          `sha256:${'d'.repeat(64)}`,
        ),
      }),
    ).rejects.toThrow(/parameter hash/i);
    await expect(
      broker.executeTerminal({
        scope: scope('request-secret', parameterHash),
        command: {
          ...command,
          environment: { API_TOKEN: 'secret' },
          environmentAllowlist: ['API_TOKEN'],
        },
        execution: execution(
          'terminal.execution',
          'terminal.spawn',
          'request-secret',
          parameterHash,
        ),
      }),
    ).rejects.toThrow(/environment/i);
    await expect(
      broker.executeTerminal({
        scope: scope('request-cwd', parameterHash),
        command: { ...command, cwd: 'C:\\outside' },
        execution: execution(
          'terminal.execution',
          'terminal.spawn',
          'request-cwd',
          parameterHash,
        ),
      }),
    ).rejects.toThrow(/outside/i);

    vi.mocked(port.executeTerminal).mockResolvedValueOnce({
      ...(await fixture()).terminalReceipt,
      stdoutBytes: 1,
    });
    await expect(
      broker.executeTerminal({
        scope: scope('request-false', parameterHash),
        command,
        execution: execution(
          'terminal.execution',
          'terminal.spawn',
          'request-false',
          parameterHash,
        ),
      }),
    ).rejects.toThrow(/evidence/i);
  });

  it('separates Git read authority and binds remote URLs without force or substitution', async () => {
    const { broker, port } = await fixture();
    const status: NativeGitIntent = { operation: 'git.status', includeUntracked: true };
    const statusHash = await hashNativeGitIntent(status, bounds);
    const receipt = await broker.executeGit({
      scope: scope('request-status', statusHash),
      intent: status,
      bounds,
      execution: execution('git.status', 'git.status', 'request-status', statusHash),
    });
    expect(receipt).toMatchObject({
      operation: 'git.status',
      intentHash: statusHash,
      headBefore: receipt.headAfter,
      indexBefore: receipt.indexAfter,
    });
    expect(port.executeGit).toHaveBeenCalledWith(
      expect.objectContaining({
        disableHooks: true,
        disableCredentialHelpers: true,
        environment: {},
      }),
    );

    const push: NativeGitIntent = {
      operation: 'git.push',
      remoteName: 'origin',
      remoteUrl: 'https://evil.example/repo.git',
      refspecs: ['refs/heads/main:refs/heads/main'],
      force: false,
    };
    const pushHash = await hashNativeGitIntent(push, bounds);
    await expect(
      broker.executeGit({
        scope: scope('request-push', pushHash),
        intent: push,
        bounds,
        execution: execution('git.push', 'git.push', 'request-push', pushHash),
      }),
    ).rejects.toThrow(/substitution/i);
    expect(port.executeGit).toHaveBeenCalledTimes(1);
  });

  it('blocks force refspecs, embedded remote credentials, and destructive ref actions', async () => {
    const { broker } = await fixture();
    for (const intent of [
      {
        operation: 'git.push',
        remoteName: 'origin',
        remoteUrl: 'https://example.com/acme/repo.git',
        refspecs: ['+refs/heads/main:refs/heads/main'],
        force: false,
      },
      {
        operation: 'git.fetch',
        remoteName: 'origin',
        remoteUrl: 'https://user:secret@example.com/repo.git',
        refspecs: ['refs/heads/main:refs/remotes/origin/main'],
      },
      {
        operation: 'git.ref',
        action: 'delete',
        name: 'refs/heads/main',
        target: 'a'.repeat(40),
      },
    ] as unknown as NativeGitIntent[]) {
      const parameterHash = await hashNativeGitIntent(intent, bounds);
      await expect(
        broker.executeGit({
          scope: scope(`request-${intent.operation.slice(4)}`, parameterHash),
          intent,
          bounds,
          execution: execution(
            `git.${intent.operation.slice(4)}`,
            intent.operation,
            `request-${intent.operation.slice(4)}`,
            parameterHash,
          ),
        }),
      ).rejects.toThrow(/unsafe|remote/i);
    }
  });
});
