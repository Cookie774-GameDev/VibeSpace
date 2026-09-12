import { describe, expect, it, vi } from 'vitest';

import type {
  RemoteMcpConnectRequest,
  RemoteMcpSetupConnection,
  RemoteMcpSetupRuntime,
  RemoteMcpSetupTool,
} from './remoteSetupRuntime';
import { createVibeSpaceMcpGateway, type GatewayStorage } from './vibeSpaceGateway';

const endpoint = 'https://mcp.example.test/rpc';
const readTool = Object.freeze({
  name: 'repo.read',
  description: 'Read repository files',
  inputSchema: Object.freeze({
    type: 'object',
    properties: Object.freeze({ path: Object.freeze({ type: 'string' }) }),
    additionalProperties: false,
  }),
  exposed: false,
  classification: 'read' as const,
});

function memoryStorage() {
  const values = new Map<string, string>();
  const storage: GatewayStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
  return { storage, values };
}

function runtimeHarness(tool: Readonly<RemoteMcpSetupTool> = readTool) {
  let snapshot: readonly RemoteMcpSetupConnection[] = Object.freeze([]);
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((listener) => listener());
  const connect = vi.fn(async (request: RemoteMcpConnectRequest) => {
    snapshot = Object.freeze([
      Object.freeze({
        id: request.id,
        endpoint: request.endpoint,
        state: 'connected' as const,
        tools: Object.freeze([tool]),
        exposedTools: Object.freeze([]),
      }),
    ]);
    publish();
  });
  const setToolExposure = vi.fn((id: string, names: readonly string[]) => {
    snapshot = snapshot.map((connection) =>
      connection.id === id
        ? Object.freeze({
            ...connection,
            tools: connection.tools.map((candidate) =>
              Object.freeze({ ...candidate, exposed: names.includes(candidate.name) }),
            ),
            exposedTools: Object.freeze([...names]),
          })
        : connection,
    );
    publish();
  });
  const disconnect = vi.fn(async (id: string) => {
    snapshot = snapshot.filter((connection) => connection.id !== id);
    publish();
  });
  const invoke = vi.fn(async () => ({
    content: [{ type: 'text', text: 'Bearer live-secret-value' }],
    token: 'live-secret-value',
  }));
  const runtime: RemoteMcpSetupRuntime = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect,
    setToolExposure,
    invoke,
    disconnect,
  };
  return { runtime, connect, setToolExposure, invoke, disconnect };
}

function createHarness(options: {
  storage?: ReturnType<typeof memoryStorage>;
  runtime?: ReturnType<typeof runtimeHarness>;
  now?: number;
} = {}) {
  const stored = options.storage ?? memoryStorage();
  const runtime = options.runtime ?? runtimeHarness();
  let now = options.now ?? 1_000;
  const gateway = createVibeSpaceMcpGateway({
    scope: { accountId: 'account_a', projectId: 'project_a' },
    runtime: runtime.runtime,
    storage: stored.storage,
    clock: { now: () => now },
  });
  return { gateway, stored, runtime, setNow: (value: number) => void (now = value) };
}

async function approve(harness: ReturnType<typeof createHarness>) {
  await harness.gateway.connect({
    id: 'reviewed-server',
    endpoint,
    confirmedByUser: true,
  });
  harness.gateway.approve('reviewed-server', { confirmedByUser: true });
}

describe('VibeSpace MCP Gateway', () => {
  it('invokes only an approved task-scoped tool and persists a redacted receipt', async () => {
    const harness = createHarness();
    await approve(harness);
    harness.gateway.setToolExposure(
      'reviewed-server',
      ['repo.read'],
      { confirmedByUser: true },
    );

    const response = await harness.gateway.invoke({
      accountId: 'account_a',
      projectId: 'project_a',
      taskId: 'task_1',
      connectionId: 'reviewed-server',
      toolName: 'repo.read',
      arguments: { path: 'README.md' },
      allowedTools: ['reviewed-server.repo.read'],
      classification: 'read',
    });

    expect(JSON.stringify(response.result)).not.toContain('live-secret-value');
    expect(response.receipt.status).toBe('succeeded');
    expect(harness.gateway.getReceipts()).toEqual([response.receipt]);
    expect(harness.runtime.invoke).toHaveBeenCalledWith(
      'reviewed-server',
      'repo.read',
      { path: 'README.md' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('fails closed for wrong scope, task allowlist, classification, and raw secrets', async () => {
    const harness = createHarness();
    await approve(harness);
    harness.gateway.setToolExposure(
      'reviewed-server',
      ['repo.read'],
      { confirmedByUser: true },
    );
    const base = {
      accountId: 'account_a',
      projectId: 'project_a',
      taskId: 'task_1',
      connectionId: 'reviewed-server',
      toolName: 'repo.read',
      arguments: { path: 'README.md' },
      allowedTools: ['reviewed-server.repo.read'],
      classification: 'read' as const,
    };

    await expect(harness.gateway.invoke({ ...base, accountId: 'account_b' })).rejects.toThrow('scope');
    await expect(harness.gateway.invoke({ ...base, allowedTools: [] })).rejects.toThrow('task allowlist');
    await expect(harness.gateway.invoke({ ...base, classification: 'write' })).rejects.toThrow('classification');
    await expect(harness.gateway.invoke({
      ...base,
      arguments: { token: 'raw-secret' },
    })).rejects.toThrow('secret references');
    expect(harness.runtime.invoke).not.toHaveBeenCalled();
  });

  it('requires a distinct approval before persisting the first discovered schema', async () => {
    const harness = createHarness();
    await harness.gateway.connect({
      id: 'reviewed-server',
      endpoint,
      confirmedByUser: true,
    });

    expect(harness.gateway.getSnapshot()[0]).toMatchObject({
      trust: 'approval_required',
      durableApproval: false,
    });
    expect(harness.stored.values.size).toBe(0);
    expect(() =>
      harness.gateway.approve('reviewed-server', { confirmedByUser: false }),
    ).toThrow(/explicit user approval/i);

    harness.gateway.approve('reviewed-server', { confirmedByUser: true });
    expect(harness.gateway.getSnapshot()[0]).toMatchObject({
      trust: 'approved',
      durableApproval: true,
    });
    const durable = [...harness.stored.values.values()][0] ?? '';
    expect(durable).toContain('schemaDigest');
    expect(durable).not.toMatch(/credential|password|apiKey|authorization|arguments/i);
  });

  it('recovers an unchanged approved profile lazily after restart', async () => {
    const first = createHarness();
    await approve(first);
    await first.gateway.disconnect('reviewed-server');

    const restartedRuntime = runtimeHarness();
    const restarted = createHarness({ storage: first.stored, runtime: restartedRuntime });
    expect(restartedRuntime.connect).not.toHaveBeenCalled();
    expect(restarted.gateway.getSnapshot()[0]).toMatchObject({
      durableApproval: true,
      state: 'disconnected',
    });

    await restarted.gateway.reconnect('reviewed-server');
    expect(restartedRuntime.connect).toHaveBeenCalledWith({
      id: 'reviewed-server',
      endpoint,
      confirmedByUser: true,
    });
    expect(restarted.gateway.getSnapshot()[0]).toMatchObject({
      state: 'connected',
      trust: 'approved',
    });
  });

  it('rejects endpoint changes and fails closed on schema changes', async () => {
    const first = createHarness();
    await approve(first);
    await first.gateway.disconnect('reviewed-server');

    await expect(
      first.gateway.reconnect('reviewed-server', 'https://other.example.test/mcp'),
    ).rejects.toThrow(/endpoint changed/i);
    expect(first.runtime.connect).toHaveBeenCalledTimes(1);

    const changed = runtimeHarness(
      Object.freeze({
        ...readTool,
        inputSchema: Object.freeze({
          type: 'object',
          properties: Object.freeze({ path: Object.freeze({ type: 'number' }) }),
          additionalProperties: false,
        }),
      }),
    );
    const restarted = createHarness({ storage: first.stored, runtime: changed });
    await expect(restarted.gateway.reconnect('reviewed-server')).rejects.toThrow(
      /changed and requires approval/i,
    );
    expect(changed.setToolExposure).toHaveBeenLastCalledWith('reviewed-server', []);
    expect(restarted.gateway.getSnapshot()[0]?.trust).toBe('changed');
  });

  it('requires explicit approval for tool exposure expansion', async () => {
    const harness = createHarness();
    await approve(harness);
    expect(() => harness.gateway.setToolExposure('reviewed-server', ['repo.read'])).toThrow(
      /expansion requires explicit/i,
    );
    harness.gateway.setToolExposure(
      'reviewed-server',
      ['repo.read'],
      { confirmedByUser: true },
    );
    expect(harness.runtime.setToolExposure).toHaveBeenLastCalledWith('reviewed-server', [
      'repo.read',
    ]);
  });

  it('bounds transient reconnect attempts with explicit lazy backoff', async () => {
    const first = createHarness();
    await approve(first);
    await first.gateway.disconnect('reviewed-server');
    const failing = runtimeHarness();
    failing.connect.mockRejectedValue(new Error('provider detail'));
    const restarted = createHarness({ storage: first.stored, runtime: failing, now: 10_000 });

    await expect(restarted.gateway.reconnect('reviewed-server')).rejects.toThrow(
      /Unable to connect through/i,
    );
    await expect(restarted.gateway.reconnect('reviewed-server')).rejects.toThrow(/backed off/i);
    restarted.setNow(11_000);
    await expect(restarted.gateway.reconnect('reviewed-server')).rejects.toThrow(
      /Unable to connect through/i,
    );
    restarted.setNow(13_000);
    await expect(restarted.gateway.reconnect('reviewed-server')).rejects.toThrow(
      /Unable to connect through/i,
    );
    expect(failing.connect).toHaveBeenCalledTimes(3);
    await expect(restarted.gateway.reconnect('reviewed-server')).rejects.toThrow(/limit reached/i);
  });

  it('revokes the live lease and durable profile', async () => {
    const harness = createHarness();
    await approve(harness);
    await harness.gateway.revoke('reviewed-server');
    expect(harness.runtime.disconnect).toHaveBeenCalledWith('reviewed-server');
    expect(harness.stored.values.size).toBe(0);
    expect(harness.gateway.getSnapshot()).toEqual([]);
    await expect(harness.gateway.reconnect('reviewed-server')).rejects.toThrow(/requires approval/i);
  });

  it('isolates durable approvals by exact account and project scope', async () => {
    const stored = memoryStorage();
    const approved = createHarness({ storage: stored });
    await approve(approved);
    const other = createVibeSpaceMcpGateway({
      scope: { accountId: 'account_b', projectId: 'project_a' },
      runtime: runtimeHarness().runtime,
      storage: stored.storage,
    });
    expect(other.getSnapshot()).toEqual([]);
  });
});
