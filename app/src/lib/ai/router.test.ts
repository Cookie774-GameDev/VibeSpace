import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@/types';
import type { CompiledJarvisPrompt } from '@/lib/jarvis/contracts';
import { useAuthStore } from '@/stores/auth';
import { providerActivityTracker } from '@/features/taskbar-usage/activityTracker';
import { AGENT_DEFAULT_PROVIDER_MODEL } from './agentProviderOptions';

const { openCodeDetect, openCodeProbeAuth, openCodeSend } = vi.hoisted(() => ({
  openCodeDetect: vi.fn(),
  openCodeProbeAuth: vi.fn(),
  openCodeSend: vi.fn(),
}));

vi.mock('./adapters/opencodePersistent', () => ({
  openCodePersistentAdapter: {
    id: 'opencode-cli',
    detect: openCodeDetect,
    probeAuth: openCodeProbeAuth,
    send: openCodeSend,
    cancel: vi.fn(),
  },
}));

import { runAgent } from './router';

const jarvis: Agent = {
  id: 'agent_jarvis' as Agent['id'],
  slug: 'jarvis',
  name: 'Jarvis',
  description: 'Jarvis',
  system_prompt: 'You are Jarvis.',
  model: { provider: 'google', model: 'gemini-2.5-flash-lite' },
  tools_allowed: [],
  memory_scope: 'workspace',
  capabilities: [],
  builtin: true,
  created_at: 1,
  updated_at: 1,
};

const openaiAgent: Agent = {
  ...jarvis,
  id: 'agent_openai' as Agent['id'],
  slug: 'openai-agent',
  system_prompt: 'You are the selected OpenAI agent.',
  model: { provider: 'openai', model: 'gpt-protected' },
};

const defaultProviderAgent: Agent = {
  ...jarvis,
  id: 'agent_default' as Agent['id'],
  slug: 'default-agent',
  builtin: false,
  model: { provider: 'mock', model: AGENT_DEFAULT_PROVIDER_MODEL },
};

const compiledPrompt: Readonly<CompiledJarvisPrompt> = Object.freeze({
  schemaVersion: 1,
  layers: [],
  systemText: 'EXACT PROTECTED SYSTEM CONTRACT',
  promptHash: 'b'.repeat(64),
  identityVersion: 1,
  profileRevisionId: 'profile-revision-1',
  diagnostics: { totalChars: 31, omittedSourceRefs: [], warnings: [] },
});

const protectedAttempt = Object.freeze({
  accountId: 'account-1',
  runId: 'run-1',
  requestId: 'request-1',
  attemptNumber: 1,
});

function successfulOpenCodeEvents(text = 'done') {
  return (async function* () {
    yield { type: 'text', delta: text } as const;
    yield {
      type: 'usage',
      usage: {
        capturedAt: Date.now(),
        inputTokens: { value: 2, provenance: 'provider-reported' as const },
        outputTokens: { value: 1, provenance: 'provider-reported' as const },
        costUsd: { value: 0, provenance: 'provider-reported' as const },
      },
    } as const;
    yield { type: 'done', finishReason: 'stop' } as const;
  })();
}

describe('canonical OpenCode AI routing', () => {
  beforeEach(() => {
    openCodeDetect.mockReset();
    openCodeDetect.mockResolvedValue({ status: 'available', version: 'test' });
    openCodeProbeAuth.mockReset();
    openCodeProbeAuth.mockResolvedValue({ status: 'authenticated', accountLabel: 'test' });
    openCodeSend.mockReset();
    openCodeSend.mockImplementation(() => successfulOpenCodeEvents());
    try {
      localStorage.clear();
    } catch {
      // jsdom storage may be unavailable in isolated tests.
    }
    useAuthStore.setState({
      apiKeys: {},
      defaultProvider: 'google',
      selectedModels: {},
      chatModelSelection: { mode: 'none' },
      offlineMode: false,
      defaultLocalModel: 'llama3.2',
      plan: 'free',
      workspaceId: 'workspace-a' as never,
      projectId: 'project-a' as never,
    });
  });

  it('routes ordinary production chat only through persistent OpenCode with stable scope and policy', async () => {
    const onApprovalRequested = vi.fn();
    const onHarnessSessionBound = vi.fn();
    const tools = { 'terminal.list': true, 'terminal.write': false } as const;
    const response = await runAgent({
      agent: openaiAgent,
      chatId: 'chat-production-1',
      parentChatId: 'chat-parent-1',
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      messages: [{ role: 'user', content: 'hello' }],
      onApprovalRequested,
      onHarnessSessionBound,
      interactionMode: 'agent',
      accessLevel: 'read-only',
      tools,
    });

    expect(response).toMatchObject({ text: 'done', provider: 'openai', model: 'gpt-protected' });
    expect(openCodeSend).toHaveBeenCalledOnce();
    expect(openCodeSend).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-production-1',
        accountId: 'account-a',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        prompt: 'hello',
        modelId: 'openai/gpt-protected',
        systemPrompt: 'You are the selected OpenAI agent.',
        interactionMode: 'agent',
        accessLevel: 'read-only',
        tools,
        onApprovalRequested,
        onSessionBound: onHarnessSessionBound,
      }),
    );
  });

  it('applies explicit reasoning effort to canonical runtime controls', async () => {
    await runAgent({
      agent: openaiAgent,
      chatId: 'chat-effort',
      messages: [{ role: 'user', content: 'reason deeply' }],
      provider_options: { reasoning_effort: 'xhigh' },
    });

    expect(openCodeSend).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoningEffort: 'xhigh',
        runtimeSettings: expect.objectContaining({ effort: 'ultra' }),
      }),
    );
  });

  it('rejects conflicting runtime and provider reasoning controls instead of guessing', async () => {
    await expect(
      runAgent({
        agent: openaiAgent,
        messages: [{ role: 'user', content: 'reason' }],
        provider_options: { reasoning_effort: 'high' },
        runtimeSettings: {
          effort: 'low',
          fastMode: 'auto',
          performance: 'quality',
          rlmEnabled: true,
        },
      }),
    ).rejects.toThrow(/conflicts with the active runtime setting/i);
    expect(openCodeSend).not.toHaveBeenCalled();
  });

  it('routes an exact local connection through OpenCode without native provider fallback', async () => {
    const localAgent: Agent = {
      ...jarvis,
      id: 'agent_local' as Agent['id'],
      slug: 'local-agent',
      model: { provider: 'ollama', model: 'qwen3:8b' },
    };
    openCodeSend.mockImplementationOnce(() => successfulOpenCodeEvents('local result'));
    const response = await runAgent({
      agent: localAgent,
      connectionId: 'ollama-local',
      purpose: 'prompt_forge',
      messages: [{ role: 'user', content: 'Upgrade this draft.' }],
    });
    expect(response).toMatchObject({ text: 'local result', provider: 'ollama', model: 'qwen3:8b' });
    expect(openCodeSend).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({ id: 'ollama-local', adapterId: 'opencode-cli' }),
        modelId: 'ollama/qwen3:8b',
      }),
    );
  });

  it('routes Model Foundry selections through OpenCode without a native bypass', async () => {
    const foundryAgent: Agent = {
      ...jarvis,
      id: 'agent_foundry' as Agent['id'],
      slug: 'release-adapter',
      model: { provider: 'ollama', model: 'foundry:job_12345' },
    };
    const response = await runAgent({
      agent: foundryAgent,
      messages: [{ role: 'user', content: 'Review this release.' }],
    });

    expect(openCodeSend).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'ollama/foundry:job_12345' }),
    );
    expect(response).toMatchObject({ provider: 'ollama', model: 'foundry:job_12345' });
  });

  it('passes Model Foundry cancellation through the persistent OpenCode boundary', async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    openCodeSend.mockImplementationOnce((request) => (async function* () {
      entered();
      await new Promise<void>((_, reject) => {
        request.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted by user', 'AbortError')),
          { once: true },
        );
      });
      yield { type: 'done' } as const;
    })());
    const foundryAgent: Agent = {
      ...jarvis,
      id: 'agent_foundry_cancel' as Agent['id'],
      slug: 'release-adapter',
      model: { provider: 'ollama', model: 'foundry:job_12345' },
    };
    const pending = runAgent({
      agent: foundryAgent,
      messages: [{ role: 'user', content: 'Review this release.' }],
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('preserves protected prompt, exact connection, scope, signal and evidence hooks', async () => {
    const controller = new AbortController();
    openCodeSend.mockImplementationOnce((request) => (async function* () {
      request.onResponseObservation?.({ kind: 'bytes', byteLength: 4, observedAt: Date.now() });
      request.onActionDispatch?.({ observedAt: Date.now() });
      yield* successfulOpenCodeEvents('protected');
    })());
    await runAgent({
      agent: openaiAgent,
      messages: [{ role: 'user', content: 'protected request' }],
      connectionId: 'openai-api',
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      compiledPrompt,
      requestId: protectedAttempt.requestId,
      protectedAttempt,
      signal: controller.signal,
    });

    expect(openCodeSend).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: protectedAttempt.requestId,
        connection: expect.objectContaining({ id: 'openai-api', adapterId: 'opencode-cli' }),
        systemPrompt: compiledPrompt.systemText,
        modelId: 'openai/gpt-protected',
        accountId: 'account-1',
        workspaceId: 'workspace-1',
        signal: controller.signal,
        onResponseObservation: expect.any(Function),
        onActionDispatch: expect.any(Function),
      }),
    );
  });

  it('routes an explicitly selected subscription CLI identity through OpenCode instead of its direct CLI adapter', async () => {
    const codexAgent: Agent = {
      ...openaiAgent,
      id: 'agent_codex' as Agent['id'],
      model: { provider: 'openai', model: 'gpt-5.6-sol' },
    };
    await runAgent({
      agent: codexAgent,
      connectionId: 'openai-codex',
      messages: [{ role: 'user', content: 'Use the exact subscription model.' }],
    });
    expect(openCodeSend).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({ id: 'openai-codex', adapterId: 'opencode-cli' }),
        modelId: 'openai/gpt-5.6-sol',
      }),
    );
  });

  it('uses the explicit chat model selection for a default-provider agent', async () => {
    useAuthStore.setState({
      chatModelSelection: {
        mode: 'single',
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
        connectionId: 'deepseek-api',
      } as never,
    });
    await runAgent({
      agent: defaultProviderAgent,
      messages: [{ role: 'user', content: 'hello default' }],
    });
    expect(openCodeSend).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'deepseek/deepseek-chat' }),
    );
  });

  it('fails closed when OpenCode authentication is not verifiably authenticated', async () => {
    openCodeProbeAuth.mockResolvedValueOnce({ status: 'unknown' });
    await expect(
      runAgent({ agent: openaiAgent, messages: [{ role: 'user', content: 'hello' }] }),
    ).rejects.toThrow(/authentication could not be verified/i);
    expect(openCodeSend).not.toHaveBeenCalled();
  });

  it('rejects an explicit provider connection that does not match the selected agent model', async () => {
    await expect(
      runAgent({
        agent: openaiAgent,
        connectionId: 'anthropic-api',
        messages: [{ role: 'user', content: 'wrong provider' }],
      }),
    ).rejects.toThrow(/does not match provider connection/i);
    expect(openCodeSend).not.toHaveBeenCalled();
  });

  it('forwards approval and session callbacks without auto-approval in the router', async () => {
    const approval = {
      id: 'approval-1',
      sessionId: 'session-1',
      title: 'Write file',
      capability: 'file.write',
    };
    const onApprovalRequested = vi.fn();
    const onHarnessSessionBound = vi.fn();
    openCodeSend.mockImplementationOnce((request) => (async function* () {
      await request.onSessionBound?.({ sessionId: 'session-1' });
      await request.onApprovalRequested?.(approval);
      yield* successfulOpenCodeEvents();
    })());
    await runAgent({
      agent: openaiAgent,
      messages: [{ role: 'user', content: 'write it' }],
      onApprovalRequested,
      onHarnessSessionBound,
    });
    expect(onApprovalRequested).toHaveBeenCalledWith(approval);
    expect(onHarnessSessionBound).toHaveBeenCalledWith({ sessionId: 'session-1' });
  });

  it('tracks active routing until the persistent OpenCode stream completes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    openCodeSend.mockImplementationOnce(() => (async function* () {
      entered();
      await gate;
      yield* successfulOpenCodeEvents();
    })());
    const pending = runAgent({
      agent: openaiAgent,
      messages: [{ role: 'user', content: 'long request' }],
    });
    await started;
    expect(providerActivityTracker.snapshot().total).toBeGreaterThan(0);
    release();
    await pending;
    expect(providerActivityTracker.snapshot().total).toBe(0);
  });
});
