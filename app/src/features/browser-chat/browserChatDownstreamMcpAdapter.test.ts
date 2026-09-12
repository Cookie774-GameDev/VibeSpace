import { describe, expect, it, vi } from 'vitest';
import { createVibeSpaceMcpGateway, type GatewayStorage } from '@/lib/mcp/vibeSpaceGateway';
import type {
  RemoteMcpConnectRequest,
  RemoteMcpSetupConnection,
  RemoteMcpSetupRuntime,
  RemoteMcpSetupTool,
} from '@/lib/mcp/remoteSetupRuntime';
import { BrowserChatApprovalBroker } from './approvalBroker';
import {
  createBrowserChatDownstreamMcpAdapter,
  type BrowserChatDownstreamMcpError,
} from './browserChatDownstreamMcpAdapter';
import type {
  BrowserChatCapabilityId,
  BrowserChatCapabilityLease,
  BrowserChatPermissionProfile,
} from './permissionRegistry';

const ACCOUNT = 'account-a';
const WORKSPACE = 'workspace-a';
const PROJECT = 'project-a';
const CONNECTION = 'fixture-server';
const ENDPOINT = 'https://mcp.example.test/rpc';

const TOOLS: readonly RemoteMcpSetupTool[] = Object.freeze([
  Object.freeze({
    name: 'fixture.read',
    title: 'Read fixture',
    description: 'Reads one fixture value.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ path: Object.freeze({ type: 'string' }) }),
      required: Object.freeze(['path']),
      additionalProperties: false,
    }),
    exposed: false,
    classification: 'read' as const,
  }),
  Object.freeze({
    name: 'fixture.write',
    title: 'Write fixture',
    description: 'Mutates one in-memory fixture value.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ value: Object.freeze({ type: 'string' }) }),
      required: Object.freeze(['value']),
      additionalProperties: false,
    }),
    exposed: false,
    classification: 'mutation' as const,
  }),
  Object.freeze({
    name: 'fixture.wait',
    title: 'Wait fixture',
    description: 'Waits until cancelled.',
    inputSchema: Object.freeze({ type: 'object', additionalProperties: false }),
    exposed: false,
    classification: 'read' as const,
  }),
]);

function memoryStorage(): GatewayStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

function runtimeHarness() {
  let snapshot: readonly RemoteMcpSetupConnection[] = Object.freeze([]);
  let sideEffects = 0;
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((listener) => listener());
  const runtime: RemoteMcpSetupRuntime = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async connect(request: RemoteMcpConnectRequest) {
      snapshot = Object.freeze([
        Object.freeze({
          id: request.id,
          endpoint: request.endpoint,
          state: 'connected',
          tools: TOOLS,
          exposedTools: Object.freeze([]),
        }),
      ]);
      publish();
    },
    setToolExposure(id, names) {
      snapshot = snapshot.map((connection) =>
        connection.id === id
          ? Object.freeze({
              ...connection,
              tools: Object.freeze(
                connection.tools.map((tool) =>
                  Object.freeze({ ...tool, exposed: names.includes(tool.name) }),
                ),
              ),
              exposedTools: Object.freeze([...names]),
            })
          : connection,
      );
      publish();
    },
    async invoke(_id, toolName, input, options) {
      if (toolName === 'fixture.read') {
        return { value: `read:${String((input as { path?: unknown }).path)}` };
      }
      if (toolName === 'fixture.write') {
        sideEffects += 1;
        return { value: (input as { value?: unknown }).value, sideEffects };
      }
      if (toolName === 'fixture.wait') {
        return new Promise((_, reject) => {
          const abort = () => reject(new DOMException('cancelled', 'AbortError'));
          options?.signal?.addEventListener('abort', abort, { once: true });
          if (options?.signal?.aborted) abort();
        });
      }
      throw new Error('fixture tool unavailable');
    },
    async disconnect(id) {
      snapshot = snapshot.filter((connection) => connection.id !== id);
      publish();
    },
  };
  return { runtime, sideEffects: () => sideEffects };
}

async function gatewayHarness() {
  const fixture = runtimeHarness();
  let now = 1_000;
  const gateway = createVibeSpaceMcpGateway({
    scope: { accountId: ACCOUNT, projectId: PROJECT },
    runtime: fixture.runtime,
    storage: memoryStorage(),
    clock: { now: () => now++ },
  });
  await gateway.connect({
    id: CONNECTION,
    endpoint: ENDPOINT,
    confirmedByUser: true,
  });
  gateway.approve(CONNECTION, { confirmedByUser: true });
  gateway.setToolExposure(
    CONNECTION,
    TOOLS.map((tool) => tool.name),
    { confirmedByUser: true },
  );
  return { gateway, fixture };
}

function broker(accountId = ACCOUNT): BrowserChatApprovalBroker {
  const capabilities = new Set<BrowserChatCapabilityId>(['mcp.list', 'mcp.read', 'mcp.invoke']);
  const profile: BrowserChatPermissionProfile = {
    version: 1,
    accountId,
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
    leaseIdFactory: () => `downstream-lease-${++sequence}`,
    requestIdFactory: () => `downstream-request-${++sequence}`,
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

function errorCode(error: unknown): string | undefined {
  return (error as BrowserChatDownstreamMcpError | undefined)?.code;
}

describe('Browser Chat downstream MCP adapter', () => {
  it('lists only live approved external tools without exposing endpoint metadata', async () => {
    const { gateway } = await gatewayHarness();
    const approvalBroker = broker();
    const adapter = createBrowserChatDownstreamMcpAdapter({
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      approvalBroker,
      gateway,
    });

    const result = await adapter.listTools({
      lease: lease(approvalBroker, 'mcp.list'),
      now: 100,
    });

    expect(result).toEqual({
      tools: [
        {
          connectionId: CONNECTION,
          serverId: CONNECTION,
          toolName: 'fixture.read',
          title: 'Read fixture',
          description: 'Reads one fixture value.',
          classification: 'read',
          metadataTrust: 'external_untrusted',
          healthEvidence: 'live',
        },
        {
          connectionId: CONNECTION,
          serverId: CONNECTION,
          toolName: 'fixture.wait',
          title: 'Wait fixture',
          description: 'Waits until cancelled.',
          classification: 'read',
          metadataTrust: 'external_untrusted',
          healthEvidence: 'live',
        },
        {
          connectionId: CONNECTION,
          serverId: CONNECTION,
          toolName: 'fixture.write',
          title: 'Write fixture',
          description: 'Mutates one in-memory fixture value.',
          classification: 'mutation',
          metadataTrust: 'external_untrusted',
          healthEvidence: 'live',
        },
      ],
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toContain(ENDPOINT);
  });

  it('executes a read fixture through the real scoped gateway and returns its receipt', async () => {
    const { gateway } = await gatewayHarness();
    const approvalBroker = broker();
    const adapter = createBrowserChatDownstreamMcpAdapter({
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      approvalBroker,
      gateway,
    });

    const result = await adapter.invokeTool({
      lease: lease(approvalBroker, 'mcp.read'),
      taskId: 'task-read',
      connectionId: CONNECTION,
      toolName: 'fixture.read',
      arguments: { path: 'README.md' },
      now: 100,
    });

    expect(result.result).toEqual({ value: 'read:README.md' });
    expect(result.receipt).toMatchObject({
      accountId: ACCOUNT,
      projectId: PROJECT,
      taskId: 'task-read',
      connectionId: CONNECTION,
      toolName: 'fixture.read',
      classification: 'read',
      status: 'succeeded',
    });
  });

  it('derives mutation classification from discovery and requires a fresh invoke lease', async () => {
    const { gateway, fixture } = await gatewayHarness();
    const approvalBroker = broker();
    const adapter = createBrowserChatDownstreamMcpAdapter({
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      approvalBroker,
      gateway,
    });

    await expect(
      adapter.invokeTool({
        lease: lease(approvalBroker, 'mcp.read'),
        taskId: 'task-write',
        connectionId: CONNECTION,
        toolName: 'fixture.write',
        arguments: { value: 'changed' },
        now: 100,
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === 'capability_mismatch');
    expect(fixture.sideEffects()).toBe(0);

    const result = await adapter.invokeTool({
      lease: lease(approvalBroker, 'mcp.invoke', 200),
      taskId: 'task-write',
      connectionId: CONNECTION,
      toolName: 'fixture.write',
      arguments: { value: 'changed' },
      now: 200,
    });
    expect(result.result).toEqual({ value: 'changed', sideEffects: 1 });
    expect(result.receipt.classification).toBe('mutation');
    expect(fixture.sideEffects()).toBe(1);
  });

  it('fails closed for wrong account scope and disconnected tools', async () => {
    const { gateway } = await gatewayHarness();
    const wrongBroker = broker('account-b');
    const wrongAdapter = createBrowserChatDownstreamMcpAdapter({
      accountId: 'account-b',
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      approvalBroker: wrongBroker,
      gateway,
    });
    await expect(
      wrongAdapter.listTools({ lease: lease(wrongBroker, 'mcp.list'), now: 100 }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === 'scope_invalid');

    await gateway.disconnect(CONNECTION);
    const approvalBroker = broker();
    const adapter = createBrowserChatDownstreamMcpAdapter({
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      approvalBroker,
      gateway,
    });
    await expect(
      adapter.invokeTool({
        lease: lease(approvalBroker, 'mcp.invoke'),
        taskId: 'task-offline',
        connectionId: CONNECTION,
        toolName: 'fixture.read',
        arguments: { path: 'README.md' },
        now: 100,
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === 'tool_unavailable');
  });

  it('omits a downstream catalog whose server identity conflicts with its connection', async () => {
    const { gateway } = await gatewayHarness();
    const capabilitySnapshot = gateway.getCapabilitySnapshot();
    const conflictingGateway = Object.freeze({
      ...gateway,
      getCapabilitySnapshot: () =>
        Object.freeze({
          ...capabilitySnapshot,
          connections: Object.freeze(
            capabilitySnapshot.connections.map((connection) =>
              Object.freeze({
                ...connection,
                serverId: 'spoofed-server',
                tools: Object.freeze(
                  connection.tools.map((tool) =>
                    Object.freeze({ ...tool, serverId: 'spoofed-server' }),
                  ),
                ),
              }),
            ),
          ),
        }),
    });
    const approvalBroker = broker();
    const adapter = createBrowserChatDownstreamMcpAdapter({
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      approvalBroker,
      gateway: conflictingGateway,
    });

    await expect(
      adapter.listTools({ lease: lease(approvalBroker, 'mcp.list'), now: 100 }),
    ).resolves.toEqual({ tools: [], truncated: false });
  });

  it('propagates permission revocation into a live downstream cancellation', async () => {
    const { gateway } = await gatewayHarness();
    const approvalBroker = broker();
    const adapter = createBrowserChatDownstreamMcpAdapter({
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      approvalBroker,
      gateway,
    });
    const pending = adapter.invokeTool({
      lease: lease(approvalBroker, 'mcp.read'),
      taskId: 'task-cancel',
      connectionId: CONNECTION,
      toolName: 'fixture.wait',
      arguments: {},
      now: 100,
    });

    await vi.waitFor(() =>
      expect(gateway.getReceipts().some((receipt) => receipt.taskId === 'task-cancel')).toBe(false),
    );
    approvalBroker.revoke();

    await expect(pending).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === 'operation_cancelled',
    );
    expect(gateway.getReceipts()).toEqual([
      expect.objectContaining({ taskId: 'task-cancel', status: 'cancelled' }),
    ]);
  });
});
