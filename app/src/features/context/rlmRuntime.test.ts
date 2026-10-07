import { describe, expect, it, vi } from 'vitest';
import type { ContextOpenResult, ContextSearchItem, ContextScope } from './contextQueryService';
import { createContextPointer, createContextRecord } from './losslessContext';
import {
  RlmRuntimeError,
  createRlmRuntime,
  type RlmChildAnalysis,
  type RlmBudget,
  type RlmChildRequest,
  type RlmSynthesisRequest,
} from './rlmRuntime';

const HASH = 'a'.repeat(64);
const scope: ContextScope = { accountId: 'account-1', projectId: 'project-1' };
const executionIdentity = Object.freeze({
  transportConnectionId: 'opencode-cli',
  transportAdapterId: 'opencode-persistent',
  upstreamProviderId: 'opencode-go',
  upstreamModelId: 'deepseek-v4-flash-vision-exp',
  providerQualifiedModelId: 'opencode-go/deepseek-v4-flash-vision-exp',
  authBillingRoute: 'opencode-provider-session',
  effort: 'high',
  fastVariant: 'standard',
  catalogRevision: `sha256:${'b'.repeat(64)}`,
  observedProviderIdentity: 'opencode-go/deepseek-v4-flash-vision-exp',
});

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
  it.each([
    ['What do RLM tools report about source authority?', 'RLM'],
    ['Use Context/RLM tools to inspect O_NOFOLLOW. Which cleanup path is skipped?', 'O_NOFOLLOW'],
    ['Use Context/RLM tools. What is in source file fs/vfs/fs_open.c?', 'fs/vfs/fs_open.c'],
  ])('preserves factual acronyms and exact source anchors: %s', async (question, anchor) => {
    const item=searchItem('anchor');const contextTools=tools([item]);
    const runtime=createRlmRuntime({contextTools,
      childRunner: async request=>({answer:'grounded',citations:request.sourcePointers}),
      synthesize: async()=>({answer:'grounded',citations:[item.pointer]})});
    await runtime.investigate({question,scope,executionIdentity,budget});
    const query=(contextTools.search.mock.calls[0] as unknown as [{query:string}])[0].query;
    expect(query).toContain(anchor);
  });

  it.each([
    "Use the current project Context/RLM tools to ground each answer in the mapped synthetic files. Make five separate Context tool requests as needed and cite the current source paths: (1) What is the dispatch count? (2) What day are dispatches reviewed? (3) What is the stable station color? (4) What is the renamed route nickname? (5) What platform does the added source name? Do not modify files or use a shell. If a Context tool is unavailable, say so instead of guessing.",
    'Use the current project Context/RLM tools before answering: What is the dispatch count?',
  ])('retrieves factual evidence when Context/RLM tool directions precede the question', async (question) => {
    const item = searchItem('dispatch');
    const contextTools = { ...tools([item]), search: vi.fn(async ({ query }: { query: string }) => ({
      items: /dispatch/iu.test(query) ? [item] : [],
      truncated: false, indexAvailable: true, stale: false,
    })) };
    const childRunner = vi.fn(async (request: RlmChildRequest) => ({
      answer: '42', citations: request.sourcePointers,
    }));
    const runtime = createRlmRuntime({ contextTools, childRunner,
      synthesize: async () => ({ answer: '42', citations: [item.pointer] }) });
    const result = await runtime.investigate({ question, scope, executionIdentity, budget });
    expect(result.answer).toBe('42');
    const query = (contextTools.search.mock.calls[0] as unknown as [{query: string}])[0].query;
    expect(query).toContain('dispatch count');
    expect(query).not.toContain('RLM tools ground');
    if (question.includes('(5)')) {
      for (const phrase of ['stable station color', 'renamed route nickname', 'platform']) expect(query).toContain(phrase);
    }
    expect(childRunner).toHaveBeenCalledWith(expect.objectContaining({ question }));
  });

  it.each([
    'What does the VFS file-open helper return for a null pathname? Use the source file fs/vfs/fs_open.c as the source of record.',
    'Identify the O_NOFOLLOW cleanup path in VFS open. Use the source file fs/vfs/fs_open.c as the source of record.',
    'Compare O_NOFOLLOW cleanup in source file fs/vfs/fs_open.c and source file fs/inode/fs_inodefind.c.',
  ])('preserves explicitly requested source paths before shortening: %s', async (question) => {
    const item = searchItem('named-source');
    const contextTools = tools([item]);
    const runtime = createRlmRuntime({
      contextTools,
      childRunner: vi.fn(async (request: RlmChildRequest) => ({
        answer: 'grounded', citations: request.sourcePointers,
      })),
      synthesize: vi.fn(async () => ({ answer: 'grounded', citations: [item.pointer] })),
    });

    await runtime.investigate({ question, scope, executionIdentity, budget });

    expect(contextTools.search).toHaveBeenCalledWith(expect.objectContaining({ query: question }));
  });

  it('searches the semantic source question while retaining marked instructions for analysis', async () => {
    const item = searchItem('source');
    const contextTools = tools([item]);
    const childRunner = vi.fn(async (request: RlmChildRequest) => ({
      answer: 'grounded', citations: request.sourcePointers,
    }));
    const runtime = createRlmRuntime({
      contextTools, childRunner,
      synthesize: vi.fn(async () => ({ answer: 'grounded', citations: [item.pointer] })),
    });
    const instruction = 'Use only the active SiYuan Context Map through the real vibespace_context operation="investigate". Answer from mapped source only and cite file path and line range.';
    const questions = [
      'In a tickless or high-resolution timer build, what determines whether restarting an active watchdog reprograms the timer? Include the callback guard.',
      'Identify the resource-lifetime defect on the final-soft-link O_NOFOLLOW error path in VFS open. Show where each resource is acquired, which cleanup is skipped, and a minimal control-flow correction that preserves -ELOOP.',
    ];
    for (const [index, semantic] of questions.entries()) {
      const marked = `ROOT_NUTTX_20260924_016: NuttX source-grounded question ${index}.\n${instruction}\n${semantic}`;
      await runtime.investigate({ question: marked, scope, executionIdentity, budget });
      expect(contextTools.search).toHaveBeenLastCalledWith(expect.objectContaining({
        query: index === 1 ? 'O_NOFOLLOW VFS open' : questions[0],
      }));
      expect(childRunner).toHaveBeenLastCalledWith(expect.objectContaining({ question: marked }));
    }
  });

  it.each([
    'Could you explicitly use RLM to inspect the Cedar Lantern project notes across the entire project history and answer: What is the release mascot called?',
    'Please run a recursive RLM check over the Cedar Lantern project notes across the entire project history before answering: What is the release mascot called?',
  ])('uses the factual question after an explicit RLM routing request as the search query: %s', async (question) => {
    const item = searchItem('mascot');
    const contextTools = tools([item]);
    const childRunner = vi.fn(async (request: RlmChildRequest) => ({
      answer: 'Piper', citations: request.sourcePointers,
    }));
    const runtime = createRlmRuntime({
      contextTools, childRunner,
      synthesize: vi.fn(async () => ({ answer: 'Piper', citations: [item.pointer] })),
    });
    await runtime.investigate({ question, scope, executionIdentity, budget });

    expect(contextTools.search).toHaveBeenCalledWith(expect.objectContaining({
      query: 'What is the release mascot called?',
    }));
    expect(childRunner).toHaveBeenCalledWith(expect.objectContaining({ question }));
  });

  it('retrieves an unquoted C macro even when a provider appends a wrong file guess', async () => {
    const item = searchItem('vfs-open');
    const contextTools = tools([item]);
    const runtime = createRlmRuntime({
      contextTools,
      childRunner: vi.fn(async (request: RlmChildRequest) => ({
        answer: 'grounded', citations: request.sourcePointers,
      })),
      synthesize: vi.fn(async () => ({ answer: 'grounded', citations: [item.pointer] })),
    });
    const question = 'ROOT_NUTTX_R27_PROVIDER_RETRIEVAL_Q9_V2: Use only the active SiYuan Context Map. Identify the O_NOFOLLOW cleanup defect in VFS open. Focus on fs/open/open.c and related path resolution.';

    await runtime.investigate({ question, scope, executionIdentity, budget });

    expect(contextTools.search).toHaveBeenCalledWith(expect.objectContaining({ query: 'O_NOFOLLOW VFS open' }));
    await runtime.investigate({
      question: 'ROOT_NUTTX_R27_PROVIDER_CONTEXT_Q9_V4: Use only the active SiYuan Context Map. Identify the resource-lifetime defect on the final-soft-link `O_NOFOLLOW` error path in VFS open. Show the cleanup skipped and preserve `-ELOOP`.',
      scope, executionIdentity, budget,
    });
    expect(contextTools.search).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'O_NOFOLLOW VFS open' }));
  });

  it('removes a space-separated run marker and appended tool directions from native provider queries', async () => {
    const item = searchItem('nuttx');
    const contextTools = tools([item]);
    const runtime = createRlmRuntime({
      contextTools,
      childRunner: vi.fn(async (request: RlmChildRequest) => ({
        answer: 'grounded', citations: request.sourcePointers,
      })),
      synthesize: vi.fn(async () => ({ answer: 'grounded', citations: [item.pointer] })),
    });
    const cases = [
      {
        query: 'NUTTX_R27_TEN_02_SOURCE What does the VFS file-open helper return when the pathname is null, before it searches the inode tree? Use only the active SiYuan Context Map and mapped source. Give concise reasoning with citations.',
        expected: 'VFS open',
      },
      {
        query: 'NUTTX_R27_TEN_03_SOURCE With pseudo-files and mountpoints enabled, `open` uses `O_CREAT` for a missing entry. How is the requested mode transformed, which helper creates the entry, and what happens if creation fails? Use only the active SiYuan Context Map through mapped source.',
        expected: 'O_CREAT pseudofile',
      },
      {
        query: 'NUTTX_R27_TEN_04_SOURCE In a tickless or high-resolution timer build, what determines whether restarting an active watchdog reprograms the timer? Include the callback guard. Use only active SiYuan Context Map through mapped source.',
        expected: 'In a tickless or high-resolution timer build, what determines whether restarting an active watchdog reprograms the timer? Include the callback guard.',
      },
      {
        query: 'NUTTX_R27_TEN_05_SOURCE In the buffered TCP send implementation, what makes a send nonblocking, and how does failure to allocate the send callback differ for blocking and nonblocking calls? Use only the active SiYuan Context Map through mapped source.',
        expected: 'buffered TCP callback allocate',
      },
      {
        query: 'NUTTX_R27_TEN_07_SOURCE With BCH block proxies enabled, trace an open of a block or MTD inode from the original inode through the temporary character device. Which flags change under read-only BCH mode, which flags are stripped before opening the proxy, and what happens to the temporary name? Use only the active SiYuan Context Map through mapped source.',
        expected: 'BCH block proxy',
      },
      {
        query: 'NUTTX_R27_TEN_10_SOURCE A BCH block proxy has been registered and duplicated into the caller file object, but unlinking its temporary character-device name fails. Use only the active SiYuan Context Map through mapped source.',
        expected: 'BCH block proxy',
      },
      {
        query: 'NUTTX_R27_TEN_09_SOURCE Identify the resource-lifetime defect on the final-soft-link O_NOFOLLOW error path in VFS open. Show where each resource is acquired, which cleanup is skipped, and a minimal control-flow correction that preserves -ELOOP. Use only the active SiYuan Context Map through mapped source.',
        expected: 'O_NOFOLLOW VFS open',
      },
    ];
    for (const { query, expected } of cases) {
      await runtime.investigate({ question: query, scope, executionIdentity, budget });
      expect(contextTools.search).toHaveBeenLastCalledWith(expect.objectContaining({ query: expected }));
    }
  });

  it('searches the exact backticked source symbol instead of acceptance metadata and tool directions', async () => {
    const item = searchItem('watchdog');
    const contextTools = tools([item]);
    const runtime = createRlmRuntime({
      contextTools,
      childRunner: vi.fn(async (request: RlmChildRequest) => ({
        answer: 'source-grounded analysis', citations: request.sourcePointers,
      })),
      synthesize: vi.fn(async (request: RlmSynthesisRequest) => ({
        answer: 'source-grounded analysis', citations: request.evidence.map((entry) => entry.pointer),
      })),
    });

    await runtime.investigate({
      question: 'NUTTX_RLM_PROBE: Use only the map. What does `wd_start_abstick` return for null arguments? Cite source lines.',
      scope, executionIdentity, budget,
    });

    expect(contextTools.search).toHaveBeenCalledWith(expect.objectContaining({
      query: 'wd_start_abstick',
    }));
  });

  it('expands an issued search pointer to include nearby implementation branches', async () => {
    const item = searchItem('watchdog');
    const baseTools = tools([item]);
    const expanded = openResult(item, 'int wd_start_abstick(...) { int ret = -EINVAL; if (wdog && wdentry) ret = OK; return ret; }');
    const expand = vi.fn(async () => expanded);
    const childRunner = vi.fn(async (request: RlmChildRequest) => ({
      answer: request.evidence[0]?.text ?? '', citations: request.sourcePointers,
    }));
    const runtime = createRlmRuntime({
      contextTools: { ...baseTools, expand }, childRunner,
      synthesize: vi.fn(async (request: RlmSynthesisRequest) => ({
        answer: request.childAnalyses[0]?.answer ?? '',
        citations: request.evidence.map((entry) => entry.pointer),
      })),
    });

    const result = await runtime.investigate({
      question: 'What does `wd_start_abstick` return for null arguments?',
      scope, executionIdentity,
      budget: { ...budget, maxToolCalls: 12, maxOpenBytes: 64 * 1024 },
    });

    expect(baseTools.search).toHaveBeenCalledWith(expect.objectContaining({ limit: 4 }));
    expect(expand).toHaveBeenCalledWith(expect.objectContaining({
      pointer: item.pointer, beforeBytes: 0, afterBytes: 16_384,
    }));
    expect(baseTools.open).not.toHaveBeenCalled();
    expect(childRunner).toHaveBeenCalledWith(expect.objectContaining({
      evidence: [expect.objectContaining({ text: expect.stringContaining('-EINVAL') })],
    }));
    expect(result.answer).toContain('-EINVAL');
  });

  it('fits a named callback allocation branch into the child evidence window', async () => {
    const original = searchItem('callback');
    const item = {
      ...original,
      pointer: createContextPointer({ ...original.pointer, byteStart: 5_000, byteEnd: 5_512 }),
    };
    const baseTools = tools([item]);
    const expand = vi.fn(async () => openResult(item, 'tcp_callback_alloc(conn) returns NULL; nonblock ? -EAGAIN : -ENOMEM'));
    const runtime = createRlmRuntime({
      contextTools: { ...baseTools, expand },
      childRunner: vi.fn(async (request: RlmChildRequest) => ({
        answer: request.evidence[0]?.text ?? '', citations: request.sourcePointers,
      })),
      synthesize: vi.fn(async (request: RlmSynthesisRequest) => ({
        answer: request.childAnalyses[0]?.answer ?? '',
        citations: request.evidence.map((entry) => entry.pointer),
      })),
    });

    await runtime.investigate({
      question: 'In the buffered TCP send implementation, what makes a send nonblocking, and how does failure to allocate the send callback differ for blocking and nonblocking calls?',
      scope, executionIdentity,
      budget: { ...budget, maxToolCalls: 12, maxOpenBytes: 64 * 1024 },
    });

    expect(baseTools.search).toHaveBeenCalledWith(expect.objectContaining({
      query: 'buffered TCP callback allocate',
    }));
    expect(expand).toHaveBeenCalledWith(expect.objectContaining({
      pointer: item.pointer, beforeBytes: 4_096, afterBytes: 6_144,
    }));
  });

  it('runs bounded children on the exact caller-supplied OpenCode execution identity', async () => {
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
      executionIdentity,
      budget,
    });

    expect(childRunner).toHaveBeenCalledTimes(3);
    for (const [request] of childRunner.mock.calls) {
      expect(request.executionIdentity).toEqual(executionIdentity);
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
          detail: expect.stringContaining(
            'provider=opencode-go model=deepseek-v4-flash-vision-exp',
          ),
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
      executionIdentity,
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
      executionIdentity,
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
      executionIdentity,
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
      executionIdentity,
      budget,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(childRunner).toHaveBeenCalled());
    controller.abort('owner_cancelled');

    await expect(pending).rejects.toBeInstanceOf(RlmRuntimeError);
    expect(childStopped).toBe(true);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('does not start context work when the owner was already cancelled', async () => {
    const item = searchItem('one');
    const contextTools = tools([item]);
    const childRunner = vi.fn(async () => ({ answer: 'unexpected', citations: [] }));
    const synthesize = vi.fn(async () => ({ answer: 'unexpected', citations: [] }));
    const runtime = createRlmRuntime({ contextTools, childRunner, synthesize });
    const controller = new AbortController();
    controller.abort('cancelled_before_start');

    await expect(runtime.investigate({
      question: 'already cancelled', scope, executionIdentity, budget, signal: controller.signal,
    })).rejects.toMatchObject({ code: 'cancelled' });

    expect(contextTools.search).not.toHaveBeenCalled();
    expect(contextTools.open).not.toHaveBeenCalled();
    expect(childRunner).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('waits for active child abort acknowledgements without draining queued partitions', async () => {
    const items = [searchItem('one'), searchItem('two'), searchItem('three')];
    const contextTools = tools(items);
    const abortAcknowledgements: Array<() => void> = [];
    const abortedRecords: string[] = [];
    const childRunner = vi.fn((request: RlmChildRequest) => new Promise<never>((_resolve, reject) => {
      const recordId = request.evidence[0]!.record.id;
      request.signal.addEventListener('abort', () => {
        abortedRecords.push(recordId);
        let acknowledge!: () => void;
        const pendingAcknowledgement = new Promise<void>((resolve) => { acknowledge = resolve; });
        abortAcknowledgements.push(acknowledge);
        void pendingAcknowledgement.then(() => reject(new DOMException('aborted', 'AbortError')));
      }, { once: true });
    }));
    const synthesize = vi.fn(async () => ({ answer: 'unexpected', citations: [] }));
    const runtime = createRlmRuntime({
      contextTools, childRunner, synthesize, partitionSize: 1,
    });
    const controller = new AbortController();
    let settled = false;
    const pending = runtime.investigate({
      question: 'cancel before queued partition',
      scope,
      executionIdentity,
      budget: { ...budget, maxSubcalls: 3, maxConcurrentSubcalls: 2 },
      signal: controller.signal,
    });
    void pending.then(() => { settled = true; }, () => { settled = true; });

    await vi.waitFor(() => expect(childRunner).toHaveBeenCalledTimes(2));
    controller.abort('owner_cancelled');
    try {
      await vi.waitFor(() => expect(abortAcknowledgements).toHaveLength(2));

      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(abortedRecords).toEqual(['one', 'two']);
      expect(childRunner).toHaveBeenCalledTimes(2);
      expect(synthesize).not.toHaveBeenCalled();
    } finally {
      abortAcknowledgements.forEach((acknowledge) => acknowledge());
    }
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(childRunner).toHaveBeenCalledTimes(2);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('reports unconfirmed cancellation when an active child never acknowledges abort', async () => {
    vi.useFakeTimers();
    let settleChild!: (analysis: RlmChildAnalysis) => void;
    let pending: Promise<unknown> | undefined;
    try {
      const item = searchItem('one');
      let abortObserved = false;
      const childRunner = vi.fn((request: RlmChildRequest) => new Promise<RlmChildAnalysis>((resolve) => {
        request.signal.addEventListener('abort', () => { abortObserved = true; }, { once: true });
        settleChild = resolve;
      }));
      const synthesize = vi.fn(async () => ({ answer: 'unexpected', citations: [] }));
      const runtime = createRlmRuntime({
        contextTools: tools([item]), childRunner, synthesize,
      });
      const controller = new AbortController();
      pending = runtime.investigate({
        question: 'report missing abort acknowledgement',
        scope,
        executionIdentity,
        budget: { ...budget, maxWallTimeMs: 10_000 },
        signal: controller.signal,
      });
      for (let attempt = 0; attempt < 8 && childRunner.mock.calls.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      expect(childRunner).toHaveBeenCalledOnce();

      const result = expect(pending).rejects.toMatchObject({ code: 'abort_unconfirmed' });
      controller.abort('owner_cancelled');
      await vi.advanceTimersByTimeAsync(5_000);
      await result;
      expect(abortObserved).toBe(true);
      expect(synthesize).not.toHaveBeenCalled();
    } finally {
      if (settleChild) settleChild({ answer: 'late', citations: [] });
      await pending?.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it('preserves a typed abort failure from an aborted child instead of reporting cancellation', async () => {
    const item = searchItem('one');
    const contextTools = tools([item]);
    const childRunner = vi.fn((request: RlmChildRequest) => new Promise<RlmChildAnalysis>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => {
        reject(new RlmRuntimeError('abort_unconfirmed', 'rlm_abort_acknowledgement_failed'));
      }, { once: true });
    }));
    const synthesize = vi.fn(async () => ({ answer: 'unexpected', citations: [] }));
    const runtime = createRlmRuntime({ contextTools, childRunner, synthesize });
    const controller = new AbortController();
    const pending = runtime.investigate({
      question: 'preserve failed native abort acknowledgement',
      scope,
      executionIdentity,
      budget,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(childRunner).toHaveBeenCalledOnce());
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'abort_unconfirmed',
      message: 'rlm_abort_acknowledgement_failed',
    });
    controller.abort('owner_cancelled');

    await assertion;
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
        executionIdentity,
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

    const result = await runtime.investigate({
      question: 'validate sources',
      scope,
      executionIdentity,
      budget,
    });
    expect(result.answer).toBe('root validates');
    expect(result.citations.every((citation) => citation.recordId !== 'invented')).toBe(true);
    expect(result.trace.events.some((event) => event.type === 'child_failed')).toBe(true);
  });

  it('fails the whole run closed when the exact child execution route is unavailable', async () => {
    const item = searchItem('one');
    const synthesize = vi.fn();
    const runtime = createRlmRuntime({
      contextTools: tools([item]),
      childRunner: vi.fn(async () => {
        throw new RlmRuntimeError('execution_route_unavailable', 'rlm_exact_variant_unavailable');
      }),
      synthesize,
    });

    await expect(
      runtime.investigate({
        question: 'preserve exact route',
        scope,
        executionIdentity,
        budget,
      }),
    ).rejects.toMatchObject({
      code: 'execution_route_unavailable',
      message: 'rlm_exact_variant_unavailable',
    });
    expect(synthesize).not.toHaveBeenCalled();
  });
});
