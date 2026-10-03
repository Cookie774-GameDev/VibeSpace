import { RlmRuntimeError } from '@/features/context/rlmRuntime';
import * as contextPersistence from '@/features/context';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalTranscriptStore } from '@/features/terminals/transcriptStore';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { usePluginStore } from '@/features/plugins';
import * as mcpGatewayModule from '@/lib/mcp/vibeSpaceGateway';
import type { ProjectId, WorkspaceId } from '@/types/common';
import {
  clearToolGatewayMutationGrants,
  consumeToolGatewayContextCitationItems,
  createProductionToolGatewayDependencies,
  grantNextToolGatewayMutation,
  grantToolGatewayMutation,
  installToolGatewayRlmContextPort,
  installToolGatewayPluginReadPort,
  prepareCurrentRlmScopeRevision,
  readCurrentRlmScopeRevision,
} from './toolGatewayProduction';
import { registerToolGatewayFallbackCitations } from './toolGatewayCitations';
import {
  bindToolGatewayObservedExecutionAuthority,
  bindToolGatewaySessionAuthority,
  captureToolGatewayAuthorityClaim,
  releaseToolGatewaySessionAuthority,
} from './toolGatewayAuthority';
import { parseToolGatewayRequest } from './toolGatewayProtocol';
import { productionContextGateway } from '@/features/context/gateway/productionContextGateway';
import { ContextRequiredUnavailableError } from '@/features/context/gateway/ContextGateway';
import type { ContextReceipt } from '@/features/context/gateway/contextGatewayContracts';
import type { RlmContextLease } from '@/features/context/rlmOpenCodeTool';
import { createRlmOpenCodeTool } from '@/features/context/rlmOpenCodeTool';

vi.mock('@/lib/sync', () => ({
  enqueueMutation: vi.fn(async () => 'sync-test'),
}));

const observedIdentity = Object.freeze({
  transportConnectionId: 'opencode-cli',
  transportAdapterId: 'opencode-persistent',
  upstreamProviderId: 'opencode-go',
  upstreamModelId: 'deepseek-v4-flash-vision-exp',
  providerQualifiedModelId: 'opencode-go/deepseek-v4-flash-vision-exp',
  authBillingRoute: 'opencode-provider-session',
  effort: 'high',
  fastVariant: 'standard',
  catalogRevision: 'catalog-verified-7',
  observedProviderIdentity: 'opencode-go/deepseek-v4-flash-vision-exp',
});

function mutation() {
  return parseToolGatewayRequest({
    protocolVersion: 1,
    requestId: 'request-1',
    sessionId: 'session-1',
    messageId: 'message-1',
    tool: 'app.navigate',
    args: { route: '/terminal' },
    directory: 'C:\\work\\project',
  });
}

describe('production tool gateway dependencies', () => {
  it('admits a cold selected map after persistence publishes its initialization event', async () => {
    const authority = captureToolGatewayAuthorityClaim()!;
    expect(bindToolGatewaySessionAuthority('session-rlm-cold', authority, undefined, {
      requestId: 'provider-turn-cold', chatId: 'chat-cold',
      protectedAttempt: { accountId: 'account-a', runId: 'run-cold',
        requestId: 'provider-turn-cold', attemptNumber: 1 },
    })).toBe(true);
    const active = { accountId: 'account-a', projectId: 'project-a',
      selectedMapId: 'map-cold', maps: [{ id: 'map-cold', status: 'active' }] };
    let initialized = false;
    const selected = vi.spyOn(contextPersistence, 'getActiveContextPersistenceState')
      .mockImplementation(() => initialized ? active as never : null);
    const ensure = vi.spyOn(contextPersistence, 'ensureContextPersistence')
      .mockImplementation(async () => {
        initialized = true;
        window.dispatchEvent(new Event('jarvis:context-tree-updated'));
        return active as never;
      });
    const execute = vi.fn(async (..._args: unknown[]) => ({ mode: 'rlm' }));
    const dispose = installToolGatewayRlmContextPort({ execute });
    try {
      await expect(createProductionToolGatewayDependencies().context.rlm(
        { operation: 'describe' },
        { requestId: 'rlm-cold', sessionId: 'session-rlm-cold', messageId: 'provider-turn-cold',
          directory: 'C:\\work\\project', mutationApproved: false },
      )).resolves.toEqual({ mode: 'rlm' });
      expect(ensure).toHaveBeenCalledWith('project-a');
      const lease = execute.mock.calls.at(-1)![1] as RlmContextLease;
      expect(lease.selectedMapId).toBe('map-cold');
      expect(readCurrentRlmScopeRevision({ accountId: 'account-a', workspaceId: 'workspace-a',
        projectId: 'project-a' }, 'map-cold')).toBe(lease.contextRevision);
      expect(await prepareCurrentRlmScopeRevision({ accountId: 'account-a',
        workspaceId: 'workspace-a', projectId: 'project-a' }, 'map-cold')).toBe(true);
      expect(ensure).toHaveBeenCalledTimes(1);
    } finally {
      dispose(); ensure.mockRestore(); selected.mockRestore();
    }
  });

  it('rejects cold initialization if auth navigates A-B-A before the lease is issued', async () => {
    const authority = captureToolGatewayAuthorityClaim()!;
    expect(bindToolGatewaySessionAuthority('session-rlm-cold-aba', authority, undefined, {
      requestId: 'provider-turn-cold-aba', chatId: 'chat-cold-aba',
      protectedAttempt: { accountId: 'account-a', runId: 'run-cold-aba',
        requestId: 'provider-turn-cold-aba', attemptNumber: 1 },
    })).toBe(true);
    const active = { accountId: 'account-a', projectId: 'project-a',
      selectedMapId: 'map-cold', maps: [{ id: 'map-cold', status: 'active' }] };
    let initialized = false;
    const selected = vi.spyOn(contextPersistence, 'getActiveContextPersistenceState')
      .mockImplementation(() => initialized ? active as never : null);
    let finish!: () => void;
    const ensure = vi.spyOn(contextPersistence, 'ensureContextPersistence')
      .mockImplementation(async () => {
        await new Promise<void>((resolve) => { finish = resolve; });
        initialized = true;
        window.dispatchEvent(new Event('jarvis:context-tree-updated'));
        return active as never;
      });
    const execute = vi.fn(async (..._args: unknown[]) => ({ mode: 'rlm' }));
    const dispose = installToolGatewayRlmContextPort({ execute });
    try {
      const pending = createProductionToolGatewayDependencies().context.rlm(
        { operation: 'describe' },
        { requestId: 'rlm-cold-aba', sessionId: 'session-rlm-cold-aba', messageId: 'provider-turn-cold-aba',
          directory: 'C:\\work\\project', mutationApproved: false },
      );
      expect(ensure).toHaveBeenCalledTimes(1);
      useAuthStore.setState({ projectId: 'project-b' as ProjectId });
      useAuthStore.setState({ projectId: 'project-a' as ProjectId });
      finish();
      await expect(pending).rejects.toThrow('rlm_context_authority_unavailable');
      expect(execute).not.toHaveBeenCalled();
    } finally {
      dispose(); ensure.mockRestore(); selected.mockRestore();
    }
  });

  it('rejects a cold result after session release and a newer attempt is rebound', async () => {
    const authority = captureToolGatewayAuthorityClaim()!;
    const sessionId = 'session-rlm-cold-rebind';
    const requestId = 'provider-turn-cold-rebind';
    expect(bindToolGatewaySessionAuthority(sessionId, authority, undefined, {
      requestId, chatId: 'chat-cold-rebind',
      protectedAttempt: { accountId: 'account-a', runId: 'run-cold-rebind',
        requestId, attemptNumber: 1 },
    })).toBe(true);
    const active = { accountId: 'account-a', projectId: 'project-a',
      selectedMapId: 'map-cold', maps: [{ id: 'map-cold', status: 'active' }] };
    let initialized = false;
    const selected = vi.spyOn(contextPersistence, 'getActiveContextPersistenceState')
      .mockImplementation(() => initialized ? active as never : null);
    let finish!: () => void;
    const ensure = vi.spyOn(contextPersistence, 'ensureContextPersistence')
      .mockImplementation(async () => {
        await new Promise<void>((resolve) => { finish = resolve; });
        initialized = true;
        window.dispatchEvent(new Event('jarvis:context-tree-updated'));
        return active as never;
      });
    const execute = vi.fn(async (..._args: unknown[]) => ({ mode: 'rlm' }));
    const dispose = installToolGatewayRlmContextPort({ execute });
    try {
      const pending = createProductionToolGatewayDependencies().context.rlm(
        { operation: 'describe' },
        { requestId: 'rlm-cold-rebind', sessionId, messageId: requestId,
          directory: 'C:\\work\\project', mutationApproved: false },
      );
      expect(ensure).toHaveBeenCalledTimes(1);
      releaseToolGatewaySessionAuthority(sessionId);
      const replacement = captureToolGatewayAuthorityClaim()!;
      expect(bindToolGatewaySessionAuthority(sessionId, replacement, undefined, {
        requestId, chatId: 'chat-cold-rebind',
        protectedAttempt: { accountId: 'account-a', runId: 'run-cold-rebind',
          requestId, attemptNumber: 2 },
      })).toBe(true);
      finish();
      await expect(pending).rejects.toThrow('rlm_context_authority_unavailable');
      expect(execute).not.toHaveBeenCalled();
    } finally {
      dispose(); ensure.mockRestore(); selected.mockRestore();
      releaseToolGatewaySessionAuthority(sessionId);
    }
  });

  it('keeps a recursive investigation lease through its bounded work and expires it at 120 seconds', async () => {
    const authority = captureToolGatewayAuthorityClaim()!;
    expect(bindToolGatewayObservedExecutionAuthority('session-1', authority, {
      executionIdentity: observedIdentity, performance: 'quality',
    })).toBe(true);
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    const execute = vi.fn(async (_input: unknown, lease: RlmContextLease,
      _signal: AbortSignal | undefined, assertCurrent: (value: RlmContextLease) => string | undefined) => {
      expect(lease.expiresAt - startedAt).toBe(120_000);
      clock.mockReturnValue(startedAt + 31_000);
      expect(assertCurrent(lease)).toBe(lease.contextRevision);
      clock.mockReturnValue(startedAt + 95_000);
      expect(assertCurrent(lease)).toBe(lease.contextRevision);
      clock.mockReturnValue(startedAt + 120_001);
      expect(assertCurrent(lease)).toBeUndefined();
      return { mode: 'rlm' };
    });
    const dispose = installToolGatewayRlmContextPort({ execute });
    try {
      await expect(createProductionToolGatewayDependencies().context.rlm(
        { operation: 'investigate', query: 'Trace the selected physical source' },
        { requestId: 'rlm-long', sessionId: 'session-1', messageId: 'message-1',
          directory: 'C:\\work\\project', mutationApproved: false },
      )).resolves.toEqual({ mode: 'rlm' });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      dispose(); clock.mockRestore();
    }
  });

  it('revokes an issued RLM evidence lease after project A-B-A navigation', async () => {
    const execute = vi.fn(async (..._args: unknown[]) => ({ mode: 'rlm' }));
    const dispose = installToolGatewayRlmContextPort({ execute });
    try {
      await createProductionToolGatewayDependencies().context.rlm(
        { operation: 'describe' },
        { requestId: 'rlm-aba', sessionId: 'session-1', messageId: 'message-1',
          directory: 'C:\\work\\project', mutationApproved: false },
      );
      const call = execute.mock.calls.at(-1)!;
      const lease = call[1] as RlmContextLease;
      const assertCurrent = call[3] as (value: Readonly<RlmContextLease>) => string | undefined;
      expect(Object.isFrozen(lease)).toBe(true);
      expect(assertCurrent(lease)).toBe(lease.contextRevision);
      const factoryAndPortClone = Object.freeze({ ...lease,
        ...(lease.executionIdentity ? { executionIdentity: Object.freeze({ ...lease.executionIdentity }) } : {}),
        ...(lease.canonicalBinding ? { canonicalBinding: Object.freeze({ ...lease.canonicalBinding }) } : {}),
      });
      expect(assertCurrent(factoryAndPortClone)).toBe(lease.contextRevision);
      useAuthStore.setState({ projectId: 'project-b' as ProjectId });
      useAuthStore.setState({ projectId: 'project-a' as ProjectId });
      expect(assertCurrent(lease)).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it('revokes an issued RLM evidence lease after selected-map A-B-A publication', async () => {
    const active = { accountId: 'account-a', projectId: 'project-a',
      selectedMapId: 'map-a', maps: [{ id: 'map-a', status: 'active' }] };
    const selected = vi.spyOn(contextPersistence, 'getActiveContextPersistenceState')
      .mockReturnValue(active as never);
    const execute = vi.fn(async (..._args: unknown[]) => ({ mode: 'rlm' }));
    const dispose = installToolGatewayRlmContextPort({ execute });
    try {
      await createProductionToolGatewayDependencies().context.rlm(
        { operation: 'describe' },
        { requestId: 'rlm-map-aba', sessionId: 'session-1', messageId: 'message-1',
          directory: 'C:\\work\\project', mutationApproved: false },
      );
      const call = execute.mock.calls.at(-1)!;
      const lease = call[1] as RlmContextLease;
      const assertCurrent = call[3] as (value: Readonly<RlmContextLease>) => string | undefined;
      expect(assertCurrent(lease)).toBe(lease.contextRevision);
      expect(readCurrentRlmScopeRevision({ accountId: 'account-a', workspaceId: 'workspace-a',
        projectId: 'project-a' }, 'map-a')).toBe(lease.contextRevision);
      selected.mockReturnValue({ ...active, selectedMapId: 'map-b',
        maps: [{ id: 'map-b', status: 'active' }] } as never);
      window.dispatchEvent(new Event('jarvis:context-tree-updated'));
      selected.mockReturnValue(active as never);
      window.dispatchEvent(new Event('jarvis:context-tree-updated'));
      expect(assertCurrent(lease)).toBeUndefined();
      expect(readCurrentRlmScopeRevision({ accountId: 'account-a', workspaceId: 'workspace-a',
        projectId: 'project-a' }, 'map-a')).not.toBe(lease.contextRevision);
    } finally {
      dispose();
      selected.mockRestore();
    }
  });

  it('accepts the real RLM port lease clone, then rejects an async result after project A-B-A', async () => {
    const result = { items: [] as unknown[] };
    const search = vi.fn(async () => result);
    const empty = async () => result;
    const port = createRlmOpenCodeTool({
      queryService: { describe: empty, search, open: empty, expand: empty,
        related: empty, timeline: empty, sources: empty, checkpoint: empty },
      rlmRuntime: { investigate: empty },
      verifiedFallbackCitations: async () => [],
    });
    const dispose = installToolGatewayRlmContextPort(port);
    const input = { requestId: 'rlm-real-port', sessionId: 'session-1', messageId: 'message-1',
      directory: 'C:\\work\\project', mutationApproved: false };
    try {
      await expect(createProductionToolGatewayDependencies().context.rlm(
        { operation: 'search', query: 'needle' }, input)).resolves.toBe(result);
      let resolveDeferred!: (value: typeof result) => void;
      search.mockImplementationOnce(() => new Promise<typeof result>((resolve) => {
        resolveDeferred = resolve;
      }));
      const pending = createProductionToolGatewayDependencies().context.rlm(
        { operation: 'search', query: 'needle' }, input);
      useAuthStore.setState({ projectId: 'project-b' as ProjectId });
      useAuthStore.setState({ projectId: 'project-a' as ProjectId });
      resolveDeferred(result);
      await expect(pending).rejects.toMatchObject({ code: 'lease_not_current' });
    } finally {
      dispose();
    }
  });

  it('binds RLM trace authority to the issued attempt and authenticated selected map', async () => {
    const authority = captureToolGatewayAuthorityClaim()!;
    const sessionId = 'session-rlm-issued-map';
    const binding = { accountId: 'account-a', runId: 'jrun_issued_map',
      requestId: 'provider-turn-map', attemptNumber: 2 };
    expect(bindToolGatewaySessionAuthority(sessionId, authority, undefined, {
      requestId: binding.requestId, chatId: 'chat-map', protectedAttempt: binding,
    })).toBe(true);
    expect(bindToolGatewayObservedExecutionAuthority(sessionId, authority, {
      executionIdentity: observedIdentity, performance: 'quality',
    })).toBe(true);
    const selected = vi.spyOn(contextPersistence, 'getActiveContextPersistenceState')
      .mockReturnValue({ accountId: 'account-a', projectId: 'project-a',
        selectedMapId: 'map-active',
        maps: [{ id: 'map-active', status: 'active' }] } as never);
    const execute = vi.fn(async (..._args: unknown[]) => ({ answer: 'Bounded retrieval' }));
    const dispose = installToolGatewayRlmContextPort({ execute });
    const input = { requestId: 'tool-map', sessionId, messageId: binding.requestId,
      directory: 'C:\\work\\project', mutationApproved: false };
    try {
      await createProductionToolGatewayDependencies().context.rlm(
        { operation: 'investigate', query: 'Find mapped source' }, input);
      expect(execute).toHaveBeenLastCalledWith(expect.anything(),
        expect.objectContaining({ accountId: 'account-a', selectedMapId: 'map-active',
          canonicalBinding: { runId: binding.runId, requestId: binding.requestId,
            attemptNumber: 2 } }), undefined, expect.any(Function));

      selected.mockReturnValue({ accountId: 'other-account', projectId: 'project-a',
        selectedMapId: 'map-active',
        maps: [{ id: 'map-active', status: 'active' }] } as never);
      await createProductionToolGatewayDependencies().context.rlm(
        { operation: 'investigate', query: 'Find mapped source' }, input);
      expect(execute.mock.calls.at(-1)?.[1]).not.toHaveProperty('selectedMapId');
    } finally {
      dispose();
      selected.mockRestore();
    }
  });

  it('captures the exact bound chat identity for RLM preferences instead of model input', async () => {
    const authority = captureToolGatewayAuthorityClaim()!;
    const sessionId = 'session-rlm-chat-preference';
    expect(
      bindToolGatewaySessionAuthority(sessionId, authority, undefined, {
        requestId: 'provider-turn-chat',
        chatId: 'chat-rlm-off',
      }),
    ).toBe(true);
    expect(
      bindToolGatewayObservedExecutionAuthority(sessionId, authority, {
        executionIdentity: observedIdentity,
        performance: 'quality',
      }),
    ).toBe(true);
    const execute = vi.fn(async () => ({ answer: 'Bounded retrieval' }));
    const dispose = installToolGatewayRlmContextPort({ execute });
    try {
      await createProductionToolGatewayDependencies().context.rlm(
        { operation: 'investigate', query: 'Find the project fixture' },
        {
          requestId: 'tool-chat',
          sessionId,
          messageId: 'provider-turn-chat',
          directory: 'C:\\work\\project',
          mutationApproved: false,
        },
      );
      expect(execute).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ chatId: 'chat-rlm-off' }),
        undefined,
        expect.any(Function),
      );
    } finally {
      dispose();
    }
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    clearToolGatewayMutationGrants();
    usePluginStore.setState({
      connectionsByAccount: {
        'account-a': {
          github: {
            accountId: 'account-a',
            pluginId: 'github',
            state: 'connected',
            enabled: true,
            enabledProjectIds: ['project-a'],
            configuredFields: [],
            updatedAt: 1,
          },
        },
      },
    });
    useAuthStore.setState({
      localUserId: 'account-a',
      cloudSession: null,
      workspaceId: 'workspace-a' as WorkspaceId,
      projectId: 'project-a' as ProjectId,
    });
    const authority = captureToolGatewayAuthorityClaim()!;
    bindToolGatewaySessionAuthority('session-1', authority);
    bindToolGatewaySessionAuthority('different-session', authority);
  });

  it('consumes an exact short-lived session grant once', async () => {
    const deps = createProductionToolGatewayDependencies();
    await expect(Promise.resolve(deps.authorizeMutation(mutation()))).resolves.toBe(false);
    grantNextToolGatewayMutation('different-session');
    await expect(Promise.resolve(deps.authorizeMutation(mutation()))).resolves.toBe(false);
    grantNextToolGatewayMutation('session-1');
    await expect(Promise.resolve(deps.authorizeMutation(mutation()))).resolves.toBe(true);
    await expect(Promise.resolve(deps.authorizeMutation(mutation()))).resolves.toBe(false);
  });

  it('binds once and always grants to the exact semantic capability', async () => {
    const deps = createProductionToolGatewayDependencies();
    const navigation = mutation();
    const terminalWrite = parseToolGatewayRequest({
      ...navigation,
      requestId: 'request-2',
      tool: 'terminal.write',
      args: { terminal: 4, command: 'git status' },
    });

    grantToolGatewayMutation('session-1', 'app.navigate', 'once');
    await expect(Promise.resolve(deps.authorizeMutation(terminalWrite))).resolves.toBe(false);
    await expect(Promise.resolve(deps.authorizeMutation(navigation))).resolves.toBe(true);
    await expect(Promise.resolve(deps.authorizeMutation(navigation))).resolves.toBe(false);

    grantToolGatewayMutation('session-1', 'app.navigate', 'always');
    await expect(Promise.resolve(deps.authorizeMutation(navigation))).resolves.toBe(true);
    await expect(Promise.resolve(deps.authorizeMutation(navigation))).resolves.toBe(true);
  });

  it.each([
    ['account', () => useAuthStore.setState({ localUserId: 'account-b' }), false],
    ['workspace', () => useAuthStore.setState({ workspaceId: 'workspace-b' as WorkspaceId }), false],
    ['project', () => useAuthStore.setState({ projectId: 'project-b' as ProjectId }), true],
  ])('handles an approval when the %s authority changes', async (_label, transition, expected) => {
    const deps = createProductionToolGatewayDependencies();
    const navigation = mutation();

    grantToolGatewayMutation('session-1', 'app.navigate', 'always');
    await expect(Promise.resolve(deps.authorizeMutation(navigation))).resolves.toBe(true);

    transition();
    await expect(Promise.resolve(deps.authorizeMutation(navigation))).resolves.toBe(expected);
  });

  it('binds reads to one scope and rejects the session after a scope transition', async () => {
    const deps = createProductionToolGatewayDependencies();
    const read = parseToolGatewayRequest({
      ...mutation(),
      requestId: 'request-read',
      tool: 'app.getState',
      args: {},
    });

    await expect(Promise.resolve(deps.authorizeRequest(read))).resolves.toBe(true);
    useAuthStore.setState({ workspaceId: 'workspace-b' as WorkspaceId });
    await expect(Promise.resolve(deps.authorizeRequest(read))).resolves.toBe(false);
    useAuthStore.setState({ workspaceId: 'workspace-a' as WorkspaceId });
    await expect(Promise.resolve(deps.authorizeRequest(read))).resolves.toBe(false);
  });

  it('reads bounded visible terminal and app state without mutation authority', async () => {
    useTerminalTranscriptStore.setState({ sessions: {} });
    useTerminalTranscriptStore.getState().registerSession('tty-1', {
      paneId: 'pane-1',
      projectId: null,
      command: 'pwsh',
    });
    useTerminalTranscriptStore.getState().appendOutput('tty-1', 'ready');
    useUIStore.getState().setRoute('chat');
    const deps = createProductionToolGatewayDependencies();

    await expect(Promise.resolve(deps.terminal.list({}, {} as never))).resolves.toEqual([
      expect.objectContaining({ sessionId: 'tty-1', outputChars: 5 }),
    ]);
    await expect(Promise.resolve(deps.app.getState({}, {} as never))).resolves.toEqual(
      expect.objectContaining({ route: 'chat', terminalCount: 1 }),
    );
  });

  it('delegates a fixed plugin operation through the live read-only security port', async () => {
    const run = vi.fn(async () => ({
      ok: true as const,
      summary: 'Fixed plugin tool completed.',
      data: { login: 'octocat' },
    }));
    const dispose = installToolGatewayPluginReadPort({ run });
    const deps = createProductionToolGatewayDependencies();
    useAuthStore.setState({ projectId: 'project-b' as ProjectId });
    const context = {
      requestId: 'request-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      mutationApproved: false,
    };

    await expect(
      Promise.resolve(
        deps.plugins.run(
          {
            pluginId: 'github',
            operation: 'identity',
            input: { owner: 'vibespace' },
          },
          context,
        ),
      ),
    ).resolves.toEqual({
      summary: 'Fixed plugin tool completed.',
      data: { login: 'octocat' },
    });
    expect(run).toHaveBeenCalledWith({
      pluginId: 'github',
      operation: 'identity',
      params: { owner: 'vibespace' },
      context,
    });
    dispose();
    await expect(
      Promise.resolve(
        deps.plugins.run({ pluginId: 'github', operation: 'identity', input: {} }, context),
      ),
    ).rejects.toThrow('plugin_operation_unavailable');
  });

  it('marks the still-current plugin connection for reauthorization after a provider 401', async () => {
    const dispose = installToolGatewayPluginReadPort({
      run: vi.fn().mockRejectedValue(new Error('connection_rejected_401')),
    });
    try {
      await expect(
        createProductionToolGatewayDependencies().plugins.run(
          { pluginId: 'github', operation: 'identity', input: {} },
          { requestId: 'request-401', sessionId: 'session-1', messageId: 'message-401', mutationApproved: false },
        ),
      ).rejects.toMatchObject({
        code: 'plugin_operation_failed',
        data: { pluginId: 'github', reason: 'connection_rejected_401' },
      });
    } finally {
      dispose();
    }

    expect(usePluginStore.getState().connectionsByAccount['account-a'].github).toMatchObject({
      state: 'reauthorize',
      enabled: false,
      enabledProjectIds: ['project-a'],
      error: 'GitHub identity failed (connection_rejected_401). Reconnect GitHub in Plugins.',
      lastTestedAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
  });

  it('does not let an old provider 401 invalidate a connection reauthorized in flight', async () => {
    const run = vi.fn(async () => {
      const current = usePluginStore.getState().connectionsByAccount['account-a'].github;
      usePluginStore.setState({
        connectionsByAccount: {
          ...usePluginStore.getState().connectionsByAccount,
          'account-a': {
            ...usePluginStore.getState().connectionsByAccount['account-a'],
            github: {
              ...current,
              state: 'connected',
              enabled: true,
              accountLabel: 'Reauthorized account',
              updatedAt: 2,
            },
          },
        },
      });
      throw new Error('connection_rejected_401');
    });
    const dispose = installToolGatewayPluginReadPort({ run });
    try {
      await expect(
        createProductionToolGatewayDependencies().plugins.run(
          { pluginId: 'github', operation: 'identity', input: {} },
          { requestId: 'request-stale-401', sessionId: 'session-1', messageId: 'message-stale-401', mutationApproved: false },
        ),
      ).rejects.toMatchObject({ data: { reason: 'connection_rejected_401' } });
    } finally {
      dispose();
    }

    expect(usePluginStore.getState().connectionsByAccount['account-a'].github).toMatchObject({
      state: 'connected',
      enabled: true,
      accountLabel: 'Reauthorized account',
      updatedAt: 2,
    });
  });

  it('classifies only declared read-only plugin operations from trusted metadata', () => {
    const plugins = createProductionToolGatewayDependencies().plugins;
    expect(plugins.isReadOnly?.({ pluginId: 'github', operation: 'identity' })).toBe(true);
    expect(plugins.isReadOnly?.({ pluginId: 'github', operation: 'delete_repository', readOnly: true })).toBe(false);
    expect(plugins.isReadOnly?.({ pluginId: 'unknown', operation: 'identity', classification: 'read' })).toBe(false);
  });

  it.each([
    ['Plugin credential authority denied the operation: credential_grant_unavailable.', 'credential_grant_unavailable'],
    ['Plugin credential authority denied the operation: connection_rejected_401.', 'connection_rejected_401'],
    ['provider_response_invalid', 'provider_response_invalid'],
    ['request https://private.example/?token=secret failed: Bearer private-value', 'internal_plugin_failure'],
    ['Plugin credential authority denied the operation: credential_grant_unavailable. token=secret', 'internal_plugin_failure'],
  ])('reports only safe plugin failure codes: %s', async (error, reason) => {
    const dispose = installToolGatewayPluginReadPort({ run: vi.fn().mockRejectedValue(new Error(error)) });
    try {
      await expect(createProductionToolGatewayDependencies().plugins.run(
        { pluginId: 'github', operation: 'identity', input: {} },
        { requestId: 'request-1', sessionId: 'session-1', messageId: 'message-1', mutationApproved: false },
      )).rejects.toMatchObject({
        name: 'ToolGatewaySemanticError',
        code: 'plugin_operation_failed',
        message: `GitHub identity failed (${reason}).${reason.startsWith('credential_') || reason === 'connection_rejected_401' ? ' Reconnect GitHub in Plugins.' : ''}`,
        data: { pluginId: 'github', operation: 'identity', reason },
      });
    } finally { dispose(); }
  });

  it('does not expose raw provider failures returned by a plugin', async () => {
    const dispose = installToolGatewayPluginReadPort({ run: vi.fn().mockResolvedValue({ ok: false, error: 'token=secret raw provider body' }) });
    try {
      await expect(createProductionToolGatewayDependencies().plugins.run(
        { pluginId: 'github', operation: 'identity', input: {} },
        { requestId: 'request-1', sessionId: 'session-1', messageId: 'message-1', mutationApproved: false },
      )).rejects.toMatchObject({
        code: 'plugin_operation_failed',
        message: 'GitHub identity failed (internal_plugin_failure).',
        data: { pluginId: 'github', operation: 'identity', reason: 'internal_plugin_failure' },
      });
    } finally { dispose(); }
  });

  it('lists only plugins connected and enabled for the exact local account and project', async () => {
    usePluginStore.setState({
      connectionsByAccount: {
        'account-a': {
          github: {
            accountId: 'account-a',
            pluginId: 'github',
            state: 'connected',
            enabled: true,
            enabledProjectIds: ['project-a'],
            configuredFields: [],
            updatedAt: 1,
          },
          gmail: {
            accountId: 'account-a',
            pluginId: 'gmail',
            state: 'connected',
            enabled: true,
            enabledProjectIds: ['different-project'],
            configuredFields: [],
            updatedAt: 1,
          },
        },
      },
    });

    const listed = await Promise.resolve(
      createProductionToolGatewayDependencies().plugins.list({}, {
        requestId: 'request-list-plugins',
        sessionId: 'session-1',
        messageId: 'message-list-plugins',
        mutationApproved: false,
      }),
    );
    expect(listed).toEqual([expect.objectContaining({ id: 'github', connected: true })]);
  });

  it('restores approved MCPs automatically and exposes only connected approved tools', async () => {
    const restoreApprovedConnections = vi.fn(async () => ({
      restoredIds: ['docs-server'],
      skippedIds: [],
      failedIds: [],
    }));
    const getSnapshot = vi.fn(() => [
      {
        id: 'docs-server',
        endpoint: 'https://mcp.example.test',
        state: 'connected',
        trust: 'approved',
        durableApproval: true,
        schemaDigest: 'schema-1',
        reconnectAttempt: 0,
        exposedTools: ['search'],
        tools: [
          {
            name: 'search',
            description: 'Search project documentation.',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string' },
                apiKey: { type: 'string' },
              },
              required: ['query', 'apiKey'],
            },
            exposed: true,
            classification: 'read',
          },
          {
            name: 'hidden',
            description: 'Must stay hidden.',
            inputSchema: { type: 'object' },
            exposed: false,
            classification: 'read',
          },
        ],
      },
      {
        id: 'changed-server',
        endpoint: 'https://changed.example.test',
        state: 'connected',
        trust: 'changed',
        durableApproval: true,
        schemaDigest: 'schema-2',
        reconnectAttempt: 0,
        exposedTools: ['unsafe'],
        tools: [],
      },
    ]);
    vi.spyOn(mcpGatewayModule, 'getVibeSpaceMcpGateway').mockReturnValue({
      restoreApprovedConnections,
      getSnapshot,
    } as never);

    const result = await Promise.resolve(
      createProductionToolGatewayDependencies().mcp.list({}, {
        requestId: 'request-list-mcp',
        sessionId: 'session-1',
        messageId: 'message-list-mcp',
        mutationApproved: false,
      }),
    );

    expect(restoreApprovedConnections).toHaveBeenCalledOnce();
    expect(result).toEqual([
      {
        connectionId: 'docs-server',
        tools: [
          {
            name: 'search',
            description: 'Search project documentation.',
            classification: 'read',
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          },
        ],
      },
    ]);
  });

  it('invokes the exact restored MCP tool with project scope, classification, and approval', async () => {
    const invoke = vi.fn(async () => ({
      result: { matches: 2 },
      receipt: { receiptId: 'mcpinv-1', status: 'succeeded' },
    }));
    const gateway = {
      restoreApprovedConnections: vi.fn(async () => ({
        restoredIds: [],
        skippedIds: ['docs-server'],
        failedIds: [],
      })),
      getSnapshot: vi.fn(() => [
        {
          id: 'docs-server',
          state: 'connected',
          trust: 'approved',
          durableApproval: true,
          schemaDigest: 'schema-1',
          exposedTools: ['search'],
          tools: [
            {
              name: 'search',
              description: 'Search project documentation.',
              inputSchema: { type: 'object' },
              exposed: true,
              classification: 'write',
            },
          ],
        },
      ]),
      invoke,
    };
    vi.spyOn(mcpGatewayModule, 'getVibeSpaceMcpGateway').mockReturnValue(gateway as never);
    const context = {
      requestId: 'request-mcp',
      sessionId: 'session-1',
      messageId: 'message-1',
      mutationApproved: true,
      signal: new AbortController().signal,
    };
    useAuthStore.setState({ projectId: 'project-b' as ProjectId });

    await expect(
      Promise.resolve(
        createProductionToolGatewayDependencies().mcp.run(
          {
            connectionId: 'docs-server',
            toolName: 'search',
            classification: 'write',
            input: { query: 'VibeSpace' },
          },
          context,
        ),
      ),
    ).resolves.toEqual({
      result: { matches: 2 },
      receipt: { receiptId: 'mcpinv-1', status: 'succeeded' },
    });
    expect(gateway.restoreApprovedConnections).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith({
      accountId: 'account-a',
      projectId: 'project-a',
      taskId: 'request-mcp',
      signal: context.signal,
      connectionId: 'docs-server',
      toolName: 'search',
      arguments: { query: 'VibeSpace' },
      allowedTools: ['docs-server.search'],
      classification: 'write',
      approval: { confirmedByUser: true },
    });
  });

  it('does not let a stale plugin-port disposer revoke a newer host', async () => {
    expect(
      bindToolGatewaySessionAuthority('session-2', captureToolGatewayAuthorityClaim()!),
    ).toBe(true);
    const first = installToolGatewayPluginReadPort({
      run: vi.fn(async () => ({ ok: true as const, data: 'first' })),
    });
    const secondRun = vi.fn(async () => ({ ok: true as const, data: 'second' }));
    const second = installToolGatewayPluginReadPort({ run: secondRun });
    first();

    await expect(
      Promise.resolve(
        createProductionToolGatewayDependencies().plugins.run(
          { pluginId: 'github', operation: 'identity', input: {} },
          {
            requestId: 'request-2',
            sessionId: 'session-2',
            messageId: 'message-2',
            mutationApproved: false,
          },
        ),
      ),
    ).resolves.toEqual({ summary: undefined, data: 'second' });
    expect(secondRun).toHaveBeenCalledOnce();
    second();
  });

  it('binds the RLM context port to the session account, project, worktree, and session', async () => {
    const execute = vi.fn(async () => ({ mode: 'rlm', bounded: true }));
    const dispose = installToolGatewayRlmContextPort({ execute });
    const deps = createProductionToolGatewayDependencies();
    const context = {
      requestId: 'request-rlm',
      sessionId: 'session-1',
      messageId: 'message-1',
      directory: 'C:\\work\\project',
      worktree: 'C:\\work\\project\\.worktrees\\feature',
      mutationApproved: false,
    };
    useAuthStore.setState({ projectId: 'project-b' as ProjectId });

    await expect(
      Promise.resolve(deps.context.rlm({ operation: 'describe' }, context)),
    ).resolves.toEqual({ mode: 'rlm', bounded: true });
    expect(execute).toHaveBeenCalledWith(
      { operation: 'describe' },
      expect.objectContaining({
        sessionId: 'session-1',
        accountId: 'account-a',
        projectId: 'project-a',
        worktreeId: 'C:\\work\\project\\.worktrees\\feature',
      }),
      undefined,
      expect.any(Function),
    );
    dispose();
  });

  it('fails a high-level Context query closed until the exact session has observed execution identity', async () => {
    const execute = vi.fn(async () => ({ mode: 'legacy' }));
    const dispose = installToolGatewayRlmContextPort({ execute });
    const deps = createProductionToolGatewayDependencies();

    await expect(
      Promise.resolve().then(() =>
        deps.context.rlm(
          { operation: 'query', query: 'Find the exact project context.' },
          {
            requestId: 'request-unobserved',
            sessionId: 'different-session',
            messageId: 'message-1',
            worktree: 'C:\\work\\project\\.worktrees\\feature',
            mutationApproved: false,
          },
        ),
      ),
    ).rejects.toThrow('gateway_execution_identity_unavailable');
    expect(execute).not.toHaveBeenCalled();
    dispose();
  });

  it('routes an observed high-level Context query through the shared Gateway with exact identity', async () => {
    const authority = captureToolGatewayAuthorityClaim()!;
    expect(
      bindToolGatewayObservedExecutionAuthority('session-1', authority, {
        executionIdentity: observedIdentity,
        performance: 'quality',
      }),
    ).toBe(true);
    const execute = vi.fn(async () => ({ mode: 'legacy' }));
    const dispose = installToolGatewayRlmContextPort({ execute });
    const gatewayResult = Object.freeze({
      promptBlock: '<vibespace_context>grounded</vibespace_context>',
      receipt: Object.freeze({ receiptId: 'context-receipt-1' }),
    });
    const ask = vi.spyOn(productionContextGateway, 'ask').mockResolvedValue(gatewayResult as never);
    const deps = createProductionToolGatewayDependencies();

    await expect(
      Promise.resolve(
        deps.context.rlm(
          { operation: 'query', query: 'Find the exact project context.' },
          {
            requestId: 'request-gateway',
            sessionId: 'session-1',
            messageId: 'message-1',
            directory: 'C:\\work\\project',
            worktree: 'C:\\work\\project\\.worktrees\\feature',
            mutationApproved: false,
          },
        ),
      ),
    ).resolves.toBe(gatewayResult);
    expect(ask).toHaveBeenCalledWith({
      requestId: 'request-gateway',
      question: 'Find the exact project context.',
      scope: {
        accountId: 'account-a',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        worktreeId: 'C:\\work\\project\\.worktrees\\feature',
        revision: 'session-1:0',
      },
      taskKind: 'answer',
      access: 'read',
      workingSet: 'incomplete',
      userIntent: { context: true },
      optionalEnrichmentEnabled: true,
      executionIdentity: observedIdentity,
      performance: 'quality',
      activePaths: ['C:\\work\\project'],
    });
    expect(execute).not.toHaveBeenCalled();
    ask.mockRestore();
    dispose();
  });

  it('routes explicit investigate through the installed recursive RLM port with observed identity and cancellation', async () => {
    const authority = captureToolGatewayAuthorityClaim()!;
    expect(bindToolGatewayObservedExecutionAuthority('session-1', authority, {
      executionIdentity: observedIdentity,
      performance: 'quality',
    })).toBe(true);
    const result = Object.freeze({ answer: 'Grounded answer', citations: Object.freeze([]),
      trace: Object.freeze({ mode: 'rlm', usage: { subcalls: 1 } }) });
    const execute = vi.fn(async () => result);
    const dispose = installToolGatewayRlmContextPort({ execute });
    const ask = vi.spyOn(productionContextGateway, 'ask');
    const signal = new AbortController().signal;
    const args = { operation: 'investigate', query: 'Trace the active mapped source.' };

    await expect(Promise.resolve(createProductionToolGatewayDependencies().context.rlm(args, {
      requestId: 'request-rlm-investigate', sessionId: 'session-1', messageId: 'message-1',
      directory: 'C:\\work\\project', worktree: 'C:\\work\\project\\.worktrees\\feature',
      mutationApproved: false, signal,
    }))).resolves.toBe(result);
    expect(execute).toHaveBeenCalledWith(args, expect.objectContaining({
      sessionId: 'session-1', accountId: 'account-a', projectId: 'project-a',
      worktreeId: 'C:\\work\\project\\.worktrees\\feature', executionIdentity: observedIdentity,
    }), signal, expect.any(Function));
    expect(ask).not.toHaveBeenCalled();
    ask.mockRestore();
    dispose();
  });

  it('passes only investigate inputs accepted by the recursive port when the tool supplies search display limits', async () => {
    const authority = captureToolGatewayAuthorityClaim()!;
    expect(bindToolGatewayObservedExecutionAuthority('session-1', authority, {
      executionIdentity: observedIdentity,
      performance: 'quality',
    })).toBe(true);
    const execute = vi.fn(async () => ({ answer: 'Grounded answer' }));
    const dispose = installToolGatewayRlmContextPort({ execute });

    await createProductionToolGatewayDependencies().context.rlm(
      { operation: 'investigate', query: 'Trace mapped source.', limit: 10, maxBytes: 12_000 },
      {
        requestId: 'request-investigate-display-limits', sessionId: 'session-1', messageId: 'message-1',
        directory: 'C:\\work\\project', mutationApproved: false,
      },
    );

    expect(execute).toHaveBeenCalledWith(
      { operation: 'investigate', query: 'Trace mapped source.' },
      expect.objectContaining({ executionIdentity: observedIdentity }),
      undefined,
      expect.any(Function),
    );
    dispose();
  });

  it('projects recursive trace onto the provider-safe result while preserving usage and citations', async () => {
    const authority = captureToolGatewayAuthorityClaim()!;
    expect(bindToolGatewayObservedExecutionAuthority('session-1', authority, {
      executionIdentity: observedIdentity, performance: 'quality',
    })).toBe(true);
    const citation = { id: 'ptr:rlm:record:0:12', recordId: 'record', byteStart: 0,
      byteEnd: 12, sourceVersion: 'sha256:' + 'a'.repeat(64), contentHash: 'a'.repeat(64) };
    const execute = vi.fn(async () => ({ answer: 'Grounded answer', citations: [citation], trace: {
      mode: 'rlm', events: [{ type: 'child_completed', at: 1, depth: 1 }],
      usage: { subcalls: 1, toolCalls: 2, openBytes: 12, maxDepthReached: 1 },
      budget: { maxInputTokens: 8192, maxOutputTokens: 2048 }, budgetExhausted: false,
    } }));
    const dispose = installToolGatewayRlmContextPort({ execute });

    const result = await createProductionToolGatewayDependencies().context.rlm(
      { operation: 'investigate', query: 'Trace mapped source.' },
      { requestId: 'request-investigate-safe-trace', sessionId: 'session-1',
        messageId: 'message-1', directory: 'C:\\work\\project', mutationApproved: false },
    );

    expect(result).toMatchObject({ answer: 'Grounded answer', citations: [citation],
      trace: { mode: 'rlm', usage: { subcalls: 1 }, events: [{ type: 'child_completed' }] } });
    expect((result as { trace: Record<string, unknown> }).trace).not.toHaveProperty('budget');
    expect(consumeToolGatewayContextCitationItems('session-1')).toEqual([]);
    const original = await execute.mock.results[0]!.value;
    expect(original.answer).toBe('Grounded answer');
    expect(original.trace).toHaveProperty('budget');
    dispose();
  });

  it.each(['execution_route_unavailable', 'cancelled'] as const)(
    'preserves safe actual tool receipts on recursive %s errors', async (code) => {
      const authority = captureToolGatewayAuthorityClaim()!;
      expect(bindToolGatewayObservedExecutionAuthority('session-1', authority, {
        executionIdentity: observedIdentity, performance: 'quality',
      })).toBe(true);
      const error = new RlmRuntimeError(code, 'private provider payload must not escape');
      const invocation = Object.freeze({ id: 'run-trace:tool-1', runId: 'run-trace',
        operation: 'search' as const, depth: 0, startedAt: 10, finishedAt: 12,
        status: 'completed' as const });
      error.toolInvocations = Object.freeze([invocation]);
      const dispose = installToolGatewayRlmContextPort({ execute: vi.fn(async () => { throw error; }) });
      try {
        await expect(createProductionToolGatewayDependencies().context.rlm(
          { operation: 'investigate', query: 'Find mapped source.' },
          { requestId: 'request-failed-trace', sessionId: 'session-1', messageId: 'message-1',
            directory: 'C:\\work\\project', mutationApproved: false },
        )).rejects.toMatchObject({ code: `rlm_${code}`,
          message: 'The bounded context investigation could not complete.',
          data: { code, toolInvocations: [invocation] } });
      } finally { dispose(); }
    },
  );

  it('preserves the exact empty-first failure receipt as a continuable semantic boundary', async () => {
    const authority = captureToolGatewayAuthorityClaim()!;
    expect(
      bindToolGatewayObservedExecutionAuthority('session-1', authority, {
        executionIdentity: observedIdentity,
        performance: 'quality',
      }),
    ).toBe(true);
    const receipt = Object.freeze({
      receiptId: 'context-receipt-empty-first',
      policyVersion: 'vibespace-context-policy-v1',
      route: 'focused',
      decision: 'blocked-context-unavailable',
      required: true,
      decisionReasons: Object.freeze(['explicit-context'] as const),
      scopeRevision: Object.freeze({
        accountId: 'account-a',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        worktreeId: 'C:\\work\\project',
        revision: 'session-1:0',
      }),
      sourceRevisions: Object.freeze([]),
      evidenceHandles: Object.freeze([]),
      cacheStatus: 'not-applicable',
      queueDepthAtStart: 0,
      stageTimingsMs: Object.freeze({ decision: 1 }),
      cancellationGeneration: 0,
      safeFailure: 'retrieval-failed',
      executionIdentity: observedIdentity,
    } as const) satisfies Readonly<ContextReceipt>;
    const ask = vi
      .spyOn(productionContextGateway, 'ask')
      .mockRejectedValue(new ContextRequiredUnavailableError(receipt));

    await expect(
      Promise.resolve(
        createProductionToolGatewayDependencies().context.rlm(
          { operation: 'query', query: 'Find the project evidence, then continue the safe work.' },
          {
            requestId: 'request-empty-first',
            sessionId: 'session-1',
            messageId: 'message-empty-first',
            directory: 'C:\\work\\project',
            mutationApproved: false,
          },
        ),
      ),
    ).rejects.toMatchObject({
      name: 'ToolGatewaySemanticError',
      code: 'context_unavailable',
      data: {
        grounded: false,
        required: true,
        safeFailure: 'retrieval-failed',
        receiptId: 'context-receipt-empty-first',
        route: 'focused',
        scopeRevision: receipt.scopeRevision,
      },
    });
    expect(consumeToolGatewayContextCitationItems('session-1')).toEqual([]);
    ask.mockRestore();
  });

  it('uses the exact main-checkout directory when OpenCode omits its optional worktree field', async () => {
    const authority = captureToolGatewayAuthorityClaim()!;
    expect(
      bindToolGatewayObservedExecutionAuthority('session-1', authority, {
        executionIdentity: observedIdentity,
        performance: 'quality',
      }),
    ).toBe(true);
    const gatewayResult = Object.freeze({
      promptBlock: '<vibespace_context>grounded main checkout</vibespace_context>',
      receipt: Object.freeze({ receiptId: 'context-receipt-main-checkout' }),
    });
    const ask = vi.spyOn(productionContextGateway, 'ask').mockResolvedValue(gatewayResult as never);

    await expect(
      Promise.resolve(
        createProductionToolGatewayDependencies().context.rlm(
          { operation: 'query', query: 'Ground this answer in the active project.' },
          {
            requestId: 'request-main-checkout',
            sessionId: 'session-1',
            messageId: 'message-main-checkout',
            directory: 'C:\\work\\project',
            mutationApproved: false,
          },
        ),
      ),
    ).resolves.toMatchObject({ receipt: gatewayResult.receipt });
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({
          projectId: 'project-a',
          worktreeId: 'C:\\work\\project',
        }),
        activePaths: ['C:\\work\\project'],
      }),
    );
    ask.mockRestore();
  });

  it('adds canonical provenance to the shared Gateway query route', async () => {
    const authority = captureToolGatewayAuthorityClaim()!;
    expect(
      bindToolGatewayObservedExecutionAuthority('session-1', authority, {
        executionIdentity: observedIdentity,
        performance: 'quality',
      }),
    ).toBe(true);
    const execute = vi.fn(async () => ({ mode: 'rlm', bounded: true }));
    const dispose = installToolGatewayRlmContextPort({ execute });
    const gatewayResult = Object.freeze({
      promptBlock: '<vibespace_context>grounded alias</vibespace_context>',
      receipt: Object.freeze({
        receiptId: 'context-receipt-investigate',
        scopeRevision: Object.freeze({
          accountId: 'account-a',
          workspaceId: 'workspace-a',
          projectId: 'project-a',
          worktreeId: 'C:\\work\\project\\.worktrees\\feature',
          revision: 'session-1:0',
        }),
        sourceRevisions: Object.freeze([
          Object.freeze({ sourceId: 'rlm-source:source-1', revision: `sha256:${'a'.repeat(64)}` }),
        ]),
        evidenceHandles: Object.freeze(['ptr:rlm:record-1:0:512:expand:6144:6144']),
        safeFailure: null,
      }),
    });
    const ask = vi.spyOn(productionContextGateway, 'ask').mockResolvedValue(gatewayResult as never);
    const receiptUri = `vibespace:context/receipt/${[
      ...new TextEncoder().encode('context-receipt-investigate'),
    ]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')}`;

    const result = await Promise.resolve(
      createProductionToolGatewayDependencies().context.rlm(
        { operation: 'query', query: 'Trace the cross-source decision.' },
        {
          requestId: 'request-investigate',
          sessionId: 'session-1',
          messageId: 'message-1',
          worktree: 'C:\\work\\project\\.worktrees\\feature',
          mutationApproved: false,
        },
      ),
    );
    expect(result).toMatchObject({ receipt: gatewayResult.receipt });
    expect((result as { promptBlock: string }).promptBlock).toContain(receiptUri);
    expect((result as { promptBlock: string }).promptBlock).toContain(
      'vibespace:context/source/rlm-source%3Asource-1',
    );
    expect((result as { promptBlock: string }).promptBlock).toContain(
      'vibespace:context/evidence/ptr%3Arlm%3Arecord-1%3A0%3A512%3Aexpand%3A6144%3A6144',
    );
    expect(consumeToolGatewayContextCitationItems('session-1')).toEqual([
      expect.objectContaining({
        purpose: 'citation',
        source: expect.objectContaining({
          id: 'context-receipt-investigate',
          uri: receiptUri,
          trust: 'app_verified',
        }),
      }),
      expect.objectContaining({
        source: expect.objectContaining({
          id: 'rlm-source:source-1',
          uri: 'vibespace:context/source/rlm-source%3Asource-1',
        }),
      }),
      expect.objectContaining({
        source: expect.objectContaining({
          id: 'ptr:rlm:record-1:0:512:expand:6144:6144',
          uri: 'vibespace:context/evidence/ptr%3Arlm%3Arecord-1%3A0%3A512%3Aexpand%3A6144%3A6144',
        }),
      }),
    ]);
    expect(consumeToolGatewayContextCitationItems('session-1')).toEqual([]);
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-investigate',
        question: 'Trace the cross-source decision.',
        executionIdentity: observedIdentity,
        performance: 'quality',
        userIntent: { context: true },
      }),
    );
    expect(execute).not.toHaveBeenCalled();
    ask.mockRestore();
    dispose();
  });

  it('registers fallback search/open citations so final-answer spans validate', () => {
    registerToolGatewayFallbackCitations(
      'session-fallback',
      [
        {
          pointerId: 'ptr:rlm:abc123:0:512',
          recordId: 'record-fallback',
          sourceRevision: 'sha256:' + 'a'.repeat(64),
          contentHash: 'a'.repeat(64),
        },
      ],
      { accountId: 'account-1', projectId: 'project-1' },
    );
    const items = consumeToolGatewayContextCitationItems('session-fallback');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      purpose: 'citation',
      source: {
        id: 'ptr:rlm:abc123:0:512',
        trust: 'app_verified',
      },
    });
    expect(items[0]!.source.uri).toContain('vibespace:context/evidence/');
    // Consuming clears; a second consume returns empty.
    expect(consumeToolGatewayContextCitationItems('session-fallback')).toEqual([]);
  });

  it('deduplicates fallback citations already registered by the receipt', () => {
    const citation = {
      pointerId: 'ptr:rlm:dup:0:256',
      recordId: 'record-dup',
      sourceRevision: 'sha256:' + 'b'.repeat(64),
      contentHash: 'b'.repeat(64),
    };
    registerToolGatewayFallbackCitations('session-dup', [citation], {
      accountId: 'account-1',
      projectId: 'project-1',
    });
    registerToolGatewayFallbackCitations('session-dup', [citation], {
      accountId: 'account-1',
      projectId: 'project-1',
    });
    expect(consumeToolGatewayContextCitationItems('session-dup')).toHaveLength(1);
  });

  it('rejects low-level recursive investigate without observed session identity', async () => {
    const execute = vi.fn(async () => ({ mode: 'legacy' }));
    const dispose = installToolGatewayRlmContextPort({ execute });

    await expect(
      Promise.resolve().then(() =>
        createProductionToolGatewayDependencies().context.rlm(
          { operation: 'investigate', query: 'Trace the cross-source decision.' },
          {
            requestId: 'request-unbound-investigate',
            sessionId: 'different-session',
            messageId: 'message-1',
            worktree: 'C:\\work\\project\\.worktrees\\feature',
            mutationApproved: false,
          },
        ),
      ),
    ).rejects.toThrow('gateway_execution_identity_unavailable');
    expect(execute).not.toHaveBeenCalled();
    dispose();
  });

  it('rejects investigate without observed identity before checking the optional RLM port', async () => {
    await expect(
      Promise.resolve().then(() =>
        createProductionToolGatewayDependencies().context.rlm(
          { operation: 'investigate', query: 'Trace the cross-source decision.' },
          {
            requestId: 'request-unbound-no-port',
            sessionId: 'different-session',
            messageId: 'message-1',
            worktree: 'C:\\work\\project\\.worktrees\\feature',
            mutationApproved: false,
          },
        ),
      ),
    ).rejects.toThrow('gateway_execution_identity_unavailable');
  });

  it('rejects an observed high-level query when worktree scope is incomplete', async () => {
    const authority = captureToolGatewayAuthorityClaim()!;
    expect(
      bindToolGatewayObservedExecutionAuthority('session-1', authority, {
        executionIdentity: observedIdentity,
        performance: 'balanced',
      }),
    ).toBe(true);
    const execute = vi.fn(async () => ({ mode: 'legacy' }));
    const dispose = installToolGatewayRlmContextPort({ execute });

    await expect(
      Promise.resolve().then(() =>
        createProductionToolGatewayDependencies().context.rlm(
          { operation: 'query', query: 'Find the exact project context.' },
          {
            requestId: 'request-incomplete-scope',
            sessionId: 'session-1',
            messageId: 'message-1',
            mutationApproved: false,
          },
        ),
      ),
    ).rejects.toThrow('gateway_scope_unavailable');
    expect(execute).not.toHaveBeenCalled();
    dispose();
  });
});
