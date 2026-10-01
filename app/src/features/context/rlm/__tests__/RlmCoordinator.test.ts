import { describe, expect, it, vi } from 'vitest';
import { RlmCoordinator } from '../RlmCoordinator';

const pointer = {
  pointerId: 'p1', leaseId: 'l', accountId: 'a', projectId: 'p', sourceId: 's', recordId: 'r',
  sourceVersion: 'v1', contentHash: 'h', byteStart: '0', byteEnd: '10', repositoryGeneration: 'g', issuedAt: 1,
};

describe('RlmCoordinator', () => {
  it('adds no context overhead for a direct current-file task', async () => {
    const search = vi.fn();
    const investigate = vi.fn();
    const coordinator = new RlmCoordinator({ search, open: vi.fn() }, { investigate });
    await expect(coordinator.query({
      question: 'rename this variable', scope: { accountId: 'a', projectId: 'p' },
      signals: { enabled: true, activeFileOnly: true }, performance: 'quality',
    })).resolves.toMatchObject({ route: 'direct', answerSupport: [] });
    expect(search).not.toHaveBeenCalled();
    expect(investigate).not.toHaveBeenCalled();
  });

  it('uses bounded search/open for an ordinary historical lookup', async () => {
    const search = vi.fn(async () => [{ pointer, preview: 'preview' }]);
    const open = vi.fn(async () => ({ pointer, text: 'evidence', truncated: false }));
    const coordinator = new RlmCoordinator({ search, open }, { investigate: vi.fn() });
    const result = await coordinator.query({
      question: 'what did we decide?', scope: { accountId: 'a', projectId: 'p' },
      signals: { enabled: true, historicalLookup: true }, performance: 'quality',
    });
    expect(result.route).toBe('retrieval');
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ maxBytes: 256 * 1024 }));
  });

  it('uses the recursive worker only for justified large cross-source work', async () => {
    const investigate = vi.fn(async () => ({
      evidence: [{ pointer, text: 'bounded', truncated: false }], unresolved: [], childCalls: 1, maxDepth: 1,
    }));
    const coordinator = new RlmCoordinator(
      { search: vi.fn(), open: vi.fn() },
      { investigate },
    );
    const result = await coordinator.query({
      question: 'analyze all project history', scope: { accountId: 'a', projectId: 'p' },
      signals: {
        enabled: true, userRequestsWholeProject: true, crossSourceSynthesis: true,
        estimatedCorpusTokens: 30_000_000, modelContextTokens: 1_000_000,
      },
      performance: 'quality',
    });
    expect(result).toMatchObject({ route: 'rlm', childCalls: 1, maxDepth: 1 });
    expect(investigate).toHaveBeenCalledWith(expect.objectContaining({ maxSubcalls: 6, maxConcurrentSubcalls: 2 }));
  });
});
