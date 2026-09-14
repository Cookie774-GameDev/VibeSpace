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
  function clean(value: unknown): unknown {
    const seen = new WeakSet<object>();
    // Bound traversal before serialization: a post-stringify cap still walks an
    // entire corpus result on the UI thread. Never invoke source getters/toJSON.
    let nodes = 512;
    let remainingChars = 32_000;
    function bounded(entry: unknown, depth = 0): unknown {
      if (nodes-- <= 0 || depth > 8 || remainingChars <= 0) return '[details omitted: limit]';
      if (typeof entry === 'string') {
        const count = Math.min(entry.length, 16_000, remainingChars);
        remainingChars -= count;
        return (
          entry.slice(0, count) +
          (count < entry.length ? ` [${entry.length - count} characters omitted]` : '')
        );
      }
      if (typeof entry === 'bigint') return bounded(String(entry), depth + 1);
      if (typeof entry === 'function' || typeof entry === 'symbol') return '[non-data omitted]';
      if (!entry || typeof entry !== 'object') return entry;
      if (seen.has(entry)) return '[repeated object omitted]';
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
              : '[accessor omitted]',
          );
        }
        if (rows.length < entry.length)
          rows.push(`[${entry.length - rows.length} entries omitted]`);
        return rows;
      }
      const result: Record<string, unknown> = Object.create(null);
      let count = 0;
      for (const key in entry) {
        if (!Object.prototype.hasOwnProperty.call(entry, key)) continue;
        if (count++ >= 64 || nodes <= 0 || remainingChars <= 0) {
          result['[diagnostic limit]'] = '[additional fields omitted]';
          break;
        }
        if (key.length > 256) {
          result['[long field]'] = '[field omitted]';
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
            : '[accessor omitted]';
      }
      return result;
    }
    let text: string;
    try {
      text = JSON.stringify(bounded(value)) ?? 'null';
    } catch {
      return '[unreadable diagnostic details omitted]';
    }
    if (text.length > 64000) {
      const result = applySecretPolicy(text.slice(0, 64000), 'redact');
      return {
        preview: result.findings.length >= 100 ? '[redaction limit]' : result.text,
        truncated: true,
        originalChars: text.length,
      };
    }
    const result = applySecretPolicy(text, 'redact');
    if (result.findings.length >= 100) return '[redaction limit]';
    try {
      return JSON.parse(result.text ?? 'null');
    } catch {
      return '[redacted record]';
    }
  }
  function record(
    kind: string,
    phase: string,
    data: unknown,
    operationId = `${instanceId}:${sequence + 1}`,
    durationMs?: number,
  ) {
    try {
      const event = {
        sequence: ++sequence,
        operationId,
        kind,
        phase,
        observedAt: Date.now(),
        monotonicMs: performance.now(),
        durationMs,
        data: clean(data),
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
  return {
    record,
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
