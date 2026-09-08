import type { ProviderEvent, UsageSnapshot, UsageValue } from './types';
import { appActivityLog } from '@/lib/diagnostics/appActivityLog';

export type CodexApprovalKind = 'command' | 'file_change' | 'permissions';
export type CodexSimpleApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface CodexRequestedPermissionSummary {
  networkRequested: boolean;
  fileSystemReadCount: number;
  fileSystemWriteCount: number;
  fileSystemEntryCount: number;
}

export interface CodexApprovalDisplay {
  action: CodexApprovalKind;
  reason?: string;
  commandPreview?: string;
  cwdLabel?: string;
  fileLabels?: readonly string[];
  availableDecisions?: readonly CodexSimpleApprovalDecision[];
  requestedPermissions?: CodexRequestedPermissionSummary;
}

export interface CodexApprovalControlRequest {
  type: 'approval';
  kind: CodexApprovalKind;
  requestId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  /** Opaque JSON-RPC request identity for a future process-scoped secure response store. */
  responseHandle: string;
  requestMethod: string;
  responseKind: string;
  nativeApprovalId?: string;
  display: Readonly<CodexApprovalDisplay>;
}

export interface CodexQuestionControlRequest {
  type: 'question';
  requestId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: readonly Readonly<{
    id: string;
    header: string;
    prompt: string;
    options: readonly Readonly<{ label: string; description: string }>[];
    allowCustomAnswer: boolean;
  }>[];
}

export interface CodexSecureQuestionControlRequest {
  type: 'secure_question';
  requestId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  questionIds: readonly string[];
}

export interface CodexTurnBindingControlRequest {
  type: 'turn_binding';
  threadId: string;
  turnId: string;
}

export type CodexControlRequest =
  | CodexApprovalControlRequest
  | CodexQuestionControlRequest
  | CodexSecureQuestionControlRequest
  | CodexTurnBindingControlRequest
  | { type: 'plan_delta'; itemId: string; delta: string }
  | { type: 'plan_snapshot'; itemId: string; text: string }
  | { type: 'resolved'; requestId: string };

export interface CodexAppServerProjection {
  recognized: boolean;
  events: ProviderEvent[];
  controls: CodexControlRequest[];
}

export interface CodexAppServerProjectionOptions {
  capturedAt?: number;
  scope?: Readonly<{
    activeGeneration: number;
    messageGeneration: number;
    threadId: string;
    turnId?: string;
  }>;
}

const MAX_PUBLIC_TEXT = 32_768;
const MAX_IDENTIFIER = 256;
const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/u;
const UNSAFE_CONTROL_GLOBAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/gu;
const SCOPED_METHODS = new Set([
  'error',
  'item/agentMessage/delta',
  'item/completed',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/plan/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'item/started',
  'item/tool/requestUserInput',
  'serverRequest/resolved',
  'thread/tokenUsage/updated',
  'turn/completed',
  'turn/started',
]);

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeIdentifier(value: unknown): string | undefined {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  if (!text || text.length > MAX_IDENTIFIER || UNSAFE_CONTROL.test(text)) return undefined;
  return text;
}

function safePublicText(value: unknown, maximum = MAX_PUBLIC_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined;
  const sanitized = value
    .replace(ANSI_ESCAPE, '')
    .replace(UNSAFE_CONTROL_GLOBAL, '')
    .slice(0, maximum);
  return sanitized || undefined;
}

function safeApprovalText(value: unknown, maximum: number): string | undefined {
  const text = safePublicText(value, maximum);
  if (!text) return undefined;
  return text
    .replace(
      /\b(api[_-]?key|token|password|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      '$1=[redacted]',
    )
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]')
    .replace(/[A-Za-z]:[\\/][^\s"'`]+/gu, '[path]')
    .replace(/(^|[\s"'`])\/(?:[^\s"'`/]+\/)*[^\s"'`]*/gu, '$1[path]');
}

function leafFileLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const label = value.replaceAll('\\', '/').split('/').filter(Boolean).at(-1);
  if (
    !label ||
    label === '.' ||
    label === '..' ||
    label.length > 255 ||
    UNSAFE_CONTROL.test(label)
  ) {
    return undefined;
  }
  return label;
}

function projection(
  events: ProviderEvent[] = [],
  controls: CodexControlRequest[] = [],
  recognized = true,
): CodexAppServerProjection {
  return { recognized, events, controls };
}

function toolStatus(value: unknown): Extract<ProviderEvent, { type: 'tool' }>['status'] {
  if (value === 'completed' || value === 'success') return 'completed';
  if (value === 'failed' || value === 'declined' || value === 'error') return 'failed';
  return 'started';
}

function commandToolName(actions: unknown): 'read' | 'search' | 'command' | 'verify' {
  if (!Array.isArray(actions)) return 'command';
  for (const action of actions) {
    const type = recordOf(action)?.type;
    if (type === 'read') return 'read';
    if (type === 'search') return 'search';
    if (type === 'verify') return 'verify';
  }
  return 'command';
}

function firstActionFileLabel(actions: unknown): string | undefined {
  if (!Array.isArray(actions)) return undefined;
  for (const action of actions) {
    const record = recordOf(action);
    const label = leafFileLabel(record?.path ?? record?.file ?? record?.name);
    if (label) return label;
  }
  return undefined;
}

function approvalFileLabels(params: Record<string, unknown>): string[] {
  const labels: string[] = [];
  const add = (value: unknown) => {
    const label = leafFileLabel(value);
    if (label && !labels.includes(label) && labels.length < 8) labels.push(label);
  };
  if (Array.isArray(params.commandActions)) {
    for (const action of params.commandActions) {
      const record = recordOf(action);
      add(record?.path);
    }
  }
  add(params.grantRoot);
  return labels;
}

function approvalCommandPreview(actions: unknown, command: unknown): string {
  const fallback = () => safeApprovalText(command, 1_024) ?? 'Run command';
  if (!Array.isArray(actions)) return fallback();
  const summaries = actions.slice(0, 3).flatMap((action) => {
    const record = recordOf(action);
    const label = leafFileLabel(record?.path);
    if (record?.type === 'read') return [`Read${label ? ` ${label}` : ' file'}`];
    if (record?.type === 'listFiles') return [`List files${label ? ` in ${label}` : ''}`];
    if (record?.type === 'search') return [`Search${label ? ` ${label}` : ''}`];
    if (record?.type === 'unknown') {
      const preview = safeApprovalText(record.command, 1_024);
      return preview ? [preview] : [];
    }
    return [];
  });
  return summaries.length > 0 ? summaries.join('; ') : fallback();
}

function simpleApprovalDecisions(value: unknown): CodexSimpleApprovalDecision[] {
  if (!Array.isArray(value)) return [];
  const decisions: CodexSimpleApprovalDecision[] = [];
  for (const candidate of value) {
    if (
      (candidate === 'accept' ||
        candidate === 'acceptForSession' ||
        candidate === 'decline' ||
        candidate === 'cancel') &&
      !decisions.includes(candidate)
    ) {
      decisions.push(candidate);
    }
  }
  return decisions;
}

function requestedPermissionSummary(value: unknown): CodexRequestedPermissionSummary | undefined {
  const profile = recordOf(value);
  if (!profile) return undefined;
  const network = recordOf(profile.network);
  const fileSystem = recordOf(profile.fileSystem);
  return {
    networkRequested: network?.enabled === true,
    fileSystemReadCount: Array.isArray(fileSystem?.read) ? fileSystem.read.length : 0,
    fileSystemWriteCount: Array.isArray(fileSystem?.write) ? fileSystem.write.length : 0,
    fileSystemEntryCount: Array.isArray(fileSystem?.entries) ? fileSystem.entries.length : 0,
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function providerReported(value: unknown): UsageValue<number> | undefined {
  const number = finiteNumber(value);
  return number === undefined ? undefined : { value: number, provenance: 'provider-reported' };
}

function normalizeItem(item: Record<string, unknown>, method: string): ProviderEvent[] {
  const type = item.type;
  const callId = safeIdentifier(item.id);

  if (type === 'agentMessage') {
    const delta = safePublicText(item.text);
    return delta && callId ? [{ type: 'text', delta, mode: 'replace', streamPartId: callId }] : [];
  }

  if (type === 'reasoning') {
    return [];
  }

  if (type === 'commandExecution') {
    const result: Record<string, unknown> = {};
    const exitCode = finiteNumber(item.exitCode);
    const durationMs = finiteNumber(item.durationMs);
    if (exitCode !== undefined) result.exitCode = exitCode;
    if (durationMs !== undefined) result.durationMs = durationMs;
    if (typeof item.aggregatedOutput === 'string' && item.aggregatedOutput.length > 0) {
      result.outputAvailable = true;
    }
    const hasResult = Object.keys(result).length > 0;
    return [
      {
        type: 'tool',
        name: commandToolName(item.commandActions),
        status: toolStatus(item.status ?? (method === 'item/completed' ? 'completed' : 'started')),
        ...(callId ? { callId } : {}),
        ...(firstActionFileLabel(item.commandActions)
          ? { fileLabel: firstActionFileLabel(item.commandActions) }
          : {}),
        ...(hasResult ? { result } : {}),
      },
    ];
  }

  if (type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const firstChange = recordOf(changes[0]);
    return [
      {
        type: 'tool',
        name: 'edit',
        status: toolStatus(item.status ?? (method === 'item/completed' ? 'completed' : 'started')),
        ...(callId ? { callId } : {}),
        ...(leafFileLabel(firstChange?.path)
          ? { fileLabel: leafFileLabel(firstChange?.path) }
          : {}),
        result: {
          changeCount: changes.length,
          diffAvailable: changes.some((change) => Boolean(recordOf(change)?.diff)),
        },
      },
    ];
  }

  if (type === 'collabAgentToolCall' && callId) {
    const operation = safeIdentifier(item.tool) ?? 'task';
    const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
    const states = recordOf(item.agentsStates);
    const ids = receivers.length ? receivers : [undefined];
    return ids.slice(0, 64).map((rawId, index): ProviderEvent => {
      const sessionId = safeIdentifier(rawId);
      const child = sessionId ? recordOf(states?.[sessionId]) : undefined;
      const status = child?.status === 'completed' ? 'done' :
        child?.status === 'errored' ? 'error' :
        child?.status === 'interrupted' || child?.status === 'shutdown' ? 'cancelled' :
        child?.status === 'running' || child?.status === 'pendingInit' ? 'running' : 'unknown';
      return { type: 'tool', name: 'task',
        status: toolStatus(item.status ?? (method === 'item/completed' ? 'completed' : 'started')),
        callId: `${callId}:${index}`, nativeTask: { name: 'Codex agent',
          ...(sessionId ? { sessionId } : {}), currentStep: operation, status,
          ...(safeIdentifier(item.model) ? { modelLabel: safeIdentifier(item.model) } : {}),
        } };
    });
  }

  if (type === 'mcpToolCall' || type === 'dynamicToolCall') {
    const server = safeIdentifier(item.server ?? item.namespace);
    const tool = safeIdentifier(item.tool);
    if (!tool) return [];
    const name = server ? `${server}.${tool}`.slice(0, MAX_IDENTIFIER) : tool;
    return [
      {
        type: 'tool',
        name,
        status: toolStatus(item.status ?? (method === 'item/completed' ? 'completed' : 'started')),
        ...(callId ? { callId } : {}),
      },
    ];
  }

  return [];
}

function normalizeQuestion(message: Record<string, unknown>, params: Record<string, unknown>) {
  const requestId = safeIdentifier(message.id);
  const sessionId = safeIdentifier(params.threadId);
  const turnId = safeIdentifier(params.turnId);
  const itemId = safeIdentifier(params.itemId);
  const rawQuestions = Array.isArray(params.questions) ? params.questions : [];
  if (!requestId || !sessionId || !turnId || !itemId || rawQuestions.length === 0) {
    return projection([{ type: 'error', message: 'Codex returned a malformed question request.' }]);
  }
  if (rawQuestions.some((question) => recordOf(question)?.isSecret === true)) {
    const questionIds = rawQuestions.flatMap((question) => {
      const id = safeIdentifier(recordOf(question)?.id);
      return id ? [id] : [];
    });
    return projection(
      [
        {
          type: 'warning',
          message: 'Codex requested secret input. Use the secure credential setup action.',
        },
      ],
      questionIds.length > 0
        ? [
            {
              type: 'secure_question',
              requestId,
              threadId: sessionId,
              turnId,
              itemId,
              questionIds,
            },
          ]
        : [],
    );
  }

  const questions = rawQuestions.slice(0, 3).flatMap((question) => {
    const record = recordOf(question);
    const id = safeIdentifier(record?.id);
    const header = safePublicText(record?.header, 64);
    const prompt = safePublicText(record?.question, 1_024);
    if (!id || !header || !prompt) return [];
    const options = Array.isArray(record?.options)
      ? record.options.slice(0, 8).flatMap((option) => {
          const optionRecord = recordOf(option);
          const label = safePublicText(optionRecord?.label, 120);
          const description = safePublicText(optionRecord?.description, 512);
          return label && description ? [{ label, description }] : [];
        })
      : [];
    return [
      {
        id,
        header,
        prompt,
        options,
        multiple: false,
        allowCustomAnswer: record?.isOther === true || options.length === 0,
      },
    ];
  });
  if (questions.length === 0) {
    return projection([{ type: 'error', message: 'Codex returned a malformed question request.' }]);
  }

  return projection(
    [
      {
        type: 'question',
        request: {
          id: requestId,
          sessionId,
          questions: questions.map(({ id: _id, ...question }) => question),
          tool: { messageId: turnId, callId: itemId },
        },
      },
    ],
    [
      {
        type: 'question',
        requestId,
        threadId: sessionId,
        turnId,
        itemId,
        questions,
      },
    ],
  );
}

function approvalKind(method: string): CodexApprovalKind | undefined {
  if (method === 'item/commandExecution/requestApproval') {
    return 'command';
  }
  if (method === 'item/fileChange/requestApproval') {
    return 'file_change';
  }
  if (method === 'item/permissions/requestApproval') return 'permissions';
  return undefined;
}

function normalizeApproval(
  message: Record<string, unknown>,
  params: Record<string, unknown>,
  kind: CodexApprovalKind,
) {
  const requestId = safeIdentifier(message.id);
  const threadId = safeIdentifier(params.threadId ?? params.conversationId);
  const turnId = safeIdentifier(params.turnId);
  const itemId = safeIdentifier(params.itemId ?? params.callId ?? params.approvalId);
  if (!requestId || !threadId || !turnId || !itemId) {
    return projection([{ type: 'error', message: 'Codex returned a malformed approval request.' }]);
  }
  const reason = safeApprovalText(params.reason, 512);
  const responseKind = safeIdentifier(params.kind) ?? kind;
  const nativeApprovalId = safeIdentifier(params.approvalId);
  const fileLabels = approvalFileLabels(params);
  const cwdLabel = leafFileLabel(params.cwd);
  const availableDecisions = simpleApprovalDecisions(params.availableDecisions);
  const requestedPermissions = requestedPermissionSummary(
    params.permissions ?? params.additionalPermissions,
  );
  const display: CodexApprovalDisplay = {
    ...(reason ? { reason } : {}),
    action: kind,
    ...(kind === 'command'
      ? { commandPreview: approvalCommandPreview(params.commandActions, params.command) }
      : {}),
    ...(cwdLabel ? { cwdLabel } : {}),
    ...(fileLabels.length > 0 ? { fileLabels } : {}),
    ...(availableDecisions.length > 0 ? { availableDecisions } : {}),
    ...(requestedPermissions ? { requestedPermissions } : {}),
  };
  return projection(
    [],
    [
      {
        type: 'approval',
        kind,
        requestId,
        threadId,
        turnId,
        itemId,
        responseHandle: requestId,
        requestMethod: safeIdentifier(message.method) ?? '',
        responseKind,
        ...(nativeApprovalId ? { nativeApprovalId } : {}),
        display,
      },
    ],
  );
}

export function normalizeCodexThreadBindingResponse(
  value: unknown,
  expectedRequestId: string,
): CodexAppServerProjection {
  const response = recordOf(value);
  if (safeIdentifier(response?.id) !== expectedRequestId) return projection([], [], false);
  const sessionId = safeIdentifier(recordOf(recordOf(response?.result)?.thread)?.id);
  return sessionId
    ? projection([{ type: 'session', sessionId }])
    : projection([{ type: 'error', message: 'Codex returned a malformed thread binding.' }]);
}

function isWithinActiveScope(
  method: string,
  params: Record<string, unknown>,
  options: CodexAppServerProjectionOptions,
): boolean {
  const scope = options.scope;
  if (!scope || scope.activeGeneration !== scope.messageGeneration) return false;
  const threadId = safeIdentifier(params.threadId);
  if (!threadId || threadId !== scope.threadId) return false;
  if (method === 'serverRequest/resolved') return true;
  const turnId =
    safeIdentifier(params.turnId) ??
    (method === 'turn/completed' || method === 'turn/started'
      ? safeIdentifier(recordOf(params.turn)?.id)
      : undefined);
  if (method === 'turn/started') return scope.turnId ? turnId === scope.turnId : Boolean(turnId);
  if (!scope.turnId) return false;
  return turnId === scope.turnId;
}

export function normalizeCodexAppServerMessage(
  value: unknown,
  options: CodexAppServerProjectionOptions = {},
): CodexAppServerProjection {
  const message = recordOf(value);
  const method = safeIdentifier(message?.method);
  const params = recordOf(message?.params) ?? {};
  if (!message || !method) return projection([], [], false);

  if (method === 'thread/started') {
    return projection();
  }
  if (SCOPED_METHODS.has(method) && !isWithinActiveScope(method, params, options)) {
    return projection();
  }
  // Record only protocol methods this projection recognizes. Private reasoning is excluded.
  if (SCOPED_METHODS.has(method) && method !== 'item/reasoning/textDelta') {
    const item = recordOf(params.item);
    appActivityLog.record('codex.event', 'received', {
      method,
      params:
        item?.type === 'reasoning'
          ? {
              threadId: params.threadId,
              turnId: params.turnId,
              item: { id: item.id, type: item.type, summary: item.summary },
            }
          : params,
    });
  }
  if (method === 'turn/started') {
    const threadId = safeIdentifier(params.threadId);
    const turnId = safeIdentifier(recordOf(params.turn)?.id);
    return projection([], threadId && turnId ? [{ type: 'turn_binding', threadId, turnId }] : []);
  }
  if (method === 'item/agentMessage/delta') {
    const delta = safePublicText(params.delta);
    const streamPartId = safeIdentifier(params.itemId);
    return projection(
      delta ? [{ type: 'text', delta, ...(streamPartId ? { streamPartId } : {}) }] : [],
    );
  }
  if (method === 'item/reasoning/summaryTextDelta') {
    const delta = safePublicText(params.delta);
    return projection(delta ? [{ type: 'reasoning', delta }] : []);
  }
  if (method === 'item/reasoning/textDelta') return projection();
  if (method === 'item/plan/delta') {
    const itemId = safeIdentifier(params.itemId);
    const delta = safePublicText(params.delta);
    return projection(
      itemId && delta ? [{ type: 'text', delta, streamPartId: itemId }] : [],
      itemId && delta ? [{ type: 'plan_delta', itemId, delta }] : [],
    );
  }
  if (method === 'item/started' || method === 'item/completed') {
    const item = recordOf(params.item);
    if (item?.type === 'plan') {
      const itemId = safeIdentifier(item.id);
      const text = safePublicText(item.text);
      // Reuse the chat's plan review contract; prose heuristics miss native plans.
      const publicText = method === 'item/completed' && itemId && text
        ? '```jarvis_plan\n' + JSON.stringify({
            id: `codex_plan_${itemId}`, title: 'Review plan', summary: text, steps: [],
          }).replaceAll('`', '\\u0060') + '\n```'
        : text;
      return projection(
        itemId && publicText ? [{ type: 'text', delta: publicText, mode: 'replace', streamPartId: itemId }] : [],
        itemId && text ? [{ type: 'plan_snapshot', itemId, text }] : [],
      );
    }
    return projection(item ? normalizeItem(item, method) : []);
  }
  if (method === 'item/tool/requestUserInput') return normalizeQuestion(message, params);

  const kind = approvalKind(method);
  if (kind) return normalizeApproval(message, params, kind);

  if (method === 'serverRequest/resolved') {
    const requestId = safeIdentifier(params.requestId);
    return projection([], requestId ? [{ type: 'resolved', requestId }] : []);
  }

  if (method === 'thread/tokenUsage/updated') {
    const last = recordOf(recordOf(params.tokenUsage)?.last);
    if (!last) return projection();
    const usage: UsageSnapshot = {
      capturedAt: finiteNumber(options.capturedAt) ?? Date.now(),
      ...(providerReported(last.inputTokens)
        ? { inputTokens: providerReported(last.inputTokens) }
        : {}),
      ...(providerReported(last.cachedInputTokens)
        ? { cacheReadTokens: providerReported(last.cachedInputTokens) }
        : {}),
      ...(providerReported(last.cacheWriteInputTokens)
        ? { cacheWriteTokens: providerReported(last.cacheWriteInputTokens) }
        : {}),
      ...(providerReported(last.outputTokens)
        ? { outputTokens: providerReported(last.outputTokens) }
        : {}),
      ...(providerReported(last.reasoningOutputTokens)
        ? { reasoningTokens: providerReported(last.reasoningOutputTokens) }
        : {}),
      ...(providerReported(last.totalTokens)
        ? { totalTokens: providerReported(last.totalTokens) }
        : {}),
    };
    return projection([{ type: 'usage', usage }]);
  }

  if (method === 'turn/completed') {
    const turn = recordOf(params.turn);
    const status = turn?.status;
    if (status === 'completed') return projection([{ type: 'done', finishReason: 'completed' }]);
    if (status === 'interrupted')
      return projection([{ type: 'done', finishReason: 'interrupted' }]);
    if (status === 'failed') {
      const message = safePublicText(recordOf(turn?.error)?.message, 2_048);
      return projection([{ type: 'error', message: message ?? 'Codex turn failed.' }]);
    }
    return projection([{ type: 'error', message: 'Codex returned an invalid terminal state.' }]);
  }

  if (method === 'error') {
    const message = safePublicText(recordOf(params.error)?.message, 2_048);
    return projection([
      {
        type: 'warning',
        message: message ?? 'Codex app-server reported an error.',
      },
    ]);
  }

  return projection([], [], false);
}
