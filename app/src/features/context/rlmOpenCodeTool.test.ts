import { describe, expect, it, vi } from 'vitest';
import { createRlmOpenCodeTool } from './rlmOpenCodeTool';

const HASH = 'a'.repeat(64);
const lease = {
  sessionId: 'session-1',
  accountId: 'account-1',
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  expiresAt: 2_000,
};

function dependencies() {
  return {
    queryService: {
      address: vi.fn(async (input) => input),
      describe: vi.fn(async ({ scope }) => ({ scope, recordCount: 2 })),
      search: vi.fn(async ({ scope, query }) => ({
        scope,
        query,
        items: [],
        truncated: false,
      })),
      open: vi.fn(async ({ scope, pointer, maxBytes }) => ({
        scope,
        pointer,
        maxBytes,
        text: 'exact',
        truncated: false,
      })),
      expand: vi.fn(async (input) => input),
      related: vi.fn(async (input) => input),
      timeline: vi.fn(async (input) => input),
      sources: vi.fn(async (input) => input),
      checkpoint: vi.fn(async (input) => input),
      investigate: vi.fn(async (input) => input),
    },
    rlmRuntime: {
      investigate: vi.fn(async ({ question, scope }) => ({
        answer: `investigated:${question}`,
        citations: [],
        scope,
        trace: { mode: 'rlm' },
      })),
    },
  };
}

describe('OpenCode RLM context tool adapter', () => {
  it('derives account/project/worktree scope only from the trusted VibeSpace lease', async () => {
    const deps = dependencies();
    const tool = createRlmOpenCodeTool({ ...deps, now: () => 1_000 });

    await tool.execute({ operation: 'search', query: 'needle', limit: 7 }, lease);

    expect(deps.queryService.search).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: {
          accountId: 'account-1',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
        query: 'needle',
        limit: 7,
      }),
    );
  });

  it('accepts exact bounded pointer opens and forwards cancellation', async () => {
    const deps = dependencies();
    const tool = createRlmOpenCodeTool({ ...deps, now: () => 1_000, maxOpenBytes: 32 });
    const controller = new AbortController();
    await tool.execute(
      {
        operation: 'open',
        pointer: {
          id: 'pointer-1',
          recordId: 'record-1',
          byteStart: 10,
          byteEnd: 20,
          sourceVersion: 'sha256:aaaaaaaa',
          contentHash: HASH,
        },
        maxBytes: 9_999,
      },
      lease,
      controller.signal,
    );

    expect(deps.queryService.open).toHaveBeenCalledWith(
      expect.objectContaining({
        maxBytes: 32,
        signal: controller.signal,
      }),
    );
  });

  it('uses query as the high-level entry and stays lazy for ordinary short chat', async () => {
    const deps = dependencies();
    const tool = createRlmOpenCodeTool({ ...deps, now: () => 1_000 });
    const result = await tool.execute({ operation: 'query', query: 'Hi Jarvis' }, lease);

    expect(deps.rlmRuntime.investigate).not.toHaveBeenCalled();
    expect(deps.queryService.search).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      mode: 'direct',
      skippedRecursiveSearch: true,
      evidence: [],
    });
  });

  it('routes a default query with investigation signals through the RLM runtime', async () => {
    const deps = dependencies();
    const tool = createRlmOpenCodeTool({ ...deps, now: () => 1_000 });
    await tool.execute(
      { operation: 'query', query: 'Investigate the entire project history for the leak' },
      lease,
    );
    expect(deps.rlmRuntime.investigate).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'Investigate the entire project history for the leak',
      }),
    );
  });

  it('routes investigate through the bounded RLM runtime with conservative budgets', async () => {
    const deps = dependencies();
    const tool = createRlmOpenCodeTool({ ...deps, now: () => 1_000 });
    const result = await tool.execute(
      { operation: 'investigate', query: 'cross-source root cause' },
      lease,
    );

    expect(deps.rlmRuntime.investigate).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'cross-source root cause',
        scope: expect.objectContaining({ accountId: 'account-1' }),
        budget: expect.objectContaining({
          maxDepth: 1,
          maxConcurrentSubcalls: 2,
          maxWallTimeMs: 60_000,
        }),
      }),
    );
    expect(result).toMatchObject({ answer: 'investigated:cross-source root cause' });
  });

  it.each([
    '999999999',
    '1000000000',
    '1000000001',
    '9999999999',
    '10000000000',
    '10000000001',
    '100000000000',
    '9007199254740991',
    '9007199254740992',
    '9007199254740993',
  ])('routes canonical logical address %s using only lease-derived scope', async (position) => {
    const deps = dependencies();
    const tool = createRlmOpenCodeTool({ ...deps, now: () => 1_000 });
    const controller = new AbortController();

    await tool.execute(
      { operation: 'address', corpusId: 'sparse-boundaries', position },
      lease,
      controller.signal,
    );

    expect(deps.queryService.address).toHaveBeenCalledWith({
      scope: {
        accountId: 'account-1',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
      corpusId: 'sparse-boundaries',
      position,
      signal: controller.signal,
    });
  });

  it.each([
    { operation: 'address', corpusId: 'sparse', position: 10_000_000_001 },
    { operation: 'address', corpusId: 'sparse', position: '01' },
    { operation: 'address', corpusId: 'sparse', position: '1e10' },
    { operation: 'address', corpusId: 'sparse', position: '-1' },
    { operation: 'address', corpusId: 'sparse', position: '+1' },
    { operation: 'address', corpusId: 'sparse', position: '1.0' },
    { operation: 'address', corpusId: '../foreign', position: '1' },
    { operation: 'address', corpusId: 'safe/path', position: '1' },
    { operation: 'address', corpusId: 'sparse', position: '1', root: 'C:\\foreign' },
  ])('rejects malformed or authority-bearing address arguments: %o', async (args) => {
    const deps = dependencies();
    const tool = createRlmOpenCodeTool({ ...deps, now: () => 1_000 });

    await expect(tool.execute(args, lease)).rejects.toMatchObject({ code: 'invalid_arguments' });
    expect(deps.queryService.address).not.toHaveBeenCalled();
    expect(deps.queryService.search).not.toHaveBeenCalled();
    expect(deps.queryService.open).not.toHaveBeenCalled();
  });

  it.each([
    [{ operation: 'search', query: 'x', accountId: 'attacker' }],
    [{ operation: 'unknown' }],
    [{ operation: 'search', query: '' }],
    [
      {
        operation: 'open',
        pointer: {
          id: 'pointer-1',
          recordId: 'record-1',
          byteStart: 20,
          byteEnd: 10,
          sourceVersion: 'v1',
          contentHash: HASH,
        },
      },
    ],
  ])('rejects malformed or authority-injecting arguments: %o', async (args) => {
    const tool = createRlmOpenCodeTool({ ...dependencies(), now: () => 1_000 });
    await expect(tool.execute(args, lease)).rejects.toMatchObject({ code: 'invalid_arguments' });
  });

  it('rejects expired or wrong-session leases before invoking context tools', async () => {
    const deps = dependencies();
    const tool = createRlmOpenCodeTool({ ...deps, now: () => 3_000 });
    await expect(tool.execute({ operation: 'describe' }, lease)).rejects.toMatchObject({
      code: 'lease_expired',
    });
    expect(deps.queryService.describe).not.toHaveBeenCalled();
  });
});
