import { describe, expect, it, vi } from 'vitest';
import { createRlmRuntime, RlmRuntimeError } from './rlmRuntime';
import { createContextPointer, createContextRecord } from '@/features/context/losslessContext';
import type { ContextOpenResult, ContextSearchItem } from '@/features/context/contextQueryService';

const scope = { accountId: 'receipt-account', projectId: 'receipt-project' };
const identity = {
  transportConnectionId: 'opencode-cli', transportAdapterId: 'opencode-persistent',
  upstreamProviderId: 'openai', upstreamModelId: 'gpt-6-luna',
  providerQualifiedModelId: 'openai/gpt-6-luna', authBillingRoute: 'opencode-provider-session',
  effort: 'low', fastVariant: 'standard', catalogRevision: 'sha256:' + 'b'.repeat(64),
  observedProviderIdentity: 'openai/gpt-6-luna',
};
const budget = { maxDepth: 1, maxSubcalls: 1, maxConcurrentSubcalls: 1,
  maxWallTimeMs: 1000, maxToolCalls: 8, maxOpenBytes: 1000 };
function fixture() {
  const record = createContextRecord({ id: 'receipt-record', ...scope, sourceKind: 'file_version',
    sourceId: 'receipt-source', createdAt: 1, contentHash: 'a'.repeat(64),
    contentRef: 'asset://receipt', trustLevel: 'app_verified' });
  const pointer = createContextPointer({ id: 'receipt-pointer', recordId: record.id,
    byteStart: 0, byteEnd: 10, sourceVersion: 'sha256:receipt', contentHash: 'a'.repeat(64) });
  const item: ContextSearchItem = { record, pointer, preview: 'safe fixture', score: 1 };
  const opened: ContextOpenResult = { status: 'current', record, pointer, text: 'safe text',
    byteStart: 0, byteEnd: 9, lineStart: 1, lineEnd: 1, truncated: false };
  const contextTools = { search: vi.fn(async () => ({ items: [item], truncated: false,
    indexAvailable: true, stale: false })), open: vi.fn(async () => opened) };
  const childRunner = vi.fn(async () => ({ answer: 'safe', citations: [pointer] }));
  const synthesize = vi.fn(async () => ({ answer: 'safe', citations: [pointer] }));
  return { item, opened, contextTools, childRunner, synthesize };
}
describe('real RLM dependency receipts', () => {
  it.each([false, true])('records exactly the real search and selected open/expand calls (expand=%s)', async (expand) => {
    const f = fixture();
    const expansion = vi.fn(async () => f.opened);
    const runtime = createRlmRuntime({ ...f, contextTools: { ...f.contextTools,
      ...(expand ? { expand: expansion } : {}) } });
    const result = await runtime.investigate({ question: 'Find the safe source', scope,
      executionIdentity: identity, budget });
    const calls = result.trace.toolInvocations!;
    expect(calls.map(call => call.operation)).toEqual(['search', expand ? 'expand' : 'open']);
    expect(calls).toHaveLength(f.contextTools.search.mock.calls.length +
      f.contextTools.open.mock.calls.length + expansion.mock.calls.length);
    expect(new Set(calls.map(call => call.id)).size).toBe(calls.length);
    for (const call of calls) {
      expect(call.runId).toBe(result.trace.runId);
      expect(call.id).toMatch(new RegExp('^' + result.trace.runId + ':tool-\\d+$'));
      expect(call.status).toBe('completed');
      expect(call.finishedAt).toBeGreaterThanOrEqual(call.startedAt);
      expect(Object.isFrozen(call)).toBe(true);
      expect(Object.keys(call)).not.toContain('query');
    }
    expect(Object.isFrozen(calls)).toBe(true);
  });
  it('retains completed retrieval receipts when child execution is unavailable', async () => {
    const f = fixture();
    f.childRunner.mockRejectedValue(new RlmRuntimeError('execution_route_unavailable'));
    const runtime = createRlmRuntime(f);
    const error = await runtime.investigate({ question: 'Find source', scope,
      executionIdentity: identity, budget }).catch(error => error as RlmRuntimeError);
    if (!(error instanceof RlmRuntimeError)) throw new Error('Expected route failure');
    expect(error.code).toBe('execution_route_unavailable');
    expect(error.toolInvocations!.map((call: {status: string}) => call.status))
      .toEqual(['completed', 'completed']);
  });
  it('does not count a cancelled-before-start request as a real tool invocation', async () => {
    const f = fixture();
    const controller = new AbortController(); controller.abort();
    const error = await createRlmRuntime(f).investigate({ question: 'Find source', scope,
      executionIdentity: identity, budget, signal: controller.signal }).catch(error => error as RlmRuntimeError);
    if (!(error instanceof RlmRuntimeError)) throw new Error('Expected cancellation');
    expect(error.code).toBe('cancelled');
    expect(error.toolInvocations).toEqual([]);
    expect(f.contextTools.search).not.toHaveBeenCalled();
  });
  it('records cancellation of an actual pending search once, without fictitious open calls', async () => {
    const f = fixture(); const controller = new AbortController();
    f.contextTools.search.mockImplementationOnce(async () => {
      controller.abort(); throw new Error('cancelled safe fixture');
    });
    const error = await createRlmRuntime(f).investigate({ question: 'Find source', scope,
      executionIdentity: identity, budget, signal: controller.signal }).catch(error => error as RlmRuntimeError);
    if (!(error instanceof RlmRuntimeError)) throw new Error('Expected cancellation');
    expect(error.code).toBe('cancelled');
    expect(error.toolInvocations).toHaveLength(1);
    expect(error.toolInvocations![0]).toMatchObject({ operation: 'search', status: 'cancelled' });
    expect(f.contextTools.open).not.toHaveBeenCalled();
  });
});
