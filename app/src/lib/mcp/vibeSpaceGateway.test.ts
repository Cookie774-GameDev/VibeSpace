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
      ...snapshot.filter((connection) => connection.id !== request.id),
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
  const drop = vi.fn(() => {
    snapshot = Object.freeze([]);
    publish();
  });
  const invoke = vi.fn(async (): Promise<unknown> => ({
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
  return { runtime, connect, setToolExposure, invoke, disconnect, drop };
}

function createHarness(options: {
  storage?: ReturnType<typeof memoryStorage>;
  runtime?: ReturnType<typeof runtimeHarness>;
  now?: number;
  restoreTimeoutMs?: number;
} = {}) {
  const stored = options.storage ?? memoryStorage();
  const runtime = options.runtime ?? runtimeHarness();
  let now = options.now ?? 1_000;
  const gateway = createVibeSpaceMcpGateway({
    scope: { accountId: 'account_a', projectId: 'project_a' },
    runtime: runtime.runtime,
    storage: stored.storage,
    clock: { now: () => now },
    restoreTimeoutMs: options.restoreTimeoutMs,
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
  it.each([
    { exposed: false, connected: false },
    { exposed: true, connected: false },
    { exposed: true, connected: true },
  ])('keeps healthy routes available while another reconnect fails ($exposed/$connected)', async ({ exposed, connected }) => {
    const harness = createHarness();
    await approve(harness);
    harness.gateway.setToolExposure('reviewed-server', ['repo.read'], { confirmedByUser: true });
    await harness.gateway.connect({ id: 'stale-server', endpoint, confirmedByUser: true });
    harness.gateway.approve('stale-server', { confirmedByUser: true });
    if (exposed) harness.gateway.setToolExposure('stale-server', ['repo.read'], { confirmedByUser: true });
    if (!connected) await harness.gateway.disconnect('stale-server');
    let rejectReconnect!: (error: Error) => void;
    harness.runtime.connect.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectReconnect = reject;
    }));
    const reconnect = harness.gateway.reconnect('stale-server');
    const rejected = expect(reconnect).rejects.toThrow(/Unable to connect through/i);
    await vi.waitFor(() => expect(rejectReconnect).toBeTypeOf('function'));
    const invoke = (taskId: string) => harness.gateway.invoke({
      accountId: 'account_a', projectId: 'project_a', taskId,
      connectionId: 'reviewed-server', toolName: 'repo.read',
      arguments: { path: 'README.md' }, allowedTools: ['reviewed-server.repo.read'],
      classification: 'read',
    });
    try {
      expect(harness.gateway.getCapabilitySnapshot().connections.map((connection) => connection.id))
        .not.toContain('stale-server');
      await expect(invoke('during-reconnect')).resolves.toMatchObject({ receipt: { status: 'succeeded' } });
    } finally {
      rejectReconnect(new Error('fixture offline'));
      await rejected;
    }
    await expect(invoke('after-reconnect')).resolves.toMatchObject({ receipt: { status: 'succeeded' } });
    expect(harness.runtime.invoke).toHaveBeenCalledTimes(2);
    expect(harness.gateway.getCapabilitySnapshot().connections.map((connection) => connection.id))
      .toContain('reviewed-server');
  });

  it('refreshes capability routes when the runtime reports an unsolicited disconnect', async () => {
    const harness = createHarness();
    await approve(harness);
    harness.gateway.setToolExposure('reviewed-server', ['repo.read'], { confirmedByUser: true });
    expect(harness.gateway.getCapabilitySnapshot().connections.map((connection) => connection.id))
      .toContain('reviewed-server');

    harness.runtime.drop();

    expect(harness.gateway.getCapabilitySnapshot().connections.map((connection) => connection.id))
      .not.toContain('reviewed-server');
    await expect(harness.gateway.invoke({
      accountId: 'account_a', projectId: 'project_a', taskId: 'after-drop',
      connectionId: 'reviewed-server', toolName: 'repo.read',
      arguments: { path: 'README.md' }, allowedTools: ['reviewed-server.repo.read'],
      classification: 'read',
    })).rejects.toThrow('MCP connector is not live');
  });

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

  it('records a normalized external MCP failure as a failed receipt', async () => {
    const harness = createHarness();
    await approve(harness);
    harness.gateway.setToolExposure(
      'reviewed-server',
      ['repo.read'],
      { confirmedByUser: true },
    );
    harness.runtime.invoke.mockResolvedValueOnce({
      ok: false,
      contentTrust: 'external_untrusted',
      safeSummary: 'External MCP tool reported an execution error with 1 text result.',
      textExcerpts: ['The upstream tool rejected the request.'],
      sourceRefs: [],
      artifacts: [],
      suggestedNextActions: [],
      structuredData: { token: '[REDACTED]' },
      omitted: { inlineMedia: 0, unsafeReferences: 0, truncatedValues: 0 },
    });

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

    expect(response.receipt.status).toBe('failed');
    expect(harness.gateway.getReceipts()).toEqual([response.receipt]);
  });

  it('preserves bounded normalized fields when the combined result needs gateway compaction', async () => {
    const harness = createHarness();
    await approve(harness);
    harness.gateway.setToolExposure(
      'reviewed-server',
      ['repo.read'],
      { confirmedByUser: true },
    );
    harness.runtime.invoke.mockResolvedValueOnce({
      ok: true,
      contentTrust: 'external_untrusted',
      safeSummary: 'Large but safe MCP result.',
      textExcerpts: Array.from({ length: 8 }, (_, index) => `excerpt-${index}-${'x'.repeat(1_000)}`),
      sourceRefs: Array.from({ length: 16 }, (_, index) => ({
        uri: `https://example.com/report/${index}/${'x'.repeat(1_900)}`,
        name: `Report ${index}`,
      })),
      artifacts: Array.from({ length: 16 }, (_, index) => ({
        kind: 'link' as const,
        uri: `https://example.com/artifact/${index}/${'x'.repeat(1_900)}`,
        title: `Artifact ${index}`,
      })),
      suggestedNextActions: Array.from({ length: 8 }, (_, index) => `Open report ${index}-${'x'.repeat(280)}`),
      structuredData: {
        answer: 42,
        nonce: 'AUDIT_GATEWAY_COMPACT',
        rows: Array.from({ length: 24 }, (_, index) => ({
          index,
          value: 'x'.repeat(500),
        })),
      },
      omitted: { inlineMedia: 0, unsafeReferences: 0, truncatedValues: 0 },
    });

    const response = await harness.gateway.invoke({
      accountId: 'account_a',
      projectId: 'project_a',
      taskId: 'task_gateway_compaction',
      connectionId: 'reviewed-server',
      toolName: 'repo.read',
      arguments: { path: 'README.md' },
      allowedTools: ['reviewed-server.repo.read'],
      classification: 'read',
    });

    const result = response.result as Record<string, unknown>;
    expect(result).toMatchObject({
      ok: true,
      structuredData: {
        answer: 42,
        nonce: 'AUDIT_GATEWAY_COMPACT',
      },
      sourceRefs: expect.any(Array),
      artifacts: expect.any(Array),
    });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(64 * 1024);
    expect((result.omitted as { truncatedValues: number }).truncatedValues).toBeGreaterThan(0);
  });

  it('re-sanitizes normalized fields for direct Gateway consumers', async () => {
    const harness = createHarness();
    await approve(harness);
    harness.gateway.setToolExposure(
      'reviewed-server',
      ['repo.read'],
      { confirmedByUser: true },
    );
    harness.runtime.invoke.mockResolvedValueOnce({
      ok: true,
      contentTrust: 'external_untrusted',
      safeSummary: 'See https://user:synthetic-secret@example.com/report.',
      textExcerpts: ['See https://user:synthetic-secret@example.com/report.'],
      sourceRefs: [
        {
          uri: 'https://user:synthetic-secret@example.com/report?access_token=leak&view=full',
          name: 'Report',
        },
      ],
      artifacts: [
        {
          kind: 'link',
          uri: 'https://example.com/report',
          title: 'Report',
        },
      ],
      suggestedNextActions: ['Open https://user:synthetic-secret@example.com/report'],
      structuredData: {
        answer: 42,
        accessToken: 'synthetic-access-token',
        nested: { clientSecret: 'synthetic-client-secret' },
      },
      omitted: {
        inlineMedia: Number.MAX_SAFE_INTEGER,
        unsafeReferences: Number.MAX_SAFE_INTEGER,
        truncatedValues: Number.MAX_SAFE_INTEGER,
      },
    });

    const response = await harness.gateway.invoke({
      accountId: 'account_a',
      projectId: 'project_a',
      taskId: 'task_direct_normalized',
      connectionId: 'reviewed-server',
      toolName: 'repo.read',
      arguments: { path: 'README.md' },
      allowedTools: ['reviewed-server.repo.read'],
      classification: 'read',
    });

    const result = response.result as Record<string, unknown>;
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    expect(JSON.stringify(result)).not.toContain('synthetic-access-token');
    expect(JSON.stringify(result)).not.toContain('access_token=leak');
    expect(result).toMatchObject({
      ok: true,
      contentTrust: 'external_untrusted',
      sourceRefs: [],
      artifacts: [{ kind: 'link', uri: 'https://example.com/report', title: 'Report' }],
      structuredData: { answer: 42, nested: { clientSecret: '[REDACTED]' } },
    });
    expect((result.omitted as { inlineMedia: number }).inlineMedia).toBeLessThanOrEqual(1_000_000);
    expect((result.omitted as { unsafeReferences: number }).unsafeReferences).toBeLessThanOrEqual(1_000_000);
    expect((result.omitted as { truncatedValues: number }).truncatedValues).toBeLessThanOrEqual(1_000_000);
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
    for (const key of ['accessToken', 'refresh_token', 'clientSecret', 'credentialBlob', 'sessionToken']) {
      await expect(harness.gateway.invoke({
        ...base,
        arguments: { [key]: 'raw-secret' },
      })).rejects.toThrow('secret references');
    }
    expect(harness.runtime.invoke).not.toHaveBeenCalled();
  });

  it('accepts only approved SAFE_ID values for sensitive secret references', async () => {
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
      taskId: 'task_secret_ref',
      connectionId: 'reviewed-server',
      toolName: 'repo.read',
      allowedTools: ['reviewed-server.repo.read'],
      classification: 'read' as const,
    };

    for (const key of ['accessTokenRef', 'refresh_token_ref', 'clientSecretRef', 'privateKeyRef']) {
      await expect(harness.gateway.invoke({
        ...base,
        arguments: { [key]: 'secret_ref_1' },
      })).rejects.toThrow('secret references');
      await expect(harness.gateway.invoke({
        ...base,
        arguments: { [key]: 'secret_ref_1' },
        secretRefs: ['other_ref'],
      })).rejects.toThrow('secret references');
      await expect(harness.gateway.invoke({
        ...base,
        arguments: { [key]: 'not a safe reference' },
        secretRefs: ['not a safe reference'],
      })).rejects.toThrow('Invalid MCP secret reference');
      await harness.gateway.invoke({
        ...base,
        arguments: { [key]: 'secret_ref_1' },
        secretRefs: ['secret_ref_1'],
      });
    }

    expect(harness.runtime.invoke).toHaveBeenCalledTimes(4);
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

  it('restores only durably approved explicit exposure once across concurrent startup requests', async () => {
    const first = createHarness();
    await approve(first);
    first.gateway.setToolExposure(
      'reviewed-server',
      ['repo.read'],
      { confirmedByUser: true },
    );
    await first.gateway.disconnect('reviewed-server');

    const restartedRuntime = runtimeHarness();
    const restarted = createHarness({ storage: first.stored, runtime: restartedRuntime });
    const [left, right] = await Promise.all([
      restarted.gateway.restoreApprovedConnections(),
      restarted.gateway.restoreApprovedConnections(),
    ]);

    expect(left).toEqual({
      restoredIds: ['reviewed-server'],
      skippedIds: [],
      failedIds: [],
    });
    expect(right).toEqual(left);
    expect(restartedRuntime.connect).toHaveBeenCalledTimes(1);
    expect(restartedRuntime.setToolExposure).toHaveBeenLastCalledWith('reviewed-server', [
      'repo.read',
    ]);
    expect(restarted.gateway.getSnapshot()[0]).toMatchObject({
      state: 'connected',
      trust: 'approved',
      exposedTools: ['repo.read'],
    });

    expect(await restarted.gateway.restoreApprovedConnections()).toEqual({
      restoredIds: [],
      skippedIds: ['reviewed-server'],
      failedIds: [],
    });
    expect(restartedRuntime.connect).toHaveBeenCalledTimes(1);
  });

  it('does not reconnect approved profiles that expose no tools', async () => {
    const first = createHarness();
    await approve(first);
    await first.gateway.disconnect('reviewed-server');

    const restartedRuntime = runtimeHarness();
    const restarted = createHarness({ storage: first.stored, runtime: restartedRuntime });

    expect(await restarted.gateway.restoreApprovedConnections()).toEqual({
      restoredIds: [],
      skippedIds: ['reviewed-server'],
      failedIds: [],
    });
    expect(restartedRuntime.connect).not.toHaveBeenCalled();
  });

  it('bounds a stalled approved restoration and retires its partial runtime lease', async () => {
    vi.useFakeTimers();
    try {
      const first = createHarness();
      await approve(first);
      first.gateway.setToolExposure(
        'reviewed-server',
        ['repo.read'],
        { confirmedByUser: true },
      );
      await first.gateway.disconnect('reviewed-server');

      const stalled = runtimeHarness();
      stalled.connect.mockImplementation(() => new Promise<void>(() => undefined));
      const restarted = createHarness({
        storage: first.stored,
        runtime: stalled,
        restoreTimeoutMs: 25,
      });
      const restoration = restarted.gateway.restoreApprovedConnections();

      await vi.advanceTimersByTimeAsync(25);
      await expect(restoration).resolves.toEqual({
        restoredIds: [],
        skippedIds: [],
        failedIds: ['reviewed-server'],
      });
      expect(stalled.connect).toHaveBeenCalledTimes(1);
      expect(stalled.disconnect).toHaveBeenCalledWith('reviewed-server');
    } finally {
      vi.useRealTimers();
    }
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
