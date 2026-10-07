import { describe, expect, it, vi } from 'vitest';
import { createRlmOpenCodeTool } from './rlmOpenCodeTool';
import { setChatRlmEnabled } from './rlmPreferenceStore';
import {
  consumeToolGatewayContextCitationItems,
  clearToolGatewayContextCitationItems,
} from '@/lib/harness/toolGatewayCitations';

const HASH = 'a'.repeat(64);
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
});
const lease = {
  sessionId: 'session-1',
  accountId: 'account-1',
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  executionIdentity,
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
  it('honors chat Off for recursive investigation while allowing bounded Context retrieval', async () => {
    localStorage.clear();
    try {
      setChatRlmEnabled('chat-off', false);
      const deps = dependencies();
      const tool = createRlmOpenCodeTool({ ...deps, now: () => 1_000 });
      const chatLease = { ...lease, workspaceId: 'workspace-1', chatId: 'chat-off' };
      await tool.execute({ operation: 'investigate', query: 'Audit the entire project history' }, chatLease);
      expect(deps.rlmRuntime.investigate).not.toHaveBeenCalled();
      expect(deps.queryService.search).toHaveBeenCalledOnce();
      await tool.execute({ operation: 'search', query: 'Find the signed record' }, chatLease);
      expect(deps.queryService.search).toHaveBeenCalledTimes(2);
      await tool.execute({ operation: 'investigate', query: 'Audit the entire project history' },
        { ...chatLease, chatId: 'chat-on' });
      expect(deps.rlmRuntime.investigate).toHaveBeenCalledOnce();
    } finally {
      localStorage.clear();
    }
  });

  it('records a failed retrieval route when high-level query search rejects', async () => {
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    };
    vi.stubGlobal('localStorage', storage);
    try {
      const failure = new Error('retrieval failed');
      const deps = dependencies();
      deps.queryService.search = vi.fn(async () => {
        throw failure;
      });
      const tool = createRlmOpenCodeTool({ ...deps, now: () => 1_000 });

      await expect(
        tool.execute({ operation: 'query', query: 'Search the previous decision' }, lease),
      ).rejects.toBe(failure);

      const lastWrite = storage.setItem.mock.calls.at(-1);
      expect(lastWrite?.[0]).toBe('vibespace.rlm-preference.v1');
      expect(JSON.parse(lastWrite?.[1] ?? '{}')).toMatchObject({
        lastRoute: 'retrieval',
        lastRunStatus: 'failed',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('records a failed RLM route when investigation rejects', async () => {
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    };
    vi.stubGlobal('localStorage', storage);
    try {
      const failure = new Error('investigation failed');
      const deps = dependencies();
      deps.rlmRuntime.investigate = vi.fn(async () => {
        throw failure;
      });
      const tool = createRlmOpenCodeTool({ ...deps, now: () => 1_000 });

      await expect(
        tool.execute(
          { operation: 'investigate', query: 'Investigate the entire project history for the leak' },
          lease,
        ),
      ).rejects.toBe(failure);

      const lastWrite = storage.setItem.mock.calls.at(-1);
      expect(lastWrite?.[0]).toBe('vibespace.rlm-preference.v1');
      expect(JSON.parse(lastWrite?.[1] ?? '{}')).toMatchObject({
        lastRoute: 'rlm',
        lastRunStatus: 'failed',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('records a successful retrieval route only after the operation resolves', async () => {
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    };
    vi.stubGlobal('localStorage', storage);
    try {
      let release!: (value: any) => void;
      const deps = dependencies();
      deps.queryService.search = vi.fn(
        (_input: any) =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const tool = createRlmOpenCodeTool({ ...deps, now: () => 1_000 });

      const pending = tool.execute(
        { operation: 'query', query: 'Search the previous decision' },
        lease,
      );
      await vi.waitFor(() => expect(deps.queryService.search).toHaveBeenCalled());
      expect(storage.setItem).not.toHaveBeenCalled();

      release({ scope: lease, query: 'Search the previous decision', items: [], truncated: false });
      await expect(pending).resolves.toMatchObject({ items: [], truncated: false });

      const lastWrite = storage.setItem.mock.calls.at(-1);
      expect(JSON.parse(lastWrite?.[1] ?? '{}')).toMatchObject({
        lastRoute: 'retrieval',
        lastRunStatus: 'ok',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not replace a successful retrieval when its status write fails', async () => {
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error('storage unavailable');
      }),
    };
    vi.stubGlobal('localStorage', storage);
    try {
      const deps = dependencies();
      deps.queryService.search = vi.fn(async ({ scope, query }: any) => ({
        scope,
        query,
        items: [],
        truncated: false,
      }));
      const tool = createRlmOpenCodeTool({ ...deps, now: () => 1_000 });

      await expect(
        tool.execute({ operation: 'query', query: 'Search the previous decision' }, lease),
      ).resolves.toMatchObject({ items: [], truncated: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('registers fallback search/open/expand citations for final-answer validation', async () => {
    clearToolGatewayContextCitationItems();
    const pointer = {
      id: 'ptr:rlm:reg:0:512',
      recordId: 'record-reg',
      sourceVersion: `sha256:${HASH}`,
      contentHash: HASH,
      byteStart: 0,
      byteEnd: 512,
    };
    const deps = dependencies();
    deps.queryService.search = vi.fn(async ({ scope, query }: any): Promise<any> => ({
      scope,
      query,
      items: [
        {
          record: { id: 'record-reg', sourceId: 'src-reg' },
          pointer,
          preview: 'p',
          score: 1,
        },
      ],
      truncated: false,
    }) as any);
    deps.queryService.open = vi.fn(async ({ scope, maxBytes }: any): Promise<any> => ({
      scope,
      maxBytes,
      record: { id: 'record-reg' },
      pointer,
      text: 'exact',
      truncated: false,
    }) as any);
    const protectedLease = { ...lease, contextRevision: `sha256:${HASH}` };
    const assertCurrent = vi.fn(() => protectedLease.contextRevision);
    // Synthetic issued-evidence port: only the fixture's exact pointer receives proof.
    const verifyIssued = vi.fn(async (result: unknown) => {
      const value = result as { pointer?: typeof pointer; items?: { pointer: typeof pointer }[] };
      const issued = value.pointer === pointer || value.items?.some((item) => item.pointer === pointer);
      return issued ? [{ pointerId: pointer.id, recordId: pointer.recordId,
        sourceRevision: pointer.sourceVersion, contentHash: pointer.contentHash }] : [];
    });
    const tool = createRlmOpenCodeTool({ ...deps, verifiedFallbackCitations: verifyIssued, now: () => 1_000 });
    await tool.execute({ operation: 'search', query: 'needle' }, protectedLease, undefined, assertCurrent);
    await tool.execute({ operation: 'open', pointer }, protectedLease, undefined, assertCurrent);
    expect(verifyIssued).toHaveBeenCalledTimes(2);
    expect(verifyIssued).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining(protectedLease), undefined);
    const items = consumeToolGatewayContextCitationItems('session-1');
    expect(items.some((item) => item.source.id === 'ptr:rlm:reg:0:512')).toBe(true);
    expect(items[0]!.source.uri).toContain('vibespace:context/evidence/');
    clearToolGatewayContextCitationItems();
  });

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
        executionIdentity,
      }),
      expect.objectContaining(lease),
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
        executionIdentity,
        scope: expect.objectContaining({ accountId: 'account-1' }),
        budget: expect.objectContaining({
          maxDepth: 1,
          maxConcurrentSubcalls: 2,
          maxWallTimeMs: 60_000,
        }),
      }),
      expect.objectContaining(lease),
    );
    expect(result).toMatchObject({ answer: 'investigated:cross-source root cause' });
  });

  it('fails closed before recursive retrieval when the trusted lease lacks execution identity', async () => {
    const deps = dependencies();
    const tool = createRlmOpenCodeTool({ ...deps, now: () => 1_000 });
    const { executionIdentity: _omitted, ...unboundLease } = lease;

    await expect(
      tool.execute({ operation: 'investigate', query: 'cross-source root cause' }, unboundLease),
    ).rejects.toThrow('rlm_execution_identity_required');
    expect(deps.rlmRuntime.investigate).not.toHaveBeenCalled();
    expect(deps.queryService.search).not.toHaveBeenCalled();
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


describe('OpenCode Context citation and cancellation boundaries', () => {
  const pointer = {
    id: 'ptr:rlm:fallback:0:64', recordId: 'record-fallback',
    sourceVersion: `sha256:${HASH}`, contentHash: HASH, byteStart: 0, byteEnd: 64,
  };
  const searchResult = {
    items: [{ record: { id: pointer.recordId, sourceId: 'source-fallback' }, pointer,
      preview: 'Verified source fact', score: 1 }],
    truncated: false,
  };
  const openResult = { record: { id: pointer.recordId }, pointer, text: 'Verified source fact', truncated: false };
  const routes = [
    { name: 'query retrieval', input: { operation: 'query', query: 'Search the previous decision' }, enabled: true },
    { name: 'query RLM-disabled fallback', input: { operation: 'query', query: 'Investigate the entire project history' }, enabled: false },
    { name: 'investigate RLM-disabled fallback', input: { operation: 'investigate', query: 'Investigate the entire project history' }, enabled: false },
  ];
  function storage(enabled = true) {
    const values = new Map([['vibespace.rlm-preference.v1', JSON.stringify({
      version: 1, userDefault: enabled, chats: {}, workspaces: {},
    })]]);
    const result = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    };
    vi.stubGlobal('localStorage', result);
    return result;
  }
  function cleanup() {
    clearToolGatewayContextCitationItems();
    vi.unstubAllGlobals();
  }

  it.each(routes)('$name preserves retrieved citation handles in the exact session', async ({ input, enabled }) => {
    clearToolGatewayContextCitationItems();
    storage(enabled);
    try {
      const deps = dependencies();
      const search = vi.fn(async () => searchResult);
      const protectedLease = { ...lease, contextRevision: `sha256:${HASH}` };
      const assertCurrent = vi.fn(() => protectedLease.contextRevision);
      const verifyIssued = vi.fn(async (result: unknown) => result === searchResult ? [{
        pointerId: pointer.id, recordId: pointer.recordId,
        sourceRevision: pointer.sourceVersion, contentHash: pointer.contentHash,
      }] : []);
      const tool = createRlmOpenCodeTool({ ...deps, queryService: { ...deps.queryService, search },
        verifiedFallbackCitations: verifyIssued, now: () => 1_000 });
      const response = await tool.execute(input, protectedLease, undefined, assertCurrent);
      expect(response).toMatchObject(searchResult);
      expect(response).toHaveProperty('canonicalProvenance.evidenceUris', [
        'vibespace:context/evidence/ptr%3Arlm%3Afallback%3A0%3A64',
      ]);
      expect(searchResult).not.toHaveProperty('canonicalProvenance');
      expect(verifyIssued).toHaveBeenCalledWith(searchResult, expect.objectContaining(protectedLease), undefined);
      expect(search).toHaveBeenCalledTimes(1);
      expect(deps.rlmRuntime.investigate).not.toHaveBeenCalled();
      expect(consumeToolGatewayContextCitationItems('different-session')).toEqual([]);
      expect(consumeToolGatewayContextCitationItems(lease.sessionId)).toEqual([
        expect.objectContaining({ source: expect.objectContaining({
          id: pointer.id, accountId: lease.accountId, projectId: lease.projectId,
          uri: expect.stringContaining('vibespace:context/evidence/'),
        }) }),
      ]);
    } finally { cleanup(); }
  });

  it.each(routes)('$name does not invent citation scope when no project is bound', async ({ input, enabled }) => {
    clearToolGatewayContextCitationItems();
    storage(enabled);
    try {
      const deps = dependencies();
      const { projectId: _project, ...withoutProject } = lease;
      const tool = createRlmOpenCodeTool({ ...deps, queryService: {
        ...deps.queryService, search: vi.fn(async () => searchResult),
      }, now: () => 1_000 });
      await expect(tool.execute(input, withoutProject)).resolves.toBe(searchResult);
      expect(consumeToolGatewayContextCitationItems(lease.sessionId)).toEqual([]);
    } finally { cleanup(); }
  });

  it.each([
    { operation: 'query', query: 'Hi Jarvis' },
    ...routes.map(({ input }) => input),
    { operation: 'describe' }, { operation: 'search', query: 'decision' },
    { operation: 'open', pointer }, { operation: 'expand', pointer },
    { operation: 'sources' }, { operation: 'timeline' }, { operation: 'checkpoint' },
    { operation: 'related', recordId: pointer.recordId },
    { operation: 'address', corpusId: 'fallback-corpus', position: '0' },
  ])('rejects a pre-cancelled $operation before dispatch or success recording', async (input) => {
    const stored = storage();
    try {
      const deps = dependencies();
      const controller = new AbortController();
      const reason = new Error('The user stopped this Context request.');
      controller.abort(reason);
      const tool = createRlmOpenCodeTool({ ...deps, now: () => 1_000 });
      await expect(tool.execute(input, lease, controller.signal)).rejects.toBe(reason);
      for (const method of Object.values(deps.queryService)) expect(method).not.toHaveBeenCalled();
      expect(deps.rlmRuntime.investigate).not.toHaveBeenCalled();
      expect(stored.setItem).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it.each([
    ...routes,
    { name: 'explicit search', input: { operation: 'search', query: 'decision' }, enabled: true },
    { name: 'open', input: { operation: 'open', pointer }, enabled: true },
    { name: 'expand', input: { operation: 'expand', pointer }, enabled: true },
  ])('does not register late evidence after cancelling $name', async ({ input, enabled }) => {
    clearToolGatewayContextCitationItems();
    const stored = storage(enabled);
    try {
      const deps = dependencies();
      let release!: (value: unknown) => void;
      const pending = new Promise<unknown>((resolve) => { release = resolve; });
      const method = input.operation === 'open' || input.operation === 'expand' ? input.operation : 'search';
      const tool = createRlmOpenCodeTool({ ...deps, queryService: {
        ...deps.queryService, [method]: vi.fn(async () => pending),
      }, now: () => 1_000 });
      const controller = new AbortController();
      const reason = new Error('Cancelled during retrieval.');
      const task = tool.execute(input, lease, controller.signal);
      controller.abort(reason);
      release(method === 'search' ? searchResult : openResult);
      await expect(task).rejects.toBe(reason);
      expect(consumeToolGatewayContextCitationItems(lease.sessionId)).toEqual([]);
      expect(stored.setItem.mock.calls.every(([, value]) => JSON.parse(value).lastRunStatus !== 'ok')).toBe(true);
    } finally { cleanup(); }
  });
});
