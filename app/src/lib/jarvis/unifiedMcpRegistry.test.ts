import { describe, expect, it } from 'vitest';
import { createUnifiedMcpRegistry } from './unifiedMcpRegistry';

const scope = { accountId: 'account-1', projectId: 'project-1' };

function connection(id = 'github') {
  return {
    schemaVersion: 1 as const,
    id,
    serverId: 'github-server',
    kind: 'external_mcp' as const,
    tools: [
      {
        serverId: 'github-server',
        toolName: 'repo.read',
        capabilityId: 'mcp.github.repo.read',
      },
    ],
  };
}

describe('unified MCP registry', () => {
  it('isolates connections by account/project and rejects duplicate or conflicting tool identities', () => {
    const registry = createUnifiedMcpRegistry();
    registry.register(scope, connection());
    registry.register({ accountId: 'account-1', projectId: 'project-2' }, connection());

    expect(() => registry.register(scope, connection())).toThrow();
    expect(() =>
      registry.register(scope, {
        ...connection('github-other'),
        tools: [
          {
            serverId: 'github-server',
            toolName: 'repo.read',
            capabilityId: 'mcp.other.repo.read',
          },
        ],
      }),
    ).toThrow();
    expect(registry.snapshot(scope).connections).toHaveLength(1);
    expect(
      registry.snapshot({ accountId: 'account-1', projectId: 'project-2' }).connections,
    ).toHaveLength(1);
  });

  it('publishes frozen health and capability snapshots with no implicit authority', () => {
    const registry = createUnifiedMcpRegistry();
    registry.register(scope, connection());
    registry.updateHealth(scope, 'github', {
      generation: 1,
      state: 'connected',
      observedAt: 1_000,
      evidenceRef: 'jlive_mcp_github_1',
    });

    const snapshot = registry.snapshot(scope);
    expect(snapshot).toEqual({
      schemaVersion: 1,
      accountId: 'account-1',
      projectId: 'project-1',
      connections: [
        {
          id: 'github',
          serverId: 'github-server',
          kind: 'external_mcp',
          state: 'connected',
          generation: 1,
          observedAt: 1_000,
          evidenceRef: 'jlive_mcp_github_1',
          authority: 'none',
          tools: [
            {
              serverId: 'github-server',
              toolName: 'repo.read',
              capabilityId: 'mcp.github.repo.read',
              metadataTrust: 'external_untrusted',
              authority: 'none',
            },
          ],
        },
      ],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.connections[0]?.tools[0])).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/credential|password|token|endpoint/i);
    expect(() =>
      registry.updateHealth(scope, 'github', {
        generation: 1,
        state: 'degraded',
        observedAt: 1_001,
        evidenceRef: 'jlive_mcp_github_2',
      }),
    ).toThrow();
  });

  it('resolves only exact connected tool identities and provides cancellable non-authoritative handles', () => {
    const registry = createUnifiedMcpRegistry();
    registry.register(scope, connection());
    registry.updateHealth(scope, 'github', {
      generation: 1,
      state: 'connected',
      observedAt: 1_000,
      evidenceRef: 'jlive_mcp_github_1',
    });

    const handle = registry.beginInvocation(scope, {
      invocationId: 'invocation-1',
      connectionId: 'github',
      serverId: 'github-server',
      toolName: 'repo.read',
    });
    expect(handle).toMatchObject({
      invocationId: 'invocation-1',
      authority: 'none',
      tool: {
        serverId: 'github-server',
        toolName: 'repo.read',
        metadataTrust: 'external_untrusted',
      },
    });
    expect(handle.signal.aborted).toBe(false);
    expect(() =>
      registry.beginInvocation(scope, {
        invocationId: 'invocation-1',
        connectionId: 'github',
        serverId: 'github-server',
        toolName: 'repo.read',
      }),
    ).toThrow();
    expect(registry.cancelInvocation(scope, 'invocation-1')).toBe(true);
    expect(handle.signal.aborted).toBe(true);
    expect(registry.cancelInvocation(scope, 'invocation-1')).toBe(false);
    expect(() =>
      registry.beginInvocation(scope, {
        invocationId: 'invocation-2',
        connectionId: 'github',
        serverId: 'other-server',
        toolName: 'repo.read',
      }),
    ).toThrow();
  });
});
