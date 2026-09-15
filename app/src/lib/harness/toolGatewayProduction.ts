import { invoke } from '@tauri-apps/api/core';
import { getAllActions, runAction } from '@/lib/actions';
import { loadPersistedContextMaps } from '@/features/context';
import { useAllAboutMeStore } from '@/features/all-about-me/store';
import { useJarvisLearningStore } from '@/features/jarvis-memory/learningStore';
import { APP_ROUTES, type Route } from '@/features/navigation/routeSchema';
import { PLUGIN_CATALOG, isPluginActive } from '@/features/plugins';
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

type ToolGatewayRlmContextPort = Readonly<{
  execute(args: Record<string, unknown>, lease: RlmContextLease): Promise<unknown>;
}>;

let rlmContextPort: ToolGatewayRlmContextPort | undefined;

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

function activeToolGatewayScope(): { accountId: string; projectId: string } {
  const auth = useAuthStore.getState();
  const identity = resolveAccountIdentity(auth);
  const projectId = auth.projectId ? String(auth.projectId) : '';
  if (!identity || !projectId) throw new Error('tool_gateway_scope_unavailable');
  return { accountId: identity.accountId, projectId };
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
      return { id: node.id, title: node.title, summary: node.summary, path: node.path };
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

async function readContext(contextId: string) {
  for (const map of await loadPersistedContextMaps(
    useAuthStore.getState().projectId ? String(useAuthStore.getState().projectId) : null,
  )) {
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
  const result = await runAction(
    action.id,
    args,
    {
      source: 'ai',
      chatId: context.sessionId,
      messageId: context.messageId,
      callId: context.requestId,
    },
    { emitToast: false },
  );
  if (!result.ok) throw new Error('command_failed');
  return { summary: result.summary, data: result.data };
}

export function createProductionToolGatewayDependencies(): ToolGatewayDependencies {
  return {
    authorizeRequest: authorizeToolGatewayRequest,
    authorizeMutation: authorizeToolGatewayMutation,
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
      list: (args) =>
        getAllActions()
          .slice(0, (args.limit as number | undefined) ?? 100)
          .map(({ id, label, description, category, destructive, params }) => ({
            id,
            label,
            description,
            category,
            destructive: Boolean(destructive),
            params: params.map(({ key, type, required }) => ({
              key,
              type,
              required: Boolean(required),
            })),
          })),
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
      list: async (args) =>
        (
          await loadPersistedContextMaps(
            useAuthStore.getState().projectId ? String(useAuthStore.getState().projectId) : null,
          )
        )
          .slice(0, (args.limit as number | undefined) ?? 100)
          .map(({ id, name, status, updatedAt, sourceType }) => ({
            id,
            name,
            status,
            updatedAt,
            sourceType,
          })),
      read: (args) => readContext(stringArg(args, 'contextId')),
      attach: async (args) => ({ attached: await readContext(stringArg(args, 'contextId')) }),
      rlm: (args, context) => {
        const auth = useAuthStore.getState();
        if (!auth.localUserId) throw new Error('rlm_context_authority_unavailable');
        const worktreeId = context.worktree?.trim() || context.directory?.trim();
        const baseLease = {
          sessionId: context.sessionId,
          accountId: auth.localUserId,
          ...(auth.workspaceId ? { workspaceId: String(auth.workspaceId) } : {}),
          ...(auth.projectId ? { projectId: String(auth.projectId) } : {}),
          ...(worktreeId ? { worktreeId } : {}),
          expiresAt: Date.now() + 30_000,
        } satisfies RlmContextLease;
        if (args.operation === 'query' || args.operation === 'investigate') {
          const observed = readToolGatewayObservedExecutionAuthority(context.sessionId);
          if (!observed) throw new Error('gateway_execution_identity_unavailable');
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
              userIntent:
                args.operation === 'investigate'
                  ? { context: true, deep: true }
                  : { context: true },
              optionalEnrichmentEnabled: true,
              executionIdentity: observed.executionIdentity,
              performance: observed.performance,
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
                return Object.freeze({
                  ...baseLease,
                  executionIdentity: observed.executionIdentity,
                }) satisfies RlmContextLease;
              })()
            : baseLease;
        const port = rlmContextPort;
        if (!port) throw new Error('rlm_context_unavailable');
        return port.execute(args, lease);
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
      list: (args) => {
        const { accountId, projectId } = activeToolGatewayScope();
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
        const { accountId, projectId } = activeToolGatewayScope();
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
        const port = pluginReadPort;
        if (!port) throw new Error('plugin_operation_unavailable');
        const parsed = args.input ?? {};
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed) ||
          Object.getPrototypeOf(parsed) !== Object.prototype
        ) {
          throw new Error('plugin_input_invalid');
        }
        const result = await port.run({
          pluginId,
          operation,
          params: parsed as Record<string, unknown>,
          context,
        });
        if (!result.ok) throw new Error('plugin_operation_failed');
        return { summary: result.summary, data: result.data };
      },
    },
    mcp: {
      list: async (args) => {
        const scope = activeToolGatewayScope();
        const gateway = getVibeSpaceMcpGateway(scope);
        await gateway.restoreApprovedConnections();
        return gateway
          .getSnapshot()
          .map((connection) => ({
            connectionId: connection.id,
            tools: connectedMcpTools(connection),
          }))
          .filter((connection) => connection.tools.length > 0)
          .slice(0, (args.limit as number | undefined) ?? 100);
      },
      run: async (args, context) => {
        const scope = activeToolGatewayScope();
        const gateway = getVibeSpaceMcpGateway(scope);
        await gateway.restoreApprovedConnections();
        const connectionId = stringArg(args, 'connectionId');
        const toolName = stringArg(args, 'toolName');
        const classification = stringArg(
          args,
          'classification',
        ) as VibeSpaceMcpInvocationClassification;
        const connection = gateway.getSnapshot().find((candidate) => candidate.id === connectionId);
        const tool = connection
          ? connectedMcpTools(connection).find((candidate) => candidate.name === toolName)
          : undefined;
        if (!tool || tool.classification !== classification) {
          throw new Error('mcp_tool_unavailable');
        }
        return gateway.invoke({
          ...scope,
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
        const schedule = stringArg(args, 'schedule').toLowerCase();
        const recurrence = ['daily', 'weekly', 'monthly', 'weekdays'].includes(schedule)
          ? schedule
          : 'once';
        const parsed = Date.parse(stringArg(args, 'schedule'));
        const startAtMs =
          recurrence === 'once' && Number.isFinite(parsed) ? parsed : Date.now() + 60_000;
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
