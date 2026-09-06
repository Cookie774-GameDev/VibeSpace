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

/** Local diagnostic evidence only. Never allows a recording failure to fail an operation. */
export function createActivityRecorder(capacity = 2000) {
  const events: AppActivityEvent[] = [];
  let sequence = 0;
  const active = new Map<string, AppActivityEvent>();
  const instanceId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  function clean(value: unknown): unknown {
    const seen = new WeakSet<object>();
    const text =
      JSON.stringify(value, (key, entry) => {
        if (
          /(?:secret|password|passwd|authorization|cookie|credential|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|cancellationKey)/i.test(
            key,
          ) ||
          key === 'token'
        )
          return '[redacted]';
        if (typeof entry === 'string' && entry.length > 16000)
          return (
            entry.slice(0, 16000) + `\n[truncated: ${entry.length - 16000} characters omitted]`
          );
        if (typeof entry === 'bigint') return String(entry);
        if (entry instanceof Error) return { name: entry.name, message: entry.message };
        if (entry && typeof entry === 'object') {
          if (seen.has(entry)) return '[repeated object omitted]';
          seen.add(entry);
        }
        return entry;
      }) ?? 'null';
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
      if (['completed', 'failed', 'stream_closed'].includes(phase)) active.delete(operationId);
      if (active.size > 100) active.delete(active.keys().next().value!);
      if (events.length > capacity) events.splice(0, events.length - capacity);
    } catch {
      /* Diagnostics must never alter model/tool behavior. */
    }
    return operationId;
  }
  return {
    record,
    snapshot(after = 0) {
      return {
        instanceId,
        sequence,
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
        const failed =
          result && typeof result === 'object' && 'ok' in result && result.ok === false;
        record(
          kind,
          failed ? 'failed' : 'completed',
          { request: data, result },
          id,
          performance.now() - start,
        );
        return result;
      } catch (error) {
        record(kind, 'failed', { request: data, error }, id, performance.now() - start);
        throw error;
      }
    },
  };
}

export const appActivityLog = createActivityRecorder();
