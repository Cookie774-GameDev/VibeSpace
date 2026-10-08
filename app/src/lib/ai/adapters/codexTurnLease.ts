import { appActivityLog } from '@/lib/diagnostics/appActivityLog';

type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const KEY = 'vibespace.codex-native-generation.v1';

type LeaseKind = 'turn' | 'model-catalog' | 'skills-catalog' | 'mcp-status' | 'unknown';
type LeaseContext = Readonly<{ kind: LeaseKind; requestId?: string }>;
type LeaseIdentity = Readonly<{ leaseId: string; kind: LeaseKind; requestId?: string }>;
export type CodexLeaseDiagnostic = Readonly<LeaseIdentity & {
  phase: 'requested' | 'acquired' | 'released' | 'cancelled' | 'native-bound';
  queueDepth: number;
  durationMs?: number;
  blockedBy?: LeaseIdentity;
  generation?: string;
}>;

/** Only app-generated request correlations, never caller prose or paths. */
export function codexDiagnosticRequestId(value: string | undefined): string | undefined {
  return value && /^jreq_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
    ? value : undefined;
}

/** One native app-server per WebView. Reload recovery never replays a prompt. */
export function createCodexTurnLease(storage?: StoragePort, diagnostics?: {
  record(event: CodexLeaseDiagnostic): void;
  monotonic?(): number;
}) {
  let busy = false;
  const queue: Array<() => void> = [];
  let generation: string | undefined;
  let sequence = 0;
  let activeOwner: LeaseIdentity | undefined;
  const now = (): number | undefined => {
    try {
      const value = diagnostics?.monotonic?.() ?? performance.now();
      return Number.isFinite(value) ? value : undefined;
    } catch { return undefined; }
  };
  const elapsed = (start: number | undefined): number | undefined => {
    const end = now();
    return start !== undefined && end !== undefined && end >= start ? end - start : undefined;
  };
  const record = (event: CodexLeaseDiagnostic): void => {
    try { diagnostics?.record(Object.freeze(event)); } catch { /* Observation cannot change admission. */ }
  };
  return {
    acquire(signal?: AbortSignal, context?: LeaseContext): Promise<() => void> {
      const kind: LeaseKind = context && ['turn', 'model-catalog', 'skills-catalog', 'mcp-status'].includes(context.kind)
        ? context.kind : 'unknown';
      const requestId = codexDiagnosticRequestId(context?.requestId);
      const owner: LeaseIdentity = Object.freeze({
        leaseId: `codex-lease-${++sequence}`, kind, ...(requestId ? { requestId } : {}),
      });
      const requestedAt = now();
      const requested: CodexLeaseDiagnostic = { ...owner, phase: 'requested', queueDepth: queue.length,
        ...(activeOwner ? { blockedBy: activeOwner } : {}),
      };
      let requestRecorded = false;
      const recordRequest = () => {
        if (requestRecorded) return;
        requestRecorded = true;
        record(requested);
      };
      return new Promise((resolve, reject) => {
        let cancellationRecorded = false;
        const abort = () => {
          const index = queue.indexOf(admit);
          if (index >= 0) queue.splice(index, 1);
          recordRequest();
          if (!cancellationRecorded) {
            cancellationRecorded = true;
            record({ ...owner, phase: 'cancelled', queueDepth: queue.length, durationMs: elapsed(requestedAt) });
          }
          reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        const admit = () => {
          signal?.removeEventListener('abort', abort);
          if (signal?.aborted) {
            abort();
            queue.shift()?.();
            return;
          }
          busy = true;
          activeOwner = owner;
          const acquiredAt = now();
          // Stabilize ownership before notifying synchronous observers. A
          // diagnostic subscriber can itself request a lease.
          recordRequest();
          record({ ...owner, phase: 'acquired', queueDepth: queue.length, durationMs: elapsed(requestedAt) });
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            // Keep the slot held while observing release so reentrant callers
            // queue behind existing waiters instead of taking a second owner.
            record({ ...owner, phase: 'released', queueDepth: queue.length, durationMs: elapsed(acquiredAt) });
            busy = false;
            activeOwner = undefined;
            queue.shift()?.();
          });
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener('abort', abort, { once: true });
        if (busy) {
          queue.push(admit);
          recordRequest();
        }
        else admit();
      });
    },
    remember(value: string) {
      generation = value;
      storage?.setItem(KEY, value);
      if (activeOwner && /^codex-generation-[A-Za-z0-9_-]{20}$/u.test(value)) {
        record({ ...activeOwner, phase: 'native-bound', queueDepth: queue.length, generation: value });
      }
    },
    forget(value: string) {
      if (generation === value) generation = undefined;
      if (storage?.getItem(KEY) === value) storage.removeItem(KEY);
    },
    async recover(stop: (generation: string) => Promise<boolean>) {
      const previous = generation ?? storage?.getItem(KEY);
      if (!previous) return;
      if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(previous))
        throw Error('Codex recovery generation is invalid.');
      await stop(previous);
      this.forget(previous);
    },
  };
}
const key = Symbol.for('vibespace.codexTurnLease.v1');
const host = globalThis as typeof globalThis & { [key]?: ReturnType<typeof createCodexTurnLease> };
export const codexTurnLease = (host[key] ??= createCodexTurnLease(
  typeof sessionStorage === 'undefined' ? undefined : sessionStorage,
  { record: (event) => appActivityLog.record(
    'harness.codex.lease', event.phase, {
      ...event,
      callId: event.leaseId,
      eventType: `lease.${event.kind}.${event.phase}`,
      ...(event.generation ? { runtimeGeneration: event.generation } : {}),
      ...(event.blockedBy ? { result: { code: `blocked-by.${event.blockedBy.leaseId}` } } : {}),
    }, event.leaseId, event.durationMs,
  ) },
));
