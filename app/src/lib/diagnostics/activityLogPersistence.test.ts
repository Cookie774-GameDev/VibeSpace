import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppActivityEvent } from './appActivityLog';
import {
  createActivityLogWriter,
  toPersistedActivity,
  type DiagnosticBatch,
} from './activityLogPersistence';

const event = (sequence = 1, data: unknown = {}): AppActivityEvent => ({
  sequence,
  operationId: `test:${sequence}`,
  kind: 'semantic-tool',
  phase: 'completed',
  observedAt: 1_789_344_000_000,
  monotonicMs: 100,
  durationMs: 15,
  data,
});
const receipt = (accepted: number) => ({ accepted, path: 'context-runtime.jsonl' });
afterEach(() => vi.useRealTimers());

describe('metadata-only diagnostic evidence', () => {
  it('preserves correlated tool identity without source text, queries, paths or credentials', () => {
    const row = toPersistedActivity(
      event(1, {
        request: {
          requestId: 'req-1',
          sessionId: 'sess-1',
          tool: 'vibespace_context',
          args: { operation: 'open', query: 'PRIVATE QUESTION' },
          directory: 'PRIVATE PATH',
        },
        result: {
          ok: true,
          code: 'ok',
          data: {
            text: 'PRIVATE SOURCE',
            truncated: true,
            continuation: 'PRIVATE CURSOR',
            password: 'PRIVATE PASSWORD',
          },
        },
      }),
    );
    expect(row).toMatchObject({
      requestId: 'req-1',
      sessionId: 'sess-1',
      tool: 'vibespace_context',
      operation: 'open',
      outcome: 'success',
      completeness: 'truncated',
      hasContinuation: true,
      returnedChars: 14,
    });
    expect(JSON.stringify(row)).not.toContain('PRIVATE');
  });
  it('does not invent completeness from an ok response', () => {
    expect(toPersistedActivity(event(1, { result: { ok: true } })).completeness).toBe('unknown');
    expect(
      toPersistedActivity(event(1, { result: { ok: true } })).diagnosticTruncated,
    ).toBeUndefined();
    expect(toPersistedActivity(event(2, { result: { ok: false } })).outcome).toBe('failure');
  });
  it('retains native event type, call identity and cancellation without persisting payloads', () => {
    const row = toPersistedActivity({
      ...event(),
      kind: 'cli.event',
      phase: 'received',
      data: {
        event: {
          type: 'message.part.updated',
          properties: {
            part: {
              callID: 'call-3',
              sessionID: 'sess-3',
              tool: 'vibespace_context',
              state: {
                status: 'completed',
                input: { operation: 'search', query: 'HIDDEN' },
                output: 'HIDDEN',
              },
            },
          },
        },
      },
    });
    expect(row).toMatchObject({
      eventType: 'message.part.updated',
      callId: 'call-3',
      sessionId: 'sess-3',
      tool: 'vibespace_context',
      operation: 'search',
    });
    expect(JSON.stringify(row)).not.toContain('HIDDEN');
    expect(toPersistedActivity({ ...event(), phase: 'cancelled' }).outcome).toBe('cancelled');
  });
  it('never walks arbitrary arrays or invokes getters during metadata projection', () => {
    let reads = 0;
    const data = {
      get request() {
        reads++;
        throw Error('do not read');
      },
      rows: Array.from({ length: 100_000 }, () => ({
        get text() {
          reads++;
          return 'text';
        },
      })),
    };
    expect(() => toPersistedActivity(event(1, data))).not.toThrow();
    expect(reads).toBe(0);
  });
  it('rejects secret-shaped identifiers and excessive or injected values', () => {
    const row = toPersistedActivity(
      event(1, {
        model: 'sk-proj-do-not-persist',
        chatId: 'line\ninjection',
        requestId: 'x'.repeat(1000),
      }),
    );
    expect(row.model).toBeUndefined();
    expect(row.chatId).toBeUndefined();
    expect(row.requestId).toBeUndefined();
  });
});

describe('bounded non-blocking native writer', () => {
  it('defers disk work and keeps exactly one batch in flight', async () => {
    vi.useFakeTimers();
    let resolve!: (value: ReturnType<typeof receipt>) => void;
    const sink = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      )
      .mockResolvedValue(receipt(1));
    const writer = createActivityLogWriter(sink, { batchSize: 2, capacity: 4 });
    writer.enqueue(event(1));
    writer.enqueue(event(2));
    writer.enqueue(event(3));
    expect(sink).not.toHaveBeenCalled();
    const pending = writer.flush();
    await Promise.resolve();
    expect(sink).toHaveBeenCalledTimes(1);
    void writer.flush();
    writer.enqueue(event(4));
    expect(sink).toHaveBeenCalledTimes(1);
    expect(writer.status()).toMatchObject({ pending: 2, inFlight: 2, persisted: 0 });
    resolve(receipt(2));
    await pending;
    expect(writer.status().persisted).toBe(2);
    writer.stop();
  });
  it('accounts for buffer overflow explicitly in the next durable batch', async () => {
    vi.useFakeTimers();
    const sink = vi.fn().mockResolvedValue(receipt(2));
    const writer = createActivityLogWriter(sink, { capacity: 2, batchSize: 2 });
    for (let i = 1; i <= 10; i++) writer.enqueue(event(i));
    expect(writer.status()).toMatchObject({ pending: 2, dropped: 8 });
    await writer.flush();
    expect(sink.mock.calls[0][0]).toMatchObject({ droppedTotal: 8 });
    writer.stop();
  });
  it('does not silently acknowledge failed or partial writes, and never retries an ambiguous batch', async () => {
    vi.useFakeTimers();
    const sink = vi
      .fn()
      .mockRejectedValueOnce(new Error('PRIVATE DISK ERROR'))
      .mockResolvedValueOnce(receipt(0))
      .mockResolvedValueOnce(receipt(1));
    const writer = createActivityLogWriter(sink);
    writer.enqueue(event(1));
    await writer.flush();
    expect(writer.status()).toMatchObject({
      persisted: 0,
      dropped: 1,
      failedBatches: 1,
      lastError: 'persistence_uncertain',
      lastFailure: { kind: 'persistence_uncertain', firstSequence: 1, lastSequence: 1 },
    });
    writer.enqueue(event(2));
    await writer.flush();
    expect(writer.status()).toMatchObject({ persisted: 0, dropped: 2, failedBatches: 2 });
    writer.enqueue(event(3));
    await writer.flush();
    expect(writer.status()).toMatchObject({ persisted: 1, dropped: 2, failedBatches: 2 });
    expect(sink.mock.calls[2][0]).toMatchObject({ droppedTotal: 2, failedBatches: 2 });
    expect(JSON.stringify(writer.status())).not.toContain('PRIVATE');
    writer.stop();
  });
  it('distinguishes a deterministic schema rejection from an uncertain append failure', async () => {
    vi.useFakeTimers();
    const sink = vi.fn().mockRejectedValue(new Error('diagnostics_invalid_metadata'));
    const writer = createActivityLogWriter(sink);
    writer.enqueue(event(21));
    await writer.flush();
    expect(writer.status()).toMatchObject({
      persisted: 0,
      dropped: 1,
      failedBatches: 1,
      lastError: 'diagnostics_schema_rejected',
      lastFailure: { kind: 'schema_rejection', firstSequence: 21, lastSequence: 21 },
    });
    writer.stop();
  });

  it('flushes quiet traffic on a timer, and stops without pretending pending data was persisted', async () => {
    vi.useFakeTimers();
    const sink = vi.fn().mockResolvedValue(receipt(1));
    const writer = createActivityLogWriter(sink, { flushDelayMs: 50 });
    writer.enqueue(event());
    await vi.advanceTimersByTimeAsync(49);
    expect(sink).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(writer.status().persisted).toBe(1);
    writer.enqueue(event(2));
    writer.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(writer.status()).toMatchObject({ pending: 1, persisted: 1, stopped: true });
  });
});

it('retains renderer timing and log clipping separately from source completeness', () => {
  const observed = {
    ...event(9, {
      requestId: 'r9',
      runId: 'run9',
      chatId: 'c9',
      publicationRevision: 27,
      coalescedRevisions: 2,
      uiCommitMs: 4.5,
    }),
    kind: 'ui.preview',
    phase: 'committed',
    diagnosticTruncated: true,
  };
  expect(toPersistedActivity(observed)).toMatchObject({
    publicationRevision: 27,
    coalescedRevisions: 2,
    uiCommitMs: 4.5,
    runId: 'run9',
    diagnosticTruncated: true,
    completeness: 'unknown',
  });
});

it('drains every queued batch exactly once during graceful close', async () => {
  vi.useFakeTimers();
  const sink = vi.fn(async (batch: DiagnosticBatch) => ({
    accepted: batch.events.length,
    path: 'context-runtime.jsonl',
  }));
  const writer = createActivityLogWriter(sink, { batchSize: 2, capacity: 8 });
  for (let i = 1; i <= 5; i++) writer.enqueue(event(i));
  expect(writer.close).toBeTypeOf('function');
  const closing = writer.close();
  writer.enqueue(event(6));
  await closing;
  expect(sink).toHaveBeenCalledTimes(3);
  expect(sink.mock.calls.flatMap(([batch]) => batch.events.map((row) => row.sequence))).toEqual([
    1, 2, 3, 4, 5,
  ]);
  expect(writer.status()).toMatchObject({ persisted: 5, pending: 0, inFlight: 0, stopped: true });
  await writer.close();
  expect(sink).toHaveBeenCalledTimes(3);
});

describe('actual producer envelope correlation', () => {
  it('captures Codex tool and turn lifecycle identifiers without copying command/output', () => {
    const tool = toPersistedActivity({
      ...event(31),
      kind: 'codex.event',
      phase: 'received',
      data: {
        method: 'item/completed',
        params: {
          threadId: 'thread31',
          turnId: 'turn31',
          item: {
            id: 'call31',
            type: 'commandExecution',
            status: 'completed',
            command: 'PRIVATE COMMAND',
            aggregatedOutput: 'PRIVATE OUTPUT',
            exitCode: 0,
          },
        },
      },
    });
    expect(tool).toMatchObject({
      sessionId: 'thread31',
      callId: 'call31',
      eventType: 'item/completed',
      tool: 'commandExecution',
      outcome: 'success',
    });
    expect(JSON.stringify(tool)).not.toContain('PRIVATE');
    const completed = toPersistedActivity({
      ...event(32),
      kind: 'codex.event',
      phase: 'received',
      data: {
        method: 'turn/completed',
        params: { threadId: 'thread31', turn: { id: 'turn31', status: 'failed' } },
      },
    });
    expect(completed).toMatchObject({ sessionId: 'thread31', outcome: 'failure' });
  });
  it('retains modelId from actual preparation events', () => {
    expect(
      toPersistedActivity(
        event(33, {
          request: {
            chatId: 'chat33',
            requestId: 'req33',
            modelId: 'openai/gpt-5.6-luna',
          },
        }),
      ),
    ).toMatchObject({ model: 'openai/gpt-5.6-luna', requestId: 'req33' });
  });
  it('does not interpret an uninspected diagnostic copy as known not clipped', () => {
    expect(toPersistedActivity(event()).diagnosticTruncated).toBeUndefined();
    expect(toPersistedActivity({ ...event(), diagnosticTruncated: false })).toMatchObject({
      diagnosticTruncated: false,
    });
    expect(toPersistedActivity({ ...event(), diagnosticTruncated: true })).toMatchObject({
      diagnosticTruncated: true,
      completeness: 'unknown',
    });
  });
});

it('does not inflate tool counts with Codex prose, and retains nonzero command exits as failures', () => {
  const prose = toPersistedActivity({
    ...event(),
    kind: 'codex.event',
    phase: 'received',
    data: {
      method: 'item/completed',
      params: { item: { id: 'prose1', type: 'agentMessage', text: 'PRIVATE' } },
    },
  });
  expect(prose.tool).toBeUndefined();
  expect(prose.callId).toBeUndefined();
  const command = toPersistedActivity({
    ...event(),
    kind: 'codex.event',
    phase: 'received',
    data: {
      method: 'item/completed',
      params: { item: { id: 'cmd1', type: 'commandExecution', status: 'completed', exitCode: 1 } },
    },
  });
  expect(command).toMatchObject({ callId: 'cmd1', tool: 'commandExecution', outcome: 'failure' });
});


describe('nested Codex tool result envelopes', () => {
  const completedTool = (item: Record<string, unknown>): AppActivityEvent => ({
    ...event(),
    kind: 'codex.event',
    phase: 'received',
    data: {
      method: 'item/completed',
      params: {
        threadId: 'thread-nested',
        item: { id: 'call-nested', type: 'mcpToolCall', tool: 'vibespace_context', status: 'completed', ...item },
      },
    },
  });

  it.each([
    { result: { isError: true, content: [{ type: 'text', text: 'PRIVATE FAILURE' }] } },
    { error: { message: 'PRIVATE ERROR' } },
  ])('does not mistake protocol completion for tool success: %j', (item) => {
    const row = toPersistedActivity(completedTool(item));
    expect(row).toMatchObject({ callId: 'call-nested', outcome: 'failure' });
    expect(JSON.stringify(row)).not.toContain('PRIVATE');
  });

  it('retains nested operation and partial-result metadata without copying content', () => {
    const row = toPersistedActivity(completedTool({
      arguments: { operation: 'open', query: 'PRIVATE QUERY' },
      result: { ok: true, data: { partial: true, continuation: 'PRIVATE CURSOR', items: [1, 2], text: 'PRIVATE SOURCE' } },
    }));
    expect(row).toMatchObject({ operation: 'open', completeness: 'partial', hasContinuation: true, returnedItems: 2 });
    expect(JSON.stringify(row)).not.toContain('PRIVATE');
  });

  it('keeps a successful result with unknown completeness unknown', () => {
    expect(toPersistedActivity(completedTool({ error: null, result: { isError: false } })))
      .toMatchObject({ outcome: 'success', completeness: 'unknown' });
  });

  it('does not consume result or argument fields from assistant prose', () => {
    const row = toPersistedActivity(completedTool({ type: 'agentMessage', arguments: { operation: 'open' }, result: { isError: true } }));
    expect(row.operation).toBeUndefined();
    expect(row.outcome).toBe('success');
    expect(row.tool).toBeUndefined();
  });
});


describe('A8F1 public lifecycle projection regressions', () => {
  it('preserves the actual callId across richer start updates and completion', () => {
    const rows = ['started', 'started', 'completed'].map((status, index) =>
      toPersistedActivity({
        ...event(500 + index), kind: 'model.tool', phase: status,
        data: { requestId: 'req-a8f1', chatId: 'chat-a8f1', activity: {
          callId: 'opencode-tool-1', toolCallId: 'legacy-alias', name: 'read', status,
          ...(index ? { details: { arguments: { filePath: 'PRIVATE PATH' } } } : {}),
        } },
      }),
    );
    expect(rows.map(row => row.callId)).toEqual(Array(3).fill('opencode-tool-1'));
    expect(rows.map(row => row.outcome)).toEqual(['running', 'running', 'success']);
    expect(new Set(rows.map(row => `${row.requestId}:${row.callId}`)).size).toBe(1);
    expect(JSON.stringify(rows)).not.toContain('PRIVATE');
  });

  it.each([-1, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'does not emit an out-of-contract optional numeric value: %s', invalid => {
      const row = toPersistedActivity({ ...event(510, {
        publicationRevision: invalid, coalescedRevisions: invalid, uiCommitMs: invalid,
      }), durationMs: invalid });
      expect(row.publicationRevision).toBeUndefined();
      expect(row.coalescedRevisions).toBeUndefined();
      expect(row.uiCommitMs).toBeUndefined();
      expect(row.durationMs).toBeUndefined();
    },
  );

  it('preserves zero, finite timing and the upper safe bound', () => {
    expect(toPersistedActivity(event(511, {
      publicationRevision: Number.MAX_SAFE_INTEGER, coalescedRevisions: 0, uiCommitMs: 0.125,
    }))).toMatchObject({ publicationRevision: Number.MAX_SAFE_INTEGER, coalescedRevisions: 0, uiCommitMs: 0.125 });
  });

  it('never fabricates an absent or credential-shaped callId', () => {
    expect(toPersistedActivity(event(512, { activity: { name: 'read' } })).callId).toBeUndefined();
    expect(toPersistedActivity(event(513, { activity: { callId: 'github_pat_private' } })).callId).toBeUndefined();
  });
});
