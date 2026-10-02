import { describe, expect, it, vi } from 'vitest';
import { createRlmRuntime, RlmRuntimeError, type RlmTerminalReceipt } from './rlmRuntime';
import { createContextPointer, createContextRecord } from '@/features/context/losslessContext';

const scope = { accountId: 'terminal-account', projectId: 'terminal-project' };
const executionIdentity = {
  transportConnectionId: 'opencode-cli', transportAdapterId: 'opencode-persistent',
  upstreamProviderId: 'openai', upstreamModelId: 'gpt-6-luna',
  providerQualifiedModelId: 'openai/gpt-6-luna', authBillingRoute: 'opencode-provider-session',
  effort: 'low', fastVariant: 'standard', catalogRevision: 'sha256:' + 'b'.repeat(64),
};
const budget = { maxDepth: 1, maxSubcalls: 1, maxConcurrentSubcalls: 1,
  maxWallTimeMs: 1000, maxToolCalls: 8, maxOpenBytes: 1000 };
function fixture() {
  const record = createContextRecord({ id: 'terminal-record', ...scope, sourceKind: 'file_version',
    sourceId: 'terminal-source', createdAt: 1, contentHash: 'a'.repeat(64),
    contentRef: 'asset://terminal', trustLevel: 'app_verified' });
  const pointer = createContextPointer({ id: 'terminal-pointer', recordId: record.id,
    byteStart: 0, byteEnd: 10, sourceVersion: 'sha256:terminal', contentHash: 'a'.repeat(64) });
  const contextTools = {
    search: vi.fn(async () => ({ items: [{ record, pointer, preview: 'PRIVATE_PREVIEW', score: 1 }],
      truncated: false, indexAvailable: true, stale: false })),
    open: vi.fn(async () => ({ status: 'current' as const, record, pointer, text: 'PRIVATE_EVIDENCE',
      byteStart: 0, byteEnd: 9, lineStart: 1, lineEnd: 1, truncated: false })),
  };
  const childRunner = vi.fn(async () => ({ answer: 'PRIVATE_CHILD_ANSWER', citations: [pointer] }));
  const synthesize = vi.fn(async () => ({ answer: 'PRIVATE_FINAL_ANSWER', citations: [pointer] }));
  const receipts: Readonly<RlmTerminalReceipt>[] = [];
  return { contextTools, childRunner, synthesize, receipts,
    onTerminalReceipt: (receipt: Readonly<RlmTerminalReceipt>) => { receipts.push(receipt); } };
}
const request = { question: 'Find PRIVATE_QUESTION in records', scope, executionIdentity, budget };

describe('actual terminal RLM receipt lifecycle', () => {
  it('publishes one immutable completed receipt matching genuine dependencies without private payloads', async () => {
    const f = fixture(); const result = await createRlmRuntime(f).investigate(request);
    expect(f.receipts).toHaveLength(1);
    const receipt = f.receipts[0]!;
    expect(receipt).toMatchObject({ runId: result.trace.runId, status: 'completed' });
    expect(receipt.trace.toolInvocations).toEqual(result.trace.toolInvocations);
    expect(receipt.endedAt).toBeGreaterThanOrEqual(receipt.startedAt);
    expect(receipt.trace.usage).toEqual(result.trace.usage);
    expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE_|asset:\/\/|terminal-pointer|terminal-record/);
    expect(receipt.trace.events.every(event => !('detail' in event))).toBe(true);
    for (const value of [receipt, receipt.trace, receipt.trace.events, receipt.trace.events[0],
      receipt.trace.toolInvocations, receipt.trace.toolInvocations![0], receipt.trace.usage, receipt.trace.budget]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => Object.assign(receipt.trace.events[0]!, { at: -1 })).toThrow();
  });
  it('retains the actual run ID for cancellation before any dependency starts', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort('PRIVATE_ABORT_REASON');
    await expect(createRlmRuntime(f).investigate({ ...request, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'cancelled' });
    expect(f.receipts).toHaveLength(1);
    expect(f.receipts[0]).toMatchObject({ status: 'cancelled', errorCode: 'cancelled' });
    expect(f.receipts[0]!.runId).toMatch(/^rlm-/);
    expect(f.receipts[0]!.trace.toolInvocations).toEqual([]);
    expect(f.contextTools.search).not.toHaveBeenCalled();
    expect(JSON.stringify(f.receipts)).not.toContain('PRIVATE_ABORT_REASON');
  });
  it('publishes typed failed search with exactly one real invocation', async () => {
    const f = fixture(); f.contextTools.search.mockRejectedValue(new RlmRuntimeError('no_evidence', 'PRIVATE_ERROR'));
    await expect(createRlmRuntime(f).investigate(request)).rejects.toMatchObject({ code: 'no_evidence' });
    expect(f.receipts).toHaveLength(1);
    expect(f.receipts[0]).toMatchObject({ status: 'failed', errorCode: 'no_evidence' });
    expect(f.receipts[0]!.trace.toolInvocations).toHaveLength(1);
    expect(f.receipts[0]!.trace.toolInvocations![0]).toMatchObject({ operation: 'search', status: 'failed' });
    expect(JSON.stringify(f.receipts)).not.toContain('PRIVATE_ERROR');
  });
  it('does not copy arbitrary dependency errors into the trace', async () => {
    const f = fixture(); f.contextTools.search.mockRejectedValue(new Error('PRIVATE_ERROR_WITH_AUTH'));
    await expect(createRlmRuntime(f).investigate(request)).rejects.toThrow('PRIVATE_ERROR_WITH_AUTH');
    expect(f.receipts).toHaveLength(1);
    expect(f.receipts[0]!.status).toBe('failed');
    expect(f.receipts[0]).not.toHaveProperty('errorCode');
    expect(JSON.stringify(f.receipts)).not.toContain('PRIVATE_ERROR_WITH_AUTH');
  });
  it('publishes a real deadline and cancelled pending search without synthetic open calls', async () => {
    const f = fixture(); f.contextTools.search.mockImplementation(() => new Promise(() => {}));
    await expect(createRlmRuntime(f).investigate({ ...request, budget: { ...budget, maxWallTimeMs: 20 } }))
      .rejects.toMatchObject({ code: 'wall_time_exceeded' });
    expect(f.receipts).toHaveLength(1);
    expect(f.receipts[0]).toMatchObject({ status: 'timed_out', errorCode: 'wall_time_exceeded' });
    expect(f.receipts[0]!.trace.toolInvocations).toHaveLength(1);
    expect(f.receipts[0]!.trace.toolInvocations![0]!.status).toBe('cancelled');
    expect(f.contextTools.open).not.toHaveBeenCalled();
  });
  it('preserves a successful answer if the diagnostic sink throws', async () => {
    const f = fixture(); const sink = vi.fn(() => { throw new Error('receipt store full'); });
    const result = await createRlmRuntime({ ...f, onTerminalReceipt: sink }).investigate(request);
    expect(result.answer).toBe('PRIVATE_FINAL_ANSWER');
    expect(sink).toHaveBeenCalledTimes(1);
  });
});
