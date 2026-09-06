import { describe, expect, it, vi } from 'vitest';

import type { ProviderAdapter, ProviderEvent, ProviderRequest } from '@/lib/ai/adapters/types';
import {
  createOpenCodeChatGptAdeDispatcher,
  resolveProductionChatGptAdeAuthority,
} from './productionChatGptAdeBinding';

const connection = Object.freeze({
  id: 'opencode-cli',
  adapterId: 'opencode-persistent',
  providerId: 'opencode',
  displayName: 'OpenCode',
  mode: 'external-cli' as const,
  authSource: 'managed-opencode-auth',
  capabilities: Object.freeze({
    text: true,
    images: true,
    files: true,
    tools: true,
    modelSelection: true,
    structuredOutput: false,
    streaming: true,
    cancellation: true,
    resumeSession: true,
    systemPrompt: true,
    workingDirectory: true,
    usage: true,
    subscriptionQuota: true,
    localOnly: false,
  }),
  promptTransport: 'native-system' as const,
  enabled: true,
});

const evidence = Object.freeze({
  schemaVersion: 1 as const,
  connectionId: 'opencode-cli' as const,
  authority: 'current-session-authenticated' as const,
  sessionChecked: true as const,
  available: true as const,
  auth: 'authenticated' as const,
  catalogGeneration: 7,
  accountGeneration: 3,
  refreshReason: 'requested' as const,
  refreshRequestedAt: 100,
  lastVerifiedAt: 101,
  refreshIntervalMs: 300_000,
  routeCount: 1,
  catalogSha256: 'a'.repeat(64),
});

describe('production ChatGPT ADE binding', () => {
  it('requires exact authenticated live selection plus explicit provider-supported effort and Fast authority', () => {
    const ready = resolveProductionChatGptAdeAuthority({
      account: { accountId: 'account-a', source: 'supabase' },
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      worktreeId: 'C:\\repo',
      activeChatId: 'chat-a',
      selection: {
        mode: 'single',
        providerId: 'openai',
        modelId: 'openai/gpt-5.6-sol',
        connectionId: 'opencode-cli',
        connectionMode: 'external-cli',
        authSource: connection.authSource,
        capabilities: connection.capabilities,
      },
      connection,
      liveModel: {
        id: 'openai/gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        variants: ['high', 'high-fast'],
      },
      catalogEvidence: evidence,
      runtime: { effort: 'high', fastMode: 'on', performance: 'quality', rlmEnabled: true },
    });

    expect(ready).toMatchObject({
      kind: 'ready',
      accountSource: 'supabase',
      executionIdentity: {
        transportConnectionId: 'opencode-cli',
        upstreamProviderId: 'openai',
        upstreamModelId: 'gpt-5.6-sol',
        providerQualifiedModelId: 'openai/gpt-5.6-sol',
        effort: 'high',
        fastVariant: 'high-fast',
      },
      scope: { accountId: 'account-a', projectId: 'project-a', worktreeId: 'C:\\repo' },
    });

    for (const runtime of [
      { effort: 'auto' as const, fastMode: 'on' as const },
      { effort: 'high' as const, fastMode: 'auto' as const },
      { effort: 'high' as const, fastMode: 'off' as const },
    ]) {
      expect(
        resolveProductionChatGptAdeAuthority({
          account: { accountId: 'account-a', source: 'local' },
          workspaceId: 'workspace-a',
          projectId: 'project-a',
          worktreeId: 'C:\\repo',
          activeChatId: 'chat-a',
          selection: {
            mode: 'single',
            providerId: 'openai',
            modelId: 'openai/gpt-5.6-sol',
            connectionId: 'opencode-cli',
            connectionMode: 'external-cli',
            authSource: connection.authSource,
            capabilities: connection.capabilities,
          },
          connection,
          liveModel: {
            id: 'openai/gpt-5.6-sol',
            label: 'GPT-5.6 Sol',
            variants: ['high', 'high-fast'],
          },
          catalogEvidence: evidence,
          runtime: { ...runtime, performance: 'quality', rlmEnabled: true },
        }),
      ).toMatchObject({ kind: 'unavailable', code: 'runtime_authority_unavailable' });
    }
  });

  it('returns every exact missing scope prerequisite without fabricating authority', () => {
    const base = {
      account: { accountId: 'account-a', source: 'local' as const },
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      worktreeId: 'C:\\repo',
      activeChatId: 'chat-a',
      selection: {
        mode: 'single' as const,
        providerId: 'openai' as const,
        modelId: 'openai/gpt-5.6-sol',
        connectionId: 'opencode-cli',
        connectionMode: 'external-cli' as const,
        authSource: connection.authSource,
        capabilities: connection.capabilities,
      },
      connection,
      liveModel: {
        id: 'openai/gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        variants: ['high-fast'],
      },
      catalogEvidence: evidence,
      runtime: {
        effort: 'high' as const,
        fastMode: 'on' as const,
        performance: 'quality' as const,
        rlmEnabled: true,
      },
    };
    expect(
      resolveProductionChatGptAdeAuthority({
        ...base,
        account: null,
        workspaceId: null,
        projectId: null,
        worktreeId: '',
        activeChatId: null,
      }),
    ).toEqual({
      kind: 'unavailable',
      code: 'scope_unavailable',
      message: 'An exact account, workspace, project, worktree, and chat scope is required.',
      missingScope: ['account', 'workspace', 'project', 'worktree', 'chat'],
    });
  });

  it('fails closed for stale auth, mismatched routes, and Ollama', () => {
    const base = {
      account: { accountId: 'account-a', source: 'local' as const },
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      worktreeId: 'C:\\repo',
      activeChatId: 'chat-a',
      selection: {
        mode: 'single' as const,
        providerId: 'openai' as const,
        modelId: 'openai/gpt-5.6-sol',
        connectionId: 'opencode-cli',
        connectionMode: 'external-cli' as const,
        authSource: connection.authSource,
        capabilities: connection.capabilities,
      },
      connection,
      liveModel: {
        id: 'openai/gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        variants: ['high-fast'],
      },
      catalogEvidence: evidence,
      runtime: {
        effort: 'high' as const,
        fastMode: 'on' as const,
        performance: 'quality' as const,
        rlmEnabled: true,
      },
    };
    expect(
      resolveProductionChatGptAdeAuthority({
        ...base,
        catalogEvidence: { ...evidence, lastVerifiedAt: 99 },
      }),
    ).toMatchObject({ kind: 'unavailable', code: 'catalog_unavailable' });
    expect(
      resolveProductionChatGptAdeAuthority({
        ...base,
        selection: { ...base.selection, providerId: 'ollama', modelId: 'llama3.2' },
      }),
    ).toMatchObject({ kind: 'unavailable', code: 'route_unavailable' });
  });

  it.each([true, false])(
    'dispatches scoped context tools with RLM enabled=%s and requires observed Tool Gateway identity',
    async (rlmEnabled) => {
      const events: ProviderEvent[] = [
        { type: 'session', sessionId: 'session-a' },
        { type: 'model', modelId: 'openai/gpt-5.6-sol' },
        { type: 'text', delta: 'done' },
        { type: 'done' },
      ];
      const send = vi.fn(async function* () {
        yield* events;
      });
      const cancel = vi.fn(async () => undefined);
      const adapter: ProviderAdapter = { id: 'opencode-cli', send, cancel };
      const observed = {
        executionIdentity: {
          transportConnectionId: 'opencode-cli',
          transportAdapterId: 'opencode-persistent',
          upstreamProviderId: 'openai',
          upstreamModelId: 'gpt-5.6-sol',
          providerQualifiedModelId: 'openai/gpt-5.6-sol',
          authBillingRoute: 'managed-opencode-auth',
          effort: 'high',
          fastVariant: 'high-fast',
          catalogRevision: `sha256:${'b'.repeat(64)}`,
          observedProviderIdentity: 'openai/gpt-5.6-sol',
        },
        performance: 'quality' as const,
        scopeRevision: 'session-a:1',
      };
      const dispatcher = createOpenCodeChatGptAdeDispatcher({
        adapter,
        connection,
        readObservedAuthority: () => observed,
        runtimeSettings: { effort: 'high', fastMode: 'on', performance: 'quality', rlmEnabled },
      });
      const signal = new AbortController().signal;
      const onOutput = vi.fn();
      const result = await dispatcher.dispatch({
        runId: 'run-a',
        selectedHarness: 'chatgpt',
        instruction: 'Inspect this project.',
        contextPromptBlock: 'verified context',
        executionIdentity: {
          ...observed.executionIdentity,
          catalogRevision: `sha256:${'a'.repeat(64)}`,
        },
        scope: {
          accountId: 'account-a',
          workspaceId: 'workspace-a',
          projectId: 'project-a',
          worktreeId: 'C:\\repo',
          revision: 'ade-scope-3-7',
        },
        terminalLink: null,
        signal,
        onOutput,
      });

      expect(result.output).toBe('done');
      expect(result.observedExecutionIdentity.providerQualifiedModelId).toBe('openai/gpt-5.6-sol');
      expect(onOutput).toHaveBeenCalledWith('done');
      expect(send).toHaveBeenCalledOnce();
      const request = (send.mock.calls as unknown as [[ProviderRequest]])[0]![0];
      expect(request.tools).toMatchObject({
        'context.list': true,
        'context.read': true,
        'plugins.list': true,
        'mcp.list': true,
        'terminal.list': true,
        'terminal.read': true,
        vibespace_context: rlmEnabled,
      });
      expect(Object.values(request.tools ?? {}).some((enabled) => enabled === true)).toBe(true);
      expect(request.accessLevel).toBe('read-only');
      expect(request.explicitReadRoot).not.toBe(true);
      expect(request.explicitReadSynthesis).not.toBe(true);
      expect(request.projectId).toBe('project-a');
      expect(request.workingDirectory).toBe('C:\\repo');
      expect(request.runtimeSettings).toMatchObject({ effort: 'high', fastMode: 'on' });
      expect(JSON.stringify(request)).not.toMatch(/ollama|11434|api.?key|credential/iu);

      dispatcher.cancel('run-a');
      expect(cancel).toHaveBeenCalledWith('run-a');
    },
  );

  it('rejects missing or fabricated observed authority', async () => {
    const adapter: ProviderAdapter = {
      id: 'opencode-cli',
      send: async function* () {
        yield { type: 'session', sessionId: 'session-a' };
        yield { type: 'model', modelId: 'openai/gpt-5.6-sol' };
        yield { type: 'done' };
      },
      cancel: vi.fn(async () => undefined),
    };
    const dispatcher = createOpenCodeChatGptAdeDispatcher({
      adapter,
      connection,
      readObservedAuthority: () => null,
      runtimeSettings: { effort: 'high', fastMode: 'on', performance: 'quality', rlmEnabled: true },
    });
    await expect(
      dispatcher.dispatch({
        runId: 'run-a',
        selectedHarness: 'chatgpt',
        instruction: 'Read.',
        contextPromptBlock: '',
        executionIdentity: {
          transportConnectionId: 'opencode-cli',
          transportAdapterId: 'opencode-persistent',
          upstreamProviderId: 'openai',
          upstreamModelId: 'gpt-5.6-sol',
          providerQualifiedModelId: 'openai/gpt-5.6-sol',
          authBillingRoute: 'managed-opencode-auth',
          effort: 'high',
          fastVariant: 'high-fast',
          catalogRevision: `sha256:${'a'.repeat(64)}`,
        },
        scope: {
          accountId: 'a',
          workspaceId: 'w',
          projectId: 'p',
          worktreeId: 'C:\\r',
          revision: 'r',
        },
        terminalLink: null,
        signal: new AbortController().signal,
        onOutput: vi.fn(),
      }),
    ).rejects.toThrow(/observed authority/iu);
  });

  it('rejects cancellation before processing late provider output', async () => {
    const controller = new AbortController();
    const onOutput = vi.fn();
    const adapter: ProviderAdapter = {
      id: 'opencode-cli',
      send: async function* () {
        yield { type: 'session', sessionId: 'session-a' };
        controller.abort();
        yield { type: 'text', delta: 'late secret output' };
        yield { type: 'done' };
      },
      cancel: vi.fn(async () => undefined),
    };
    const dispatcher = createOpenCodeChatGptAdeDispatcher({
      adapter,
      connection,
      readObservedAuthority: () => null,
      runtimeSettings: { effort: 'high', fastMode: 'on', performance: 'quality', rlmEnabled: true },
    });

    await expect(
      dispatcher.dispatch({
        runId: 'run-a',
        selectedHarness: 'chatgpt',
        instruction: 'Read.',
        contextPromptBlock: '',
        executionIdentity: {
          transportConnectionId: 'opencode-cli',
          transportAdapterId: 'opencode-persistent',
          upstreamProviderId: 'openai',
          upstreamModelId: 'gpt-5.6-sol',
          providerQualifiedModelId: 'openai/gpt-5.6-sol',
          authBillingRoute: 'managed-opencode-auth',
          effort: 'high',
          fastVariant: 'high-fast',
          catalogRevision: `sha256:${'a'.repeat(64)}`,
        },
        scope: {
          accountId: 'a',
          workspaceId: 'w',
          projectId: 'p',
          worktreeId: 'C:\\r',
          revision: 'r',
        },
        terminalLink: null,
        signal: controller.signal,
        onOutput,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(onOutput).not.toHaveBeenCalled();
  });
});
