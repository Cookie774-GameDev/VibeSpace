import { applySecretPolicy } from '@/lib/security/secretDetector';

export interface AppActivityEvent {
  sequence: number;
  operationId: string;
  kind: string;
  phase: string;
  observedAt: number;
  monotonicMs: number;
  durationMs?: number;
  data: unknown;
  /** Whether this diagnostic copy omitted data; not source/tool completeness. */
  diagnosticTruncated?: boolean;
}

type ActivityListener = (event: AppActivityEvent) => void | Promise<void>;

function ownData(value: unknown, key: string): unknown {
  try {
    if (!value || typeof value !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

const generatedCorrelationPatterns = [
  ['requestId', /^jreq_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u],
  ['runId', /^jrun_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u],
] as const;

function retainGeneratedCorrelation(source: unknown, sanitized: unknown): void {
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) return;
  // Only app-generated UUID-v4 correlation fields at known envelope positions
  // may survive a generic entropy false-positive. Never undo credential redaction
  // or exempt matching strings inside tool results, prompts, or arbitrary text.
  for (const [key, pattern] of generatedCorrelationPatterns) {
    const value = ownData(source, key);
    if (
      typeof value === 'string' &&
      pattern.test(value) &&
      ownData(sanitized, key) === '[redacted:high_entropy_candidate]'
    )
      (sanitized as Record<string, unknown>)[key] = value;
  }
}

function failurePhase(error: unknown): 'failed' | 'cancelled' | 'timed_out' {
  const rawCode = ownData(error, 'code');
  const code = typeof rawCode === 'string' ? rawCode : '';
  let name = ownData(error, 'name');
  try {
    if (error instanceof Error || error instanceof DOMException) name ??= error.name;
  } catch {
    /* observational only */
  }
  if (
    name === 'AbortError' ||
    ['cancelled', 'canceled', 'aborted', 'ABORT_ERR'].includes(String(code))
  )
    return 'cancelled';
  if (
    name === 'TimeoutError' ||
    ['timed_out', 'timeout', 'wall_time_exceeded', 'ETIMEDOUT'].includes(String(code))
  )
    return 'timed_out';
  return 'failed';
}

/** Local diagnostic evidence only. Never allows a recording failure to fail an operation. */
export function createActivityRecorder(capacity = 2000) {
  const events: AppActivityEvent[] = [];
  let sequence = 0;
  let listenerFailures = 0;
  const listeners = new Set<ActivityListener>();
  const active = new Map<string, AppActivityEvent>();
  const instanceId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  function clean(value: unknown): { data: unknown; diagnosticTruncated: boolean } {
    const seen = new WeakSet<object>();
    let diagnosticTruncated = false;
    const omitted = (value: unknown): unknown => {
      diagnosticTruncated = true;
      return value;
    };
    const finish = (data: unknown) => ({ data, diagnosticTruncated });
    // Bound traversal before serialization: a post-stringify cap still walks an
    // entire corpus result on the UI thread. Never invoke source getters/toJSON.
    let nodes = 512;
    let remainingChars = 32_000;
    function bounded(entry: unknown, depth = 0): unknown {
      if (nodes-- <= 0 || depth > 8 || remainingChars <= 0)
        return omitted('[details omitted: limit]');
      if (typeof entry === 'string') {
        const count = Math.min(entry.length, 16_000, remainingChars);
        remainingChars -= count;
        if (count < entry.length) diagnosticTruncated = true;
        return (
          entry.slice(0, count) +
          (count < entry.length ? ` [${entry.length - count} characters omitted]` : '')
        );
      }
      if (typeof entry === 'bigint') return bounded(String(entry), depth + 1);
      if (typeof entry === 'function' || typeof entry === 'symbol')
        return omitted('[non-data omitted]');
      if (!entry || typeof entry !== 'object') return entry;
      if (seen.has(entry)) return omitted('[repeated object omitted]');
      seen.add(entry);
      if (entry instanceof Error)
        return bounded(
          { name: entry.name, message: entry.message, code: ownData(entry, 'code') },
          depth + 1,
        );
      if (Array.isArray(entry)) {
        const rows: unknown[] = [];
        const count = Math.min(entry.length, 64);
        for (let i = 0; i < count && nodes > 0 && remainingChars > 0; i += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(entry, String(i));
          rows.push(
            descriptor && 'value' in descriptor
              ? bounded(descriptor.value, depth + 1)
              : omitted('[accessor omitted]'),
          );
        }
        if (rows.length < entry.length)
          rows.push(omitted(`[${entry.length - rows.length} entries omitted]`));
        return rows;
      }
      const result: Record<string, unknown> = Object.create(null);
      let count = 0;
      for (const key in entry) {
        if (!Object.prototype.hasOwnProperty.call(entry, key)) continue;
        if (count++ >= 64 || nodes <= 0 || remainingChars <= 0) {
          result['[diagnostic limit]'] = omitted('[additional fields omitted]');
          break;
        }
        if (key.length > 256) {
          result['[long field]'] = omitted('[field omitted]');
          continue;
        }
        remainingChars -= key.length;
        if (
          /(?:secret|password|passwd|authorization|cookie|credential|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|cancellationKey)/i.test(
            key,
          ) ||
          key === 'token'
        ) {
          result[key] = '[redacted]';
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(entry, key);
        result[key] =
          descriptor && 'value' in descriptor
            ? bounded(descriptor.value, depth + 1)
            : omitted('[accessor omitted]');
      }
      return result;
    }
    let text: string;
    try {
      text = JSON.stringify(bounded(value)) ?? 'null';
    } catch {
      return finish(omitted('[unreadable diagnostic details omitted]'));
    }
    if (text.length > 64000) {
      const result = applySecretPolicy(text.slice(0, 64000), 'redact');
      diagnosticTruncated = true;
      return finish({
        preview: result.findings.length >= 100 ? '[redaction limit]' : result.text,
        truncated: true,
        originalChars: text.length,
      });
    }
    const result = applySecretPolicy(text, 'redact');
    if (result.findings.length >= 100) return finish(omitted('[redaction limit]'));
    try {
      const sanitized: unknown = JSON.parse(result.text ?? 'null');
      retainGeneratedCorrelation(value, sanitized);
      retainGeneratedCorrelation(ownData(value, 'request'), ownData(sanitized, 'request'));
      return finish(sanitized);
    } catch {
      return finish(omitted('[redacted record]'));
    }
  }
  function appendEvent(
    kind: string,
    phase: string,
    operationId: string,
    observedAt: number,
    monotonicMs: number,
    data: unknown,
    diagnosticTruncated: boolean,
    durationMs?: number,
  ): string {
    try {
      const event: AppActivityEvent = {
        sequence: ++sequence,
        operationId,
        kind,
        phase,
        observedAt,
        monotonicMs,
        durationMs,
        data,
        diagnosticTruncated,
      };
      events.push(event);
      if (
        phase === 'started' &&
        ['model', 'harness', 'semantic-tool', 'terminal-command', 'cli.prompt-http'].includes(kind)
      )
        active.set(operationId, event);
      if (
        [
          'completed',
          'failed',
          'stream_closed',
          'cancelled',
          'canceled',
          'aborted',
          'timed_out',
          'wall_time_exceeded',
        ].includes(phase)
      )
        active.delete(operationId);
      if (active.size > 100) active.delete(active.keys().next().value!);
      if (events.length > capacity) events.splice(0, events.length - capacity);
      for (const listener of listeners) {
        try {
          const pending = listener(event);
          if (pending)
            void pending.catch(() => {
              listenerFailures += 1;
            });
        } catch {
          listenerFailures += 1;
        }
      }
    } catch {
      /* Diagnostics must never alter model/tool behavior. */
    }
    return operationId;
  }

  function record(
    kind: string,
    phase: string,
    data: unknown,
    operationId = `${instanceId}:${sequence + 1}`,
    durationMs?: number,
  ) {
    // Capture ingress before bounded diagnostic formatting so this timestamp is
    // about observation, not the cost of redaction or metadata projection.
    const observedAt = Date.now();
    const monotonicMs = performance.now();
    try {
      const diagnostic = clean(data);
      return appendEvent(
        kind,
        phase,
        operationId,
        observedAt,
        monotonicMs,
        diagnostic.data,
        diagnostic.diagnosticTruncated,
        durationMs,
      );
    } catch {
      return operationId;
    }
  }

  /**
   * Fast path for locally constructed, already-bounded primitive metadata.
   * It deliberately rejects raw provider text, nested objects and sensitive
   * field names instead of recursively sanitizing them on the streaming path.
   */
  function recordMetadata(
    kind: string,
    phase: string,
    data: Readonly<Record<string, string | number | boolean | null | undefined>>,
    operationId = `${instanceId}:${sequence + 1}`,
    durationMs?: number,
  ) {
    const observedAt = Date.now();
    const monotonicMs = performance.now();
    try {
      const safe: Record<string, string | number | boolean | null> = Object.create(null);
      let diagnosticTruncated = false;
      let count = 0;
      for (const key of Object.keys(data)) {
        if (count++ >= 32) {
          diagnosticTruncated = true;
          break;
        }
        if (
          key.length > 128 ||
          /(?:secret|password|passwd|authorization|cookie|credential|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|cancellationKey)/i.test(
            key,
          ) ||
          key === 'token'
        ) {
          diagnosticTruncated = true;
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(data, key);
        if (!descriptor || !('value' in descriptor)) {
          diagnosticTruncated = true;
          continue;
        }
        const value = descriptor.value;
        if (value === undefined) continue;
        if (typeof value === 'string') {
          if (
            value.length > 512 ||
            /[\u0000-\u001f\u007f]/u.test(value) ||
            !/^[A-Za-z0-9][A-Za-z0-9._:@/+\- ]{0,511}$/u.test(value)
          ) {
            safe[key] = '[metadata omitted]';
            diagnosticTruncated = true;
            continue;
          }
          safe[key] = value;
          continue;
        }
        if (
          value === null ||
          typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value))
        ) {
          safe[key] = value;
          continue;
        }
        diagnosticTruncated = true;
      }
      return appendEvent(
        kind,
        phase,
        operationId,
        observedAt,
        monotonicMs,
        safe,
        diagnosticTruncated,
        durationMs,
      );
    } catch {
      return operationId;
    }
  }
  return {
    record,
    recordMetadata,
    subscribe(listener: ActivityListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot(after = 0) {
      return {
        instanceId,
        sequence,
        listenerFailures,
        active: [...active.values()],
        dropped: Math.max(0, (events[0]?.sequence ?? 1) - after - 1),
        events: events.filter((event) => event.sequence > after),
      };
    },
    async trace<T>(kind: string, data: unknown, action: () => Promise<T>): Promise<T> {
      const start = performance.now();
      const id = record(kind, 'started', data);
      try {
        const result = await action();
        const failed = ownData(result, 'ok') === false || ownData(result, 'isError') === true;
        record(
          kind,
          failed ? failurePhase(result) : 'completed',
          { request: data, result },
          id,
          performance.now() - start,
        );
        return result;
      } catch (error) {
        record(kind, failurePhase(error), { request: data, error }, id, performance.now() - start);
        throw error;
      }
    },
  };
}

// The native log viewer and Vite HMR can import different module URLs. All
// instrumentation in one renderer must write to the same bounded recorder.
const recorderKey = Symbol.for('vibespace.appActivityLog.v1');
const renderer = globalThis as typeof globalThis & {
  [recorderKey]?: ReturnType<typeof createActivityRecorder>;
};
export const appActivityLog = (renderer[recorderKey] ??= createActivityRecorder());
