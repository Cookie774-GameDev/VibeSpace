import { applySecretPolicy } from '@/lib/security/secretDetector';
import { mergePublicToolDetails, publicToolDetails } from '@/lib/ai/publicToolDetails';
import type { PublicToolDetails } from '@/lib/ai/adapters/types';
import type { Message } from '@/types';
import type { ChatActivityEvent, ChatActivityStatus } from '../activity/types';

export const MAX_LEDGER_RECEIPTS = 500;

export type LedgerReceiptKind =
  | 'read'
  | 'search'
  | 'command'
  | 'edit'
  | 'check'
  | 'subagent'
  | 'other';
export type UsageProvenance = 'exact' | 'estimated' | 'unavailable';

export type LedgerUsageValue = Readonly<{
  value: number | null;
  provenance: UsageProvenance;
  source: 'response-metadata' | 'provider-reported' | 'local-estimate' | 'unavailable';
}>;

export type AssistantActivityReceipt = Readonly<{
  id: string;
  kind: LedgerReceiptKind;
  label: string;
  status: ChatActivityStatus;
  ts: number;
  durationMs?: number;
  filePath?: string;
  fileLabel?: string;
  /** Sanitized public operation detail. Never contains raw tool results or environment data. */
  detail?: string;
  toolDetails?: Readonly<import('@/lib/ai/adapters/types').PublicToolDetails>;
  /** Sanitized provider tool identity, shown only in the expanded receipt. */
  toolName?: string;
  /** Stable, display-only call identity; never an execution authority. */
  callId?: string;
  /** MCP/plugin server attribution derived from an explicit tool identity. */
  plugin?: string;
  /** MCP server attribution for the generic mcp_run bridge. */
  mcpServer?: string;
  agentSlug?: string;
  countsAsAction: boolean;
}>;

export type AssistantActivityLedgerProjection = Readonly<{
  status: 'idle' | 'running' | 'done' | 'cancelled' | 'error';
  currentOperation?: string;
  actionsTotal: number;
  readsTotal: number;
  searchesTotal: number;
  commandsTotal: number;
  editedFilesTotal: number;
  verifiedChecksTotal: number;
  failedChecksTotal: number;
  subagentsTotal: number;
  usage: Readonly<{ input: LedgerUsageValue; output: LedgerUsageValue }>;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  receipts: readonly AssistantActivityReceipt[];
  omittedReceipts: number;
}>;

const COMMAND_TOOL = /(?:^|[._:/-])(shell|terminal|command|exec|powershell|bash)(?:$|[._:/-])/i;
const READ_TOOL = /(?:^|[._:/-])(read|open|get_file|file_read)(?:$|[._:/-])/i;
const SEARCH_TOOL = /(?:^|[._:/-])(search|find|grep|glob|query)(?:$|[._:/-])/i;
const EDIT_TOOL = /(?:^|[._:/-])(edit|write|patch|apply_patch|replace)(?:$|[._:/-])/i;
const CHECK_TOOL = /(?:^|[._:/-])(test|verify|check|lint|build)(?:$|[._:/-])/i;
const SUBAGENT_TOOL = /(?:^|[._:/-])(subagent|agent_spawn|spawn_agent|delegate)(?:$|[._:/-])/i;

function safeText(value: string, max = 4096): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const redacted = applySecretPolicy(normalized, 'redact').text ?? '';
  return redacted.slice(0, max);
}

function safeFileLabel(filePath: string): string {
  const leaf = filePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? '';
  return safeText(leaf, 256) || 'File';
}

function correlatedToolFileLabel(
  kind: LedgerReceiptKind,
  args: Record<string, unknown>,
): string | undefined {
  if (kind !== 'read' && kind !== 'edit') return undefined;
  const candidate = args.path ?? args.filePath ?? args.file_path;
  return typeof candidate === 'string' && candidate.trim().length > 0
    ? safeFileLabel(candidate)
    : undefined;
}

function safeCommandDetail(args: Record<string, unknown>): string | undefined {
  const value = args.command ?? args.cmd ?? args.script;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (/\b(?:private|secret|password|passphrase|token|api[_-]?key|credential)\b/iu.test(value)) {
    return undefined;
  }
  return safeText(value, 1_024) || undefined;
}

function messageReceiptDetail(
  kind: LedgerReceiptKind,
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  if (kind === 'command') return safeCommandDetail(args);
  if (kind === 'read' || kind === 'edit') return undefined;
  return safeText(tool, 256) || undefined;
}

function pluginAttribution(
  tool: string,
  args?: Record<string, unknown>,
): Readonly<{ plugin?: string; mcpServer?: string }> {
  const normalizedTool = tool.trim();
  const pluginBridge = /^plugins?(?:__|[.:/_-])(?:list|run)$/iu.test(normalizedTool);
  const pluginId = args?.pluginId ?? args?.plugin_id;
  if (pluginBridge && typeof pluginId === 'string' && pluginId.trim()) {
    return { plugin: safeText(pluginId, 128) || undefined };
  }

  // Generic bridge names are dispatchers, not plugin/server identities.
  if (/^mcp(?:__|[.:/_-])run$/iu.test(normalizedTool)) {
    const connectionId = args?.connectionId ?? args?.connection_id;
    return {
      mcpServer:
        typeof connectionId === 'string' && connectionId.trim()
          ? safeText(connectionId, 128) || 'MCP server'
          : 'MCP server',
    };
  }

  const pluginMatch = normalizedTool.match(/^plugins?(?:__|[.:/_-])([^.:/_-]+)(?:[.:/_-]|$)/iu);
  if (pluginMatch?.[1] && !/^(?:list|run)$/iu.test(pluginMatch[1])) {
    return { plugin: safeText(pluginMatch[1], 128) || undefined };
  }
  const mcpMatch = normalizedTool.match(/^mcp(?:__|[.:/])([^.:/_]+)(?:[.:/_]|$)/iu);
  if (mcpMatch?.[1] && !/^run$/iu.test(mcpMatch[1])) {
    return { mcpServer: safeText(mcpMatch[1], 128) || undefined };
  }
  return {};
}

function publicAttributionArguments(details: Readonly<PublicToolDetails> | undefined): Record<string, unknown> {
  let value: unknown = details?.arguments;
  if (typeof value === 'string' && value.length <= 16_384) {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function messageToolDetails(
  args: Record<string, unknown>,
  result: Extract<Message['parts'][number], { kind: 'tool_result' }> | undefined,
  existing: Readonly<PublicToolDetails> | undefined,
): Readonly<PublicToolDetails> {
  const evidence = result ? resultEvidence(result.result) : undefined;
  const generated = publicToolDetails({
    arguments: args,
    ...(result?.result === undefined ? {} : { result: result.result }),
    ...(result?.error === undefined ? {} : { error: result.error }),
    ...(evidence?.durationMs === undefined ? {} : { durationMs: evidence.durationMs }),
  });
  return existing ? mergePublicToolDetails(existing, generated) : generated;
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function toolKind(tool: string): LedgerReceiptKind {
  if (SUBAGENT_TOOL.test(tool)) return 'subagent';
  if (COMMAND_TOOL.test(tool)) return 'command';
  if (READ_TOOL.test(tool)) return 'read';
  if (SEARCH_TOOL.test(tool)) return 'search';
  if (EDIT_TOOL.test(tool)) return 'edit';
  if (CHECK_TOOL.test(tool)) return 'check';
  return 'other';
}

function activityKind(event: ChatActivityEvent): LedgerReceiptKind {
  if (event.kind === 'diff') return 'edit';
  if (event.kind === 'url') return 'search';
  if (event.kind === 'subagent') return 'subagent';
  if (event.kind === 'file') return 'read';
  if (event.kind === 'tool' && event.category === 'file') return 'read';
  if (event.kind === 'tool' && event.category === 'writing') return 'edit';
  if (event.kind === 'tool') {
    if (/\bterminal\b/iu.test(event.title)) return 'command';
    if (event.subtitle?.trim()) return toolKind(event.subtitle);
  }
  return 'other';
}

function receiptLabel(kind: LedgerReceiptKind, status: ChatActivityStatus): string {
  const lifecycle = <T extends string>(labels: Record<ChatActivityStatus, T>): T => labels[status];
  if (kind === 'command')
    return lifecycle({
      pending: 'Command queued',
      running: 'Running command',
      done: 'Ran command',
      cancelled: 'Command cancelled',
      error: 'Command failed',
    });
  if (kind === 'read')
    return lifecycle({
      pending: 'File read queued',
      running: 'Reading file',
      done: 'Read file',
      cancelled: 'File read cancelled',
      error: 'File read failed',
    });
  if (kind === 'search')
    return lifecycle({
      pending: 'Search queued',
      running: 'Searching',
      done: 'Searched',
      cancelled: 'Search cancelled',
      error: 'Search failed',
    });
  if (kind === 'edit')
    return lifecycle({
      pending: 'Edit queued',
      running: 'Editing file',
      done: 'Edited file',
      cancelled: 'Edit cancelled',
      error: 'Edit failed',
    });
  if (kind === 'check')
    return lifecycle({
      pending: 'Check queued',
      running: 'Checking',
      done: 'Verified check',
      cancelled: 'Check cancelled',
      error: 'Check failed',
    });
  if (kind === 'subagent')
    return lifecycle({
      pending: 'Subagent queued',
      running: 'Starting subagent',
      done: 'Subagent finished',
      cancelled: 'Subagent cancelled',
      error: 'Subagent failed',
    });
  return lifecycle({
    pending: 'Activity queued',
    running: 'Activity running',
    done: 'Completed activity',
    cancelled: 'Activity cancelled',
    error: 'Activity failed',
  });
}

function eventReceiptLabel(event: ChatActivityEvent, kind: LedgerReceiptKind): string {
  if (kind !== 'edit') return receiptLabel(kind, event.status);
  const creating = /\b(?:creat(?:e|ed|ing)|new file)\b/i.test(event.title);
  if (!creating) return receiptLabel(kind, event.status);
  return {
    pending: 'File creation queued',
    running: 'Creating file',
    done: 'Created file',
    cancelled: 'File creation cancelled',
    error: 'File creation failed',
  }[event.status];
}

function resultEvidence(result: unknown): { status: ChatActivityStatus; durationMs?: number } {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { status: 'done' };
  const record = result as Record<string, unknown>;
  const rawExitCode = record.exitCode ?? record.exit_code ?? record.code;
  const exitCode =
    typeof rawExitCode === 'number' && Number.isFinite(rawExitCode) ? rawExitCode : undefined;
  const durationMs = positive(record.durationMs ?? record.duration_ms ?? record.elapsed_ms);
  return {
    status: exitCode !== undefined && exitCode !== 0 ? 'error' : 'done',
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function messageReceipts(message: Message): AssistantActivityReceipt[] {
  const seenCallIds = new Set<string>();
  const toolCallCounts = new Map<string, number>();
  const latestToolCalls = new Map<
    string,
    Extract<Message['parts'][number], { kind: 'tool_call' }>
  >();
  for (const part of message.parts) {
    if (part.kind === 'tool_call') {
      toolCallCounts.set(part.call_id, (toolCallCounts.get(part.call_id) ?? 0) + 1);
      latestToolCalls.set(part.call_id, part);
    }
  }
  const canonicalToolCallIds = new Set(
    message.parts.flatMap((part) => (part.kind === 'tool_call' ? [part.call_id] : [])),
  );
  const results = new Map(
    message.parts.flatMap((part) =>
      part.kind === 'tool_result' ? [[part.call_id, part] as const] : [],
    ),
  );
  return message.parts.flatMap((part, index) => {
    if (part.kind === 'action_proposal' && !canonicalToolCallIds.has(part.call_id)) {
      if (seenCallIds.has(part.call_id)) return [];
      seenCallIds.add(part.call_id);
      const kind = toolKind(part.action_id);
      const status: ChatActivityStatus =
        part.status === 'success'
          ? 'done'
          : part.status === 'error'
            ? 'error'
            : part.status === 'cancelled'
              ? 'cancelled'
              : part.status === 'pending'
                ? 'pending'
                : 'running';
      const fileLabel = correlatedToolFileLabel(kind, part.params);
      const detail = messageReceiptDetail(kind, part.action_id, part.params);
      return [
        {
          id: `message:${String(message.id)}:action:${part.call_id}`,
          kind,
          label: receiptLabel(kind, status),
          status,
          ts: message.created_at + index / 1000,
          toolName: safeText(part.action_id, 256) || undefined,
          callId: safeText(part.call_id, 256) || undefined,
          ...pluginAttribution(part.action_id, part.params),
          toolDetails: publicToolDetails({ arguments: part.params }),
          ...(fileLabel ? { fileLabel } : {}),
          ...(detail ? { detail } : {}),
          countsAsAction: true,
        },
      ];
    }
    if (part.kind !== 'tool_call') return [];
    if (seenCallIds.has(part.call_id)) return [];
    seenCallIds.add(part.call_id);
    const canonicalPart = latestToolCalls.get(part.call_id) ?? part;
    const kind = toolKind(canonicalPart.tool);
    const result = results.get(part.call_id);
    const evidence = result
      ? result.error
        ? { status: 'error' as const }
        : resultEvidence(result.result)
      : { status: 'running' as const };
    const fileLabel = correlatedToolFileLabel(kind, canonicalPart.args);
    const detail =
      toolCallCounts.get(part.call_id) === 1
        ? messageReceiptDetail(kind, canonicalPart.tool, canonicalPart.args)
        : undefined;
    return [
      {
        id: `message:${String(message.id)}:tool:${part.call_id}`,
        kind,
        label: receiptLabel(kind, evidence.status),
        toolName: safeText(canonicalPart.tool, 256) || undefined,
        callId: safeText(part.call_id, 256) || undefined,
        ...pluginAttribution(canonicalPart.tool, {
          ...publicAttributionArguments(canonicalPart.details),
          ...canonicalPart.args,
        }),
        toolDetails: messageToolDetails(canonicalPart.args, result, canonicalPart.details),
        status: evidence.status,
        ts: message.created_at + index / 1000,
        ...(evidence.durationMs === undefined ? {} : { durationMs: evidence.durationMs }),
        ...(fileLabel ? { fileLabel } : {}),
        ...(detail ? { detail } : {}),
        countsAsAction: true,
      },
    ];
  });
}

type LatestEventCollection = Readonly<{
  values: Iterable<ChatActivityEvent>;
  newestFirst: boolean;
}>;

function latestEvents(events: readonly ChatActivityEvent[]): LatestEventCollection {
  let ordered = true;
  let previous: ChatActivityEvent | undefined;
  for (const event of events) {
    if (previous && compareEvents(previous, event) > 0) {
      ordered = false;
      break;
    }
    previous = event;
  }
  if (ordered) {
    return {
      newestFirst: true,
      values: {
        *[Symbol.iterator]() {
          const seen = new Set<string>();
          for (let index = events.length - 1; index >= 0; index -= 1) {
            const event = events[index];
            if (seen.has(event.id)) continue;
            seen.add(event.id);
            yield event;
          }
        },
      },
    };
  }

  const latestById = new Map<string, ChatActivityEvent>();
  for (const event of events) {
    const current = latestById.get(event.id);
    if (!current || event.ts >= current.ts) latestById.set(event.id, event);
  }
  return { values: latestById.values(), newestFirst: false };
}

function compareEvents(left: ChatActivityEvent, right: ChatActivityEvent): number {
  return left.ts - right.ts || left.id.localeCompare(right.id);
}

function pushRecentEvent(heap: ChatActivityEvent[], event: ChatActivityEvent): void {
  if (heap.length < MAX_LEDGER_RECEIPTS) {
    heap.push(event);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareEvents(heap[parent], heap[index]) <= 0) break;
      [heap[parent], heap[index]] = [heap[index], heap[parent]];
      index = parent;
    }
    return;
  }
  if (compareEvents(event, heap[0]) <= 0) return;
  heap[0] = event;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let smallest = index;
    if (left < heap.length && compareEvents(heap[left], heap[smallest]) < 0) smallest = left;
    if (right < heap.length && compareEvents(heap[right], heap[smallest]) < 0) smallest = right;
    if (smallest === index) break;
    [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
    index = smallest;
  }
}

function eventReceipt(event: ChatActivityEvent): AssistantActivityReceipt {
  const kind = activityKind(event);
  const toolName = event.subtitle?.trim() ? safeText(event.subtitle, 256) : undefined;
  const durationMs =
    event.endedAt !== undefined
      ? Math.max(0, event.endedAt - (event.startedAt ?? event.ts))
      : undefined;
  return {
    id: `activity:${event.id}`,
    kind,
    label: eventReceiptLabel(event, kind),
    ...(event.toolDetails ? { toolDetails: event.toolDetails } : {}),
    ...(toolName ? { toolName } : {}),
    ...(event.providerCallId ? { callId: safeText(event.providerCallId, 256) } : {}),
    ...(toolName ? pluginAttribution(toolName) : {}),
    status: event.status,
    ts: event.ts,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(event.filePath
      ? { filePath: event.filePath, fileLabel: safeFileLabel(event.filePath) }
      : {}),
    ...(event.agentSlug ? { agentSlug: safeText(event.agentSlug, 256) } : {}),
    ...(event.detail?.trim() ? { detail: safeText(event.detail, 1_024) } : {}),
    countsAsAction: true,
  };
}

function usage(message: Message): AssistantActivityLedgerProjection['usage'] {
  const exact = !message.usage?.provenance;
  const exactInput = exact ? positive(message.usage?.input_tokens) : undefined;
  const exactOutput = exact ? positive(message.usage?.output_tokens) : undefined;
  const estimatedOutput =
    message.usage?.provenance === 'estimated' ? positive(message.usage.output_tokens) : undefined;
  let estimatedInput =
    message.usage?.provenance === 'estimated' ? positive(message.usage.input_tokens) : undefined;
  let reportedInput: number | undefined;
  let reportedOutput: number | undefined;
  for (const part of message.parts) {
    if (part.kind !== 'token_optimization_receipt') continue;
    estimatedInput = positive(part.receipt.estimatedInputTokensAfter) ?? estimatedInput;
    reportedInput = positive(part.usage?.actualInputTokens) ?? reportedInput;
    reportedOutput = positive(part.usage?.actualOutputTokens) ?? reportedOutput;
  }
  const inputValue = exactInput ?? reportedInput ?? estimatedInput;
  const outputValue = exactOutput ?? reportedOutput ?? estimatedOutput;
  return {
    input:
      inputValue === undefined
        ? { value: null, provenance: 'unavailable', source: 'unavailable' }
        : exactInput !== undefined
          ? { value: inputValue, provenance: 'exact', source: 'response-metadata' }
          : reportedInput !== undefined
            ? { value: inputValue, provenance: 'exact', source: 'provider-reported' }
            : { value: inputValue, provenance: 'estimated', source: 'local-estimate' },
    output:
      outputValue === undefined
        ? { value: null, provenance: 'unavailable', source: 'unavailable' }
        : exactOutput !== undefined
          ? { value: outputValue, provenance: 'exact', source: 'response-metadata' }
          : reportedOutput !== undefined
            ? { value: outputValue, provenance: 'exact', source: 'provider-reported' }
            : { value: outputValue, provenance: 'estimated', source: 'local-estimate' },
  };
}

export function projectAssistantActivityLedger(
  message: Message,
  explicitlyCorrelatedEvents: readonly ChatActivityEvent[] = [],
): AssistantActivityLedgerProjection {
  if (message.role !== 'assistant') {
    return {
      status: 'idle',
      actionsTotal: 0,
      readsTotal: 0,
      searchesTotal: 0,
      commandsTotal: 0,
      editedFilesTotal: 0,
      verifiedChecksTotal: 0,
      failedChecksTotal: 0,
      subagentsTotal: 0,
      usage: {
        input: { value: null, provenance: 'unavailable', source: 'unavailable' },
        output: { value: null, provenance: 'unavailable', source: 'unavailable' },
      },
      startedAt: message.created_at,
      receipts: [],
      omittedReceipts: 0,
    };
  }
  const fromMessage = messageReceipts(message);
  const messageHasCommand = fromMessage.some((receipt) => receipt.kind === 'command');
  const eventsById = latestEvents(explicitlyCorrelatedEvents);
  let recentEvents: ChatActivityEvent[] = [];
  let eventsAreChronological = true;
  let previousEvent: ChatActivityEvent | undefined;
  const editedFiles = new Set<string>();
  const subagents = new Set<string>();
  const completedReads = new Set<string>();
  let actionsTotal = 0;
  let searchesTotal = 0;
  let commandsTotal = 0;
  let verifiedChecksTotal = 0;
  let failedChecksTotal = 0;
  let eventReceiptCount = 0;
  let startedAt = message.created_at;
  let latestEvidenceEnd: number | undefined;
  let latestRunningEvent: ChatActivityEvent | undefined;
  let hasEventError = false;
  let hasEventCancelled = false;
  for (const event of eventsById.values) {
    const kind = activityKind(event);
    if (kind === 'command' && messageHasCommand) continue;
    const actionable =
      kind !== 'other' ||
      (event.kind === 'tool' &&
        (Boolean(event.subtitle) ||
          event.title === 'Jarvis tool activity' ||
          event.title === 'Jarvis terminal activity'));
    if (actionable) {
      eventReceiptCount += 1;
      actionsTotal += 1;
    }
    if (kind === 'read' && event.status === 'done') completedReads.add(event.filePath ?? event.id);
    if (kind === 'search') searchesTotal += 1;
    if (kind === 'command') commandsTotal += 1;
    if (kind === 'edit') editedFiles.add(event.filePath ?? event.id);
    if (kind === 'check' && event.status === 'done') verifiedChecksTotal += 1;
    if (kind === 'check' && event.status === 'error') failedChecksTotal += 1;
    if (kind === 'subagent' && (event.status === 'running' || event.status === 'done'))
      subagents.add(`activity:${event.id}`);
    if (
      (event.status === 'running' || event.status === 'pending') &&
      (!latestRunningEvent || compareEvents(event, latestRunningEvent) > 0)
    ) {
      latestRunningEvent = event;
    }
    hasEventError ||= event.status === 'error';
    hasEventCancelled ||= event.status === 'cancelled';
    startedAt = Math.min(startedAt, event.startedAt ?? event.ts);
    const eventEnd =
      event.endedAt ??
      (event.status === 'done' || event.status === 'cancelled' || event.status === 'error'
        ? event.ts
        : undefined);
    if (eventEnd !== undefined) {
      latestEvidenceEnd = Math.max(latestEvidenceEnd ?? eventEnd, eventEnd);
    }
    if (actionable) {
      if (eventsById.newestFirst) {
        if (recentEvents.length < MAX_LEDGER_RECEIPTS) recentEvents.push(event);
      } else if (
        eventsAreChronological &&
        (!previousEvent || compareEvents(previousEvent, event) <= 0)
      ) {
        recentEvents.push(event);
        if (recentEvents.length >= MAX_LEDGER_RECEIPTS * 2) {
          recentEvents = recentEvents.slice(-MAX_LEDGER_RECEIPTS);
        }
      } else {
        if (eventsAreChronological) {
          const chronologicalTail = recentEvents.slice(-MAX_LEDGER_RECEIPTS);
          recentEvents = [];
          for (const retainedEvent of chronologicalTail)
            pushRecentEvent(recentEvents, retainedEvent);
          eventsAreChronological = false;
        }
        pushRecentEvent(recentEvents, event);
      }
      previousEvent = event;
    }
  }
  for (const receipt of fromMessage) {
    if (receipt.countsAsAction) actionsTotal += 1;
    if (receipt.kind === 'read' && receipt.status === 'done')
      completedReads.add(receipt.filePath ?? receipt.id);
    if (receipt.kind === 'search') searchesTotal += 1;
    if (receipt.kind === 'command') commandsTotal += 1;
    if (receipt.kind === 'edit' && receipt.filePath) editedFiles.add(receipt.filePath);
    if (receipt.kind === 'edit' && !receipt.filePath) editedFiles.add(receipt.id);
    if (receipt.kind === 'check' && receipt.status === 'done') verifiedChecksTotal += 1;
    if (receipt.kind === 'check' && receipt.status === 'error') failedChecksTotal += 1;
    if (receipt.kind === 'subagent' && (receipt.status === 'running' || receipt.status === 'done'))
      subagents.add(receipt.id);
  }
  const allReceipts = [
    ...fromMessage,
    ...(eventsById.newestFirst
      ? recentEvents
      : eventsAreChronological
        ? recentEvents.slice(-MAX_LEDGER_RECEIPTS)
        : recentEvents
    )
      .sort(compareEvents)
      .map(eventReceipt),
  ]
    .sort((left, right) => left.ts - right.ts || left.id.localeCompare(right.id))
    .slice(-MAX_LEDGER_RECEIPTS);
  const running = allReceipts
    .filter((receipt) => receipt.status === 'running' || receipt.status === 'pending')
    .at(-1);
  const hasError = hasEventError || fromMessage.some((receipt) => receipt.status === 'error');
  const hasCancelled =
    hasEventCancelled || fromMessage.some((receipt) => receipt.status === 'cancelled');
  const hasAnswer = message.parts.some(
    (part) => part.kind === 'text' && part.text.trim().length > 0,
  );
  const status =
    running || latestRunningEvent
      ? 'running'
      : hasError
        ? 'error'
        : hasCancelled
          ? 'cancelled'
          : hasAnswer || allReceipts.length || explicitlyCorrelatedEvents.length > 0
            ? 'done'
            : 'idle';
  const terminal = status === 'done' || status === 'cancelled' || status === 'error';
  const terminalEndedAt = terminal
    ? Math.max(message.updated_at, latestEvidenceEnd ?? message.updated_at)
    : undefined;
  return {
    status,
    ...(running
      ? { currentOperation: running.label }
      : latestRunningEvent
        ? {
            currentOperation: eventReceiptLabel(
              latestRunningEvent,
              activityKind(latestRunningEvent),
            ),
          }
        : {}),
    actionsTotal,
    readsTotal: completedReads.size,
    searchesTotal,
    commandsTotal,
    editedFilesTotal: editedFiles.size,
    verifiedChecksTotal,
    failedChecksTotal,
    subagentsTotal: subagents.size,
    usage: usage(message),
    startedAt,
    ...(terminalEndedAt === undefined
      ? {}
      : { endedAt: terminalEndedAt, durationMs: Math.max(0, terminalEndedAt - startedAt) }),
    receipts: allReceipts,
    omittedReceipts: Math.max(0, fromMessage.length + eventReceiptCount - allReceipts.length),
  };
}
