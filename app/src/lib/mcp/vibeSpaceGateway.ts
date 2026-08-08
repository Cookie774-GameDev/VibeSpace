import {
  createMcpConnectionSupervisor,
  type McpConnectionSupervisor,
} from '../jarvis/mcpConnectionSupervisor';
import {
  createUnifiedMcpRegistry,
  type UnifiedMcpCapabilitySnapshot,
  type UnifiedMcpRegistry,
  type UnifiedMcpScope,
} from '../jarvis/unifiedMcpRegistry';
import {
  remoteMcpSetupRuntime,
  type RemoteMcpConnectRequest,
  type RemoteMcpSetupConnection,
  type RemoteMcpSetupRuntime,
  type RemoteMcpSetupTool,
} from './remoteSetupRuntime';

const PROFILE_VERSION = 1;
const MAX_PROFILES = 16;
const MAX_TOOLS = 64;
const MAX_STORED_CHARS = 64 * 1024;
const MAX_RECONNECT_ATTEMPTS = 3;
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u;
const STORAGE_PREFIX = 'vibespace.mcp-gateway.v1';
const SAFE_GATEWAY_ERROR = 'Unable to connect through the VibeSpace MCP Gateway.';
const MAX_RECEIPTS = 128;
const MAX_RESULT_CHARS = 64 * 1024;
const MAX_IN_FLIGHT = 4;
const SECRET_TEXT = /(bearer\s+[a-z0-9._~+/-]+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+)/gi;
const FORBIDDEN_SECRET_KEY = /^(?:authorization|api[_-]?key|token|password|secret|credential)$/i;

export type VibeSpaceGatewayTrust =
  | 'approval_required'
  | 'approved'
  | 'changed'
  | 'revoked';

export type VibeSpaceGatewayConnection = Readonly<Omit<RemoteMcpSetupConnection, 'state'> & {
  readonly state: RemoteMcpSetupConnection['state'] | 'disconnected';
  readonly trust: VibeSpaceGatewayTrust;
  readonly schemaDigest: string;
  readonly reconnectAttempt: number;
  readonly nextReconnectAt?: number;
  readonly durableApproval: boolean;
  readonly schemaDiff?: Readonly<{
    addedTools: readonly string[];
    removedTools: readonly string[];
    changedTools: readonly string[];
    catalogChanged: boolean;
  }>;
}>;

export interface GatewayStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface VibeSpaceGatewayClock {
  now(): number;
}

export interface VibeSpaceGatewayApproval {
  readonly confirmedByUser: boolean;
}

export interface VibeSpaceGatewayDisconnectOptions {
  readonly forgetApproval?: boolean;
}

export type VibeSpaceMcpInvocationClassification = 'read' | 'write' | 'mutation';

export interface VibeSpaceMcpInvocationRequest {
  readonly accountId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly connectionId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly allowedTools: readonly string[];
  readonly classification: VibeSpaceMcpInvocationClassification;
  readonly secretRefs?: readonly string[];
  readonly approval?: VibeSpaceGatewayApproval;
  readonly signal?: AbortSignal;
  readonly onProgress?: (update: Readonly<{
    progress: number;
    total?: number;
    message?: string;
  }>) => void;
}

export interface VibeSpaceMcpInvocationReceipt {
  readonly receiptId: string;
  readonly accountId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly connectionId: string;
  readonly toolName: string;
  readonly classification: VibeSpaceMcpInvocationClassification;
  readonly schemaDigest: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly status: 'succeeded' | 'failed' | 'cancelled';
}

export interface VibeSpaceMcpInvocationResult {
  readonly result: unknown;
  readonly receipt: Readonly<VibeSpaceMcpInvocationReceipt>;
}

export interface VibeSpaceMcpGateway {
  getSnapshot(): readonly Readonly<VibeSpaceGatewayConnection>[];
  subscribe(listener: () => void): () => void;
  connect(request: RemoteMcpConnectRequest): Promise<void>;
  approve(id: string, approval: VibeSpaceGatewayApproval): void;
  reconnect(id: string, endpoint?: string): Promise<void>;
  setToolExposure(
    id: string,
    toolNames: readonly string[],
    approval?: VibeSpaceGatewayApproval,
  ): void;
  disconnect(id: string, options?: VibeSpaceGatewayDisconnectOptions): Promise<void>;
  revoke(id: string): Promise<void>;
  getCapabilitySnapshot(): UnifiedMcpCapabilitySnapshot;
  invoke(request: VibeSpaceMcpInvocationRequest): Promise<VibeSpaceMcpInvocationResult>;
  getReceipts(): readonly Readonly<VibeSpaceMcpInvocationReceipt>[];
}

type StoredTool = Readonly<{
  name: string;
  schemaDigest: string;
  classification: VibeSpaceMcpInvocationClassification;
}>;
type StoredProfile = Readonly<{
  version: 1;
  id: string;
  endpoint: string;
  endpointIntegrity: string;
  schemaDigest: string;
  tools: readonly StoredTool[];
  exposedTools: readonly string[];
  approvedAt: number;
}>;

type RetryState = { attempt: number; nextAt?: number };

export interface VibeSpaceGatewayDependencies {
  readonly scope: UnifiedMcpScope;
  readonly runtime?: RemoteMcpSetupRuntime;
  readonly storage?: GatewayStorage;
  readonly clock?: VibeSpaceGatewayClock;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) output[key] = stableValue(source[key]);
  return output;
}

function digest(value: unknown): string {
  const text = JSON.stringify(stableValue(value));
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
}

function toolMetadata(tools: readonly RemoteMcpSetupTool[]): readonly StoredTool[] {
  if (tools.length > MAX_TOOLS) throw new Error('MCP profile has too many tools.');
  return Object.freeze(
    tools
      .map((tool) =>
        Object.freeze({
          name: tool.name,
          schemaDigest: digest(tool.inputSchema),
          classification: tool.classification ?? 'write',
        }),
      )
      .sort((left, right) => left.name.localeCompare(right.name, 'en')),
  );
}

function connectionSchemaDigest(connection: Pick<
  RemoteMcpSetupConnection,
  'tools' | 'resources' | 'prompts' | 'schemaFingerprint'
>): string {
  return digest({
    tools: toolMetadata(connection.tools),
    resources: connection.resources ?? [],
    prompts: connection.prompts ?? [],
    sdk: connection.schemaFingerprint ?? null,
  });
}

function profileStorageKey(scope: UnifiedMcpScope): string {
  if (!SAFE_ID.test(scope.accountId) || !SAFE_ID.test(scope.projectId)) {
    throw new Error('Invalid MCP gateway scope.');
  }
  return `${STORAGE_PREFIX}:${scope.accountId.length}:${scope.accountId}:${scope.projectId}`;
}

function validProfile(value: unknown): value is StoredProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const profile = value as Partial<StoredProfile>;
  return (
    profile.version === PROFILE_VERSION &&
    typeof profile.id === 'string' &&
    SAFE_ID.test(profile.id) &&
    typeof profile.endpoint === 'string' &&
    profile.endpoint.length <= 2_048 &&
    typeof profile.endpointIntegrity === 'string' &&
    /^[a-f0-9]{16}$/u.test(profile.endpointIntegrity) &&
    typeof profile.schemaDigest === 'string' &&
    /^[a-f0-9]{16}$/u.test(profile.schemaDigest) &&
    Array.isArray(profile.tools) &&
    profile.tools.length <= MAX_TOOLS &&
    profile.tools.every(
      (tool) =>
        tool &&
        typeof tool.name === 'string' &&
        SAFE_ID.test(tool.name) &&
        typeof tool.schemaDigest === 'string' &&
        /^[a-f0-9]{16}$/u.test(tool.schemaDigest) &&
        ['read', 'write', 'mutation'].includes(tool.classification),
    ) &&
    Array.isArray(profile.exposedTools) &&
    profile.exposedTools.length <= MAX_TOOLS &&
    profile.exposedTools.every(
      (name) => typeof name === 'string' && profile.tools?.some((tool) => tool.name === name),
    ) &&
    typeof profile.approvedAt === 'number' &&
    Number.isFinite(profile.approvedAt)
  );
}

function loadProfiles(storage: GatewayStorage | undefined, key: string): Map<string, StoredProfile> {
  const profiles = new Map<string, StoredProfile>();
  let serialized: string | null | undefined;
  try {
    serialized = storage?.getItem(key);
  } catch {
    return profiles;
  }
  if (!serialized || serialized.length > MAX_STORED_CHARS) return profiles;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed) || parsed.length > MAX_PROFILES) return profiles;
    for (const candidate of parsed) {
      if (!validProfile(candidate) || profiles.has(candidate.id)) return new Map();
      const profile: StoredProfile = Object.freeze({
        version: PROFILE_VERSION,
        id: candidate.id,
        endpoint: candidate.endpoint,
        endpointIntegrity: candidate.endpointIntegrity,
        schemaDigest: candidate.schemaDigest,
        tools: Object.freeze(
          candidate.tools.map((tool) =>
            Object.freeze({
              name: tool.name,
              schemaDigest: tool.schemaDigest,
              classification: tool.classification,
            }),
          ),
        ),
        exposedTools: Object.freeze([...candidate.exposedTools]),
        approvedAt: candidate.approvedAt,
      });
      profiles.set(profile.id, profile);
    }
  } catch {
    return new Map();
  }
  return profiles;
}

function defaultStorage(): GatewayStorage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function schemaDiff(
  connection: RemoteMcpSetupConnection,
  profile: StoredProfile,
): NonNullable<VibeSpaceGatewayConnection['schemaDiff']> {
  const observed = new Map(toolMetadata(connection.tools).map((tool) => [tool.name, tool]));
  const approved = new Map(profile.tools.map((tool) => [tool.name, tool]));
  const addedTools = [...observed.keys()].filter((name) => !approved.has(name)).sort();
  const removedTools = [...approved.keys()].filter((name) => !observed.has(name)).sort();
  const changedTools = [...observed.entries()]
    .filter(([name, tool]) => {
      const prior = approved.get(name);
      return prior && (
        prior.schemaDigest !== tool.schemaDigest ||
        prior.classification !== tool.classification
      );
    })
    .map(([name]) => name)
    .sort();
  return Object.freeze({
    addedTools: Object.freeze(addedTools),
    removedTools: Object.freeze(removedTools),
    changedTools: Object.freeze(changedTools),
    catalogChanged:
      connectionSchemaDigest(connection) !== profile.schemaDigest &&
      addedTools.length === 0 &&
      removedTools.length === 0 &&
      changedTools.length === 0,
  });
}

function loadReceipts(
  storage: GatewayStorage | undefined,
  key: string,
): VibeSpaceMcpInvocationReceipt[] {
  try {
    const serialized = storage?.getItem(`${key}:receipts`);
    if (!serialized || serialized.length > MAX_STORED_CHARS) return [];
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed) || parsed.length > MAX_RECEIPTS) return [];
    return parsed.filter((value): value is VibeSpaceMcpInvocationReceipt => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const receipt = value as Partial<VibeSpaceMcpInvocationReceipt>;
      return (
        typeof receipt.receiptId === 'string' &&
        SAFE_ID.test(receipt.receiptId) &&
        typeof receipt.taskId === 'string' &&
        SAFE_ID.test(receipt.taskId) &&
        typeof receipt.connectionId === 'string' &&
        typeof receipt.toolName === 'string' &&
        ['read', 'write', 'mutation'].includes(receipt.classification ?? '') &&
        ['succeeded', 'failed', 'cancelled'].includes(receipt.status ?? '')
      );
    });
  } catch {
    return [];
  }
}

function assertNoRawSecrets(value: unknown, depth = 0): void {
  if (depth > 8) throw new Error('MCP arguments exceed the safe nesting limit.');
  if (Array.isArray(value)) {
    for (const item of value) assertNoRawSecrets(item, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_SECRET_KEY.test(key) && !/ref$/i.test(key)) {
      throw new Error('Use secret references instead of raw MCP credentials.');
    }
    assertNoRawSecrets(child, depth + 1);
  }
}

function safeResult(value: unknown): unknown {
  const sanitize = (candidate: unknown, depth: number): unknown => {
    if (depth > 8) return '[truncated]';
    if (typeof candidate === 'string') return candidate.replace(SECRET_TEXT, '[REDACTED]');
    if (Array.isArray(candidate)) return candidate.slice(0, 256).map((item) => sanitize(item, depth + 1));
    if (!candidate || typeof candidate !== 'object') return candidate;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>).slice(0, 256)) {
      output[key] = FORBIDDEN_SECRET_KEY.test(key) ? '[REDACTED]' : sanitize(child, depth + 1);
    }
    return output;
  };
  const sanitized = sanitize(value, 0);
  const serialized = JSON.stringify(sanitized) ?? 'null';
  return serialized.length <= MAX_RESULT_CHARS
    ? sanitized
    : Object.freeze({ truncated: true, preview: serialized.slice(0, MAX_RESULT_CHARS) });
}

export function createVibeSpaceMcpGateway(
  dependencies: VibeSpaceGatewayDependencies,
): VibeSpaceMcpGateway {
  const runtime = dependencies.runtime ?? remoteMcpSetupRuntime;
  const storage = dependencies.storage ?? defaultStorage();
  const clock = dependencies.clock ?? { now: () => Date.now() };
  const key = profileStorageKey(dependencies.scope);
  const profiles = loadProfiles(storage, key);
  const receipts = loadReceipts(storage, key);
  const ownedIds = new Set(profiles.keys());
  const pendingTrust = new Map<string, VibeSpaceGatewayTrust>();
  const retryState = new Map<string, RetryState>();
  const listeners = new Set<() => void>();
  let registry: UnifiedMcpRegistry = createUnifiedMcpRegistry();
  let supervisor: McpConnectionSupervisor | undefined;
  let liveCounter = 0;
  let invocationCounter = 0;
  let inFlight = 0;
  let snapshot: readonly Readonly<VibeSpaceGatewayConnection>[] = Object.freeze([]);

  const persist = () => {
    if (!storage) return;
    const serialized = JSON.stringify(
      [...profiles.values()].sort((left, right) => left.id.localeCompare(right.id, 'en')),
    );
    if (serialized.length > MAX_STORED_CHARS) throw new Error('MCP approval store is too large.');
    if (profiles.size === 0) storage.removeItem(key);
    else storage.setItem(key, serialized);
  };

  const persistReceipts = () => {
    if (!storage) return;
    const serialized = JSON.stringify(receipts);
    if (serialized.length > MAX_STORED_CHARS) {
      while (receipts.length > 1 && JSON.stringify(receipts).length > MAX_STORED_CHARS) {
        receipts.shift();
      }
    }
    if (receipts.length === 0) storage.removeItem(`${key}:receipts`);
    else storage.setItem(`${key}:receipts`, JSON.stringify(receipts));
  };

  const appendReceipt = (receipt: VibeSpaceMcpInvocationReceipt) => {
    receipts.push(Object.freeze(receipt));
    while (receipts.length > MAX_RECEIPTS) receipts.shift();
    try {
      persistReceipts();
    } catch {
      // Invocation evidence remains available in memory when durable storage is unavailable.
    }
  };

  const rebuild = () => {
    const live = new Map(
      runtime
        .getSnapshot()
        .filter((connection) => ownedIds.has(connection.id))
        .map((connection) => [connection.id, connection]),
    );
    const ids = new Set([...profiles.keys(), ...live.keys(), ...pendingTrust.keys()]);
    snapshot = Object.freeze(
      [...ids]
        .sort((left, right) => left.localeCompare(right, 'en'))
        .map((id) => {
          const connection = live.get(id);
          const profile = profiles.get(id);
          const retry = retryState.get(id);
          const observedDigest = connection
            ? connectionSchemaDigest(connection)
            : profile?.schemaDigest ?? '';
          const exact =
            Boolean(connection && profile) &&
            connection?.endpoint === profile?.endpoint &&
            observedDigest === profile?.schemaDigest;
          const trust =
            pendingTrust.get(id) ??
            (profile ? (exact || !connection ? 'approved' : 'changed') : 'approval_required');
          const tools =
            connection?.tools ??
            Object.freeze(
              (profile?.tools ?? []).map((tool) =>
                Object.freeze({
                  name: tool.name,
                  description: 'Approved metadata; connect to refresh health.',
                  inputSchema: Object.freeze({}),
                  exposed: profile?.exposedTools.includes(tool.name) ?? false,
                  classification: tool.classification,
                }),
              ),
            );
          return Object.freeze({
            id,
            endpoint: connection?.endpoint ?? profile?.endpoint ?? '',
            state: connection?.state ?? ('disconnected' as const),
            tools,
            resources: connection?.resources ?? Object.freeze([]),
            prompts: connection?.prompts ?? Object.freeze([]),
            ...(connection?.schemaFingerprint === undefined
              ? {}
              : { schemaFingerprint: connection.schemaFingerprint }),
            exposedTools: connection?.exposedTools ?? profile?.exposedTools ?? Object.freeze([]),
            ...(connection?.error === undefined ? {} : { error: connection.error }),
            trust,
            schemaDigest: observedDigest,
            reconnectAttempt: retry?.attempt ?? 0,
            ...(retry?.nextAt === undefined ? {} : { nextReconnectAt: retry.nextAt }),
            durableApproval: Boolean(profile),
            ...(!connection || !profile || exact
              ? {}
              : { schemaDiff: schemaDiff(connection, profile) }),
          });
        }),
    );
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // Settings subscribers cannot alter gateway authority.
      }
    }
  };

  const unsubscribeRuntime = runtime.subscribe(rebuild);
  void unsubscribeRuntime;
  rebuild();

  const exactLiveConnection = (id: string): RemoteMcpSetupConnection => {
    const connection = runtime.getSnapshot().find((candidate) => candidate.id === id);
    if (!connection || connection.state !== 'connected') {
      throw new Error('MCP connector is not live.');
    }
    return connection;
  };

  const refreshRegistry = () => {
    const next = createUnifiedMcpRegistry();
    for (const connection of runtime.getSnapshot()) {
      const profile = profiles.get(connection.id);
      if (
        !ownedIds.has(connection.id) ||
        !profile ||
        pendingTrust.has(connection.id) ||
        connection.state !== 'connected' ||
        connection.endpoint !== profile.endpoint ||
        connectionSchemaDigest(connection) !== profile.schemaDigest ||
        profile.exposedTools.length === 0
      ) {
        continue;
      }
      const tools = Object.freeze(
        profile.exposedTools.map((toolName) =>
          Object.freeze({
            serverId: connection.id,
            toolName,
            capabilityId: `cap_${digest([connection.id, toolName])}`,
          }),
        ),
      );
      next.register(dependencies.scope, {
        schemaVersion: 1,
        id: connection.id,
        serverId: connection.id,
        kind: 'external_mcp',
        tools,
      });
      liveCounter += 1;
      next.updateHealth(dependencies.scope, connection.id, {
        generation: 1,
        state: 'connected',
        observedAt: clock.now(),
        evidenceRef: `jlive_gateway_${clock.now()}_${liveCounter}`,
      });
    }
    registry = next;
  };

  const saveApproval = (
    connection: RemoteMcpSetupConnection,
    exposedTools: readonly string[],
  ): StoredProfile => {
    if (!profiles.has(connection.id) && profiles.size >= MAX_PROFILES) {
      throw new Error('Too many approved MCP profiles.');
    }
    const metadata = toolMetadata(connection.tools);
    const profile = Object.freeze({
      version: PROFILE_VERSION,
      id: connection.id,
      endpoint: connection.endpoint,
      endpointIntegrity: digest(connection.endpoint),
      schemaDigest: connectionSchemaDigest(connection),
      tools: metadata,
      exposedTools: Object.freeze([...exposedTools].sort()),
      approvedAt: clock.now(),
    } satisfies StoredProfile);
    const previous = profiles.get(profile.id);
    profiles.set(profile.id, profile);
    try {
      persist();
    } catch (error) {
      if (previous) profiles.set(profile.id, previous);
      else profiles.delete(profile.id);
      throw error;
    }
    return profile;
  };

  const gateway: VibeSpaceMcpGateway = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async connect(request) {
      ownedIds.add(request.id);
      try {
        await runtime.connect(request);
      } catch (error) {
        if (!profiles.has(request.id)) ownedIds.delete(request.id);
        rebuild();
        throw error;
      }
      pendingTrust.set(request.id, 'approval_required');
      runtime.setToolExposure(request.id, []);
      rebuild();
    },
    approve(id, approval) {
      if (approval.confirmedByUser !== true) {
        throw new Error('Explicit user approval is required for this MCP profile.');
      }
      const connection = exactLiveConnection(id);
      const previous = profiles.get(id);
      const preservedExposure = (previous?.exposedTools ?? []).filter((name) =>
        connection.tools.some((tool) => tool.name === name),
      );
      runtime.setToolExposure(id, preservedExposure);
      saveApproval(connection, preservedExposure);
      pendingTrust.delete(id);
      retryState.delete(id);
      refreshRegistry();
      rebuild();
    },
    async reconnect(id, endpoint) {
      const profile = profiles.get(id);
      if (!profile) throw new Error('This MCP connector requires approval.');
      if (endpoint !== undefined && endpoint !== profile.endpoint) {
        pendingTrust.set(id, 'changed');
        rebuild();
        throw new Error('The MCP endpoint changed and requires approval.');
      }
      const retry = retryState.get(id) ?? { attempt: 0 };
      if (retry.attempt >= MAX_RECONNECT_ATTEMPTS) {
        throw new Error('MCP reconnect attempt limit reached.');
      }
      if (retry.nextAt !== undefined && clock.now() < retry.nextAt) {
        throw new Error('MCP reconnect is temporarily backed off.');
      }
      if (runtime.getSnapshot().some((connection) => connection.id === id)) {
        await runtime.disconnect(id);
      }
      registry = createUnifiedMcpRegistry();
      let policyChanged = false;
      if (profile.exposedTools.length === 0) {
        try {
          await runtime.connect({
            id: profile.id,
            endpoint: profile.endpoint,
            confirmedByUser: true,
          });
          const connection = exactLiveConnection(id);
          if (
            digest(connection.endpoint) !== profile.endpointIntegrity ||
            connection.endpoint !== profile.endpoint ||
            connectionSchemaDigest(connection) !== profile.schemaDigest
          ) {
            runtime.setToolExposure(id, []);
            pendingTrust.set(id, 'changed');
            rebuild();
            throw new Error('MCP connector changed and requires approval.');
          }
          runtime.setToolExposure(id, []);
          retryState.delete(id);
          pendingTrust.delete(id);
          refreshRegistry();
          rebuild();
          return;
        } catch (error) {
          if (pendingTrust.get(id) === 'changed') throw error;
          const attempt = retry.attempt + 1;
          retryState.set(id, {
            attempt,
            nextAt:
              attempt >= MAX_RECONNECT_ATTEMPTS
                ? undefined
                : clock.now() +
                  Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * 2 ** (attempt - 1)),
          });
          await runtime.disconnect(id).catch(() => undefined);
          rebuild();
          throw new Error(SAFE_GATEWAY_ERROR);
        }
      }
      supervisor = createMcpConnectionSupervisor({
        registry,
        clock,
        scheduler: {
          schedule: () => Object.freeze({ cancel() {} }),
        },
        port: {
          async connect({ signal }) {
            if (signal.aborted) throw signal.reason;
            await runtime.connect({
              id: profile.id,
              endpoint: profile.endpoint,
              confirmedByUser: true,
            });
            const connection = exactLiveConnection(id);
            const observedSchema = connectionSchemaDigest(connection);
            if (
              digest(connection.endpoint) !== profile.endpointIntegrity ||
              connection.endpoint !== profile.endpoint ||
              observedSchema !== profile.schemaDigest ||
              profile.exposedTools.some(
                (name) => !connection.tools.some((tool) => tool.name === name),
              )
            ) {
              policyChanged = true;
              runtime.setToolExposure(id, []);
              pendingTrust.set(id, 'changed');
              throw new Error('MCP connector authority changed.');
            }
            runtime.setToolExposure(id, profile.exposedTools);
            liveCounter += 1;
            return Object.freeze({
              evidenceRef: `jlive_gateway_${clock.now()}_${liveCounter}` as const,
              tools: Object.freeze(
                profile.exposedTools.map((toolName) =>
                  Object.freeze({
                    serverId: id,
                    toolName,
                    capabilityId: `${id}:${toolName}`.slice(0, 159),
                  }),
                ),
              ),
              disconnect: () => runtime.disconnect(id),
            });
          },
        },
      });
      try {
        await supervisor.start(dependencies.scope, [
          Object.freeze({
            schemaVersion: 1,
            id,
            serverId: id,
            kind: 'external_mcp',
            connectorId: profile.endpointIntegrity,
            enabled: true,
            trust: 'trusted',
            reconnect: Object.freeze({
              baseDelayMs: BASE_RECONNECT_DELAY_MS,
              maxDelayMs: MAX_RECONNECT_DELAY_MS,
              maxAttempts: 1,
            }),
          }),
        ]);
        const state = supervisor.snapshot(dependencies.scope).connections[0]?.state;
        if (state !== 'connected') throw new Error(SAFE_GATEWAY_ERROR);
        retryState.delete(id);
        pendingTrust.delete(id);
      } catch {
        if (!policyChanged) {
          const attempt = retry.attempt + 1;
          retryState.set(id, {
            attempt,
            nextAt:
              attempt >= MAX_RECONNECT_ATTEMPTS
                ? undefined
                : clock.now() +
                  Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * 2 ** (attempt - 1)),
          });
          await runtime.disconnect(id).catch(() => undefined);
        }
        rebuild();
        throw new Error(policyChanged ? 'MCP connector changed and requires approval.' : SAFE_GATEWAY_ERROR);
      }
      refreshRegistry();
      rebuild();
    },
    setToolExposure(id, requested, approval) {
      const profile = profiles.get(id);
      if (!profile || pendingTrust.has(id)) {
        throw new Error('Approve this MCP profile before changing tool exposure.');
      }
      const unique = [...new Set(requested)].sort();
      if (unique.length > MAX_TOOLS) throw new Error('MCP tool allowlist is too large.');
      const expands = unique.some((name) => !profile.exposedTools.includes(name));
      if (expands && approval?.confirmedByUser !== true) {
        throw new Error('Tool exposure expansion requires explicit user approval.');
      }
      const connection = exactLiveConnection(id);
      if (connectionSchemaDigest(connection) !== profile.schemaDigest) {
        runtime.setToolExposure(id, []);
        pendingTrust.set(id, 'changed');
        rebuild();
        throw new Error('MCP connector schema changed and requires approval.');
      }
      runtime.setToolExposure(id, unique);
      try {
        saveApproval(connection, unique);
      } catch (error) {
        runtime.setToolExposure(id, profile.exposedTools);
        throw error;
      }
      refreshRegistry();
      rebuild();
    },
    async disconnect(id, options) {
      await supervisor?.disconnect(dependencies.scope, id).catch(() => false);
      await runtime.disconnect(id);
      retryState.delete(id);
      if (options?.forgetApproval) {
        const previous = profiles.get(id);
        profiles.delete(id);
        pendingTrust.set(id, 'revoked');
        try {
          persist();
        } catch (error) {
          if (previous) profiles.set(id, previous);
          pendingTrust.delete(id);
          rebuild();
          throw error;
        }
        ownedIds.delete(id);
      } else if (!profiles.has(id)) {
        ownedIds.delete(id);
      }
      refreshRegistry();
      rebuild();
    },
    async revoke(id) {
      await supervisor?.disconnect(dependencies.scope, id).catch(() => false);
      await runtime.disconnect(id);
      const previous = profiles.get(id);
      profiles.delete(id);
      ownedIds.delete(id);
      pendingTrust.delete(id);
      retryState.delete(id);
      try {
        persist();
      } catch (error) {
        if (previous) profiles.set(id, previous);
        rebuild();
        throw error;
      }
      refreshRegistry();
      rebuild();
    },
    getCapabilitySnapshot: () => registry.snapshot(dependencies.scope),
    async invoke(request) {
      if (
        request.accountId !== dependencies.scope.accountId ||
        request.projectId !== dependencies.scope.projectId
      ) {
        throw new Error('MCP invocation scope does not match this gateway.');
      }
      if (!SAFE_ID.test(request.taskId)) throw new Error('Invalid MCP task id.');
      if (inFlight >= MAX_IN_FLIGHT) throw new Error('MCP gateway backpressure limit reached.');
      const connection = exactLiveConnection(request.connectionId);
      const profile = profiles.get(request.connectionId);
      if (
        !profile ||
        pendingTrust.has(request.connectionId) ||
        connectionSchemaDigest(connection) !== profile.schemaDigest ||
        !profile.exposedTools.includes(request.toolName)
      ) {
        throw new Error('MCP tool is not approved for invocation.');
      }
      const exactTool = `${request.connectionId}.${request.toolName}`;
      if (!request.allowedTools.includes(exactTool)) {
        throw new Error('MCP tool is not in the task allowlist.');
      }
      const tool = connection.tools.find((candidate) => candidate.name === request.toolName);
      if (!tool) throw new Error('MCP tool is not currently discovered.');
      const observedClassification = tool.classification ?? 'write';
      if (request.classification !== observedClassification) {
        throw new Error('MCP tool classification does not match discovered policy.');
      }
      if (request.classification !== 'read' && request.approval?.confirmedByUser !== true) {
        throw new Error('Explicit approval is required for MCP writes and mutations.');
      }
      for (const secretRef of request.secretRefs ?? []) {
        if (!SAFE_ID.test(secretRef)) throw new Error('Invalid MCP secret reference.');
      }
      assertNoRawSecrets(request.arguments);

      invocationCounter += 1;
      const startedAt = clock.now();
      const receiptId = `mcpinv_${startedAt}_${invocationCounter}`;
      const handle = registry.beginInvocation(dependencies.scope, {
        invocationId: receiptId,
        connectionId: request.connectionId,
        serverId: request.connectionId,
        toolName: request.toolName,
      });
      const abortFromCaller = () => registry.cancelInvocation(dependencies.scope, receiptId);
      request.signal?.addEventListener('abort', abortFromCaller, { once: true });
      if (request.signal?.aborted) abortFromCaller();
      inFlight += 1;
      let status: VibeSpaceMcpInvocationReceipt['status'] = 'failed';
      try {
        const result = await runtime.invoke(
          request.connectionId,
          request.toolName,
          request.arguments,
          {
            signal: handle.signal,
            onProgress: request.onProgress
              ? (update) => request.onProgress?.({
                  progress: update.progress,
                  total: update.total,
                  message: update.message,
                })
              : undefined,
          },
        );
        status = 'succeeded';
        const receipt = Object.freeze({
          receiptId,
          accountId: dependencies.scope.accountId,
          projectId: dependencies.scope.projectId,
          taskId: request.taskId,
          connectionId: request.connectionId,
          toolName: request.toolName,
          classification: request.classification,
          schemaDigest: profile.schemaDigest,
          startedAt,
          completedAt: clock.now(),
          status,
        } satisfies VibeSpaceMcpInvocationReceipt);
        appendReceipt(receipt);
        return Object.freeze({ result: safeResult(result), receipt });
      } catch (error) {
        status = handle.signal.aborted ? 'cancelled' : 'failed';
        appendReceipt(Object.freeze({
          receiptId,
          accountId: dependencies.scope.accountId,
          projectId: dependencies.scope.projectId,
          taskId: request.taskId,
          connectionId: request.connectionId,
          toolName: request.toolName,
          classification: request.classification,
          schemaDigest: profile.schemaDigest,
          startedAt,
          completedAt: clock.now(),
          status,
        }));
        throw error;
      } finally {
        request.signal?.removeEventListener('abort', abortFromCaller);
        registry.cancelInvocation(dependencies.scope, receiptId);
        inFlight -= 1;
      }
    },
    getReceipts: () => Object.freeze([...receipts]),
  };
  return Object.freeze(gateway);
}

const gatewaysByScope = new Map<string, VibeSpaceMcpGateway>();

export function getVibeSpaceMcpGateway(scope: UnifiedMcpScope): VibeSpaceMcpGateway {
  const key = profileStorageKey(scope);
  let gateway = gatewaysByScope.get(key);
  if (!gateway) {
    gateway = createVibeSpaceMcpGateway({ scope });
    gatewaysByScope.set(key, gateway);
  }
  return gateway;
}

export const vibeSpaceMcpGateway = getVibeSpaceMcpGateway(
  Object.freeze({ accountId: 'local_account', projectId: 'default_project' }),
);
