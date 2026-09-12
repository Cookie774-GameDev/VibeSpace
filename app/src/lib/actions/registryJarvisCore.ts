import type { ActionDef, ActionResult, ActionRunContext } from './types';
import type { JarvisRegisteredActionDefinition } from '@/lib/jarvis/actions/catalog';
import type {
  JarvisIssuedActionExecution,
  JarvisRegisteredActionDispatchOutcome,
  JarvisTerminalExecutionAcceptor,
} from '@/lib/jarvis/approvalEngine';
import type { RegisteredActionExecutionContext } from './types';

type LegacyResolver = (id: string) => ActionDef | undefined;

const ok = (summary: string, data?: unknown): ActionResult => ({ ok: true, summary, data });
const fail = (error: string): ActionResult => ({ ok: false, error });

export type JarvisTerminalRegisteredActionDispatcherDependencies = Readonly<{
  newExecutionId(): string;
  newCancellationToken(): string;
  createAcceptor(input: {
    accountId: string;
    workspaceId?: string;
    projectId?: string;
    runId: string;
    executionId: string;
    cancellationToken: string;
    command: string;
    label?: string;
    cwd?: string;
    timeoutMs?: number;
  }): JarvisTerminalExecutionAcceptor;
  resolveProtectedScope?(
    context: RegisteredActionExecutionContext,
  ): Promise<ProtectedTerminalScope | null>;
}>;

export function createJarvisTerminalRegisteredActionDispatcher(
  dependencies: JarvisTerminalRegisteredActionDispatcherDependencies,
): (input: {
  registration: Readonly<JarvisRegisteredActionDefinition>;
  params: Readonly<Record<string, unknown>>;
  context: RegisteredActionExecutionContext;
  execution: JarvisIssuedActionExecution;
}) => Promise<JarvisRegisteredActionDispatchOutcome | null> {
  return async (input) => {
    const actionId = input.registration.id;
    if (
      !['terminal.create', 'terminal.run', 'terminal.start_cli'].includes(actionId) ||
      input.registration.version !== 1 ||
      input.registration.executor.kind !== 'builtin' ||
      input.registration.executor.registryActionId !== actionId
    ) {
      return null;
    }
    if (input.execution.producerKind !== 'terminal') {
      return {
        kind: 'executor_returned',
        result: fail('Canonical terminal execution binding was rejected.'),
      };
    }
    let command = '';
    let label: string | undefined;
    let cwd: string | undefined;
    let timeoutMs: number | undefined;
    if (actionId === 'terminal.create') {
      if (Reflect.ownKeys(input.params).length !== 0) {
        return {
          kind: 'executor_returned',
          result: fail('Canonical terminal execution binding was rejected.'),
        };
      }
    } else {
      const keys = Reflect.ownKeys(input.params);
      const commandKey = actionId === 'terminal.start_cli' ? 'cli' : 'command';
      if (
        keys.some(
          (key) =>
            typeof key !== 'string' || ![commandKey, 'label', 'cwd', 'timeoutMs'].includes(key),
        )
      ) {
        return {
          kind: 'executor_returned',
          result: fail('Canonical terminal execution binding was rejected.'),
        };
      }
      command = typeof input.params[commandKey] === 'string' ? input.params[commandKey].trim() : '';
      label =
        typeof input.params.label === 'string' ? input.params.label.trim() || undefined : undefined;
      cwd = typeof input.params.cwd === 'string' ? input.params.cwd : undefined;
      timeoutMs = typeof input.params.timeoutMs === 'number' ? input.params.timeoutMs : undefined;
      if (
        !command ||
        command.length > 10_000 ||
        (input.params.label !== undefined && typeof input.params.label !== 'string') ||
        (input.params.cwd !== undefined && typeof input.params.cwd !== 'string') ||
        (cwd !== undefined && /["`;|&$\u0000-\u001F]/.test(cwd)) ||
        (timeoutMs !== undefined &&
          (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 1_800_000))
      ) {
        return {
          kind: 'executor_returned',
          result: fail('Canonical terminal execution binding was rejected.'),
        };
      }
    }
    const protectedScope =
      actionId === 'terminal.start_cli'
        ? await (dependencies.resolveProtectedScope ?? resolveProtectedTerminalScope)(input.context)
        : null;
    if (actionId === 'terminal.start_cli' && (!protectedScope || !protectedScope.isCurrent())) {
      return {
        kind: 'executor_returned',
        result: fail('Canonical terminal scope was revoked before handoff.'),
      };
    }
    const executionId = dependencies.newExecutionId();
    const cancellationToken = dependencies.newCancellationToken();
    if (
      !/^jterm_[A-Za-z0-9_-]+$/.test(executionId) ||
      !/^jcancel_native_[A-Za-z0-9_-]+$/.test(cancellationToken)
    ) {
      return {
        kind: 'executor_returned',
        result: fail('Canonical terminal execution identity was unavailable.'),
      };
    }
    try {
      const transferred = input.execution.transferTerminalOwnership({
        executionId,
        acceptor: dependencies.createAcceptor({
          accountId: input.context.accountId,
          ...(protectedScope
            ? {
                workspaceId: protectedScope.workspaceId,
                projectId: protectedScope.projectId,
              }
            : {}),
          runId: input.context.runId,
          executionId,
          cancellationToken,
          command,
          ...(label === undefined ? {} : { label }),
          ...(cwd === undefined ? {} : { cwd }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      });
      if (transferred.kind !== 'committed') {
        return {
          kind: 'executor_returned',
          result: fail('Canonical terminal ownership was revoked before handoff.'),
        };
      }
      return {
        kind: 'terminal_handoff_accepted',
        executorKind: 'terminal',
        ownerId: input.execution.ownerId,
        receipt: transferred.value,
        result: {
          ok: true,
          summary: 'Terminal execution handed off.',
          data: { state: 'queued', executionId },
        },
      };
    } catch {
      return {
        kind: 'executor_returned',
        result: fail('Canonical terminal handoff failed.'),
      };
    }
  };
}

type TerminalExecutionSnapshot = Record<string, { status: string; sessionId?: string } | undefined>;

export async function cancelTerminalExecutionsAfterObserverCancellation(
  executionIds: readonly string[],
  dependencies: {
    isCanonical(executionId: string): boolean;
    requestCanonical(executionId: string): Promise<unknown>;
    cancelQueued(executionId: string): boolean;
    readSessionId(executionId: string): string | undefined;
    killManual(sessionId: string): Promise<unknown>;
    markLegacyFailed(executionId: string): void;
  },
): Promise<void> {
  for (const executionId of executionIds) {
    if (dependencies.isCanonical(executionId)) {
      await dependencies.requestCanonical(executionId);
      continue;
    }
    const removed = dependencies.cancelQueued(executionId);
    const sessionId = dependencies.readSessionId(executionId);
    if (!removed && sessionId) {
      await dependencies.killManual(sessionId).catch(() => undefined);
    }
    dependencies.markLegacyFailed(executionId);
  }
}

export async function waitForTerminalExecutions(
  executionIds: string[],
  options: {
    timeoutMs?: number;
    read?: () => TerminalExecutionSnapshot;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    cancelled?: () => boolean;
  } = {},
): Promise<{ ok: true; sessionIds: string[] } | { ok: false; error: string }> {
  if (!executionIds.length)
    return { ok: false, error: 'The terminal service returned no execution ids to verify.' };
  const timeoutMs = options.timeoutMs ?? 30_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const defaultStore = options.read
    ? undefined
    : (await import('@/features/terminals/terminalExecutionStore')).useTerminalExecutionStore;
  const read = options.read ?? (() => defaultStore!.getState().executions);
  const deadline = now() + timeoutMs;
  while (now() <= deadline) {
    if (options.cancelled?.())
      return { ok: false, error: 'Terminal launch verification was cancelled.' };
    const snapshot = read();
    const executions = executionIds.map((id) => snapshot[id]);
    const failedIndex = executions.findIndex(
      (execution) => execution && ['failed', 'cancelled'].includes(execution.status),
    );
    if (failedIndex >= 0) {
      return {
        ok: false,
        error: `Terminal launch ${executionIds[failedIndex]} failed before startup verification.`,
      };
    }
    const started = executions.every(
      (execution) =>
        execution &&
        ['running', 'complete'].includes(execution.status) &&
        typeof execution.sessionId === 'string' &&
        execution.sessionId.length > 0,
    );
    if (started) {
      return { ok: true, sessionIds: executions.map((execution) => execution!.sessionId!) };
    }
    await sleep(200);
  }
  return {
    ok: false,
    error: `Terminal launches did not reach a verified started state within ${timeoutMs}ms.`,
  };
}

export interface JarvisAgentBatchItem {
  task: string;
  agentId?: string;
}

export function parseAgentBatch(raw: string): JarvisAgentBatchItem[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8) return null;
    const items = parsed.map((item): JarvisAgentBatchItem | null => {
      if (typeof item === 'string') {
        const task = item.trim();
        return task ? { task: task.slice(0, 4_000) } : null;
      }
      if (!item || typeof item !== 'object') return null;
      const task =
        typeof (item as { task?: unknown }).task === 'string'
          ? (item as { task: string }).task.trim()
          : '';
      const agentId =
        typeof (item as { agentId?: unknown }).agentId === 'string'
          ? (item as { agentId: string }).agentId.trim()
          : '';
      if (!task) return null;
      return { task: task.slice(0, 4_000), ...(agentId ? { agentId } : {}) };
    });
    return items.every((item): item is JarvisAgentBatchItem => item !== null) ? items : null;
  } catch {
    return null;
  }
}

type AgentBatchSnapshot = Record<
  string,
  { status: string; summary?: string; error?: string } | undefined
>;

export async function waitForAgentBatch(
  agentIds: string[],
  options: {
    timeoutMs?: number;
    read: () => AgentBatchSnapshot;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    cancelled?: () => boolean;
  },
): Promise<{ ok: true; summaries: string[] } | { ok: false; error: string }> {
  if (!agentIds.length) return { ok: false, error: 'No child agents were started.' };
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 300_000;
  const deadline = now() + timeoutMs;
  while (now() <= deadline) {
    if (options.cancelled?.()) return { ok: false, error: 'Agent batch was cancelled.' };
    const snapshot = options.read();
    for (const agentId of agentIds) {
      const agent = snapshot[agentId];
      if (!agent || !['failed', 'cancelled', 'blocked'].includes(agent.status)) continue;
      return {
        ok: false,
        error: `Agent ${agentId} is ${agent.status}: ${agent.error?.trim() || 'No additional detail was reported.'}`,
      };
    }
    if (agentIds.every((agentId) => snapshot[agentId]?.status === 'done')) {
      return {
        ok: true,
        summaries: agentIds.map(
          (agentId) => snapshot[agentId]?.summary?.trim() || `Agent ${agentId} completed.`,
        ),
      };
    }
    await sleep(250);
  }
  return { ok: false, error: `Child agents did not finish within ${timeoutMs}ms.` };
}

export const CORE_ACTION_IDS = [
  'terminal.create',
  'terminal.create_many',
  'terminal.ensure_total',
  'terminal.start_cli',
  'terminal.send_input',
  'terminal.wait_for_output',
  'terminal.collect_output',
  'chat.create',
  'chat.rename',
  'chat.send',
  'agent.create',
  'agent.run',
  'agent.run_many',
  'agent.wait',
  'agent.status',
  'tool.create',
  'tool.run',
  'plugin.connect',
  'plugin.status',
  'mcp.start',
  'mcp.status',
  'mcp.invoke',
  'file.search',
  'file.attach',
  'file.open',
  'jarvis_action.create',
  'notification.send',
  'task.cancel',
  'settings.update',
] as const;

async function runRequired(
  resolveLegacy: LegacyResolver,
  id: string,
  params: Record<string, unknown>,
  ctx: ActionRunContext,
): Promise<ActionResult> {
  const action = resolveLegacy(id);
  if (!action) return fail(`Required host action ${id} is unavailable.`);
  return action.run(params, ctx);
}

function text(params: Record<string, unknown>, key: string): string {
  return typeof params[key] === 'string' ? params[key].trim() : '';
}

function numberInRange(
  params: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = params[key];
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

type ExactTerminalRef = Readonly<{ sessionId?: string; paneId?: string }>;

function parseExactTerminalRef(raw: string, strict = false): ExactTerminalRef | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      strict &&
      (!parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        Reflect.ownKeys(parsed).length !== 1 ||
        !Reflect.ownKeys(parsed).every(
          (key) => typeof key === 'string' && ['sessionId', 'paneId'].includes(key),
        ))
    ) {
      return null;
    }
    const candidate = Array.isArray(parsed) ? (parsed.length === 1 ? parsed[0] : null) : parsed;
    if (typeof candidate === 'string') {
      const sessionId = candidate.trim();
      return sessionId ? { sessionId } : null;
    }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const source = candidate as Record<string, unknown>;
    const sessionId = typeof source.sessionId === 'string' ? source.sessionId.trim() : '';
    const paneId = typeof source.paneId === 'string' ? source.paneId.trim() : '';
    if (!sessionId && !paneId) return null;
    return {
      ...(sessionId ? { sessionId } : {}),
      ...(paneId ? { paneId } : {}),
    };
  } catch {
    return null;
  }
}

function hasExactlyOneTerminalSelector(
  params: Record<string, unknown>,
  allowAgentSlug = true,
): boolean {
  if (!allowAgentSlug && text(params, 'agentSlug')) return false;
  const selectors = allowAgentSlug ? ['sessionId', 'paneId', 'agentSlug'] : ['sessionId', 'paneId'];
  return selectors.filter((key) => text(params, key)).length === 1;
}

type ProtectedTerminalScope = Readonly<{
  accountId: string;
  workspaceId: string;
  projectId: string;
  isCurrent(): boolean;
}>;

async function resolveProtectedTerminalScope(
  ctx: ActionRunContext,
): Promise<ProtectedTerminalScope | null> {
  if (ctx.source !== 'ai' || !ctx.accountId?.trim() || !ctx.chatId?.trim()) return null;
  const [{ getActiveAccountIdentity }, { useAuthStore }, { chatRepo }] = await Promise.all([
    import('@/lib/accountIdentity'),
    import('@/stores/auth'),
    import('@/lib/db/repositories'),
  ]);
  const identityBefore = getActiveAccountIdentity();
  const authBefore = useAuthStore.getState();
  const workspaceId = authBefore.workspaceId?.trim() ?? '';
  const projectId = authBefore.projectId?.trim() ?? '';
  const isCurrent = () => {
    const identity = getActiveAccountIdentity();
    const auth = useAuthStore.getState();
    return (
      identity?.accountId === ctx.accountId &&
      String(auth.workspaceId ?? '') === workspaceId &&
      String(auth.projectId ?? '') === projectId
    );
  };
  if (identityBefore?.accountId !== ctx.accountId || !workspaceId || !projectId) {
    return null;
  }
  const chat = await chatRepo.getById(ctx.chatId as never);
  const identityAfter = getActiveAccountIdentity();
  const authAfter = useAuthStore.getState();
  if (
    identityAfter?.accountId !== ctx.accountId ||
    authAfter.workspaceId !== authBefore.workspaceId ||
    authAfter.projectId !== authBefore.projectId ||
    !chat ||
    String(chat.workspace_id) !== workspaceId ||
    String(chat.project_id ?? '') !== projectId
  ) {
    return null;
  }
  return { accountId: ctx.accountId, workspaceId, projectId, isCurrent };
}

async function terminalSessions(params: Record<string, unknown>, ctx: ActionRunContext) {
  const [{ useTerminalTranscriptStore }, terminalIntelligence, executionModule] = await Promise.all(
    [
      import('@/features/terminals/transcriptStore'),
      ctx.source === 'ai' ? import('@/lib/jarvis/terminalIntelligence') : Promise.resolve(null),
      ctx.source === 'ai'
        ? import('@/features/terminals/terminalExecutionStore')
        : Promise.resolve(null),
    ],
  );
  const protectedScope = ctx.source === 'ai' ? await resolveProtectedTerminalScope(ctx) : undefined;
  if (ctx.source === 'ai' && !protectedScope) return { sessions: [] };
  const liveProtectedPanes = protectedScope
    ? terminalIntelligence!
        .readJarvisTerminalOperatingSnapshot({
          projectId: protectedScope.projectId,
          observedAt: Date.now(),
        })
        .panes.filter(
          (pane) => !pane.stale && ['sent', 'running', 'verifying'].includes(pane.state),
        )
    : [];
  const all = Object.values(useTerminalTranscriptStore.getState().sessions);
  const sessionId = text(params, 'sessionId');
  const paneId = text(params, 'paneId');
  const agentSlug = text(params, 'agentSlug');
  const sessions = all
    .filter((session) => !sessionId || session.sessionId === sessionId)
    .filter((session) => !paneId || session.paneId === paneId)
    .filter((session) => !agentSlug || session.agentSlug === agentSlug)
    .filter(
      (session) =>
        !protectedScope ||
        (session.projectId === protectedScope.projectId &&
          liveProtectedPanes.some(
            (pane) => pane.sessionId === session.sessionId && pane.paneId === session.paneId,
          ) &&
          Object.values(executionModule!.useTerminalExecutionStore.getState().executions).filter(
            (execution) =>
              execution.status === 'running' &&
              execution.sessionId === session.sessionId &&
              execution.processIdentity?.accountId === protectedScope.accountId &&
              execution.processIdentity.projectId === protectedScope.projectId &&
              execution.processIdentity.paneId === session.paneId &&
              execution.processIdentity.sessionId === session.sessionId,
          ).length === 1 &&
          Object.values(executionModule!.useTerminalExecutionStore.getState().executions).some(
            (execution) =>
              execution.status === 'running' &&
              execution.sessionId === session.sessionId &&
              execution.accountId === protectedScope.accountId &&
              execution.processIdentity?.accountId === protectedScope.accountId &&
              execution.processIdentity.projectId === protectedScope.projectId &&
              execution.processIdentity.paneId === session.paneId &&
              execution.processIdentity.sessionId === session.sessionId,
          )),
    )
    .sort((a, b) => b.lastWriteAt - a.lastWriteAt);
  if (protectedScope && !protectedScope.isCurrent()) return { sessions: [] };
  return { sessions, ...(protectedScope ? { protectedScope } : {}) };
}

export function createJarvisCoreActions(resolveLegacy: LegacyResolver): ActionDef[] {
  return [
    {
      id: 'terminal.create',
      category: 'terminal',
      label: 'Create terminal',
      description: 'Create one terminal pane through the terminal command queue.',
      params: [
        { key: 'cwd', label: 'Working directory', type: 'string' },
        { key: 'label', label: 'Pane label', type: 'string' },
      ],
      run: (params, ctx) =>
        runRequired(
          resolveLegacy,
          'terminal.bulkOpen',
          {
            count: 1,
            cwd: text(params, 'cwd') || undefined,
            command: '',
          },
          ctx,
        ),
    },
    {
      id: 'terminal.create_many',
      category: 'terminal',
      label: 'Create terminal panes',
      description: 'Create a bounded batch of terminal panes through the terminal command queue.',
      params: [
        { key: 'count', label: 'Pane count', type: 'number', required: true },
        { key: 'cwd', label: 'Working directory', type: 'string' },
      ],
      run: (params, ctx) =>
        runRequired(
          resolveLegacy,
          'terminal.bulkOpen',
          {
            count: numberInRange(params, 'count', 1, 1, 10),
            cwd: text(params, 'cwd') || undefined,
            command: '',
          },
          ctx,
        ),
    },
    {
      id: 'terminal.ensure_total',
      category: 'terminal',
      label: 'Ensure terminal total',
      description:
        'Inspect tracked live terminals, preserve every existing pane, and create only the missing safe panes.',
      destructive: true,
      params: [
        { key: 'count', label: 'Desired total', type: 'number', required: true },
        { key: 'cli', label: 'CLI for new panes', type: 'string' },
        { key: 'cwd', label: 'Working directory', type: 'string' },
      ],
      run: async (params, ctx) => {
        const count = numberInRange(params, 'count', 1, 1, 10);
        const [{ terminalSessionRepo }, { useAuthStore }] = await Promise.all([
          import('@/lib/db/repositories'),
          import('@/stores/auth'),
        ]);
        const auth = useAuthStore.getState();
        if (!auth.workspaceId) return fail('No active workspace.');
        const sessions = auth.projectId
          ? await terminalSessionRepo.listByProject(auth.projectId)
          : await terminalSessionRepo.listByWorkspace(auth.workspaceId);
        const existing = sessions.filter((session) => session.status !== 'exited');
        const remaining = Math.max(0, count - existing.length);
        if (remaining === 0) {
          return ok(
            `Terminal total already satisfied with ${existing.length} existing pane${existing.length === 1 ? '' : 's'}; none were changed.`,
            {
              existing: existing.map((session) => session.id),
              created: 0,
            },
          );
        }
        const cli = text(params, 'cli');
        const created = await runRequired(
          resolveLegacy,
          'terminal.bulkOpen',
          {
            count: remaining,
            cwd: text(params, 'cwd') || undefined,
            command: cli,
          },
          ctx,
        );
        if (!created.ok) return created;
        const executionIds =
          typeof created.data === 'object' &&
          created.data !== null &&
          Array.isArray((created.data as { executionIds?: unknown }).executionIds)
            ? (created.data as { executionIds: unknown[] }).executionIds.filter(
                (id): id is string => typeof id === 'string' && id.length > 0,
              )
            : [];
        const cancelled = () => ctx.signal?.aborted ?? false;
        let verified: Awaited<ReturnType<typeof waitForTerminalExecutions>>;
        verified = await waitForTerminalExecutions(executionIds, { cancelled });
        if (!verified.ok) {
          if (/\bcancelled\b/i.test(verified.error)) {
            const [{ cancelQueuedTerminalCommand }, executionStore, { invoke }] = await Promise.all(
              [
                import('@/features/terminals/terminalCommandQueue'),
                import('@/features/terminals/terminalExecutionStore'),
                import('@tauri-apps/api/core'),
              ],
            );
            await cancelTerminalExecutionsAfterObserverCancellation(executionIds, {
              isCanonical: executionStore.hasCanonicalTerminalExecution,
              requestCanonical: executionStore.requestTerminalExecutionCancellation,
              cancelQueued: cancelQueuedTerminalCommand,
              readSessionId: (executionId) =>
                executionStore.useTerminalExecutionStore.getState().executions[executionId]
                  ?.sessionId,
              killManual: (sessionId) => invoke('terminal_kill', { sessionId }),
              markLegacyFailed: (executionId) =>
                executionStore.markTerminalExecution(executionId, 'failed', {
                  exitCode: null,
                  settlementError: 'manual_termination_requested',
                }),
            });
          }
          return fail(verified.error);
        }
        return ok(
          `Preserved ${existing.length} existing terminal${existing.length === 1 ? '' : 's'} and verified ${remaining} safe new pane${remaining === 1 ? '' : 's'} started${cli ? ` with ${cli}` : ''}.`,
          {
            state: 'verified',
            existing: existing.map((session) => session.id),
            created: remaining,
            executionIds,
            sessionIds: verified.sessionIds,
          },
        );
      },
    },
    {
      id: 'terminal.start_cli',
      category: 'terminal',
      label: 'Start terminal CLI',
      description: 'Start a named CLI in a new terminal pane and return its execution id.',
      destructive: true,
      params: [
        { key: 'cli', label: 'CLI command', type: 'string', required: true },
        { key: 'cwd', label: 'Working directory', type: 'string' },
        { key: 'label', label: 'Pane label', type: 'string' },
        { key: 'timeoutMs', label: 'Timeout milliseconds', type: 'number' },
      ],
      run: async (params, ctx) => {
        const cli = text(params, 'cli');
        if (!cli) return fail('CLI command is required.');
        if (ctx.source === 'ai' && (!ctx.accountId?.trim() || !ctx.runId?.trim())) {
          return fail('Canonical terminal owner identity is required.');
        }
        if (ctx.source === 'ai') {
          return fail('Canonical terminal dispatcher is required.');
        }
        return runRequired(
          resolveLegacy,
          'terminal.run',
          {
            command: cli,
            cwd: text(params, 'cwd') || undefined,
            label: text(params, 'label') || cli.split(/\s+/)[0],
            timeoutMs: numberInRange(params, 'timeoutMs', 120_000, 1_000, 3_600_000),
          },
          ctx,
        );
      },
    },
    {
      id: 'terminal.send_input',
      category: 'terminal',
      label: 'Send terminal input',
      description: 'Send explicit input to exactly one referenced live terminal.',
      destructive: true,
      params: [
        { key: 'command', label: 'Input', type: 'string', required: true },
        { key: 'refsJson', label: 'One terminal ref JSON', type: 'string', required: true },
      ],
      run: (params, ctx) => {
        const command = text(params, 'command');
        if (!command) return Promise.resolve(fail('Terminal input is required.'));
        const refsJson = text(params, 'refsJson');
        const ref = parseExactTerminalRef(refsJson, ctx.source === 'ai');
        if (
          !ref ||
          (ctx.source === 'ai' &&
            !hasExactlyOneTerminalSelector(ref as Record<string, unknown>, false))
        ) {
          return Promise.resolve(fail('Exactly one explicit terminal ref is required.'));
        }
        return terminalSessions(ref, ctx).then(({ sessions, protectedScope }) => {
          if (sessions.length !== 1) {
            return fail('The explicit terminal ref did not resolve to exactly one live terminal.');
          }
          if (protectedScope && !protectedScope.isCurrent()) {
            return fail('The protected terminal scope is no longer current.');
          }
          return runRequired(
            resolveLegacy,
            'terminal.sendToRefs',
            { command, refsJson: JSON.stringify([ref]) },
            ctx,
          );
        });
      },
    },
    {
      id: 'terminal.wait_for_output',
      category: 'terminal',
      label: 'Wait for terminal output',
      description:
        'Wait until exactly one explicitly selected terminal emits output or contains an expected string.',
      params: [
        { key: 'sessionId', label: 'Session id', type: 'string' },
        { key: 'paneId', label: 'Pane id', type: 'string' },
        { key: 'agentSlug', label: 'Agent slug', type: 'string' },
        { key: 'contains', label: 'Expected text', type: 'string' },
        { key: 'afterBytes', label: 'Minimum byte count', type: 'number' },
        { key: 'timeoutMs', label: 'Timeout milliseconds', type: 'number' },
      ],
      run: async (params, ctx) => {
        if (!hasExactlyOneTerminalSelector(params, ctx.source === 'user')) {
          return fail('Exactly one explicit terminal selector is required.');
        }
        const timeoutMs = numberInRange(params, 'timeoutMs', 30_000, 250, 60_000);
        const afterBytes = numberInRange(params, 'afterBytes', 0, 0, Number.MAX_SAFE_INTEGER);
        const contains = text(params, 'contains').toLowerCase();
        const deadline = Date.now() + timeoutMs;
        do {
          const { sessions, protectedScope } = await terminalSessions(params, ctx);
          if (sessions.length > 1) {
            return fail('The terminal selector resolved to more than one live terminal.');
          }
          const match = sessions.find(
            (session) =>
              session.bytesSeen > afterBytes &&
              (!contains || session.text.toLowerCase().includes(contains)),
          );
          if (match) {
            if (protectedScope && !protectedScope.isCurrent()) {
              return fail('The protected terminal scope is no longer current.');
            }
            return ok('Terminal output condition met.', {
              sessionId: match.sessionId,
              paneId: match.paneId,
              bytesSeen: match.bytesSeen,
              tail: match.text.slice(-2_000),
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        } while (Date.now() < deadline);
        return fail(`Terminal output did not meet the condition within ${timeoutMs}ms.`);
      },
    },
    {
      id: 'terminal.collect_output',
      category: 'terminal',
      label: 'Collect terminal output',
      description:
        'Collect a bounded, sanitized transcript tail from one explicitly selected terminal.',
      params: [
        { key: 'sessionId', label: 'Session id', type: 'string' },
        { key: 'paneId', label: 'Pane id', type: 'string' },
        { key: 'agentSlug', label: 'Agent slug', type: 'string' },
        { key: 'maxChars', label: 'Maximum characters', type: 'number' },
      ],
      run: async (params, ctx) => {
        if (!hasExactlyOneTerminalSelector(params, ctx.source === 'user')) {
          return fail('Exactly one explicit terminal selector is required.');
        }
        const { sessions, protectedScope } = await terminalSessions(params, ctx);
        if (!sessions.length) return fail('No matching terminal transcript is available.');
        if (sessions.length > 1) {
          return fail('The terminal selector resolved to more than one live terminal.');
        }
        const maxChars = numberInRange(params, 'maxChars', 8_000, 200, 16_000);
        if (protectedScope && !protectedScope.isCurrent()) {
          return fail('The protected terminal scope is no longer current.');
        }
        return ok(
          `Collected output from ${sessions.length} terminal${sessions.length === 1 ? '' : 's'}.`,
          {
            sessions: sessions.map((session) => ({
              sessionId: session.sessionId,
              paneId: session.paneId,
              agentSlug: session.agentSlug,
              output: session.text.slice(-maxChars),
              bytesSeen: session.bytesSeen,
            })),
          },
        );
      },
    },
    {
      id: 'chat.create',
      category: 'chat',
      label: 'Create chat',
      description: 'Create and open a chat in the active workspace.',
      params: [{ key: 'title', label: 'Chat title', type: 'string', required: true }],
      run: async (params) => {
        const title = text(params, 'title');
        if (!title) return fail('Chat title is required.');
        const [{ chatRepo }, { useAuthStore }, { useUIStore }] = await Promise.all([
          import('@/lib/db/repositories'),
          import('@/stores/auth'),
          import('@/stores/ui'),
        ]);
        const auth = useAuthStore.getState();
        if (!auth.workspaceId) return fail('No active workspace.');
        const chat = await chatRepo.create({
          workspace_id: auth.workspaceId,
          project_id: auth.projectId ?? undefined,
          title,
          mode: 'chat',
          active_agent_ids: [],
        });
        useUIStore.getState().setActiveChat(String(chat.id));
        useUIStore.getState().setRoute('chat');
        return ok(`Created chat: ${title}`, { chatId: chat.id });
      },
    },
    {
      id: 'chat.rename',
      category: 'chat',
      label: 'Rename chat',
      description: 'Rename an existing chat by id.',
      params: [
        { key: 'chatId', label: 'Chat id', type: 'string' },
        { key: 'title', label: 'New title', type: 'string', required: true },
      ],
      run: async (params, ctx) => {
        const chatId = text(params, 'chatId') || ctx.chatId || '';
        const title = text(params, 'title');
        if (!chatId || !title) return fail('Chat id and title are required.');
        const { chatRepo } = await import('@/lib/db/repositories');
        const chat = await chatRepo.getById(chatId as never);
        if (!chat) return fail(`Chat ${chatId} was not found.`);
        await chatRepo.update(chat.id, { title });
        return ok(`Renamed chat to ${title}.`, { chatId });
      },
    },
    {
      id: 'chat.send',
      category: 'chat',
      label: 'Send chat message',
      description: 'Persist a user message in a target chat and dispatch it to Jarvis.',
      destructive: true,
      params: [
        { key: 'chatId', label: 'Chat id', type: 'string' },
        { key: 'message', label: 'Message', type: 'string', required: true },
      ],
      run: async (params, ctx) => {
        const chatId = text(params, 'chatId') || ctx.chatId || '';
        const message = text(params, 'message');
        if (!chatId || !message) return fail('Chat id and message are required.');
        const { chatRepo, messageRepo } = await import('@/lib/db/repositories');
        if (!(await chatRepo.getById(chatId as never)))
          return fail(`Chat ${chatId} was not found.`);
        await messageRepo.create({
          chat_id: chatId as never,
          role: 'user',
          parts: [{ kind: 'text', text: message }],
        });
        window.dispatchEvent(new CustomEvent('jarvis:send', { detail: { chatId, text: message } }));
        return ok('Message sent.', { chatId });
      },
    },
    {
      id: 'agent.create',
      category: 'custom',
      label: 'Create agent',
      description:
        'Create a user agent by cloning the safe Jarvis defaults and applying an explicit persona.',
      destructive: true,
      params: [
        { key: 'name', label: 'Agent name', type: 'string', required: true },
        { key: 'description', label: 'Description', type: 'string' },
        { key: 'systemPrompt', label: 'System prompt', type: 'string', required: true },
      ],
      run: async (params) => {
        const name = text(params, 'name');
        const systemPrompt = text(params, 'systemPrompt');
        if (!name || !systemPrompt) return fail('Agent name and system prompt are required.');
        const [{ getDefaultAgents }, { agentRepo }, { useAgentStore }] = await Promise.all([
          import('@/features/agents'),
          import('@/lib/db/repositories'),
          import('@/stores/agents'),
        ]);
        const template = getDefaultAgents()[0];
        if (!template) return fail('Jarvis agent template is unavailable.');
        const { id: _id, created_at: _created, updated_at: _updated, ...defaults } = template;
        const slugBase =
          name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') || 'agent';
        const agent = await agentRepo.create({
          ...defaults,
          slug: `${slugBase}-${Date.now().toString(36)}`,
          name,
          description: text(params, 'description') || `User-created agent: ${name}`,
          system_prompt: systemPrompt,
          builtin: false,
          source: 'user-form',
        });
        useAgentStore.getState().registerAgent(agent);
        return ok(`Created agent ${name}.`, { agentId: agent.id, slug: agent.slug });
      },
    },
    {
      id: 'agent.run',
      category: 'custom',
      label: 'Run agent',
      description: 'Launch a persistent child-chat agent for a task.',
      destructive: true,
      params: [
        { key: 'task', label: 'Task', type: 'string', required: true },
        { key: 'agentId', label: 'Agent id', type: 'string' },
      ],
      run: async (params, ctx) => {
        const task = text(params, 'task');
        if (!ctx.chatId || !task) return fail('A parent chat and task are required.');
        const [{ launchJarvisChatAgent }, { useAgentStore }] = await Promise.all([
          import('@/features/jarvis-interaction/agentRunner'),
          import('@/stores/agents'),
        ]);
        const requested = text(params, 'agentId');
        const agents = Object.values(useAgentStore.getState().agents);
        const agent = agents.find((item) => String(item.id) === requested) ?? agents[0];
        const launched = await launchJarvisChatAgent({
          parentChatId: ctx.chatId,
          task,
          modelLabel: agent ? `${agent.model.provider}/${agent.model.model}` : 'current chat model',
          jarvisAgentId: agent?.id,
          commandName: 'multitask',
        });
        return ok('Agent started.', launched);
      },
    },
    {
      id: 'agent.run_many',
      category: 'custom',
      label: 'Run agent batch',
      description:
        'Launch a bounded set of child-chat agents, observe every agent, and return only after completion or a truthful block/failure.',
      destructive: true,
      params: [
        { key: 'tasksJson', label: 'Agent tasks JSON', type: 'string', required: true },
        { key: 'timeoutMs', label: 'Timeout milliseconds', type: 'number' },
      ],
      run: async (params, ctx) => {
        if (!ctx.chatId) return fail('A parent chat is required for multi-agent work.');
        const tasks = parseAgentBatch(text(params, 'tasksJson'));
        if (!tasks) return fail('tasksJson must contain 1-8 non-empty agent task objects.');
        const [{ launchJarvisChatAgent }, { useAgentStore }, { useJarvisInteractionStore }] =
          await Promise.all([
            import('@/features/jarvis-interaction/agentRunner'),
            import('@/stores/agents'),
            import('@/features/jarvis-interaction/sessionStore'),
          ]);
        const agents = Object.values(useAgentStore.getState().agents);
        const launchedIds: string[] = [];
        const launchedChildren: Array<{ agentId: string; childChatId: string }> = [];
        for (const task of tasks) {
          const agent =
            agents.find((candidate) => String(candidate.id) === task.agentId) ?? agents[0];
          const launched = await launchJarvisChatAgent({
            parentChatId: ctx.chatId,
            task: task.task,
            modelLabel: agent
              ? `${agent.model.provider}/${agent.model.model}`
              : 'current chat model',
            jarvisAgentId: agent?.id,
            commandName: 'multitask',
          });
          launchedIds.push(...launched.agents.map((item) => String(item.agentId)));
          launchedChildren.push(
            ...launched.agents.map((item) => ({
              agentId: String(item.agentId),
              childChatId: String(item.childChatId),
            })),
          );
        }
        const cancelled = () => ctx.signal?.aborted ?? false;
        let observed: Awaited<ReturnType<typeof waitForAgentBatch>>;
        observed = await waitForAgentBatch(launchedIds, {
          timeoutMs: numberInRange(params, 'timeoutMs', 300_000, 1_000, 900_000),
          read: () =>
            Object.fromEntries(
              useJarvisInteractionStore
                .getState()
                .agentsForChat(ctx.chatId!)
                .map((agent) => [
                  String(agent.agentId),
                  { status: agent.status, summary: agent.summary, error: agent.error },
                ]),
            ),
          cancelled,
        });
        if (!observed.ok) {
          if (/\bcancelled\b/i.test(observed.error)) {
            for (const child of launchedChildren) {
              window.dispatchEvent(
                new CustomEvent('jarvis:cancel', { detail: { chatId: child.childChatId } }),
              );
              useJarvisInteractionStore.getState().updateAgent(ctx.chatId, child.agentId, {
                status: 'cancelled',
                currentStep: 'Cancelled by user',
                updatedAt: new Date().toISOString(),
              });
            }
          }
          return fail(observed.error);
        }
        return ok(
          `Completed ${launchedIds.length} agent${launchedIds.length === 1 ? '' : 's'} and collected every result.`,
          {
            agentIds: launchedIds,
            summaries: observed.summaries,
          },
        );
      },
    },
    {
      id: 'agent.wait',
      category: 'custom',
      label: 'Wait for agent',
      description: 'Wait for a child agent to finish, fail, cancel, or report a block.',
      params: [
        { key: 'agentId', label: 'Agent id', type: 'string' },
        { key: 'timeoutMs', label: 'Timeout milliseconds', type: 'number' },
      ],
      run: async (params, ctx) => {
        let agentId = text(params, 'agentId');
        if (!ctx.chatId) return fail('A parent chat is required.');
        const { useJarvisInteractionStore } =
          await import('@/features/jarvis-interaction/sessionStore');
        if (!agentId) {
          const latest = useJarvisInteractionStore
            .getState()
            .agentsForChat(ctx.chatId)
            .filter((agent) => !['done', 'failed', 'cancelled'].includes(agent.status))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
          agentId = latest ? String(latest.agentId) : '';
        }
        if (!agentId) return fail('No active child agent was found in this chat.');
        const timeoutMs = numberInRange(params, 'timeoutMs', 120_000, 250, 600_000);
        const deadline = Date.now() + timeoutMs;
        do {
          const agent = useJarvisInteractionStore
            .getState()
            .agentsForChat(ctx.chatId)
            .find((item) => String(item.agentId) === agentId);
          if (!agent) return fail(`Agent ${agentId} was not found in this chat.`);
          if (agent.status === 'done')
            return ok(agent.summary || `${agent.name} completed.`, { agent });
          if (['failed', 'cancelled', 'blocked'].includes(agent.status)) {
            return fail(agent.error || `${agent.name} is ${agent.status}.`);
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        } while (Date.now() < deadline);
        return fail(`Agent ${agentId} did not finish within ${timeoutMs}ms.`);
      },
    },
    {
      id: 'agent.status',
      category: 'custom',
      label: 'Read agent status',
      description: 'Read the actual in-memory state of active runtime and child-chat agents.',
      autoApprove: true,
      params: [],
      run: async (_params, ctx) => {
        const [{ useAgentStore }, { useJarvisInteractionStore }] = await Promise.all([
          import('@/stores/agents'),
          import('@/features/jarvis-interaction/sessionStore'),
        ]);
        const runtime = useAgentStore.getState();
        const activeRuntime = Object.values(runtime.agents)
          .filter((agent) => {
            const state = runtime.runStates[agent.id];
            return Boolean(state && !['idle', 'done'].includes(state));
          })
          .map((agent) => ({
            agentId: agent.id,
            name: agent.name,
            status: runtime.runStates[agent.id],
            verb: runtime.verbs[agent.id],
          }));
        const childAgents = ctx.chatId
          ? useJarvisInteractionStore
              .getState()
              .agentsForChat(ctx.chatId)
              .filter((agent) => !['done', 'failed', 'cancelled'].includes(agent.status))
          : [];
        const count = activeRuntime.length + childAgents.length;
        return ok(`${count} agent${count === 1 ? '' : 's'} currently active.`, {
          runtime: activeRuntime,
          childAgents,
        });
      },
    },
    {
      id: 'tool.create',
      category: 'custom',
      label: 'Create tool',
      description: 'Create a reusable custom terminal command or multi-step workflow tool.',
      destructive: true,
      params: [
        { key: 'name', label: 'Tool name', type: 'string', required: true },
        { key: 'description', label: 'Description', type: 'string' },
        { key: 'command', label: 'Terminal command', type: 'string' },
        { key: 'stepsJson', label: 'Workflow steps JSON', type: 'string' },
      ],
      run: (params, ctx) => {
        const target = text(params, 'stepsJson')
          ? 'custom.createWorkflowTool'
          : 'custom.createTerminalCommand';
        return runRequired(resolveLegacy, target, params, ctx);
      },
    },
    {
      id: 'tool.run',
      category: 'custom',
      label: 'Run tool',
      description: 'Run a registered custom tool by its stable custom.<slug> id.',
      destructive: true,
      params: [{ key: 'toolId', label: 'Tool id', type: 'string', required: true }],
      run: async (params, ctx) => {
        const toolId = text(params, 'toolId');
        if (!toolId.startsWith('custom.')) return fail('Tool id must start with custom.');
        const { useToolStore } = await import('@/features/tools/toolStore');
        const action = useToolStore.getState().resolve(toolId);
        if (!action) return fail(`Custom tool ${toolId} was not found.`);
        return action.run({}, ctx);
      },
    },
    {
      id: 'plugin.connect',
      category: 'custom',
      label: 'Connect plugin',
      description:
        'Check a plugin connection or open its credential-safe setup UI when user input is required.',
      params: [{ key: 'pluginId', label: 'Plugin id', type: 'string', required: true }],
      run: async (params, ctx) => {
        const pluginId = text(params, 'pluginId');
        if (!pluginId) return fail('Plugin id is required.');
        if (!ctx.accountId) return fail('Plugin status requires an active account.');
        const [{ getPluginManifest }, { selectPluginConnectionsForAccount, usePluginStore }] =
          await Promise.all([import('@/features/plugins'), import('@/features/plugins/store')]);
        const manifest = getPluginManifest(pluginId);
        if (!manifest) return fail(`Unknown plugin ${pluginId}.`);
        const connection = selectPluginConnectionsForAccount(
          usePluginStore.getState(),
          ctx.accountId,
        )[pluginId];
        if (connection?.state === 'connected')
          return ok(`${manifest.name} is connected.`, {
            pluginId,
            enabled: connection.enabled,
          });
        const opened = await runRequired(resolveLegacy, 'settings.plugins', {}, ctx);
        if (!opened.ok) return opened;
        return ok(
          `${manifest.name} requires setup in Settings → Plugins. No connection was claimed.`,
          {
            pluginId,
            state: 'setup-required',
          },
        );
      },
    },
    {
      id: 'plugin.status',
      category: 'custom',
      label: 'Read plugin status',
      description: 'Read a plugin connection and health contract without exposing credentials.',
      autoApprove: true,
      params: [{ key: 'pluginId', label: 'Plugin id', type: 'string', required: true }],
      run: async (params, ctx) => {
        const pluginId = text(params, 'pluginId');
        if (!pluginId) return fail('Plugin id is required.');
        if (!ctx.accountId) return fail('Plugin status requires an active account.');
        const { getPluginManifest, getPluginRuntimeContract } = await import('@/features/plugins');
        const manifest = getPluginManifest(pluginId);
        if (!manifest) return fail(`Unknown plugin ${pluginId}.`);
        const contract = getPluginRuntimeContract(ctx.accountId, manifest);
        return ok(`${manifest.name} is ${contract.health.state}.`, contract);
      },
    },
    {
      id: 'mcp.start',
      category: 'custom',
      label: 'Start MCP server',
      description: 'Start a registered MCP adapter once and verify its health.',
      params: [{ key: 'serverId', label: 'Server id', type: 'string', required: true }],
      run: async (params) => {
        const serverId = text(params, 'serverId');
        if (!serverId) return fail('MCP server id is required.');
        const { jarvisMcpServerManager } = await import('@/lib/mcp/serverManager');
        try {
          const status = await jarvisMcpServerManager.start(serverId);
          const tools = await jarvisMcpServerManager.listTools(serverId);
          return ok(
            `MCP server ${serverId} is healthy with ${tools.length} tool${tools.length === 1 ? '' : 's'}.`,
            { status, tools },
          );
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      id: 'mcp.status',
      category: 'custom',
      label: 'Read MCP status',
      description: 'Read registered MCP server lifecycle and health state.',
      autoApprove: true,
      params: [{ key: 'serverId', label: 'Server id', type: 'string' }],
      run: async (params) => {
        const { jarvisMcpServerManager } = await import('@/lib/mcp/serverManager');
        const serverId = text(params, 'serverId');
        try {
          const status = serverId
            ? await jarvisMcpServerManager.health(serverId)
            : jarvisMcpServerManager.discover();
          return ok('MCP status read.', status);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      id: 'mcp.invoke',
      category: 'custom',
      label: 'Invoke MCP tool',
      description:
        'Invoke a named MCP tool with validated JSON input, timeout, and one safe restart.',
      destructive: true,
      params: [
        { key: 'serverId', label: 'Server id', type: 'string', required: true },
        { key: 'toolName', label: 'Tool name', type: 'string', required: true },
        { key: 'inputJson', label: 'Input JSON', type: 'string' },
        { key: 'timeoutMs', label: 'Timeout milliseconds', type: 'number' },
      ],
      run: async (params) => {
        const serverId = text(params, 'serverId');
        const toolName = text(params, 'toolName');
        const input = parseJsonObject(text(params, 'inputJson'));
        if (!serverId || !toolName) return fail('MCP server id and tool name are required.');
        if (!input) return fail('MCP inputJson must be a JSON object.');
        const { jarvisMcpServerManager } = await import('@/lib/mcp/serverManager');
        try {
          const result = await jarvisMcpServerManager.invoke(serverId, toolName, input, {
            timeoutMs: numberInRange(params, 'timeoutMs', 30_000, 250, 120_000),
          });
          return ok(`MCP tool ${serverId}.${toolName} completed.`, result);
        } catch {
          return fail('MCP tool invocation failed.');
        }
      },
    },
    {
      id: 'file.search',
      category: 'file',
      label: 'Search files',
      description:
        'Search filenames and text content under the active project root with bounded traversal.',
      autoApprove: true,
      params: [
        { key: 'query', label: 'Search query', type: 'string', required: true },
        { key: 'maxResults', label: 'Maximum results', type: 'number' },
      ],
      run: async (params) => {
        const query = text(params, 'query');
        if (!query) return fail('Search query is required.');
        const [{ getStoredProjectRoot }, { useAuthStore }, search] = await Promise.all([
          import('@/features/files/projectFiles'),
          import('@/stores/auth'),
          import('@/features/files/fileExplorerSearch'),
        ]);
        // Auto-approved search is always confined to the active project. A
        // model-controlled root would let an ordinary chat turn widen the
        // filesystem trust boundary.
        const root = getStoredProjectRoot(useAuthStore.getState().projectId ?? null);
        if (!root) return fail('No project folder is open.');
        const entries = await search.walkEntries(root, {
          maxDepth: 8,
          maxFiles: 4_000,
          accessRoot: root,
        });
        const hits = await search.scoreEntriesLocally(
          entries,
          search.parseSearchClues(query),
          root,
        );
        const maxResults = numberInRange(params, 'maxResults', 30, 1, 100);
        return ok(
          `Found ${Math.min(hits.length, maxResults)} matching file${hits.length === 1 ? '' : 's'}.`,
          {
            root,
            results: hits.slice(0, maxResults),
          },
        );
      },
    },
    {
      id: 'file.attach',
      category: 'file',
      label: 'Attach file',
      description: 'Attach an explicit local file path to the current chat composer.',
      params: [{ key: 'path', label: 'File path', type: 'string', required: true }],
      run: async (params, ctx) => {
        const path = text(params, 'path');
        if (!path || !ctx.chatId) return fail('File path and current chat are required.');
        window.dispatchEvent(
          new CustomEvent('jarvis:file:attach', {
            detail: { path, chatId: ctx.chatId },
          }),
        );
        return ok(`Sent ${path} to the active chat composer for attachment.`, {
          path,
          chatId: ctx.chatId,
          state: 'requested',
        });
      },
    },
    {
      id: 'file.open',
      category: 'file',
      label: 'Open file',
      description: 'Open an explicit file path in the VibeSpace file viewer.',
      params: [{ key: 'path', label: 'File path', type: 'string', required: true }],
      run: async (params) => {
        const path = text(params, 'path');
        if (!path) return fail('File path is required.');
        const [{ setStoredOpenFile }, { useAuthStore }, { useUIStore }] = await Promise.all([
          import('@/features/files/projectFiles'),
          import('@/stores/auth'),
          import('@/stores/ui'),
        ]);
        setStoredOpenFile(useAuthStore.getState().projectId ?? null, path);
        useUIStore.getState().setRoute('files');
        return ok(`Opened ${path}.`, { path });
      },
    },
    {
      id: 'jarvis_action.create',
      category: 'custom',
      label: 'Create Jarvis action',
      description: 'Create a reusable, explicit multi-step Jarvis workflow action.',
      destructive: true,
      params: [
        { key: 'name', label: 'Action name', type: 'string', required: true },
        { key: 'description', label: 'Description', type: 'string' },
        { key: 'stepsJson', label: 'Workflow steps JSON', type: 'string', required: true },
      ],
      run: (params, ctx) => runRequired(resolveLegacy, 'custom.createWorkflowTool', params, ctx),
    },
    {
      id: 'notification.send',
      category: 'host',
      label: 'Send notification',
      description: 'Show an in-app notification with an explicit title and message.',
      destructive: true,
      params: [
        { key: 'title', label: 'Title', type: 'string', required: true },
        { key: 'message', label: 'Message', type: 'string' },
        {
          key: 'level',
          label: 'Level',
          type: 'select',
          options: [
            { value: 'info', label: 'Info' },
            { value: 'success', label: 'Success' },
            { value: 'warning', label: 'Warning' },
            { value: 'error', label: 'Error' },
          ],
        },
      ],
      run: async (params) => {
        const title = text(params, 'title');
        if (!title) return fail('Notification title is required.');
        const message = text(params, 'message');
        if (
          /(?:api[-_ ]?key|password|access[-_ ]?token|secret)\s*[:=]/i.test(`${title}\n${message}`)
        ) {
          return fail('Credential-shaped content cannot be included in notifications.');
        }
        const { notify } = await import('@/lib/tauri');
        await notify(title, message || undefined, { fallbackToast: true });
        return ok(`Notification sent: ${title}`);
      },
    },
    {
      id: 'task.cancel',
      category: 'custom',
      label: 'Cancel Jarvis task',
      description: 'Request canonical Jarvis task cancellation when the kernel port is connected.',
      destructive: true,
      params: [{ key: 'runId', label: 'Task run id', type: 'string' }],
      run: async () =>
        fail('Canonical task cancellation is unavailable until the kernel port is connected.'),
    },
    {
      id: 'settings.update',
      category: 'settings',
      label: 'Update setting',
      description:
        'Update one allowlisted VibeSpace preference without exposing credentials or billing controls.',
      destructive: true,
      params: [
        {
          key: 'setting',
          label: 'Setting',
          type: 'select',
          required: true,
          options: [
            { value: 'theme', label: 'Theme' },
            { value: 'chat_auto_approve', label: 'Chat auto-approve' },
            { value: 'voice_auto_approve', label: 'Voice auto-approve' },
          ],
        },
        { key: 'value', label: 'Value', type: 'string', required: true },
      ],
      run: async (params, ctx) => {
        const setting = text(params, 'setting');
        const value = text(params, 'value').toLowerCase();
        const themeActionIds: Record<string, string> = {
          jarvis: 'theme.jarvis',
          vibespace: 'theme.vibespace',
          default: 'theme.dark',
          dark: 'theme.dark',
          monochrome: 'theme.monochrome',
          sakura: 'theme.sakura',
        };
        if (setting === 'theme' && themeActionIds[value]) {
          return runRequired(resolveLegacy, themeActionIds[value], {}, ctx);
        }
        if (setting === 'chat_auto_approve' && ['true', 'false'].includes(value)) {
          return runRequired(
            resolveLegacy,
            'preferences.setChatAutoApprove',
            { enabled: value === 'true' },
            ctx,
          );
        }
        if (setting === 'voice_auto_approve' && ['true', 'false'].includes(value)) {
          return runRequired(
            resolveLegacy,
            'voice.setAutoApprove',
            { enabled: value === 'true' },
            ctx,
          );
        }
        return fail(
          'Unsupported setting or value. Billing, pricing, credentials, and production controls cannot be changed here.',
        );
      },
    },
  ];
}
