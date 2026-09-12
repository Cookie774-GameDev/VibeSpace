import { describe, expect, it, vi } from 'vitest';
import {
  createMcpConnectionSupervisor,
  type McpConnectionPort,
  type McpSupervisorScheduler,
  type TrustedMcpConnectionConfig,
} from './mcpConnectionSupervisor';
import { createUnifiedMcpRegistry } from './unifiedMcpRegistry';

const scope = { accountId: 'account-1', projectId: 'project-1' };

function config(
  overrides: Partial<TrustedMcpConnectionConfig> = {},
): TrustedMcpConnectionConfig {
  return {
    schemaVersion: 1,
    id: 'connection-1',
    serverId: 'server-1',
    kind: 'external_mcp',
    connectorId: 'connector-1',
    enabled: true,
    trust: 'trusted',
    reconnect: {
      baseDelayMs: 100,
      maxDelayMs: 250,
      maxAttempts: 4,
    },
    ...overrides,
  };
}

function fakeScheduler() {
  const pending: Array<{
    delay: number;
    callback: () => void;
    cancelled: boolean;
  }> = [];
  const scheduler: McpSupervisorScheduler = {
    schedule(delay, callback) {
      const task = { delay, callback, cancelled: false };
      pending.push(task);
      return Object.freeze({
        cancel() {
          task.cancelled = true;
        },
      });
    },
  };
  return {
    pending,
    scheduler,
    runNext() {
      const task = pending.shift();
      if (!task) throw new Error('No scheduled task.');
      if (!task.cancelled) task.callback();
      return task;
    },
  };
}

const connectedSession = () => ({
  tools: [
    {
      serverId: 'server-1',
      toolName: 'documents.search',
      capabilityId: 'mcp.documents.search',
    },
  ],
  evidenceRef: 'jlive_mcp_connected_1' as const,
  disconnect: vi.fn(async () => undefined),
});

describe('MCP connection supervisor', () => {
  it('discovers only enabled trusted caller configs and exposes authority-free health', async () => {
    const registry = createUnifiedMcpRegistry();
    const scheduler = fakeScheduler();
    const connect = vi.fn<McpConnectionPort['connect']>(async () => connectedSession());
    const supervisor = createMcpConnectionSupervisor({
      registry,
      port: { connect },
      clock: { now: () => 1_000 },
      scheduler: scheduler.scheduler,
    });

    await supervisor.start(scope, [
      config(),
      config({ id: 'disabled', serverId: 'server-disabled', enabled: false }),
    ]);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0]?.[0].config).toMatchObject({
      id: 'connection-1',
      connectorId: 'connector-1',
      trust: 'trusted',
    });
    expect(supervisor.snapshot(scope)).toEqual({
      schemaVersion: 1,
      accountId: 'account-1',
      projectId: 'project-1',
      connections: [
        {
          id: 'connection-1',
          serverId: 'server-1',
          connectorId: 'connector-1',
          state: 'connected',
          attempt: 1,
          authority: 'none',
        },
      ],
    });
    expect(registry.snapshot(scope).connections[0]).toMatchObject({
      id: 'connection-1',
      state: 'connected',
      evidenceRef: 'jlive_mcp_connected_1',
      authority: 'none',
      tools: [
        {
          serverId: 'server-1',
          toolName: 'documents.search',
          capabilityId: 'mcp.documents.search',
          authority: 'none',
        },
      ],
    });
    expect(JSON.stringify(supervisor.snapshot(scope))).not.toMatch(
      /credential|password|secret|token|endpoint/i,
    );
    await expect(supervisor.disconnect(scope, 'connection-1')).resolves.toBe(true);
    expect(registry.snapshot(scope).connections[0]?.state).toBe('disconnected');
  });

  it('retries with deterministic bounded exponential delays and stops at the attempt bound', async () => {
    let now = 1_000;
    const scheduler = fakeScheduler();
    const connect = vi.fn<McpConnectionPort['connect']>(async () => {
      throw new Error('private connection detail');
    });
    const supervisor = createMcpConnectionSupervisor({
      registry: createUnifiedMcpRegistry(),
      port: { connect },
      clock: { now: () => now },
      scheduler: scheduler.scheduler,
    });

    await supervisor.start(scope, [config()]);
    expect(scheduler.pending.map(({ delay }) => delay)).toEqual([100]);
    expect(supervisor.snapshot(scope).connections[0]).toMatchObject({
      state: 'degraded',
      attempt: 1,
      nextRetryAt: 1_100,
    });

    now = 1_100;
    scheduler.runNext();
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.pending.map(({ delay }) => delay)).toEqual([200]);

    now = 1_300;
    scheduler.runNext();
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.pending.map(({ delay }) => delay)).toEqual([250]);

    now = 1_550;
    scheduler.runNext();
    await Promise.resolve();
    await Promise.resolve();
    expect(supervisor.snapshot(scope).connections[0]).toMatchObject({
      state: 'disconnected',
      attempt: 4,
    });
    expect(scheduler.pending).toHaveLength(0);
    expect(JSON.stringify(supervisor.snapshot(scope))).not.toContain('private connection detail');
  });

  it('cancels an in-flight connection and supports explicit manual disconnect', async () => {
    let observedSignal: AbortSignal | undefined;
    const port: McpConnectionPort = {
      connect: vi.fn<McpConnectionPort['connect']>(
        ({ signal }) =>
          new Promise((_, reject) => {
            observedSignal = signal;
            signal.addEventListener('abort', () =>
              reject(new DOMException('cancelled', 'AbortError')),
            );
          }),
      ),
    };
    const supervisor = createMcpConnectionSupervisor({
      registry: createUnifiedMcpRegistry(),
      port,
      clock: { now: () => 1_000 },
      scheduler: fakeScheduler().scheduler,
    });

    const started = supervisor.start(scope, [config()]);
    await Promise.resolve();
    await expect(supervisor.disconnect(scope, 'connection-1')).resolves.toBe(true);
    await started;

    expect(observedSignal?.aborted).toBe(true);
    expect(supervisor.snapshot(scope).connections[0]).toMatchObject({
      state: 'disconnected',
      authority: 'none',
    });
    await expect(supervisor.disconnect(scope, 'connection-1')).resolves.toBe(false);
  });

  it('fails closed for configs not marked trusted', async () => {
    const registry = createUnifiedMcpRegistry();
    const supervisor = createMcpConnectionSupervisor({
      registry,
      port: { connect: vi.fn<McpConnectionPort['connect']>(async () => connectedSession()) },
      clock: { now: () => 1_000 },
      scheduler: fakeScheduler().scheduler,
    });
    await expect(
      supervisor.start(scope, [
        { ...config(), trust: 'untrusted' } as unknown as TrustedMcpConnectionConfig,
      ]),
    ).rejects.toThrow(/trusted MCP connection config/i);
    expect(registry.snapshot(scope).connections).toEqual([]);
  });
});
