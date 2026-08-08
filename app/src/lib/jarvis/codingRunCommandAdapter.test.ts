import { describe, expect, it, vi } from 'vitest';
import {
  createCodingRunCommandAdapter,
  type CodingRunCommandCatalog,
} from './codingRunCommandAdapter';
import {
  hashNativeArguments,
  type NativeTerminalCommand,
  type NativeTerminalGitExecutionPort,
} from './nativeTerminalGitCapabilityBroker';

const command: NativeTerminalCommand = {
  executable: 'npm',
  arguments: ['test', '--', 'auth.test.ts'],
  cwd: 'C:\\fixture',
  environment: {},
  environmentAllowlist: [],
  network: 'denied',
  bounds: {
    timeoutMs: 10_000,
    outputLimitBytes: 65_536,
    maxMemoryBytes: 256 * 1024 * 1024,
    maxProcesses: 4,
    maxCpuTimeMs: 8_000,
  },
};

async function fixture() {
  const executeTerminal = vi.fn<NativeTerminalGitExecutionPort['executeTerminal']>(
    async () => ({
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
      resultRef: 'jresult_focused-test-1' as const,
    }),
  );
  const port: Pick<NativeTerminalGitExecutionPort, 'executeTerminal'> = {
    executeTerminal,
  };
  const catalog: CodingRunCommandCatalog = {
    resolve: vi.fn(async () => command),
  };
  return {
    adapter: createCodingRunCommandAdapter({ port, catalog }),
    port,
    catalog,
    argumentsHash: await hashNativeArguments(command.arguments),
  };
}

describe('coding run command adapter', () => {
  it('resolves and executes only the exact registered focused command', async () => {
    const { adapter, port, catalog, argumentsHash } = await fixture();
    const result = await adapter.execute({
      accountId: 'account-1',
      projectId: 'project-1',
      runId: 'run-1',
      plan: {
        id: 'test-1',
        executable: 'npm',
        argumentsHash,
        cwd: 'C:\\fixture',
      },
      signal: new AbortController().signal,
    });
    expect(catalog.resolve).toHaveBeenCalledWith({
      accountId: 'account-1',
      projectId: 'project-1',
      runId: 'run-1',
      planId: 'test-1',
    });
    expect(port.executeTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ command, signal: expect.any(AbortSignal) }),
    );
    expect(result).toEqual({
      command: {
        id: 'command-test-1',
        executable: 'npm',
        argumentsHash,
        cwd: 'C:\\fixture',
        startedAt: 100,
        finishedAt: 200,
        exitCode: 0,
        resultRef: 'jresult_focused-test-1',
      },
      test: {
        id: 'test-1',
        commandReceiptId: 'command-test-1',
        status: 'passed',
        resultRef: 'jresult_focused-test-1',
      },
    });
  });

  it('rejects catalog drift, network access, environment injection, and missing commands', async () => {
    const { adapter, port, catalog, argumentsHash } = await fixture();
    vi.mocked(catalog.resolve).mockResolvedValueOnce({
      ...command,
      arguments: ['test', '--', 'other.test.ts'],
    });
    await expect(
      adapter.execute({
        accountId: 'account-1',
        projectId: 'project-1',
        runId: 'run-1',
        plan: {
          id: 'test-drift',
          executable: 'npm',
          argumentsHash,
          cwd: 'C:\\fixture',
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/approved plan/i);

    vi.mocked(catalog.resolve).mockResolvedValueOnce({ ...command, network: 'unrestricted' });
    await expect(
      adapter.execute({
        accountId: 'account-1',
        projectId: 'project-1',
        runId: 'run-1',
        plan: {
          id: 'test-network',
          executable: 'npm',
          argumentsHash,
          cwd: 'C:\\fixture',
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/approved plan/i);

    vi.mocked(catalog.resolve).mockResolvedValueOnce({
      ...command,
      environment: { CI: '1' },
      environmentAllowlist: ['CI'],
    });
    await expect(
      adapter.execute({
        accountId: 'account-1',
        projectId: 'project-1',
        runId: 'run-1',
        plan: {
          id: 'test-env',
          executable: 'npm',
          argumentsHash,
          cwd: 'C:\\fixture',
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/approved plan/i);

    vi.mocked(catalog.resolve).mockResolvedValueOnce(null);
    await expect(
      adapter.execute({
        accountId: 'account-1',
        projectId: 'project-1',
        runId: 'run-1',
        plan: {
          id: 'test-missing',
          executable: 'npm',
          argumentsHash,
          cwd: 'C:\\fixture',
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/not registered/i);
    expect(port.executeTerminal).not.toHaveBeenCalled();
  });

  it('maps a nonzero canonical exit to failed and rejects timeout without an exit', async () => {
    const { adapter, port, argumentsHash } = await fixture();
    vi.mocked(port.executeTerminal).mockResolvedValueOnce({
      exitCode: 2,
      stdout: '',
      stderr: 'failed',
      stdoutBytes: 0,
      stderrBytes: 6,
      truncated: false,
      timedOut: false,
      cancelled: false,
      startedAt: 100,
      finishedAt: 200,
      resultRef: 'jresult_focused-failed',
    });
    await expect(
      adapter.execute({
        accountId: 'account-1',
        projectId: 'project-1',
        runId: 'run-1',
        plan: {
          id: 'test-failed',
          executable: 'npm',
          argumentsHash,
          cwd: 'C:\\fixture',
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ test: { status: 'failed' } });

    vi.mocked(port.executeTerminal).mockResolvedValueOnce({
      exitCode: null,
      stdout: '',
      stderr: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      truncated: false,
      timedOut: true,
      cancelled: false,
      startedAt: 300,
      finishedAt: 400,
      resultRef: 'jresult_focused-timeout',
    });
    await expect(
      adapter.execute({
        accountId: 'account-1',
        projectId: 'project-1',
        runId: 'run-1',
        plan: {
          id: 'test-timeout',
          executable: 'npm',
          argumentsHash,
          cwd: 'C:\\fixture',
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/exit status/i);
  });
});
