import { describe, expect, it, vi } from 'vitest';

import { createRemoteMcpSetupRuntime } from './remoteSetupRuntime';
import { McpServerManager, type McpServerAdapter } from './serverManager';

function setupHarness(options: { failDiscovery?: boolean } = {}) {
  const release = vi.fn(async (): Promise<void> => undefined);
  const register = vi.fn(() => release);
  const start = vi.fn(async () => undefined);
  const listTools = options.failDiscovery
    ? vi.fn(async () => {
        throw new Error('Bearer live-secret-provider-detail');
      })
    : vi.fn(async () => [
        {
          name: 'repo.write',
          title: 'Write',
          description: 'Write repository files',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        {
          name: 'repo.read',
          description: 'Read repository files',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ]);
  const setToolExposure = vi.fn();
  const invoke = vi.fn(async () => ({ content: [] }));
  const authorization = Object.freeze({
    endpoint: 'https://mcp.example.test/rpc',
    intent: 'connect_external_mcp' as const,
    expiresAt: 10_000,
  });
  const authorize = vi.fn(() => authorization);
  const adapter = Object.freeze({ id: 'reviewed-server', start: vi.fn() });
  const createAdapter = vi.fn(() => adapter);
  const runtime = createRemoteMcpSetupRuntime({
    manager: { register, start, listTools, setToolExposure, invoke },
    authorize,
    createAdapter,
  });
  return {
    runtime,
    manager: { register, start, listTools, setToolExposure, invoke },
    authorize,
    authorization,
    adapter,
    createAdapter,
    release,
  };
}

describe('remote MCP setup runtime', () => {
  it('does no network or registration work before explicit connect', () => {
    const harness = setupHarness();

    expect(harness.runtime.getSnapshot()).toEqual([]);
    expect(harness.authorize).not.toHaveBeenCalled();
    expect(harness.createAdapter).not.toHaveBeenCalled();
    expect(harness.manager.register).not.toHaveBeenCalled();
    expect(harness.manager.start).not.toHaveBeenCalled();
  });

  it('connects only after exact authorization and starts with no exposed tools', async () => {
    const harness = setupHarness();

    await harness.runtime.connect({
      id: 'reviewed-server',
      endpoint: 'https://mcp.example.test/rpc',
      confirmedByUser: true,
    });

    expect(harness.authorize).toHaveBeenCalledWith({
      endpoint: 'https://mcp.example.test/rpc',
      confirmedByUser: true,
      intent: 'connect_external_mcp',
    });
    expect(harness.createAdapter).toHaveBeenCalledWith({
      id: 'reviewed-server',
      endpoint: 'https://mcp.example.test/rpc',
      authorization: harness.authorization,
    });
    expect(harness.manager.register).toHaveBeenCalledWith(harness.adapter, {
      kind: 'external_mcp',
      domains: [],
      exposure: { mode: 'none' },
    });
    expect(harness.manager.start).toHaveBeenCalledWith('reviewed-server');
    expect(harness.manager.listTools).toHaveBeenCalledWith('reviewed-server');

    const snapshot = harness.runtime.getSnapshot();
    expect(snapshot).toEqual([
      {
        id: 'reviewed-server',
        endpoint: 'https://mcp.example.test/rpc',
        state: 'connected',
        tools: [
          {
            name: 'repo.read',
            description: 'Read repository files',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            exposed: false,
          },
          {
            name: 'repo.write',
            title: 'Write',
            description: 'Write repository files',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            exposed: false,
          },
        ],
        resources: [],
        prompts: [],
        exposedTools: [],
      },
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(Object.isFrozen(snapshot[0]?.tools)).toBe(true);
  });

  it('rejects missing confirmation and credential or process-shaped fields before registration', async () => {
    const harness = setupHarness();

    await expect(
      harness.runtime.connect({
        id: 'reviewed-server',
        endpoint: 'https://mcp.example.test/rpc',
        confirmedByUser: false,
      }),
    ).rejects.toThrow(/explicit user authorization/i);
    await expect(
      harness.runtime.connect({
        id: 'reviewed-server',
        endpoint: 'https://mcp.example.test/rpc',
        confirmedByUser: true,
        apiKey: 'forbidden',
      } as never),
    ).rejects.toThrow(/credential|invalid remote MCP setup request/i);
    await expect(
      harness.runtime.connect({
        id: 'reviewed-server',
        endpoint: 'https://mcp.example.test/rpc',
        confirmedByUser: true,
        command: 'node server.js',
      } as never),
    ).rejects.toThrow(/process|invalid remote MCP setup request/i);

    expect(harness.manager.register).not.toHaveBeenCalled();
  });

  it('requires an explicit discovered-tool allowlist and can revoke every tool', async () => {
    const harness = setupHarness();
    await harness.runtime.connect({
      id: 'reviewed-server',
      endpoint: 'https://mcp.example.test/rpc',
      confirmedByUser: true,
    });

    harness.runtime.setToolExposure('reviewed-server', ['repo.write']);
    expect(harness.manager.setToolExposure).toHaveBeenLastCalledWith('reviewed-server', {
      mode: 'allowlist',
      toolNames: ['repo.write'],
    });
    expect(harness.runtime.getSnapshot()[0]?.exposedTools).toEqual(['repo.write']);
    expect(harness.runtime.getSnapshot()[0]?.tools.map((tool) => tool.exposed)).toEqual([
      false,
      true,
    ]);

    expect(() => harness.runtime.setToolExposure('reviewed-server', ['unknown.tool'])).toThrow(
      /discovered/i,
    );

    harness.runtime.setToolExposure('reviewed-server', []);
    expect(harness.manager.setToolExposure).toHaveBeenLastCalledWith('reviewed-server', {
      mode: 'none',
    });
    expect(harness.runtime.getSnapshot()[0]?.exposedTools).toEqual([]);
  });

  it('awaits release before removal and allows the same id to reconnect', async () => {
    let resolveRelease: (() => void) | undefined;
    const release = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRelease = resolve;
        }),
    );
    const harness = setupHarness();
    harness.manager.register.mockReturnValue(release);
    await harness.runtime.connect({
      id: 'reviewed-server',
      endpoint: 'https://mcp.example.test/rpc',
      confirmedByUser: true,
    });

    const disconnecting = harness.runtime.disconnect('reviewed-server');
    expect(harness.runtime.getSnapshot()).toHaveLength(1);
    await vi.waitFor(() => expect(resolveRelease).toBeTypeOf('function'));
    resolveRelease?.();
    await disconnecting;
    expect(harness.runtime.getSnapshot()).toEqual([]);

    await harness.runtime.connect({
      id: 'reviewed-server',
      endpoint: 'https://mcp.example.test/rpc',
      confirmedByUser: true,
    });
    expect(harness.manager.register).toHaveBeenCalledTimes(2);
  });

  it('never discovers or leaks a session when disconnected during startup', async () => {
    let resolveStart: (() => void) | undefined;
    const stop = vi.fn(async () => undefined);
    const adapter: McpServerAdapter = {
      id: 'reviewed-server',
      start: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          resolveStart = resolve;
        });
        return {
          listTools: async () => [],
          invoke: async () => ({}),
          health: async () => true,
          stop,
        };
      }),
    };
    const manager = new McpServerManager();
    const listTools = vi.fn(manager.listTools.bind(manager));
    const runtime = createRemoteMcpSetupRuntime({
      manager: {
        register: manager.register.bind(manager),
        start: manager.start.bind(manager),
        listTools,
        setToolExposure: manager.setToolExposure.bind(manager),
        invoke: manager.invoke.bind(manager),
      },
      authorize: () =>
        Object.freeze({
          endpoint: 'https://mcp.example.test/rpc',
          intent: 'connect_external_mcp',
          expiresAt: 10_000,
        }),
      createAdapter: () => adapter,
    });

    const connecting = runtime.connect({
      id: 'reviewed-server',
      endpoint: 'https://mcp.example.test/rpc',
      confirmedByUser: true,
    });
    await vi.waitFor(() => expect(resolveStart).toBeTypeOf('function'));
    const disconnecting = runtime.disconnect('reviewed-server');
    resolveStart?.();

    await Promise.all([connecting, disconnecting]);
    expect(listTools).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot()).toEqual([]);
    expect(manager.discover()).toEqual([]);
  });

  it('cleans up failed discovery and exposes only a generic error', async () => {
    const harness = setupHarness({ failDiscovery: true });

    await expect(
      harness.runtime.connect({
        id: 'reviewed-server',
        endpoint: 'https://mcp.example.test/rpc',
        confirmedByUser: true,
      }),
    ).rejects.toThrow('Unable to connect to this MCP server.');

    expect(harness.release).toHaveBeenCalledOnce();
    const snapshot = harness.runtime.getSnapshot();
    expect(snapshot[0]).toMatchObject({
      id: 'reviewed-server',
      state: 'failed',
      error: 'Unable to connect to this MCP server.',
    });
    expect(JSON.stringify(snapshot)).not.toContain('live-secret');
  });
});
