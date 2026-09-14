import type { AppActivityEvent } from './appActivityLog';

export interface PersistedActivity {
  sequence: number;
  operationId: string;
  kind: string;
  phase: string;
  observedAt: number;
  monotonicMs: number;
  durationMs?: number;
  requestId?: string;
  chatId?: string;
  sessionId?: string;
  callId?: string;
  runId?: string;
  publicationRevision?: number;
  uiCommitMs?: number;
  provider?: string;
  model?: string;
  tool?: string;
  operation?: string;
  eventType?: string;
  resultCode?: string;
  outcome: 'running' | 'success' | 'failure' | 'cancelled' | 'timeout' | 'unknown';
  completeness: 'complete' | 'partial' | 'truncated' | 'unknown';
  hasContinuation?: boolean;
  returnedItems?: number;
  returnedChars?: number;
  diagnosticTruncated?: boolean;
}
export interface DiagnosticBatch {
  schemaVersion: 1;
  rendererInstance: string;
  droppedTotal: number;
  failedBatches: number;
  events: PersistedActivity[];
}
export interface DiagnosticReceipt {
  accepted: number;
  path: string;
}
interface WriterOptions {
  capacity?: number;
  batchSize?: number;
  flushDelayMs?: number;
}
// Fixed-field projection: never stringify or enumerate a tool result to log it.
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field && 'value' in field ? field.value : undefined;
  } catch {
    return undefined;
  }
}
function identifier(value: unknown): string | undefined {
  return typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/.test(value) &&
    !/^(?:sk-|gh[pousr]_|github_pat_|AIza|Bearer)/i.test(value)
    ? value
    : undefined;
}
function numericField(object: unknown, key: string): number | undefined {
  const value = own(object, key);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function field(key: string, ...objects: unknown[]): string | undefined {
  for (const object of objects) {
    const value = identifier(own(object, key));
    if (value) return value;
  }
  return undefined;
}

export function toPersistedActivity(event: AppActivityEvent): PersistedActivity {
  const data = event.data;
  const request = own(data, 'request') ?? data;
  const activity = own(data, 'activity');
  const nativeEvent = own(data, 'event');
  const properties = own(nativeEvent, 'properties');
  const part = own(properties, 'part') ?? own(properties, 'info');
  const state = own(part, 'state');
  const params = own(data, 'params');
  const codexItem = own(params, 'item');
  const codexTurn = own(params, 'turn');
  const codexType = field('type', codexItem);
  const codexTool = [
    'commandExecution',
    'fileChange',
    'mcpToolCall',
    'dynamicToolCall',
    'webSearch',
    'imageView',
  ].includes(codexType ?? '')
    ? codexItem
    : undefined;
  const exitCode = own(codexTool, 'exitCode');
  const commandFailed = typeof exitCode === 'number' && Number.isFinite(exitCode) && exitCode !== 0;
  const method = field('method', data);
  const protocolPhase = ['item/completed', 'turn/completed'].includes(method ?? '')
    ? 'completed'
    : ['item/started', 'turn/started'].includes(method ?? '')
      ? 'started'
      : undefined;
  const args = own(request, 'args') ?? own(state, 'input');
  const result = own(data, 'result');
  const payload = own(result, 'data') ?? result;
  const details = own(activity, 'details');
  const status =
    field('status', activity, state, codexItem, codexTurn) ?? protocolPhase ?? event.phase;
  const outcome: PersistedActivity['outcome'] = /^(cancelled|canceled|aborted)$/.test(status)
    ? 'cancelled'
    : /^(timeout|timed_out)$/.test(status)
      ? 'timeout'
      : own(result, 'ok') === false ||
          own(result, 'isError') === true ||
          commandFailed ||
          /^(failed|error|declined)$/.test(status)
        ? 'failure'
        : status === 'completed'
          ? 'success'
          : /^(started|running|waiting|inProgress|in_progress)$/.test(status)
            ? 'running'
            : 'unknown';
  const hasContinuation =
    typeof own(payload, 'continuation') === 'string' &&
    (own(payload, 'continuation') as string).length > 0;
  const truncated =
    own(payload, 'truncated') === true ||
    own(details, 'outputTruncated') === true ||
    own(result, 'code') === 'response_too_large';
  const completeness = truncated
    ? 'truncated'
    : own(payload, 'partial') === true || hasContinuation
      ? 'partial'
      : own(payload, 'complete') === true
        ? 'complete'
        : 'unknown';
  const text = own(payload, 'text') ?? own(payload, 'content') ?? own(state, 'output');
  const items = own(payload, 'items') ?? own(payload, 'hits') ?? own(payload, 'records');
  return {
    sequence: event.sequence,
    operationId: identifier(event.operationId) ?? 'unavailable',
    kind: identifier(event.kind) ?? 'unknown',
    phase: identifier(event.phase) ?? 'unknown',
    observedAt: event.observedAt,
    monotonicMs: event.monotonicMs,
    durationMs: event.durationMs,
    requestId: field('requestId', request, data, result),
    chatId: field('chatId', request, data),
    runId: field('runId', request, data),
    publicationRevision: numericField(data, 'publicationRevision'),
    uiCommitMs: numericField(data, 'uiCommitMs'),
    sessionId:
      field('sessionId', request, data) ??
      field('sessionID', part, properties) ??
      field('threadId', params),
    callId:
      field('toolCallId', activity, request) ??
      field('callID', part) ??
      field('id', activity, codexTool) ??
      (method?.startsWith('item/commandExecution/') ? field('itemId', params) : undefined),
    provider: field('provider', request, data),
    model: field('model', request, data) ?? field('modelId', request, data),
    tool:
      field('tool', request, part, codexTool) ??
      field('name', activity) ??
      field('type', codexTool),
    operation: field('operation', args),
    eventType: field('type', nativeEvent) ?? field('method', data),
    resultCode: field('code', result),
    outcome,
    completeness,
    hasContinuation,
    returnedItems: Array.isArray(items) ? items.length : undefined,
    // Character count of the observed diagnostic copy, not total source/corpus size.
    returnedChars: typeof text === 'string' ? text.length : undefined,
    diagnosticTruncated:
      typeof own(event, 'diagnosticTruncated') === 'boolean'
        ? (own(event, 'diagnosticTruncated') as boolean)
        : own(data, 'diagnosticTruncated') === true
          ? true
          : undefined,
  };
}

export function createActivityLogWriter(
  sink: (batch: DiagnosticBatch) => Promise<DiagnosticReceipt>,
  options: WriterOptions = {},
) {
  const capacity = Math.max(1, Math.min(2048, Math.floor(options.capacity ?? 512)));
  const batchSize = Math.max(1, Math.min(64, capacity, Math.floor(options.batchSize ?? 64)));
  const delay = Math.max(0, Math.min(5000, options.flushDelayMs ?? 250));
  const rendererInstance = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const queue: PersistedActivity[] = [];
  let pendingWrite: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = 0,
    persisted = 0,
    dropped = 0,
    failedBatches = 0;
  let lastError = '',
    path = '',
    stopped = false;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  function schedule(wait = delay) {
    if (stopped || closing || timer !== undefined || pendingWrite || queue.length === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, wait);
  }
  function flush(): Promise<void> {
    if (pendingWrite) return pendingWrite;
    if (stopped || queue.length === 0) return Promise.resolve();
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const events = queue.splice(0, batchSize);
    const batch: DiagnosticBatch = {
      schemaVersion: 1,
      rendererInstance,
      droppedTotal: dropped,
      failedBatches,
      events,
    };
    inFlight = events.length;
    pendingWrite = Promise.resolve()
      .then(() => sink(batch))
      .then((receipt) => {
        if (receipt.accepted !== events.length || typeof receipt.path !== 'string')
          throw new Error('incomplete_native_acknowledgement');
        persisted += events.length;
        path = receipt.path;
        lastError = '';
      })
      .catch(() => {
        // A failed write may have appended bytes: never retry it and create false duplicates.
        dropped += events.length;
        failedBatches += 1;
        lastError = 'native_write_failed';
      })
      .finally(() => {
        inFlight = 0;
        pendingWrite = undefined;
        schedule(lastError ? 5000 : queue.length >= batchSize ? 0 : delay);
      });
    return pendingWrite;
  }
  return {
    enqueue(event: AppActivityEvent) {
      if (stopped || closing) return;
      if (queue.length >= capacity) {
        dropped += 1;
        return;
      }
      try {
        queue.push(toPersistedActivity(event));
      } catch {
        dropped += 1;
      }
      schedule();
    },
    noteSourceGap(count: number) {
      if (Number.isSafeInteger(count) && count > 0) dropped += count;
    },
    flush,
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      closePromise = (async () => {
        // Unsubscribe before closing. No new events enter this bounded drain;
        // native acknowledgement, not queue removal, determines persistence.
        while (!stopped && (pendingWrite || queue.length > 0)) await flush();
        stopped = true;
      })();
      return closePromise;
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    status: () => ({
      pending: queue.length,
      inFlight,
      persisted,
      dropped,
      failedBatches,
      lastError,
      path,
      stopped,
    }),
  };
}
