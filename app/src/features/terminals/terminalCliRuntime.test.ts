import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getTerminalContextSession,
  resetTerminalContextSessionsForTests,
} from './terminalContextSessionStore';
import {
  createTerminalCliRuntime,
  parseTerminalCliFrontendRequest,
  type TerminalCliRuntimeDependencies,
} from './terminalCliRuntime';

function request(method: string, params: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    requestId: `request-${method.replaceAll('.', '-')}`,
    terminalSessionId: 'tty-a',
    paneId: 'pane-a',
    projectId: 'project-a',
    runIdentity: null,
    method,
    params,
  };
}

function dependencies(): TerminalCliRuntimeDependencies {
  const maps = [
    {
      id: 'map-a',
      name: 'VibeSpace Main',
      status: 'active' as const,
      sourceType: 'local_folder',
      sourceLabel: 'C:\\VibeSpace',
      updatedAt: 100,
    },
    {
      id: 'map-b',
      name: 'Documentation',
      status: 'active' as const,
      sourceType: 'github_repository',
      sourceLabel: 'Cookie774-GameDev/VibeSpace',
      updatedAt: 90,
    },
  ];
  return {
    now: () => 1_000,
    currentProject: () => ({ id: 'project-a', name: 'VibeSpace', workspaceId: 'workspace-a' }),
    resolveProject: vi.fn(async (projectId) =>
      projectId === 'project-b'
        ? { id: 'project-b', name: 'Docs', workspaceId: 'workspace-a' }
        : projectId === 'project-a'
          ? { id: 'project-a', name: 'VibeSpace', workspaceId: 'workspace-a' }
          : null,
    ),
    switchProject: vi.fn(async (projectId) => ({
      id: projectId,
      name: projectId === 'project-b' ? 'Docs' : 'VibeSpace',
      workspaceId: 'workspace-a',
    })),
    listContextMaps: vi.fn(async () => maps),
    selectContextMap: vi.fn(async (_projectId, mapId) => {
      const map = maps.find((candidate) => candidate.id === mapId);
      if (!map) throw new Error('missing');
      return map;
    }),
    searchContext: vi.fn(async (_projectId, mapIds, query) => [
      { id: 'entity-a', label: `Match ${query}`, path: 'src/App.tsx', mapId: mapIds[0]! },
    ]),
    resolveContextEntity: vi.fn(async (_projectId, target) =>
      target === 'missing'
        ? null
        : { id: 'entity-a', label: 'App', path: 'src/App.tsx', mapId: 'map-a' },
    ),
    openContextEntity: vi.fn(async () => undefined),
    refreshContextMap: vi.fn(async (_projectId, mapId) => ({
      id: mapId ?? 'map-a',
      name: 'VibeSpace Main',
      status: 'active' as const,
      sourceType: 'local_folder',
      sourceLabel: 'C:\\VibeSpace',
      updatedAt: 1_000,
    })),
    createContextMap: vi.fn(async (_projectId, input) => ({
      id: 'map-created',
      name: input.source,
      status: 'active' as const,
      sourceType: input.sourceKind,
      sourceLabel: input.source,
      updatedAt: 1_000,
    })),
    listSkills: () => [
      { id: 'build', name: 'Build', description: 'Build software.' },
      { id: 'review', name: 'Review', description: 'Review changes.' },
    ],
    listAgents: () => [
      { slug: 'builder', name: 'Builder', status: 'idle' },
      { slug: 'reviewer', name: 'Reviewer', status: 'running' },
    ],
    createNote: vi.fn(async () => ({ id: 'note-1', name: 'Untitled' })),
    openNote: vi.fn(async (_projectId, _mapId, name) => ({ id: 'note-1', name })),
    linkNotes: vi.fn(async (_projectId, _mapId, source, target) => ({ source, target })),
    openDailyNote: vi.fn(async () => ({ id: 'daily-1', name: '2026-07-26' })),
    addDailyNoteText: vi.fn(async (_projectId, _mapId, text) => ({ id: 'daily-1', text })),
    authorizeContextIdentity: vi.fn(() => ({
      version: 1 as const,
      identityId: 'terminal-run-1',
      accountId: 'account-1',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      worktreeId: 'C:\\VibeSpace',
      paneId: 'pane-a',
      terminalSessionId: 'tty-a',
      access: 'full' as const,
      runGeneration: 0,
      scopeRevision: 'terminal-run-1:0',
      issuedAt: 100,
      expiresAt: 3_600_100,
    })),
    askContext: vi.fn(async () => ({
      promptBlock: '## cited terminal evidence',
      receipt: {
        receiptId: 'receipt-1',
        policyVersion: 'vibespace-context-policy-v1' as const,
        route: 'focused' as const,
        decision: 'required-focused' as const,
        required: true,
        decisionReasons: ['explicit-context' as const],
        scopeRevision: {
          accountId: 'account-1',
          workspaceId: 'workspace-a',
          projectId: 'project-a',
          worktreeId: 'C:\\VibeSpace',
          revision: 'terminal-run-1:0',
        },
        sourceRevisions: [{ sourceId: 'source-1', revision: 'source-v1' }],
        evidenceHandles: ['pointer-1'],
        cacheStatus: 'miss' as const,
        queueDepthAtStart: 0,
        stageTimingsMs: { retrieval: 12 },
        cancellationGeneration: 0,
        safeFailure: null,
        executionIdentity: {
          transportConnectionId: 'vibespace-terminal-context',
          transportAdapterId: 'terminal-local-ipc',
          upstreamProviderId: 'local-context-gateway',
          upstreamModelId: 'context-only',
          providerQualifiedModelId: 'local-context-gateway/context-only',
          authBillingRoute: 'local-only',
          effort: 'not-applicable',
          fastVariant: 'not-applicable',
          catalogRevision: 'terminal-run-1:0',
          observedProviderIdentity: 'local-context-gateway',
        },
      },
    })),
    verifyContextReceipt: vi.fn(() => true),
    recordCaoTerminalIdentity: vi.fn(async () => undefined),
  };
}

describe('terminal CLI frontend runtime', () => {
  beforeEach(() => {
    resetTerminalContextSessionsForTests();
  });

  it('parses a nonce-free closed native event without accepting bridge extras', () => {
    expect(parseTerminalCliFrontendRequest(request('context.current'))).toMatchObject({
      protocolVersion: 1,
      requestId: 'request-context-current',
      terminalSessionId: 'tty-a',
      paneId: 'pane-a',
      projectId: 'project-a',
      method: 'context.current',
      params: {},
    });
    expect(() =>
      parseTerminalCliFrontendRequest({ ...request('context.current'), nonce: 'secret' }),
    ).toThrow(/frontend request/i);
    expect(() =>
      parseTerminalCliFrontendRequest({ ...request('context.current'), protocolVersion: 2 }),
    ).toThrow(/frontend request/i);
  });

  it('routes one exact OpenCode identity receipt through the scoped receiver', async () => {
    const deps = dependencies();
    const runtime = createTerminalCliRuntime(deps);
    const response = await runtime.execute(
      parseTerminalCliFrontendRequest(
        request('cao.identity.publish', {
          opencodeSessionId: 'ses-opencode-a',
          providerId: 'openrouter',
          modelId: 'deepseek/deepseek-v4-flash',
          variant: 'high',
          processInstanceId: 'ptyproc-a',
        }),
      ),
    );

    expect(response).toMatchObject({ ok: true, code: 'ok' });
    expect(deps.recordCaoTerminalIdentity).toHaveBeenCalledWith({
      terminalSessionId: 'tty-a',
      paneId: 'pane-a',
      projectId: 'project-a',
      identity: {
        opencodeSessionId: 'ses-opencode-a',
        providerId: 'openrouter',
        modelId: 'deepseek/deepseek-v4-flash',
        variant: 'high',
        processInstanceId: 'ptyproc-a',
      },
    });
  });

  it('rejects an identity receipt without the exact terminal scope', async () => {
    const deps = dependencies();
    const runtime = createTerminalCliRuntime(deps);

    await expect(
      runtime.execute(
        parseTerminalCliFrontendRequest({
          ...request('cao.identity.publish', {
            opencodeSessionId: 'ses-opencode-a',
            providerId: 'openrouter',
            modelId: 'deepseek/deepseek-v4-flash',
            variant: 'high',
            processInstanceId: 'ptyproc-a',
          }),
          terminalSessionId: null,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'permission_denied' });
    expect(deps.recordCaoTerminalIdentity).not.toHaveBeenCalled();
  });

  it('rejects identity fields outside the bounded provider/model/variant grammar', async () => {
    const deps = dependencies();
    const runtime = createTerminalCliRuntime(deps);

    await expect(
      runtime.execute(
        parseTerminalCliFrontendRequest(
          request('cao.identity.publish', {
            opencodeSessionId: 'ses-opencode-a',
            providerId: 'openrouter',
            modelId: 'deepseek/deepseek-v4-flash',
            variant: 'high?forged',
            processInstanceId: 'ptyproc-a',
          }),
        ),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' });
    expect(deps.recordCaoTerminalIdentity).not.toHaveBeenCalled();
  });

  it('executes one scoped high-level context ask and returns its safe receipt', async () => {
    const deps = dependencies();
    const runtime = createTerminalCliRuntime(deps);
    const response = await runtime.execute(
      parseTerminalCliFrontendRequest({
        ...request('context.ask', { question: 'What was the prior decision?' }),
        runIdentity: 'terminal-run-1',
      }),
    );
    expect(deps.authorizeContextIdentity).toHaveBeenCalledWith({
      identityId: 'terminal-run-1',
      terminalSessionId: 'tty-a',
      paneId: 'pane-a',
      projectId: 'project-a',
    });
    expect(deps.askContext).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-context-ask',
        question: 'What was the prior decision?',
      }),
    );
    expect(deps.verifyContextReceipt).toHaveBeenCalledWith({
      receiptId: 'receipt-1',
      requestId: 'request-context-ask',
      scope: {
        accountId: 'account-1',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        worktreeId: 'C:\\VibeSpace',
        revision: 'terminal-run-1:0',
      },
      minimumRoute: 'focused',
    });
    expect(response).toMatchObject({
      ok: true,
      data: {
        answer: '## cited terminal evidence',
        receipt: { receiptId: 'receipt-1', route: 'focused', required: true },
      },
    });
  });

  it('fails closed when retrieval returns a receipt outside the authorized terminal scope', async () => {
    const deps = dependencies();
    const prepared = await deps.askContext({
      requestId: 'fixture-request',
      question: 'fixture',
      identity: deps.authorizeContextIdentity({
        identityId: 'terminal-run-1',
        terminalSessionId: 'tty-a',
        paneId: 'pane-a',
        projectId: 'project-a',
      })!,
    });
    vi.mocked(deps.askContext).mockResolvedValue({
      ...prepared,
      receipt: {
        ...prepared.receipt,
        scopeRevision: { ...prepared.receipt.scopeRevision, worktreeId: 'C:\\Other' },
      },
    });
    const runtime = createTerminalCliRuntime(deps);

    await expect(
      runtime.execute(
        parseTerminalCliFrontendRequest({
          ...request('context.ask', { question: 'Search history.' }),
          runIdentity: 'terminal-run-1',
        }),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'context_unavailable' });
    expect(deps.verifyContextReceipt).not.toHaveBeenCalled();
  });

  it('fails closed when the Gateway no longer verifies the required terminal receipt', async () => {
    const deps = dependencies();
    vi.mocked(deps.verifyContextReceipt).mockReturnValue(false);
    const runtime = createTerminalCliRuntime(deps);

    await expect(
      runtime.execute(
        parseTerminalCliFrontendRequest({
          ...request('context.ask', { question: 'Search history.' }),
          runIdentity: 'terminal-run-1',
        }),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'context_unavailable' });
  });

  it('never releases an optional direct receipt from the managed context command', async () => {
    const deps = dependencies();
    const prepared = await deps.askContext({
      requestId: 'fixture-request',
      question: 'fixture',
      identity: deps.authorizeContextIdentity({
        identityId: 'terminal-run-1',
        terminalSessionId: 'tty-a',
        paneId: 'pane-a',
        projectId: 'project-a',
      })!,
    });
    vi.mocked(deps.askContext).mockResolvedValue({
      ...prepared,
      receipt: {
        ...prepared.receipt,
        route: 'direct',
        decision: 'optional-direct',
        required: false,
        sourceRevisions: [],
        evidenceHandles: [],
      },
    });
    const runtime = createTerminalCliRuntime(deps);

    await expect(
      runtime.execute(
        parseTerminalCliFrontendRequest({
          ...request('context.ask', { question: 'Search history.' }),
          runIdentity: 'terminal-run-1',
        }),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'context_unavailable' });
    expect(deps.verifyContextReceipt).not.toHaveBeenCalled();
  });

  it('fails closed before retrieval without a valid scoped run identity', async () => {
    const deps = dependencies();
    vi.mocked(deps.authorizeContextIdentity).mockReturnValue(null);
    const runtime = createTerminalCliRuntime(deps);
    await expect(
      runtime.execute(
        parseTerminalCliFrontendRequest({
          ...request('context.ask', { question: 'Search history.' }),
          runIdentity: 'terminal-run-forged',
        }),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'permission_denied' });
    expect(deps.askContext).not.toHaveBeenCalled();
  });

  it('lists, selects, attaches, reports, and clears terminal-scoped context', async () => {
    const deps = dependencies();
    const runtime = createTerminalCliRuntime(deps);

    const listed = await runtime.execute(parseTerminalCliFrontendRequest(request('context.list')));
    expect(listed).toMatchObject({ ok: true, code: 'ok' });
    expect(listed.data).toMatchObject({
      maps: [
        { id: 'map-a', name: 'VibeSpace Main' },
        { id: 'map-b', name: 'Documentation' },
      ],
    });

    const selected = await runtime.execute(
      parseTerminalCliFrontendRequest(request('context.use', { map: 'VibeSpace Main' })),
    );
    expect(selected).toMatchObject({ ok: true, code: 'ok' });
    expect(selected.message).toMatch(/Restart the current agent session.*supported fresh turn/u);
    expect(deps.selectContextMap).toHaveBeenCalledWith('project-a', 'map-a');

    const attached = await runtime.execute(
      parseTerminalCliFrontendRequest(
        request('context.attach', { entity: 'src/App.tsx', mode: 'one_turn' }),
      ),
    );
    expect(attached).toMatchObject({ ok: true, code: 'ok' });
    expect(attached.message).toMatch(/Restart the current agent session.*supported fresh turn/u);

    const current = await runtime.execute(
      parseTerminalCliFrontendRequest(request('context.current')),
    );
    expect(current.data).toMatchObject({
      session: {
        activeMapIds: ['map-a'],
        pinnedEntityIds: ['entity-a'],
        mode: 'one_turn',
      },
    });

    const cleared = await runtime.execute(
      parseTerminalCliFrontendRequest(request('context.clear')),
    );
    expect(cleared.data).toMatchObject({
      session: { activeMapIds: [], pinnedEntityIds: [], mode: 'persistent' },
    });
    expect(cleared.message).toMatch(/Restart the current agent session.*supported fresh turn/u);
  });

  it('executes search, open, refresh, source inspection, and map creation services', async () => {
    const deps = dependencies();
    const runtime = createTerminalCliRuntime(deps);
    await runtime.execute(
      parseTerminalCliFrontendRequest(request('context.use', { map: 'map-a' })),
    );
    const revisionBeforeRefresh = getTerminalContextSession('tty-a')?.contextRevision;

    const search = await runtime.execute(
      parseTerminalCliFrontendRequest(request('context.search', { query: 'bootstrap' })),
    );
    expect(search.data).toMatchObject({ results: [{ id: 'entity-a', mapId: 'map-a' }] });
    expect(deps.searchContext).toHaveBeenCalledWith('project-a', ['map-a'], 'bootstrap');

    await expect(
      runtime.execute(
        parseTerminalCliFrontendRequest(request('context.open', { target: 'src/App.tsx' })),
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(deps.openContextEntity).toHaveBeenCalled();

    const refreshed = await runtime.execute(
      parseTerminalCliFrontendRequest(request('context.refresh', { map: 'map-a' })),
    );
    expect(refreshed).toMatchObject({ ok: true });
    expect(refreshed.message).toMatch(/Restart the current agent session.*supported fresh turn/u);
    expect(getTerminalContextSession('tty-a')?.contextRevision).toBe(
      (revisionBeforeRefresh ?? 0) + 1,
    );
    await expect(
      runtime.execute(parseTerminalCliFrontendRequest(request('context.sources'))),
    ).resolves.toMatchObject({ data: { sources: expect.any(Array) } });
    await expect(
      runtime.execute(
        parseTerminalCliFrontendRequest(
          request('context.create', {
            sourceKind: 'folder',
            source: 'C:\\VibeSpace',
          }),
        ),
      ),
    ).resolves.toMatchObject({ data: { map: { id: 'map-created' } } });
  });

  it('manages skills and agents only in the targeted terminal session', async () => {
    const runtime = createTerminalCliRuntime(dependencies());

    await runtime.execute(
      parseTerminalCliFrontendRequest(request('skills.use', { skill: 'build' })),
    );
    await runtime.execute(
      parseTerminalCliFrontendRequest(request('skills.add', { skill: 'review' })),
    );
    expect(
      (await runtime.execute(parseTerminalCliFrontendRequest(request('skills.active')))).data,
    ).toEqual({ skills: ['build', 'review'] });
    await runtime.execute(
      parseTerminalCliFrontendRequest(request('skills.remove', { skill: 'build' })),
    );
    await expect(
      runtime.execute(
        parseTerminalCliFrontendRequest(request('skills.inspect', { skill: 'review' })),
      ),
    ).resolves.toMatchObject({ data: { skill: { id: 'review' } } });

    await runtime.execute(
      parseTerminalCliFrontendRequest(request('agent.use', { slug: 'builder' })),
    );
    await expect(
      runtime.execute(parseTerminalCliFrontendRequest(request('agent.current'))),
    ).resolves.toMatchObject({ data: { agent: { slug: 'builder' } } });
    await expect(
      runtime.execute(parseTerminalCliFrontendRequest(request('agent.status'))),
    ).resolves.toMatchObject({ data: { agent: { status: 'idle' } } });
    await runtime.execute(parseTerminalCliFrontendRequest(request('agent.clear')));
    await expect(
      runtime.execute(parseTerminalCliFrontendRequest(request('agent.current'))),
    ).resolves.toMatchObject({ data: { agent: null } });
  });

  it('runs note, daily-note, and workspace-authorized project commands', async () => {
    const deps = dependencies();
    const runtime = createTerminalCliRuntime(deps);
    await runtime.execute(
      parseTerminalCliFrontendRequest(request('context.use', { map: 'map-a' })),
    );

    await expect(
      runtime.execute(parseTerminalCliFrontendRequest(request('note.new'))),
    ).resolves.toMatchObject({ data: { note: { id: 'note-1' } } });
    expect(deps.createNote).toHaveBeenCalledWith('project-a', 'map-a');
    await expect(
      runtime.execute(
        parseTerminalCliFrontendRequest(request('note.open', { name: 'Architecture' })),
      ),
    ).resolves.toMatchObject({ data: { note: { name: 'Architecture' } } });
    await runtime.execute(
      parseTerminalCliFrontendRequest(
        request('note.link', { source: 'Architecture', target: 'Security' }),
      ),
    );
    await runtime.execute(parseTerminalCliFrontendRequest(request('daily.open')));
    await runtime.execute(
      parseTerminalCliFrontendRequest(request('daily.add', { text: 'Build passed.' })),
    );
    expect(deps.addDailyNoteText).toHaveBeenCalledWith('project-a', 'map-a', 'Build passed.');

    await expect(
      runtime.execute(parseTerminalCliFrontendRequest(request('project.current'))),
    ).resolves.toMatchObject({ data: { project: { id: 'project-a' } } });
    await expect(
      runtime.execute(
        parseTerminalCliFrontendRequest(request('project.switch', { projectId: 'project-b' })),
      ),
    ).resolves.toMatchObject({ data: { project: { id: 'project-b' } } });
    expect(deps.switchProject).toHaveBeenCalledWith('project-b');
  });

  it('requires terminal-scoped Context before mutating notes', async () => {
    const deps = dependencies();
    const runtime = createTerminalCliRuntime(deps);

    await expect(
      runtime.execute(parseTerminalCliFrontendRequest(request('note.new'))),
    ).resolves.toMatchObject({
      ok: false,
      code: 'conflict',
      message: 'Select a Context Map before using Context Notes.',
    });
    expect(deps.createNote).not.toHaveBeenCalled();
  });

  it('returns bounded stable error codes without exposing thrown details', async () => {
    const deps = dependencies();
    deps.listContextMaps = vi.fn(async () => {
      throw new Error('token=must-not-cross');
    });
    const runtime = createTerminalCliRuntime(deps);

    const response = await runtime.execute(
      parseTerminalCliFrontendRequest(request('context.list')),
    );
    expect(response).toEqual({
      requestId: 'request-context-list',
      ok: false,
      code: 'internal_error',
      message: 'The terminal CLI command could not be completed.',
    });
    expect(JSON.stringify(response)).not.toContain('must-not-cross');
  });

  it('awaits the production current-project authority before dispatching', async () => {
    const deps = dependencies();
    deps.currentProject = vi.fn(async () => ({
      id: 'project-async',
      name: 'Async Project',
      workspaceId: 'workspace-a',
    })) as TerminalCliRuntimeDependencies['currentProject'];
    const runtime = createTerminalCliRuntime(deps);

    const response = await runtime.execute(
      parseTerminalCliFrontendRequest({
        ...request('project.current'),
        projectId: null,
      }),
    );

    expect(response).toMatchObject({
      ok: true,
      data: { project: { id: 'project-async', name: 'Async Project' } },
    });
  });
});
