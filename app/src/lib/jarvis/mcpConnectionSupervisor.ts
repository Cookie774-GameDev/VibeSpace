import {
  type UnifiedMcpConnectionInput,
  type UnifiedMcpRegistry,
  type UnifiedMcpScope,
  type UnifiedMcpToolInput,
} from './unifiedMcpRegistry';

export type TrustedMcpConnectionConfig = Readonly<{
  schemaVersion: 1;
  id: string;
  serverId: string;
  kind: UnifiedMcpConnectionInput['kind'];
  connectorId: string;
  enabled: boolean;
  trust: 'trusted';
  reconnect: Readonly<{
    baseDelayMs: number;
    maxDelayMs: number;
    maxAttempts: number;
  }>;
}>;

export type McpConnectedSession = Readonly<{
  tools: readonly UnifiedMcpToolInput[];
  evidenceRef: `jlive_${string}`;
  disconnect(): Promise<void>;
}>;

export interface McpConnectionPort {
  connect(input: {
    config: TrustedMcpConnectionConfig;
    signal: AbortSignal;
  }): Promise<McpConnectedSession>;
}

export interface McpSupervisorScheduler {
  schedule(delayMs: number, callback: () => void): Readonly<{ cancel(): void }>;
}

export type McpSupervisedConnectionSnapshot = Readonly<{
  id: string;
  serverId: string;
  connectorId: string;
  state: 'connecting' | 'connected' | 'degraded' | 'disconnected';
  attempt: number;
  nextRetryAt?: number;
  authority: 'none';
}>;

export type McpConnectionSupervisorSnapshot = Readonly<{
  schemaVersion: 1;
  accountId: string;
  projectId: string;
  connections: readonly McpSupervisedConnectionSnapshot[];
}>;

export interface McpConnectionSupervisor {
  start(
    scope: UnifiedMcpScope,
    configs: readonly TrustedMcpConnectionConfig[],
  ): Promise<void>;
  disconnect(scope: UnifiedMcpScope, connectionId: string): Promise<boolean>;
  snapshot(scope: UnifiedMcpScope): McpConnectionSupervisorSnapshot;
}

type ManagedConnection = {
  config: TrustedMcpConnectionConfig;
  state: McpSupervisedConnectionSnapshot['state'];
  attempt: number;
  nextRetryAt?: number;
  active: boolean;
  registered: boolean;
  registryGeneration: number;
  toolIdentity?: string;
  controller?: AbortController;
  retry?: Readonly<{ cancel(): void }>;
  session?: McpConnectedSession;
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u;
const LIVE_REF = /^jlive_[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;

function scopeKey(scope: UnifiedMcpScope): string {
  if (!SAFE_ID.test(scope.accountId) || !SAFE_ID.test(scope.projectId)) {
    throw new Error('Invalid MCP supervisor scope.');
  }
  return `${scope.accountId}\u0000${scope.projectId}`;
}

function validateConfig(config: TrustedMcpConnectionConfig): void {
  if (
    config.schemaVersion !== 1 ||
    !SAFE_ID.test(config.id) ||
    !SAFE_ID.test(config.serverId) ||
    !SAFE_ID.test(config.connectorId) ||
    !['local_mcp_lite', 'external_mcp'].includes(config.kind) ||
    config.trust !== 'trusted' ||
    typeof config.enabled !== 'boolean' ||
    !Number.isSafeInteger(config.reconnect.baseDelayMs) ||
    config.reconnect.baseDelayMs < 1 ||
    !Number.isSafeInteger(config.reconnect.maxDelayMs) ||
    config.reconnect.maxDelayMs < config.reconnect.baseDelayMs ||
    !Number.isSafeInteger(config.reconnect.maxAttempts) ||
    config.reconnect.maxAttempts < 1 ||
    config.reconnect.maxAttempts > 20
  ) {
    throw new Error('Invalid trusted MCP connection config.');
  }
}

function retryDelay(config: TrustedMcpConnectionConfig, failedAttempt: number): number {
  return Math.min(
    config.reconnect.maxDelayMs,
    config.reconnect.baseDelayMs * 2 ** Math.max(0, failedAttempt - 1),
  );
}

function toolsIdentity(tools: readonly UnifiedMcpToolInput[]): string {
  return [...tools]
    .map(({ serverId, toolName, capabilityId }) => `${serverId}\u0001${toolName}\u0001${capabilityId}`)
    .sort()
    .join('\u0002');
}

export function createMcpConnectionSupervisor(input: {
  registry: UnifiedMcpRegistry;
  port: McpConnectionPort;
  clock: Readonly<{ now(): number }>;
  scheduler: McpSupervisorScheduler;
}): McpConnectionSupervisor {
  const byScope = new Map<string, Map<string, ManagedConnection>>();

  function scoped(scope: UnifiedMcpScope): Map<string, ManagedConnection> {
    const key = scopeKey(scope);
    let connections = byScope.get(key);
    if (!connections) {
      connections = new Map();
      byScope.set(key, connections);
    }
    return connections;
  }

  async function connect(scope: UnifiedMcpScope, managed: ManagedConnection): Promise<void> {
    if (!managed.active) return;
    managed.attempt += 1;
    managed.state = 'connecting';
    managed.nextRetryAt = undefined;
    const controller = new AbortController();
    managed.controller = controller;
    try {
      const session = await input.port.connect({
        config: managed.config,
        signal: controller.signal,
      });
      if (!managed.active || controller.signal.aborted) {
        await session.disconnect();
        return;
      }
      if (!LIVE_REF.test(session.evidenceRef) || session.tools.length === 0) {
        await session.disconnect();
        throw new Error('Invalid MCP connection session.');
      }
      const identity = toolsIdentity(session.tools);
      if (!managed.registered) {
        input.registry.register(scope, {
          schemaVersion: 1,
          id: managed.config.id,
          serverId: managed.config.serverId,
          kind: managed.config.kind,
          tools: session.tools,
        });
        managed.registered = true;
        managed.toolIdentity = identity;
      } else if (identity !== managed.toolIdentity) {
        await session.disconnect();
        managed.active = false;
        managed.state = 'disconnected';
        throw new Error('MCP tool identity changed during reconnect.');
      }
      managed.registryGeneration += 1;
      input.registry.updateHealth(scope, managed.config.id, {
        generation: managed.registryGeneration,
        state: 'connected',
        observedAt: input.clock.now(),
        evidenceRef: session.evidenceRef,
      });
      managed.session = session;
      managed.state = 'connected';
    } catch {
      managed.controller = undefined;
      if (!managed.active || controller.signal.aborted) return;
      if (managed.attempt >= managed.config.reconnect.maxAttempts) {
        managed.state = 'disconnected';
        if (managed.registered) {
          managed.registryGeneration += 1;
          input.registry.updateHealth(scope, managed.config.id, {
            generation: managed.registryGeneration,
            state: 'disconnected',
            observedAt: input.clock.now(),
          });
        }
        return;
      }
      const delay = retryDelay(managed.config, managed.attempt);
      managed.state = 'degraded';
      managed.nextRetryAt = input.clock.now() + delay;
      managed.retry = input.scheduler.schedule(delay, () => {
        managed.retry = undefined;
        void connect(scope, managed);
      });
    }
  }

  const supervisor: McpConnectionSupervisor = {
    async start(scope, configs) {
      const connections = scoped(scope);
      const enabled = configs.filter((config) => {
        validateConfig(config);
        return config.enabled && config.trust === 'trusted';
      });
      const seen = new Set<string>();
      for (const config of enabled) {
        if (seen.has(config.id) || connections.has(config.id)) {
          throw new Error('Duplicate supervised MCP connection.');
        }
        seen.add(config.id);
      }
      const pending = enabled.map((config) => {
        const managed: ManagedConnection = {
          config: Object.freeze({
            ...config,
            reconnect: Object.freeze({ ...config.reconnect }),
          }),
          state: 'connecting',
          attempt: 0,
          active: true,
          registered: false,
          registryGeneration: 0,
        };
        connections.set(config.id, managed);
        return connect(scope, managed);
      });
      await Promise.all(pending);
    },

    async disconnect(scope, connectionId) {
      const managed = scoped(scope).get(connectionId);
      if (!managed || !managed.active) return false;
      managed.active = false;
      managed.controller?.abort(new DOMException('MCP connection cancelled.', 'AbortError'));
      managed.retry?.cancel();
      managed.retry = undefined;
      managed.nextRetryAt = undefined;
      if (managed.session) await managed.session.disconnect();
      managed.session = undefined;
      managed.state = 'disconnected';
      if (managed.registered) {
        managed.registryGeneration += 1;
        input.registry.updateHealth(scope, connectionId, {
          generation: managed.registryGeneration,
          state: 'disconnected',
          observedAt: input.clock.now(),
        });
      }
      return true;
    },

    snapshot(scope) {
      const connections = [...scoped(scope).values()]
        .sort((left, right) => left.config.id.localeCompare(right.config.id))
        .map((managed) =>
          Object.freeze({
            id: managed.config.id,
            serverId: managed.config.serverId,
            connectorId: managed.config.connectorId,
            state: managed.state,
            attempt: managed.attempt,
            ...(managed.nextRetryAt === undefined
              ? {}
              : { nextRetryAt: managed.nextRetryAt }),
            authority: 'none' as const,
          }),
        );
      return Object.freeze({
        schemaVersion: 1,
        accountId: scope.accountId,
        projectId: scope.projectId,
        connections: Object.freeze(connections),
      });
    },
  };
  return Object.freeze(supervisor);
}
