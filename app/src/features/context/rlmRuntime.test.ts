import { describe, expect, it, vi } from 'vitest';
import type { ContextOpenResult, ContextSearchItem, ContextScope } from './contextQueryService';
import { createContextPointer, createContextRecord } from './losslessContext';
import {
  RlmRuntimeError,
  createRlmRuntime,
  type RlmBudget,
  type RlmChildRequest,
  type RlmSynthesisRequest,
} from './rlmRuntime';

const HASH = 'a'.repeat(64);
const scope: ContextScope = { accountId: 'account-1', projectId: 'project-1' };

function searchItem(id: string): ContextSearchItem {
  const record = createContextRecord({
    id,
    accountId: scope.accountId,
    projectId: scope.projectId,
    sourceKind: 'file_version',
    sourceId: `source-${id}`,
    createdAt: 1,
    contentHash: HASH,
    contentRef: `asset://${id}`,
    trustLevel: 'app_verified',
  });
  return {
    record,
    pointer: createContextPointer({
      id: `pointer-${id}`,
      recordId: id,
      byteStart: 0,
      byteEnd: 20,
      sourceVersion: 'sha256:aaaaaaaa',
      contentHash: HASH,
    }),
    preview: `preview ${id}`,
    score: 1,
  };
}

function openResult(
  item: ContextSearchItem,
  text = `evidence ${item.record.id}`,
): ContextOpenResult {
  return {
    status: 'current',
    record: item.record,
    pointer: item.pointer,
    text,
    byteStart: 0,
    byteEnd: new TextEncoder().encode(text).length,
    lineStart: 1,
    lineEnd: 1,
    truncated: false,
  };
}

const budget: RlmBudget = {
  maxDepth: 1,
  maxSubcalls: 4,
  maxConcurrentSubcalls: 2,
  maxInputTokens: 2_000,
  maxOutputTokens: 500,
  maxWallTimeMs: 5_000,
  maxToolCalls: 8,
  maxOpenBytes: 1_000,
};

function tools(items: ContextSearchItem[]) {
  return {
    search: vi.fn(async () => ({ items, truncated: false, indexAvailable: true, stale: false })),
    open: vi.fn(async ({ pointer }: { pointer: { recordId: string } }) => {
      const item = items.find((candidate) => candidate.record.id === pointer.recordId);
      if (!item) throw new Error('missing fixture');
      return openResult(item);
    }),
  };
}

describe('RLM runtime', () => {
  it('runs root search -> selected evidence -> bounded local Ollama children -> root synthesis', async () => {
    const items = [searchItem('one'), searchItem('two'), searchItem('three')];
    const contextTools = tools(items);
    const childRunner = vi.fn(async (request: RlmChildRequest) => ({
      answer: `analysis:${request.evidence.map((item) => item.pointer.recordId).join(',')}`,
      citations: request.evidence.map((item) => item.pointer),
    }));
    const synthesize = vi.fn(async (request: RlmSynthesisRequest) => ({
      answer: request.childAnalyses.map((item) => item.answer).join('|'),
      citations: request.childAnalyses.flatMap((item) => item.citations),
    }));
    const runtime = createRlmRuntime({
      contextTools,
      childRunner,
      synthesize,
      partitionSize: 1,
    });

    const result = await runtime.investigate({
      question: 'Explain the cross-source sequence',
      scope,
      budget,
    });

    expect(childRunner).toHaveBeenCalledTimes(3);
    for (const [request] of childRunner.mock.calls) {
      expect(request.provider).toBe('ollama');
      expect(request.model).toBe('llama3.2:latest');
      expect(request.evidence).toHaveLength(1);
      expect(request.question).toBe('Explain the cross-source sequence');
      expect(request.depth).toBe(1);
    }
    expect(result.answer).toContain('analysis:one');
    expect(result.citations).toHaveLength(3);
    expect(result.trace.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'root_started',
        'search_completed',
        'child_completed',
        'synthesized',
      ]),
    );
    expect(result.trace.mode).toBe('rlm');
    expect(result.trace.runId).toMatch(/^rlm-/u);
    expect(result.trace.wallTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.trace.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'search_completed',
          detail: expect.stringContaining('strategy=exact_anchor'),
        }),
        expect.objectContaining({
          type: 'child_started',
          detail: expect.stringContaining('provider=ollama model=llama3.2:latest'),
        }),
      ]),
    );
  });

  it('uses the exact bracketed source anchor as the lexical retrieval query', async () => {
    const item = searchItem('anchored');
    const contextTools = tools([item]);
    const runtime = createRlmRuntime({
      contextTools,
      childRunner: vi.fn(async () => ({ answer: 'exact', citations: [item.pointer] })),
      synthesize: vi.fn(async () => ({ answer: 'exact', citations: [item.pointer] })),
    });

    await runtime.investigate({
      question:
        'Find the unique passage containing [talk ceased and all eyes were fixed on\nKutúzov]. Return the next words.',
      scope,
      budget,
    });

    expect(contextTools.search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: '"talk ceased and all eyes were fixed on Kutúzov"',
      }),
    );
  });

  it('enforces subcall, concurrency, tool-call, and open-byte budgets', async () => {
    const items = Array.from({ length: 8 }, (_, index) => searchItem(String(index)));
    const contextTools = tools(items);
    let active = 0;
    let peak = 0;
    const childRunner = vi.fn(async (request: RlmChildRequest) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return { answer: request.evidence[0]?.text ?? '', citations: [] };
    });
    const runtime = createRlmRuntime({
      contextTools,
      childRunner,
      synthesize: vi.fn(async () => ({ answer: 'bounded', citations: [] })),
      partitionSize: 1,
    });

    const result = await runtime.investigate({
      question: 'bounded',
      scope,
      budget: {
        ...budget,
        maxSubcalls: 2,
        maxConcurrentSubcalls: 1,
        maxToolCalls: 4,
        maxOpenBytes: 20,
      },
    });

    expect(childRunner).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
    expect(contextTools.open.mock.calls.length).toBeLessThanOrEqual(3);
    expect(result.trace.usage.subcalls).toBe(2);
    expect(result.trace.usage.openBytes).toBeLessThanOrEqual(20);
    expect(result.trace.budgetExhausted).toBe(true);
  });

  it('allows bounded depth-two follow-up only when the budget explicitly permits it', async () => {
    const item = searchItem('one');
    const childRunner = vi.fn(async (request: RlmChildRequest) => ({
      answer: `depth-${request.depth}`,
      citations: [item.pointer],
      followups: request.depth === 1 ? ['Verify exact punctuation'] : ['must-not-run'],
    }));
    const runtime = createRlmRuntime({
      contextTools: tools([item]),
      childRunner,
      synthesize: vi.fn(async (request: RlmSynthesisRequest) => ({
        answer: request.childAnalyses.map((analysis) => analysis.answer).join(','),
        citations: [item.pointer],
      })),
    });

    const result = await runtime.investigate({
      question: 'root',
      scope,
      budget: { ...budget, maxDepth: 2 },
    });
    expect(childRunner.mock.calls.map(([request]) => request.depth)).toEqual([1, 2]);
    expect(result.trace.usage.maxDepthReached).toBe(2);
  });

  it('propagates owner cancellation to active child work and never synthesizes', async () => {
    const item = searchItem('one');
    let childStopped = false;
    const childRunner = vi.fn(
      (request: RlmChildRequest) =>
        new Promise<never>((_resolve, reject) => {
          request.signal.addEventListener(
            'abort',
            () => {
              childStopped = true;
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        }),
    );
    const synthesize = vi.fn();
    const runtime = createRlmRuntime({
      contextTools: tools([item]),
      childRunner,
      synthesize,
    });
    const controller = new AbortController();
    const pending = runtime.investigate({
      question: 'cancel me',
      scope,
      budget,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(childRunner).toHaveBeenCalled());
    controller.abort('owner_cancelled');

    await expect(pending).rejects.toBeInstanceOf(RlmRuntimeError);
    expect(childStopped).toBe(true);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('aborts the full run when its wall-time budget expires', async () => {
    vi.useFakeTimers();
    try {
      const item = searchItem('one');
      const childRunner = vi.fn(
        (request: RlmChildRequest) =>
          new Promise<never>((_resolve, reject) => {
            request.signal.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true },
            );
          }),
      );
      const runtime = createRlmRuntime({
        contextTools: tools([item]),
        childRunner,
        synthesize: vi.fn(),
      });
      const pending = runtime.investigate({
        question: 'time out',
        scope,
        budget: { ...budget, maxWallTimeMs: 50 },
      });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'wall_time_exceeded' });
      await vi.advanceTimersByTimeAsync(51);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('contains child failures and excludes fake citations from root source authority', async () => {
    const item = searchItem('one');
    const fake = { ...item.pointer, id: 'fake', recordId: 'invented' };
    const childRunner = vi
      .fn<(request: RlmChildRequest) => Promise<{ answer: string; citations: (typeof fake)[] }>>()
      .mockRejectedValueOnce(new Error('local model failed'))
      .mockResolvedValueOnce({ answer: 'claims fake source', citations: [fake] });
    const synthesize = vi.fn(async (request: RlmSynthesisRequest) => ({
      answer: 'root validates',
      citations: request.evidence.map((evidence) => evidence.pointer),
    }));
    const runtime = createRlmRuntime({
      contextTools: tools([item, searchItem('two')]),
      childRunner,
      synthesize,
      partitionSize: 1,
    });

    const result = await runtime.investigate({ question: 'validate sources', scope, budget });
    expect(result.answer).toBe('root validates');
    expect(result.citations.every((citation) => citation.recordId !== 'invented')).toBe(true);
    expect(result.trace.events.some((event) => event.type === 'child_failed')).toBe(true);
  });
});
