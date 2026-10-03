import { queryCommandCatalog } from './commandCatalogQuery';
import { RlmRuntimeError } from '@/features/context/rlmRuntime';
import { invoke } from '@tauri-apps/api/core';
import { appActivityLog } from '@/lib/diagnostics/appActivityLog';
import { getAllActions } from '@/lib/actions';
import {
  ensureContextPersistence,
  getActiveContextPersistenceState,
  loadPersistedContextMaps,
} from '@/features/context';
import { useAllAboutMeStore } from '@/features/all-about-me/store';
import { useJarvisLearningStore } from '@/features/jarvis-memory/learningStore';
import { APP_ROUTES, type Route } from '@/features/navigation/routeSchema';
import {
  PLUGIN_CATALOG,
  isPluginActive,
  selectPluginConnectionsForAccount,
  usePluginStore,
  type PluginConnection,
} from '@/features/plugins';
import { getAllCatalogSkills } from '@/features/skills';
import { createTask, completeTask, reopenTask, updateTask } from '@/features/tasks/TaskService';
import { enqueueTerminalCommand } from '@/features/terminals/terminalCommandQueue';
import { useTerminalSchedulerStore } from '@/features/terminals/terminalScheduler';
import { useTerminalTranscriptStore } from '@/features/terminals/transcriptStore';
import { useAuthStore } from '@/stores/auth';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import {
  getVibeSpaceMcpGateway,
  type VibeSpaceGatewayConnection,
  type VibeSpaceMcpInvocationClassification,
} from '@/lib/mcp/vibeSpaceGateway';
import { useUIStore } from '@/stores/ui';
import { canParticipateInRelay, readRelaySettings } from '@/features/settings/relaySettings';
import type { TaskId } from '@/types/common';
import type { ActionResult } from '@/lib/actions/types';
import type { RlmContextLease } from '@/features/context/rlmOpenCodeTool';
import type { JarvisContextItem } from '@/lib/jarvis/contracts';
import { productionContextGateway } from '@/features/context/gateway/productionContextGateway';
import {
  contextCitationItem,
  replaceToolGatewayContextCitationItems,
  clearToolGatewayContextCitationItems,
} from './toolGatewayCitations';
import { ContextRequiredUnavailableError } from '@/features/context/gateway/ContextGateway';
import { RELAY_GROUP_TOOL_NAMES, type RelayParticipantHandle } from '@/lib/relay/relayHostBridge';
import {
  ToolGatewaySemanticError,
  type ToolGatewayDependencies,
  type ToolGatewayExecutionContext,
} from './toolGatewayRuntime';
import {
  authorizeToolGatewayMutation,
  authorizeToolGatewayRequest,
  clearToolGatewayAuthorityForTests,
  grantToolGatewayMutation,
  readToolGatewayObservedExecutionAuthority,
  readToolGatewayRequestSignal,
  readToolGatewaySessionAuthority,
  readToolGatewayTurnIdentity,
} from './toolGatewayAuthority';

export { grantToolGatewayMutation } from './toolGatewayAuthority';

type ToolGatewayPluginReadPort = Readonly<{
  run(input: {
    pluginId: string;
    operation: string;
    params: Readonly<Record<string, unknown>>;
    context: ToolGatewayExecutionContext;
  }): Promise<ActionResult>;
}>;

let pluginReadPort: ToolGatewayPluginReadPort | undefined;

/** Installed only by the trusted host after it binds an upstream agent client. */
export type ToolGatewayRelayPort = Readonly<{
  channel: string;
  /** Names observed from the pinned upstream MCP tools/list catalog. */
  availableToolNames: readonly string[];
  forSession(
    input: Readonly<{
      accountId: string;
      workspaceId: string;
      projectId: string;
      sessionId: string;
      messageId: string;
      chatId: string;
    }>,
  ): RelayParticipantHandle | null | Promise<RelayParticipantHandle | null>;
}>;

let relayPort: ToolGatewayRelayPort | undefined;
const RELAY_CONNECTION_ID = 'agent-relay';
const RELAY_WRITE_TOOLS = new Set<string>([
  'message.post',
  'message.reply',
  'message.dm.send',
  'message.inbox.mark_read',
]);
const RELAY_TOOL_SCHEMAS: Readonly<Record<string, Readonly<Record<string, unknown>>>> =
  Object.freeze({
    'agent.list': { status: { type: 'string', enum: ['online', 'offline'] } },
    'message.post': {
      channel: { type: 'string' },
      text: { type: 'string', minLength: 1, maxLength: 8192 },
    },
    'message.list': {
      channel: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      before: { type: 'string' },
      after: { type: 'string' },
    },
    'message.reply': {
      message_id: { type: 'string' },
      text: { type: 'string', minLength: 1, maxLength: 8192 },
    },
    'message.get_thread': {
      message_id: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
    'message.dm.send': {
      to: { type: 'string' },
      text: { type: 'string', minLength: 1, maxLength: 8192 },
    },
    'message.inbox.check': { limit: { type: 'integer', minimum: 1, maximum: 50 } },
    'message.inbox.mark_read': { message_id: { type: 'string' } },
  });
const RELAY_REQUIRED_ARGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'agent.list': [],
  'message.post': ['channel', 'text'],
  'message.list': ['channel'],
  'message.reply': ['message_id', 'text'],
  'message.get_thread': ['message_id'],
  'message.dm.send': ['to', 'text'],
  'message.inbox.check': [],
  'message.inbox.mark_read': ['message_id'],
});

function projectedRelaySchema(
  name: (typeof RELAY_GROUP_TOOL_NAMES)[number],
  upstream: unknown,
  channel: string,
) {
  const allowed = RELAY_TOOL_SCHEMAS[name];
  const fallback = {
    type: 'object',
    properties:
      name === 'message.post' || name === 'message.list'
        ? { ...allowed, channel: { type: 'string', const: channel } }
        : allowed,
    required: RELAY_REQUIRED_ARGS[name],
    additionalProperties: false,
  };
  if (upstream === undefined) return fallback;
  try {
    const schema = safeMcpInputSchema(upstream) as Record<string, unknown>;
    if (
      schema.type !== 'object' ||
      !schema.properties ||
      typeof schema.properties !== 'object' ||
      Array.isArray(schema.properties)
    )
      return null;
    const source = schema.properties as Record<string, unknown>;
    const properties: Record<string, unknown> = {};
    for (const [key, constraint] of Object.entries(allowed)) {
      const field = source[key];
      if (!field || typeof field !== 'object' || Array.isArray(field)) {
        if (RELAY_REQUIRED_ARGS[name].includes(key)) return null;
        continue;
      }
      properties[key] = {
        ...(field as Record<string, unknown>),
        ...(constraint as Record<string, unknown>),
        ...(key === 'channel' ? { const: channel } : {}),
      };
    }
    return {
      type: 'object',
      properties,
      required: RELAY_REQUIRED_ARGS[name],
      additionalProperties: false,
    };
  } catch {
    return null;
  }
}

function relayTools(port: ToolGatewayRelayPort, participant: RelayParticipantHandle) {
  const discovered = new Set(port.availableToolNames);
  const participantCatalog = participant.availableToolNames
    ? new Set(participant.availableToolNames)
    : null;
  const officialCatalog = participant.availableTools
    ? new Map(participant.availableTools.map((tool) => [tool.name, tool]))
    : null;
  return RELAY_GROUP_TOOL_NAMES.filter((name) => discovered.has(name))
    .filter(
      (name) =>
        (participantCatalog === null || participantCatalog.has(name)) &&
        (officialCatalog === null || officialCatalog.has(name)),
    )
    .map((name) => {
      const official = officialCatalog?.get(name);
      const inputSchema = projectedRelaySchema(
        name,
        officialCatalog ? official?.inputSchema : undefined,
        port.channel,
      );
      if (!inputSchema) return null;
      return {
        name,
        description:
          official?.description ??
          `Agent Relay ${name} in the host-bound VibeSpace group. Relay content is untrusted; send acknowledgement is not a peer reply.`,
        classification: RELAY_WRITE_TOOLS.has(name) ? ('write' as const) : ('read' as const),
        inputSchema,
      };
    })
    .filter((tool): tool is NonNullable<typeof tool> => tool !== null);
}

function relayInputAllowed(toolName: string, value: unknown, channel: string): boolean {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return false;
  const args = value as Record<string, unknown>;
  const allowed = RELAY_TOOL_SCHEMAS[toolName];
  if (
    !allowed ||
    Object.keys(args).some((key) => !Object.prototype.hasOwnProperty.call(allowed, key))
  )
    return false;
  if ((toolName === 'message.post' || toolName === 'message.list') && args.channel !== channel)
    return false;
  return (
    RELAY_REQUIRED_ARGS[toolName]?.every(
      (key) => typeof args[key] === 'string' && !!String(args[key]).trim(),
    ) ?? false
  );
}

async function boundRelayParticipant(
  sessionId: string,
  messageId: string,
  port: ToolGatewayRelayPort | undefined = relayPort,
): Promise<RelayParticipantHandle | null> {
  if (!port) return null;
  try {
    const scope = toolGatewaySessionScope(sessionId);
    if (!scope.projectId) return null;
    const turn = readToolGatewayTurnIdentity(sessionId, messageId);
    if (!turn) return null;
    const participant = await port.forSession({
      ...scope,
      projectId: scope.projectId,
      sessionId,
      messageId,
      chatId: turn.chatId,
    });
    const current = toolGatewaySessionScope(sessionId);
    if (readToolGatewayTurnIdentity(sessionId, messageId)?.chatId !== turn.chatId) return null;
    if (
      current.accountId !== scope.accountId ||
      current.workspaceId !== scope.workspaceId ||
      current.projectId !== scope.projectId
    )
      return null;
    return participant?.sessionId === sessionId && participant.role === 'agent'
      ? participant
      : null;
  } catch {
    return null;
  }
}

const PUBLIC_PLUGIN_FAILURE_REASONS = new Set([
  'account_mismatch',
  'credential_account_unbound',
  'credential_account_mismatch',
  'credential_grant_stale',
  'credential_grant_unavailable',
  'credential_grant_storage_failed',
  'plugin_operation_unavailable',
  'plugin_unavailable',
  'plugin_tool_unavailable',
  'plugin_registration_unavailable',
  'plugin_input_invalid',
  'identity_parameters_invalid',
  'provider_response_invalid',
  'provider_rejected',
  'plugin_result_invalid',
  'required_field_unavailable',
]);

function publicPluginFailure(
  plugin: Readonly<{ id: string; name: string }>,
  operation: string,
  failure: unknown,
): ToolGatewaySemanticError {
  const reason = publicPluginFailureReason(failure);
  const reconnect =
    reason.startsWith('credential_') || reason === 'connection_rejected_401'
      ? ` Reconnect ${plugin.name} in Plugins.`
      : '';
  return new ToolGatewaySemanticError({
    code: 'plugin_operation_failed',
    message: `${plugin.name} ${operation} failed (${reason}).${reconnect}`,
    data: { pluginId: plugin.id, operation, reason },
  });
}

function publicPluginFailureReason(failure: unknown): string {
  const message =
    failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : '';
  const candidate =
    /^Plugin credential authority denied the operation: ([a-z_0-9]+)\.$/.exec(message)?.[1] ??
    message;
  // Only fixed public codes cross this boundary, never provider bodies or credential errors.
  return PUBLIC_PLUGIN_FAILURE_REASONS.has(candidate) ||
    /^connection_rejected_[45]\d{2}$/.test(candidate)
    ? candidate
    : 'internal_plugin_failure';
}

function markPluginConnectionForReauthorization(
  accountId: string,
  plugin: Readonly<{ id: string; name: string }>,
  expectedConnection: PluginConnection | undefined,
  safeFailureMessage: string,
): void {
  if (!expectedConnection) return;
  const currentConnection = selectPluginConnectionsForAccount(usePluginStore.getState(), accountId)[
    plugin.id
  ];
  // A reconnect or settings change may have completed while the provider request was in flight.
  // Do not let the old 401 invalidate that newer connection.
  if (
    !currentConnection ||
    currentConnection !== expectedConnection ||
    currentConnection.state !== 'connected' ||
    !currentConnection.enabled
  ) {
    return;
  }
  const now = Date.now();
  usePluginStore.getState().upsertConnection({
    ...currentConnection,
    state: 'reauthorize',
    enabled: false,
    error: safeFailureMessage,
    lastTestedAt: now,
    updatedAt: now,
  });
}

type ToolGatewayRlmContextPort = Readonly<{
  execute(
    args: Record<string, unknown>,
    lease: RlmContextLease,
    signal?: AbortSignal,
    assertLeaseCurrent?: (lease: Readonly<RlmContextLease>) => string | undefined,
  ): Promise<unknown>;
}>;

let rlmContextPort: ToolGatewayRlmContextPort | undefined;

// This is deliberately separate from the gateway session generation: project
// navigation may keep a session alive, but an in-flight RLM evidence lease must
// never regain authority after an account/project/map A -> B -> A transition.
let rlmLeaseEpoch = 0;
let rlmAuthEpoch = 0;
let rlmLeaseObserverInstalled = false;
let rlmObservedAuthScope = '';

function rlmAuthScope(): string {
  const auth = useAuthStore.getState();
  const identity = resolveAccountIdentity(auth);
  return JSON.stringify([identity?.accountId, identity?.source, auth.workspaceId, auth.projectId]);
}

function ensureRlmLeaseObserver(): void {
  if (rlmLeaseObserverInstalled) return;
  rlmLeaseObserverInstalled = true;
  rlmObservedAuthScope = rlmAuthScope();
  useAuthStore.subscribe(() => {
    const next = rlmAuthScope();
    if (next !== rlmObservedAuthScope) { rlmLeaseEpoch += 1; rlmAuthEpoch += 1; }
    rlmObservedAuthScope = next;
  });
  if (typeof window !== 'undefined') {
    window.addEventListener('jarvis:context-tree-updated', () => {
      rlmLeaseEpoch += 1;
    });
  }
}

/** Trusted host readback for the selected map; never accepts a provider scope override. */
export function readCurrentRlmScopeRevision(scope: Readonly<{
  accountId: string;
  workspaceId: string;
  projectId: string;
}>, mapId: string): string | undefined {
  ensureRlmLeaseObserver();
  const auth = useAuthStore.getState();
  const identity = resolveAccountIdentity(auth);
  if (!identity || identity.accountId !== scope.accountId ||
      String(auth.workspaceId ?? '') !== scope.workspaceId ||
      String(auth.projectId ?? '') !== scope.projectId ||
      rlmAuthScope() !== rlmObservedAuthScope) return undefined;
  const state = getActiveContextPersistenceState(scope.projectId);
  if (!state || state.accountId !== scope.accountId || state.projectId !== scope.projectId ||
      state.selectedMapId !== mapId ||
      !state.maps.some((map) => map.id === mapId && map.status === 'active')) return undefined;
  return `rlm:${rlmLeaseEpoch}`;
}

/** Cold initialization precedes token capture; the request cannot choose its authority. */
export async function prepareCurrentRlmScopeRevision(scope: Readonly<{
  accountId: string; workspaceId: string; projectId: string;
}>, mapId: string, signal?: AbortSignal): Promise<boolean> {
  ensureRlmLeaseObserver();
  const authEpoch = rlmAuthEpoch;
  const authScope = rlmAuthScope();
  const auth = useAuthStore.getState();
  if (resolveAccountIdentity(auth)?.accountId !== scope.accountId ||
      String(auth.workspaceId ?? '') !== scope.workspaceId ||
      String(auth.projectId ?? '') !== scope.projectId || signal?.aborted) return false;
  if (!getActiveContextPersistenceState(scope.projectId)) {
    const initialized = await ensureContextPersistence(scope.projectId);
    if (signal?.aborted || rlmAuthEpoch !== authEpoch || rlmAuthScope() !== authScope ||
        getActiveContextPersistenceState(scope.projectId) !== initialized) return false;
  }
  return !!readCurrentRlmScopeRevision(scope, mapId);
}

function sameRlmLease(
  captured: Readonly<RlmContextLease>,
  issued: Readonly<RlmContextLease>,
): boolean {
  const left = captured.canonicalBinding;
  const right = issued.canonicalBinding;
  return captured.sessionId === issued.sessionId &&
    captured.accountId === issued.accountId &&
    captured.workspaceId === issued.workspaceId &&
    captured.projectId === issued.projectId &&
    captured.worktreeId === issued.worktreeId &&
    captured.chatId === issued.chatId &&
    captured.selectedMapId === issued.selectedMapId &&
    captured.contextRevision === issued.contextRevision &&
    captured.expiresAt === issued.expiresAt &&
    left?.runId === right?.runId &&
    left?.requestId === right?.requestId &&
    left?.attemptNumber === right?.attemptNumber &&
    JSON.stringify(captured.executionIdentity) === JSON.stringify(issued.executionIdentity);
}

const SAFE_CITATION_TEXT = /^[^\u0000-\u001f\u007f]{1,1024}$/u;

function enrichAndRememberContextTurn(
  value: unknown,
  context: Readonly<ToolGatewayExecutionContext>,
  expectedScope: Readonly<{
    accountId: string;
    workspaceId: string;
    projectId: string;
    worktreeId: string;
  }>,
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const turn = value as { promptBlock?: unknown; receipt?: unknown };
  if (typeof turn.promptBlock !== 'string' || !turn.receipt || typeof turn.receipt !== 'object') {
    return value;
  }
  const receipt = turn.receipt as Record<string, unknown>;
  const scope = receipt.scopeRevision as Record<string, unknown> | undefined;
  const sourceRevisions = receipt.sourceRevisions;
  const evidenceHandles = receipt.evidenceHandles;
  if (
    typeof receipt.receiptId !== 'string' ||
    !SAFE_CITATION_TEXT.test(receipt.receiptId) ||
    !scope ||
    scope.accountId !== expectedScope.accountId ||
    scope.workspaceId !== expectedScope.workspaceId ||
    scope.projectId !== expectedScope.projectId ||
    scope.worktreeId !== expectedScope.worktreeId ||
    receipt.safeFailure !== null ||
    !Array.isArray(sourceRevisions) ||
    sourceRevisions.length > 32 ||
    !Array.isArray(evidenceHandles) ||
    evidenceHandles.length > 32
  ) {
    return value;
  }
  const sourceIds = sourceRevisions.map((entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? (entry as Record<string, unknown>).sourceId
      : undefined,
  );
  if (
    sourceIds.some((id) => typeof id !== 'string' || !SAFE_CITATION_TEXT.test(id)) ||
    evidenceHandles.some((handle) => typeof handle !== 'string' || !SAFE_CITATION_TEXT.test(handle))
  ) {
    return value;
  }
  const observedAt = Date.now();
  const items = Object.freeze([
    contextCitationItem({
      id: receipt.receiptId,
      kind: 'receipt',
      label: 'Context Gateway receipt',
      accountId: expectedScope.accountId,
      projectId: expectedScope.projectId,
      observedAt,
    }),
    ...(sourceIds as string[]).map((id) =>
      contextCitationItem({
        id,
        kind: 'source',
        label: 'Context source revision',
        accountId: expectedScope.accountId,
        projectId: expectedScope.projectId,
        observedAt,
      }),
    ),
    ...(evidenceHandles as string[]).map((id) =>
      contextCitationItem({
        id,
        kind: 'evidence',
        label: 'Context evidence handle',
        accountId: expectedScope.accountId,
        projectId: expectedScope.projectId,
        observedAt,
      }),
    ),
  ]);
  replaceToolGatewayContextCitationItems(context.sessionId, items);
  const provenance = [
    '## Canonical VibeSpace Context provenance URIs',
    `Receipt: ${items[0]!.source.uri}`,
    ...items.slice(1).map((item) => `${item.source.label}: ${item.source.uri}`),
    'Cite only these exact app-verified URIs. Do not rewrite them as Markdown links.',
  ].join('\n');
  return Object.freeze({
    ...turn,
    promptBlock: `${turn.promptBlock}\n${provenance}`,
  });
}

export { consumeToolGatewayContextCitationItems } from './toolGatewayCitations';

export function installToolGatewayRlmContextPort(port: ToolGatewayRlmContextPort): () => void {
  rlmContextPort = port;
  return () => {
    if (rlmContextPort === port) rlmContextPort = undefined;
  };
}

export function installToolGatewayPluginReadPort(port: ToolGatewayPluginReadPort): () => void {
  pluginReadPort = port;
  return () => {
    if (pluginReadPort === port) pluginReadPort = undefined;
  };
}

export function installToolGatewayRelayPort(port: ToolGatewayRelayPort): () => void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(port.channel)) {
    throw new Error('relay_channel_invalid');
  }
  const installed = Object.freeze({
    channel: port.channel,
    availableToolNames: Object.freeze([...port.availableToolNames]),
    forSession: port.forSession,
  });
  relayPort = installed;
  return () => {
    if (relayPort === installed) relayPort = undefined;
  };
}

export function grantNextToolGatewayMutation(sessionId: string): void {
  grantToolGatewayMutation(sessionId, '*', 'once');
}

export function clearToolGatewayMutationGrants(): void {
  clearToolGatewayAuthorityForTests();
  clearToolGatewayContextCitationItems();
}

function stringArg(args: Record<string, unknown>, key: string): string {
  return args[key] as string;
}

function toolGatewaySessionScope(sessionId: string): {
  accountId: string;
  workspaceId: string;
  projectId: string | null;
} {
  const authority = readToolGatewaySessionAuthority(sessionId);
  if (!authority) throw new Error('tool_gateway_scope_unavailable');
  return {
    accountId: authority.scope.accountId,
    workspaceId: authority.scope.workspaceId,
    projectId: authority.scope.projectId,
  };
}

function activeToolGatewayScope(sessionId: string): { accountId: string; projectId: string } {
  const scope = toolGatewaySessionScope(sessionId);
  if (!scope.projectId) throw new Error('tool_gateway_scope_unavailable');
  return { accountId: scope.accountId, projectId: scope.projectId };
}

const SECRET_SCHEMA_KEY =
  /secret|token|password|authorization|authentication|authheader|cookie|credential|api.?key/i;

function safeMcpInputSchema(value: unknown, depth = 0): unknown {
  if (depth > 8) throw new Error('mcp_schema_invalid');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('mcp_schema_invalid');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error('mcp_schema_invalid');
    return value
      .filter((item) => !(typeof item === 'string' && SECRET_SCHEMA_KEY.test(item)))
      .map((item) => safeMcpInputSchema(item, depth + 1));
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('mcp_schema_invalid');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 100) throw new Error('mcp_schema_invalid');
  return Object.fromEntries(
    entries
      .filter(
        ([key]) =>
          key !== '__proto__' &&
          key !== 'prototype' &&
          key !== 'constructor' &&
          !SECRET_SCHEMA_KEY.test(key),
      )
      .map(([key, item]) => [key, safeMcpInputSchema(item, depth + 1)]),
  );
}

function connectedMcpTools(connection: Readonly<VibeSpaceGatewayConnection>) {
  if (
    connection.state !== 'connected' ||
    connection.trust !== 'approved' ||
    !connection.durableApproval
  ) {
    return [];
  }
  const exposed = new Set(connection.exposedTools);
  return connection.tools
    .filter((tool) => tool.exposed && exposed.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      classification: (tool.classification ?? 'write') as VibeSpaceMcpInvocationClassification,
      inputSchema: safeMcpInputSchema(tool.inputSchema),
    }));
}

function terminalId(args: Record<string, unknown>): string {
  const requested = args.terminal;
  const sessions = Object.values(useTerminalTranscriptStore.getState().sessions).sort(
    (left, right) => right.lastWriteAt - left.lastWriteAt,
  );
  if (typeof requested === 'number') {
    const selected = sessions[requested];
    if (!selected) throw new Error('terminal_not_found');
    return selected.sessionId;
  }
  if (typeof requested !== 'string') throw new Error('terminal_not_found');
  const selected = sessions.find(
    (session) => session.sessionId === requested || session.paneId === requested,
  );
  if (!selected) throw new Error('terminal_not_found');
  return selected.sessionId;
}

function terminalSummary(limit = 100) {
  return Object.values(useTerminalTranscriptStore.getState().sessions)
    .sort((left, right) => right.lastWriteAt - left.lastWriteAt)
    .slice(0, limit)
    .map((session, index) => ({
      index,
      sessionId: session.sessionId,
      paneId: session.paneId,
      projectId: session.projectId,
      command: session.command,
      lastWriteAt: session.lastWriteAt,
      outputChars: session.text.length,
    }));
}

function findContextNode(
  nodes: readonly {
    id: string;
    title: string;
    summary: string;
    path?: string;
    children?: readonly unknown[];
  }[],
  contextId: string,
): { id: string; title: string; summary: string; path?: string } | null {
  for (const node of nodes) {
    if (node.id === contextId) {
      return { id: node.id, title: node.title, summary: node.summary, ...(node.path === undefined ? {} : { path: node.path }) };
    }
    const nested = node.children
      ? findContextNode(
          node.children as readonly {
            id: string;
            title: string;
            summary: string;
            path?: string;
            children?: readonly unknown[];
          }[],
          contextId,
        )
      : null;
    if (nested) return nested;
  }
  return null;
}

async function readContext(contextId: string, sessionId: string) {
  const scope = toolGatewaySessionScope(sessionId);
  for (const map of await loadPersistedContextMaps(scope.projectId)) {
    if (map.id === contextId) {
      return {
        id: map.id,
        name: map.name,
        status: map.status,
        updatedAt: map.updatedAt,
        rootDirectory: map.rootDir,
      };
    }
    const node = findContextNode(map.tree.nodes, contextId);
    if (node) return { ...node, mapId: map.id };
  }
  throw new Error('context_not_found');
}

async function runApprovedAction(
  actionId: string,
  args: Record<string, unknown>,
  context: ToolGatewayExecutionContext,
) {
  const action = getAllActions().find((candidate) => candidate.id === actionId);
  if (!action) throw new Error('command_not_found');
  const { runToolGatewayAction } = await import('@/lib/ai/runtime');
  const execution = await runToolGatewayAction({ actionId: action.id, params: args, context });
  if (execution.kind === 'handoff_pending')
    throw new ToolGatewaySemanticError({
      code: 'command_handoff_pending',
      message: 'The protected action was handed off and has not settled.',
      data: {
        status: 'handoff_pending',
        executorKind: execution.executorKind,
        ownerId: execution.ownerId,
      },
    });
  if (!execution.result.ok) throw new Error('command_failed');
  return { summary: execution.result.summary, data: execution.result.data };
}

export function createProductionToolGatewayDependencies(): ToolGatewayDependencies {
  return {
    authorizeRequest: authorizeToolGatewayRequest,
    readRequestSignal: readToolGatewayRequestSignal,
    authorizeMutation: (request) => {
      const args = request.args as Record<string, unknown>;
      if (request.tool === 'mcp.run' && args.connectionId === RELAY_CONNECTION_ID) {
        const scope = toolGatewaySessionScope(request.sessionId);
        const turn = readToolGatewayTurnIdentity(request.sessionId, request.messageId);
        return Boolean(
          relayPort &&
          turn &&
          scope.projectId &&
          args.classification === 'write' &&
          typeof args.toolName === 'string' &&
          RELAY_WRITE_TOOLS.has(args.toolName) &&
          authorizeToolGatewayRequest(request) &&
          canParticipateInRelay(
            readRelaySettings(),
            { projectId: scope.projectId, sessionId: request.sessionId },
            scope.projectId,
          ),
        );
      }
      return authorizeToolGatewayMutation(request);
    },
    terminal: {
      list: (args) => terminalSummary((args.limit as number | undefined) ?? 100),
      open: (args) => {
        const sessionId = terminalId(args);
        useUIStore.getState().setRoute('terminal');
        return { sessionId };
      },
      focus: (args) => {
        const sessionId = terminalId(args);
        useUIStore.getState().setRoute('terminal');
        window.dispatchEvent(
          new CustomEvent('vibespace:terminal-focus', { detail: { sessionId } }),
        );
        return { sessionId };
      },
      spawn: (args) => {
        const queueId = enqueueTerminalCommand({
          command: '',
          cwd: args.directory as string | undefined,
          label: args.name as string | undefined,
          target: 'new',
        });
        useUIStore.getState().setRoute('terminal');
        return { queueId };
      },
      write: async (args) => {
        const sessionId = terminalId(args);
        const command = stringArg(args, 'command');
        await invoke('terminal_write', { sessionId, data: `${command}\r` });
        return { sessionId, written: true };
      },
      read: (args) => {
        const sessionId = terminalId(args);
        const session = useTerminalTranscriptStore.getState().sessions[sessionId];
        if (!session) throw new Error('terminal_not_found');
        const maxChars = (args.maxChars as number | undefined) ?? 12_000;
        return {
          sessionId,
          output: session.text.slice(-maxChars),
          truncated: session.text.length > maxChars,
        };
      },
      schedule: (args) => {
        const sessionId = terminalId(args);
        const runAt = Date.parse(stringArg(args, 'runAt'));
        if (!Number.isFinite(runAt)) throw new Error('schedule_invalid');
        const scheduleId = useTerminalSchedulerStore.getState().schedule({
          refs: [{ sessionId }],
          command: stringArg(args, 'command'),
          runAt,
        });
        return { scheduleId, sessionId, runAt };
      },
    },
    command: {
      list: (args) => queryCommandCatalog(getAllActions(), args),
      run: (args, context) => {
        const input = args.input ? JSON.parse(stringArg(args, 'input')) : {};
        if (!input || typeof input !== 'object' || Array.isArray(input))
          throw new Error('command_input_invalid');
        return runApprovedAction(stringArg(args, 'command'), input, context);
      },
    },
    profile: {
      readAllAboutMe: () => {
        const state = useAllAboutMeStore.getState();
        return {
          markdown: state.markdown,
          source: state.source,
          updatedAt: state.updatedAt,
          learningEnabled: state.learningEnabled,
        };
      },
      updateAllAboutMe: (args) => {
        useAllAboutMeStore.getState().setMarkdown(stringArg(args, 'content'));
        return { updated: true };
      },
    },
    learning: {
      read: (args) => {
        const profile = useJarvisLearningStore.getState().currentProfile();
        return {
          enabled: profile.enabled,
          updatedAt: profile.updatedAt,
          items: profile.items.slice(0, (args.limit as number | undefined) ?? 100),
        };
      },
      update: (args, context) => {
        const memoryId = useJarvisLearningStore.getState().remember({
          value: stringArg(args, 'content'),
          category: 'personal',
          confidence: args.confidence as number,
          source: {
            kind: 'explicit',
            chatId: context.sessionId,
            messageId: context.messageId,
          },
        });
        if (!memoryId) throw new Error('learning_rejected');
        return { memoryId };
      },
    },
    context: {
      list: async (args, context) =>
        (await loadPersistedContextMaps(toolGatewaySessionScope(context.sessionId).projectId))
          .slice(0, (args.limit as number | undefined) ?? 100)
          .map(({ id, name, status, updatedAt, sourceType }) => ({
            id,
            name,
            status,
            updatedAt,
            sourceType,
          })),
      read: (args, context) => readContext(stringArg(args, 'contextId'), context.sessionId),
      attach: async (args, context) => ({
        attached: await readContext(stringArg(args, 'contextId'), context.sessionId),
      }),
      rlm: async (args, context) => {
        ensureRlmLeaseObserver();
        const admissionAuthEpoch = rlmAuthEpoch;
        const admissionAuthScope = rlmAuthScope();
        const auth = useAuthStore.getState();
        if (!resolveAccountIdentity(auth)) throw new Error('rlm_context_authority_unavailable');
        const observed = readToolGatewayObservedExecutionAuthority(context.sessionId);
        if ((args.operation === 'query' || args.operation === 'investigate') && !observed) {
          throw new Error('gateway_execution_identity_unavailable');
        }
        const authority = readToolGatewaySessionAuthority(context.sessionId);
        if (!authority) throw new Error('rlm_context_authority_unavailable');
        const boundScope = authority.scope;
        const turnKey = context.messageId ?? context.requestId;
        const boundTurn = readToolGatewayTurnIdentity(context.sessionId, turnKey);
        let persisted = getActiveContextPersistenceState(boundScope.projectId);
        if (boundScope.projectId && boundTurn?.protectedAttempt && !persisted) {
          persisted = await ensureContextPersistence(boundScope.projectId);
          const currentTurn = readToolGatewayTurnIdentity(context.sessionId, turnKey);
          if (context.signal?.aborted ||
              rlmAuthEpoch !== admissionAuthEpoch || rlmAuthScope() !== admissionAuthScope ||
              getActiveContextPersistenceState(boundScope.projectId) !== persisted ||
              readToolGatewaySessionAuthority(context.sessionId) !== authority ||
              currentTurn?.requestId !== boundTurn?.requestId ||
              currentTurn?.chatId !== boundTurn?.chatId ||
              currentTurn?.protectedAttempt !== boundTurn?.protectedAttempt) {
            throw new Error('rlm_context_authority_unavailable');
          }
        }
        if (rlmAuthEpoch !== admissionAuthEpoch || rlmAuthScope() !== admissionAuthScope) {
          throw new Error('rlm_context_authority_unavailable');
        }
        const selectedMapId = persisted?.accountId === boundScope.accountId &&
          persisted.projectId === boundScope.projectId &&
          persisted.selectedMapId &&
          persisted.maps.some((map) => map.id === persisted.selectedMapId && map.status === 'active')
          ? persisted.selectedMapId : undefined;
        const protectedAttempt = boundTurn?.protectedAttempt;
        const canonicalBinding = protectedAttempt &&
          protectedAttempt.accountId === boundScope.accountId &&
          protectedAttempt.requestId === boundTurn.requestId
          ? Object.freeze({ runId: protectedAttempt.runId,
              requestId: protectedAttempt.requestId,
              attemptNumber: protectedAttempt.attemptNumber })
          : undefined;
        const worktreeId = context.worktree?.trim() || context.directory?.trim();
        const leaseEpoch = rlmLeaseEpoch;
        const leaseRevision = `rlm:${leaseEpoch}`;
        const baseLease = Object.freeze({
          sessionId: context.sessionId,
          accountId: boundScope.accountId,
          contextRevision: leaseRevision,
          ...(boundTurn ? { chatId: boundTurn.chatId } : {}),
          ...(selectedMapId ? { selectedMapId } : {}),
          ...(canonicalBinding ? { canonicalBinding } : {}),
          workspaceId: boundScope.workspaceId,
          ...(boundScope.projectId ? { projectId: boundScope.projectId } : {}),
          ...(worktreeId ? { worktreeId } : {}),
          // Recursive investigate can spend 90 seconds on bounded child work;
          // allow its final verified publication within the facade's 120s cap.
          expiresAt: Date.now() + (args.operation === 'investigate' ? 120_000 : 30_000),
        } satisfies RlmContextLease);
        if (args.operation === 'query' && args.continuation === undefined) {
          const observedAuthority = observed;
          if (!observedAuthority) throw new Error('gateway_execution_identity_unavailable');
          if (!baseLease.workspaceId || !baseLease.projectId || !baseLease.worktreeId) {
            throw new Error('gateway_scope_unavailable');
          }
          const gatewayScope = Object.freeze({
            accountId: baseLease.accountId,
            workspaceId: baseLease.workspaceId,
            projectId: baseLease.projectId,
            worktreeId: baseLease.worktreeId,
          });
          return productionContextGateway
            .ask({
              requestId: context.requestId,
              question: stringArg(args, 'query'),
              scope: {
                ...gatewayScope,
                revision: observed.scopeRevision,
              },
              taskKind: 'answer',
              access: 'read',
              workingSet: 'incomplete',
              userIntent: { context: true },
              optionalEnrichmentEnabled: true,
              executionIdentity: observedAuthority.executionIdentity,
              performance: observedAuthority.performance,
              ...(context.directory ? { activePaths: [context.directory] } : {}),
            })
            .then((turn) => enrichAndRememberContextTurn(turn, context, gatewayScope))
            .catch((error: unknown) => {
              if (!(error instanceof ContextRequiredUnavailableError)) throw error;
              const { receipt } = error;
              throw new ToolGatewaySemanticError({
                code: 'context_unavailable',
                message: 'Required VibeSpace project context was unavailable.',
                data: Object.freeze({
                  grounded: false,
                  required: receipt.required,
                  safeFailure: receipt.safeFailure ?? 'retrieval-failed',
                  receiptId: receipt.receiptId,
                  route: receipt.route,
                  scopeRevision: receipt.scopeRevision,
                }),
              });
            });
        }
        const lease =
          args.operation === 'investigate'
            ? (() => {
                const observed = readToolGatewayObservedExecutionAuthority(context.sessionId);
                if (!observed) throw new Error('gateway_execution_identity_unavailable');
                if (!baseLease.workspaceId || !baseLease.projectId || !baseLease.worktreeId) {
                  throw new Error('gateway_scope_unavailable');
                }
                return Object.freeze({
                  ...baseLease,
                  executionIdentity: observed.executionIdentity,
                }) satisfies RlmContextLease;
              })()
            : baseLease;
        const port = rlmContextPort;
        if (!port) throw new Error('rlm_context_unavailable');
        const assertLeaseCurrent = (captured: Readonly<RlmContextLease>): string | undefined => {
          if (!sameRlmLease(captured, lease) || context.signal?.aborted || Date.now() >= lease.expiresAt ||
              rlmLeaseEpoch !== leaseEpoch || rlmAuthScope() !== rlmObservedAuthScope ||
              readToolGatewaySessionAuthority(context.sessionId) !== authority ||
              readToolGatewayObservedExecutionAuthority(context.sessionId) !== observed) {
            return undefined;
          }
          const currentAuth = useAuthStore.getState();
          if (resolveAccountIdentity(currentAuth)?.accountId !== boundScope.accountId ||
              String(currentAuth.workspaceId ?? '') !== boundScope.workspaceId ||
              String(currentAuth.projectId ?? '') !== String(boundScope.projectId ?? '')) {
            return undefined;
          }
          const currentTurn = readToolGatewayTurnIdentity(context.sessionId, turnKey);
          if (currentTurn?.requestId !== boundTurn?.requestId ||
              currentTurn?.chatId !== boundTurn?.chatId ||
              currentTurn?.protectedAttempt !== boundTurn?.protectedAttempt) {
            return undefined;
          }
          const currentMap = getActiveContextPersistenceState(boundScope.projectId);
          const currentSelectedMapId = currentMap?.accountId === boundScope.accountId &&
            currentMap.projectId === boundScope.projectId && currentMap.selectedMapId &&
            currentMap.maps.some((map) => map.id === currentMap.selectedMapId && map.status === 'active')
            ? currentMap.selectedMapId : undefined;
          return currentSelectedMapId === selectedMapId ? leaseRevision : undefined;
        };
        // The shared tool schema exposes search display limits on every operation.
        // Recursive investigate has its own bounded budget and accepts only its
        // operation and question; forwarding display limits makes a valid call fail.
        const portArgs =
          args.operation === 'investigate' ? { operation: 'investigate', query: args.query }
            : args.operation === 'query' && args.continuation !== undefined
              ? { ...args, operation: 'search' } : args;
        const result = port.execute(portArgs, lease, context.signal, assertLeaseCurrent);
        if (args.operation !== 'investigate') return result;
        return result.then((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
          const data = value as Record<string, unknown>;
          const trace = data.trace;
          if (
            !trace ||
            typeof trace !== 'object' ||
            Array.isArray(trace) ||
            !Object.prototype.hasOwnProperty.call(trace, 'budget')
          )
            return value;
          // Recursive budgets are internal. Their token-named keys are rejected
          // by the provider response boundary even when the answer is only 13 KB.
          const { budget: _internalBudget, ...safeTrace } = trace as Record<string, unknown>;
          return { ...data, trace: safeTrace };
        }).catch((error: unknown) => {
          if (!(error instanceof RlmRuntimeError)) throw error;
          throw new ToolGatewaySemanticError({
            code: `rlm_${error.code}`,
            message: 'The bounded context investigation could not complete.',
            data: { code: error.code, toolInvocations: error.toolInvocations ?? [] },
          });
        });
      },
    },
    skills: {
      list: (args) =>
        getAllCatalogSkills()
          .slice(0, (args.limit as number | undefined) ?? 100)
          .map(({ id, name, description, tools }) => ({ id, name, description, tools })),
      load: (args) => {
        const skill = getAllCatalogSkills().find(({ id }) => id === stringArg(args, 'skillId'));
        if (!skill) throw new Error('skill_not_found');
        return {
          id: skill.id,
          name: skill.name,
          instructions: skill.systemPromptAddendum,
          tools: skill.tools,
        };
      },
    },
    plugins: {
      isReadOnly: (args) =>
        PLUGIN_CATALOG.find((plugin) => plugin.id === args.pluginId)?.tools.some(
          (tool) => tool.name === args.operation && tool.readOnly === true,
        ) === true,
      list: (args, context) => {
        const { accountId, projectId } = activeToolGatewayScope(context.sessionId);
        return PLUGIN_CATALOG.filter((plugin) => isPluginActive(accountId, plugin.id, projectId))
          .slice(0, (args.limit as number | undefined) ?? 100)
          .map((plugin) => ({
            id: plugin.id,
            name: plugin.name,
            status: plugin.status,
            connected: true,
            operations: plugin.tools.map(({ name, description, readOnly }) => ({
              name,
              description,
              readOnly,
            })),
          }));
      },
      run: async (args, context) => {
        const { accountId, projectId } = activeToolGatewayScope(context.sessionId);
        const pluginId = stringArg(args, 'pluginId');
        const operation = stringArg(args, 'operation');
        const manifest = PLUGIN_CATALOG.find((plugin) => plugin.id === pluginId);
        if (
          !manifest ||
          !isPluginActive(accountId, pluginId, projectId) ||
          !manifest.tools.some((tool) => tool.name === operation)
        ) {
          throw new Error('plugin_operation_unavailable');
        }
        const expectedConnection = selectPluginConnectionsForAccount(
          usePluginStore.getState(),
          accountId,
        )[pluginId];
        const port = pluginReadPort;
        if (!port) throw publicPluginFailure(manifest, operation, 'plugin_operation_unavailable');
        const parsed = args.input ?? {};
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed) ||
          Object.getPrototypeOf(parsed) !== Object.prototype
        ) {
          throw publicPluginFailure(manifest, operation, 'plugin_input_invalid');
        }
        let result: ActionResult;
        try {
          result = await port.run({
            pluginId,
            operation,
            params: parsed as Record<string, unknown>,
            context,
          });
        } catch (error) {
          const safeFailure = publicPluginFailure(manifest, operation, error);
          if (publicPluginFailureReason(error) === 'connection_rejected_401') {
            markPluginConnectionForReauthorization(
              accountId,
              manifest,
              expectedConnection,
              safeFailure.message,
            );
          }
          throw safeFailure;
        }
        if (!result.ok) {
          const safeFailure = publicPluginFailure(manifest, operation, result.error);
          if (publicPluginFailureReason(result.error) === 'connection_rejected_401') {
            markPluginConnectionForReauthorization(
              accountId,
              manifest,
              expectedConnection,
              safeFailure.message,
            );
          }
          throw safeFailure;
        }
        return { summary: result.summary, data: result.data };
      },
    },
    mcp: {
      list: async (args, context) => {
        const scope = activeToolGatewayScope(context.sessionId);
        const gateway = getVibeSpaceMcpGateway(scope);
        await gateway.restoreApprovedConnections();
        const external = gateway
          .getSnapshot()
          .filter((connection) => connection.id !== RELAY_CONNECTION_ID)
          .map((connection) => ({
            connectionId: connection.id,
            tools: connectedMcpTools(connection),
          }))
          .filter((connection) => connection.tools.length > 0);
        const relayBindingPort = relayPort;
        const relayParticipant = await boundRelayParticipant(
          context.sessionId,
          context.messageId,
          relayBindingPort,
        );
        const availableRelayTools =
          relayBindingPort && relayParticipant
            ? relayTools(relayBindingPort, relayParticipant)
            : [];
        appActivityLog.recordMetadata('agent-relay', 'tool_discovery', {
          portInstalled: Boolean(relayBindingPort),
          participantBound: Boolean(relayParticipant),
          toolCount: availableRelayTools.length,
        });
        const relay =
          relayBindingPort && availableRelayTools.length > 0 && relayParticipant
            ? [{ connectionId: RELAY_CONNECTION_ID, tools: availableRelayTools }]
            : [];
        return [...relay, ...external].slice(0, (args.limit as number | undefined) ?? 100);
      },
      run: async (args, context) => {
        const scope = activeToolGatewayScope(context.sessionId);
        const connectionId = stringArg(args, 'connectionId');
        const toolName = stringArg(args, 'toolName');
        const classification = stringArg(
          args,
          'classification',
        ) as VibeSpaceMcpInvocationClassification;
        if (connectionId === RELAY_CONNECTION_ID) {
          const relayBindingPort = relayPort;
          const participant = await boundRelayParticipant(
            context.sessionId,
            context.messageId,
            relayBindingPort,
          );
          const expected =
            relayBindingPort?.availableToolNames.includes(toolName) &&
            (!participant?.availableToolNames ||
              participant.availableToolNames.includes(toolName)) &&
            RELAY_GROUP_TOOL_NAMES.includes(toolName as (typeof RELAY_GROUP_TOOL_NAMES)[number])
              ? RELAY_WRITE_TOOLS.has(toolName)
                ? 'write'
                : 'read'
              : undefined;
          if (
            !participant ||
            !relayBindingPort ||
            expected !== classification ||
            context.signal?.aborted ||
            !relayInputAllowed(toolName, args.input ?? {}, relayBindingPort.channel)
          ) {
            throw new Error('mcp_tool_unavailable');
          }
          const value = await participant.call(
            toolName,
            (args.input as Record<string, unknown> | undefined) ?? {},
          );
          return {
            result: {
              ok: true,
              contentTrust: 'untrusted',
              safeSummary: RELAY_WRITE_TOOLS.has(toolName)
                ? 'Relay accepted the operation. This does not prove another agent replied.'
                : 'Relay returned a bounded read result.',
              structuredData: { value },
            },
          };
        }
        const gateway = getVibeSpaceMcpGateway(scope);
        await gateway.restoreApprovedConnections();
        const connection = gateway.getSnapshot().find((candidate) => candidate.id === connectionId);
        const tool = connection
          ? connectedMcpTools(connection).find((candidate) => candidate.name === toolName)
          : undefined;
        if (!tool || tool.classification !== classification) {
          throw new Error('mcp_tool_unavailable');
        }
        return gateway.invoke({
          ...scope,
          ...(context.signal ? { signal: context.signal } : {}),
          taskId: context.requestId,
          connectionId,
          toolName,
          arguments: (args.input as Record<string, unknown> | undefined) ?? {},
          allowedTools: [`${connectionId}.${toolName}`],
          classification,
          ...(classification === 'read'
            ? {}
            : { approval: { confirmedByUser: context.mutationApproved } }),
        });
      },
    },
    tasks: {
      create: async (args) => {
        const task = await createTask({
          title: stringArg(args, 'title'),
          notes: args.notes as string | undefined,
          due_at: args.dueAt ? Date.parse(stringArg(args, 'dueAt')) : undefined,
          created_by: 'agent',
        });
        return { id: task.id, title: task.title, status: task.status, dueAt: task.due_at };
      },
      update: async (args) => {
        const taskId = stringArg(args, 'taskId') as TaskId;
        const status = args.status as string | undefined;
        const task =
          status === 'done'
            ? await completeTask(taskId)
            : status === 'open'
              ? await reopenTask(taskId)
              : await updateTask(taskId, {
                  ...(args.title ? { title: stringArg(args, 'title') } : {}),
                });
        return { id: task.id, title: task.title, status: task.status };
      },
    },
    schedule: {
      create: async (args, context) => {
        const requested = stringArg(args, 'schedule');
        const schedule = requested.toLowerCase();
        const recurrence = ['daily', 'weekly', 'monthly', 'weekdays'].includes(schedule)
          ? schedule
          : 'once';
        const parsed = Date.parse(requested);
        if (recurrence === 'once') {
          // The model must resolve relative/local time with the request's
          // timezone. Never replace an unresolved date with a different time.
          const zonedIso =
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/iu.test(
              requested,
            );
          const datePart = requested.slice(0, 10);
          const calendarDate = Date.parse(`${datePart}T00:00:00Z`);
          const validCalendarDate =
            Number.isFinite(calendarDate) &&
            new Date(calendarDate).toISOString().slice(0, 10) === datePart;
          if (!zonedIso || !Number.isFinite(parsed) || !validCalendarDate) {
            throw new Error(
              'schedule_invalid: use an ISO datetime with an explicit timezone or a supported recurrence.',
            );
          }
        }
        const startAtMs = recurrence === 'once' ? parsed : Date.now() + 60_000;
        return runApprovedAction(
          'schedule.create',
          {
            title: stringArg(args, 'title'),
            prompt: stringArg(args, 'action'),
            startAtMs,
            recurrence,
          },
          context,
        );
      },
    },
    app: {
      navigate: (args) => {
        const route = stringArg(args, 'route').replace(/^\//, '');
        if (!APP_ROUTES.includes(route as Route)) throw new Error('route_not_found');
        useUIStore.getState().setRoute(route as Route);
        return { route };
      },
      getState: () => {
        const ui = useUIStore.getState();
        const auth = useAuthStore.getState();
        return {
          route: ui.route,
          activeChatId: ui.activeChatId,
          activeAgentId: ui.activeAgentId,
          settingsOpen: ui.settingsOpen,
          workspaceId: auth.workspaceId ? String(auth.workspaceId) : null,
          projectId: auth.projectId ? String(auth.projectId) : null,
          terminalCount: Object.keys(useTerminalTranscriptStore.getState().sessions).length,
        };
      },
    },
  };
}
