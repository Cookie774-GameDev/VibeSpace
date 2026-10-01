import { invoke } from '@tauri-apps/api/core';
import { getAllActions, runAction } from '@/lib/actions';
import { loadPersistedContextMaps } from '@/features/context';
import { useAllAboutMeStore } from '@/features/all-about-me/store';
import { useJarvisLearningStore } from '@/features/jarvis-memory/learningStore';
import { APP_ROUTES, type Route } from '@/features/navigation/routeSchema';
import {
  PLUGIN_CATALOG,
  selectPluginConnectionsForAccount,
  usePluginStore,
} from '@/features/plugins';
import { getAllCatalogSkills } from '@/features/skills';
import { createTask, completeTask, reopenTask, updateTask } from '@/features/tasks/TaskService';
import { enqueueTerminalCommand } from '@/features/terminals/terminalCommandQueue';
import { useTerminalSchedulerStore } from '@/features/terminals/terminalScheduler';
import { useTerminalTranscriptStore } from '@/features/terminals/transcriptStore';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import type { TaskId } from '@/types/common';
import type { ActionResult } from '@/lib/actions/types';
import type { RlmContextLease } from '@/features/context/rlmOpenCodeTool';
import type { ToolGatewayDependencies, ToolGatewayExecutionContext } from './toolGatewayRuntime';
import {
  authorizeToolGatewayMutation,
  authorizeToolGatewayRequest,
  clearToolGatewayAuthorityForTests,
  grantToolGatewayMutation,
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
}

function stringArg(args: Record<string, unknown>, key: string): string {
  return args[key] as string;
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
        const port = rlmContextPort;
        if (!port) throw new Error('rlm_context_unavailable');
        const auth = useAuthStore.getState();
        if (!auth.localUserId) throw new Error('rlm_context_authority_unavailable');
        return port.execute(args, {
          sessionId: context.sessionId,
          accountId: auth.localUserId,
          ...(auth.workspaceId ? { workspaceId: String(auth.workspaceId) } : {}),
          ...(auth.projectId ? { projectId: String(auth.projectId) } : {}),
          ...(context.worktree ? { worktreeId: context.worktree } : {}),
          expiresAt: Date.now() + 30_000,
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
      list: (args) => {
        const accountId = useAuthStore.getState().cloudSession?.user_id ?? '';
        const connections = selectPluginConnectionsForAccount(usePluginStore.getState(), accountId);
        return PLUGIN_CATALOG.slice(0, (args.limit as number | undefined) ?? 100).map((plugin) => ({
          id: plugin.id,
          name: plugin.name,
          status: plugin.status,
          connected: Boolean(connections[plugin.id]?.enabled),
          operations: plugin.tools.map(({ name, description, readOnly }) => ({
            name,
            description,
            readOnly,
          })),
        }));
      },
      run: async (args, context) => {
        const port = pluginReadPort;
        if (!port) throw new Error('plugin_operation_unavailable');
        const parsed = args.input ? JSON.parse(stringArg(args, 'input')) : {};
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed) ||
          Object.getPrototypeOf(parsed) !== Object.prototype
        ) {
          throw new Error('plugin_input_invalid');
        }
        const result = await port.run({
          pluginId: stringArg(args, 'pluginId'),
          operation: stringArg(args, 'operation'),
          params: parsed as Record<string, unknown>,
          context,
        });
        if (!result.ok) throw new Error('plugin_operation_failed');
        return { summary: result.summary, data: result.data };
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
