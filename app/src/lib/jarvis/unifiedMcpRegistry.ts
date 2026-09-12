export type UnifiedMcpScope = Readonly<{ accountId: string; projectId: string }>;
export type UnifiedMcpConnectionState = 'configured' | 'connected' | 'degraded' | 'disconnected';

export type UnifiedMcpToolInput = Readonly<{
  serverId: string;
  toolName: string;
  capabilityId: string;
}>;

export type UnifiedMcpToolSnapshot = Readonly<
  UnifiedMcpToolInput & {
    metadataTrust: 'external_untrusted';
    authority: 'none';
  }
>;

export type UnifiedMcpConnectionInput = Readonly<{
  schemaVersion: 1;
  id: string;
  serverId: string;
  kind: 'local_mcp_lite' | 'external_mcp';
  tools: readonly UnifiedMcpToolInput[];
}>;

export type UnifiedMcpConnectionSnapshot = Readonly<{
  id: string;
  serverId: string;
  kind: UnifiedMcpConnectionInput['kind'];
  state: UnifiedMcpConnectionState;
  generation: number;
  observedAt?: number;
  evidenceRef?: `jlive_${string}`;
  authority: 'none';
  tools: readonly UnifiedMcpToolSnapshot[];
}>;

export type UnifiedMcpCapabilitySnapshot = Readonly<{
  schemaVersion: 1;
  accountId: string;
  projectId: string;
  connections: readonly UnifiedMcpConnectionSnapshot[];
}>;

export type UnifiedMcpInvocationHandle = Readonly<{
  invocationId: string;
  authority: 'none';
  tool: UnifiedMcpToolSnapshot;
  signal: AbortSignal;
}>;

export interface UnifiedMcpRegistry {
  register(scope: UnifiedMcpScope, connection: UnifiedMcpConnectionInput): void;
  updateHealth(
    scope: UnifiedMcpScope,
    connectionId: string,
    health: Readonly<{
      generation: number;
      state: Exclude<UnifiedMcpConnectionState, 'configured'>;
      observedAt: number;
      evidenceRef?: `jlive_${string}`;
    }>,
  ): void;
  snapshot(scope: UnifiedMcpScope): UnifiedMcpCapabilitySnapshot;
  beginInvocation(
    scope: UnifiedMcpScope,
    input: Readonly<{
      invocationId: string;
      connectionId: string;
      serverId: string;
      toolName: string;
    }>,
  ): UnifiedMcpInvocationHandle;
  cancelInvocation(scope: UnifiedMcpScope, invocationId: string): boolean;
}

type ManagedConnection = {
  readonly id: string;
  readonly serverId: string;
  readonly kind: UnifiedMcpConnectionInput['kind'];
  readonly tools: readonly UnifiedMcpToolSnapshot[];
  state: UnifiedMcpConnectionState;
  generation: number;
  observedAt?: number;
  evidenceRef?: `jlive_${string}`;
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u;
const LIVE_REF = /^jlive_[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;

function assertScope(scope: UnifiedMcpScope): void {
  if (!SAFE_ID.test(scope.accountId) || !SAFE_ID.test(scope.projectId)) {
    throw new Error('Invalid MCP registry scope.');
  }
}

function scopeKey(scope: UnifiedMcpScope): string {
  assertScope(scope);
  return `${scope.accountId}\u0000${scope.projectId}`;
}

function exactToolKey(serverId: string, toolName: string): string {
  return `${serverId}\u0000${toolName}`;
}

function frozenTool(input: UnifiedMcpToolInput): UnifiedMcpToolSnapshot {
  if (
    !SAFE_ID.test(input.serverId) ||
    !SAFE_ID.test(input.toolName) ||
    !SAFE_ID.test(input.capabilityId)
  ) {
    throw new Error('Invalid MCP tool identity.');
  }
  return Object.freeze({
    serverId: input.serverId,
    toolName: input.toolName,
    capabilityId: input.capabilityId,
    metadataTrust: 'external_untrusted',
    authority: 'none',
  });
}

export function createUnifiedMcpRegistry(): UnifiedMcpRegistry {
  const connectionsByScope = new Map<string, Map<string, ManagedConnection>>();
  const invocationsByScope = new Map<string, Map<string, AbortController>>();

  function connections(scope: UnifiedMcpScope): Map<string, ManagedConnection> {
    const key = scopeKey(scope);
    let scoped = connectionsByScope.get(key);
    if (!scoped) {
      scoped = new Map();
      connectionsByScope.set(key, scoped);
    }
    return scoped;
  }

  const registry: UnifiedMcpRegistry = {
    register(scope, input) {
      const scoped = connections(scope);
      if (
        input.schemaVersion !== 1 ||
        !SAFE_ID.test(input.id) ||
        !SAFE_ID.test(input.serverId) ||
        !['local_mcp_lite', 'external_mcp'].includes(input.kind) ||
        input.tools.length === 0 ||
        scoped.has(input.id)
      ) {
        throw new Error('Invalid or duplicate MCP connection.');
      }
      const existingTools = new Set(
        [...scoped.values()].flatMap((connection) =>
          connection.tools.map((tool) => exactToolKey(tool.serverId, tool.toolName)),
        ),
      );
      const tools = input.tools.map((tool) => {
        const frozen = frozenTool(tool);
        const key = exactToolKey(frozen.serverId, frozen.toolName);
        if (frozen.serverId !== input.serverId || existingTools.has(key)) {
          throw new Error('Conflicting MCP tool identity.');
        }
        existingTools.add(key);
        return frozen;
      });
      scoped.set(input.id, {
        id: input.id,
        serverId: input.serverId,
        kind: input.kind,
        tools: Object.freeze(tools),
        state: 'configured',
        generation: 0,
      });
    },

    updateHealth(scope, connectionId, health) {
      const connection = connections(scope).get(connectionId);
      if (
        !connection ||
        health.generation !== connection.generation + 1 ||
        !['connected', 'degraded', 'disconnected'].includes(health.state) ||
        !Number.isFinite(health.observedAt) ||
        health.observedAt < (connection.observedAt ?? 0) ||
        ((health.state === 'connected' || health.state === 'degraded') &&
          (!health.evidenceRef || !LIVE_REF.test(health.evidenceRef))) ||
        (health.evidenceRef !== undefined && !LIVE_REF.test(health.evidenceRef))
      ) {
        throw new Error('Invalid MCP connection health transition.');
      }
      connection.state = health.state;
      connection.generation = health.generation;
      connection.observedAt = health.observedAt;
      connection.evidenceRef = health.evidenceRef;
    },

    snapshot(scope) {
      const scoped = connections(scope);
      const snapshots = [...scoped.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(
          (connection): UnifiedMcpConnectionSnapshot =>
            Object.freeze({
              id: connection.id,
              serverId: connection.serverId,
              kind: connection.kind,
              state: connection.state,
              generation: connection.generation,
              ...(connection.observedAt === undefined ? {} : { observedAt: connection.observedAt }),
              ...(connection.evidenceRef === undefined
                ? {}
                : { evidenceRef: connection.evidenceRef }),
              authority: 'none',
              tools: connection.tools,
            }),
        );
      return Object.freeze({
        schemaVersion: 1,
        accountId: scope.accountId,
        projectId: scope.projectId,
        connections: Object.freeze(snapshots),
      });
    },

    beginInvocation(scope, input) {
      if (!SAFE_ID.test(input.invocationId)) {
        throw new Error('Invalid MCP invocation identity.');
      }
      const key = scopeKey(scope);
      const connection = connections(scope).get(input.connectionId);
      const tool = connection?.tools.find(
        (candidate) =>
          candidate.serverId === input.serverId && candidate.toolName === input.toolName,
      );
      let invocations = invocationsByScope.get(key);
      if (!invocations) {
        invocations = new Map();
        invocationsByScope.set(key, invocations);
      }
      if (
        !connection ||
        connection.state !== 'connected' ||
        !tool ||
        invocations.has(input.invocationId)
      ) {
        throw new Error('MCP invocation route is unavailable.');
      }
      const controller = new AbortController();
      invocations.set(input.invocationId, controller);
      return Object.freeze({
        invocationId: input.invocationId,
        authority: 'none',
        tool,
        signal: controller.signal,
      });
    },

    cancelInvocation(scope, invocationId) {
      const invocations = invocationsByScope.get(scopeKey(scope));
      const controller = invocations?.get(invocationId);
      if (!controller) return false;
      invocations?.delete(invocationId);
      controller.abort(new DOMException('MCP invocation cancelled.', 'AbortError'));
      return true;
    },
  };
  return Object.freeze(registry);
}
