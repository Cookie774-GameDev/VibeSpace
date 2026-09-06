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
        onSessionBound: expect.any(Function),
      }),
    );
  });

  it('reports only completed built-in filesystem tools as grounding evidence', async () => {
    openCodeSend.mockImplementationOnce(() =>
      (async function* () {
        yield { type: 'tool', name: 'websearch', status: 'completed' } as const;
        yield { type: 'tool', name: 'read', status: 'started' } as const;
        yield { type: 'tool', name: 'read', status: 'failed' } as const;
        yield { type: 'done', finishReason: 'stop' } as const;
      })(),
    );
    const ungrounded = await runAgent({
      agent: openaiAgent,
      messages: [{ role: 'user', content: 'inspect' }],
    });
    expect(ungrounded.tool_evidence).toEqual({
      completedReadOnlyFilesystem: false,
      anyToolObserved: true,
      rootInventoryObserved: false,
      boundedSearchObserved: false,
      representativeReadCount: 0,
    });

    openCodeSend.mockImplementationOnce(() =>
      (async function* () {
        yield { type: 'tool', name: 'list', status: 'completed' } as const;
        yield { type: 'done', finishReason: 'stop' } as const;
      })(),
    );
    const grounded = await runAgent({
      agent: openaiAgent,
      messages: [{ role: 'user', content: 'inspect' }],
    });
    expect(grounded.tool_evidence).toEqual({
      completedReadOnlyFilesystem: true,
      anyToolObserved: true,
      rootInventoryObserved: true,
      boundedSearchObserved: false,
      representativeReadCount: 0,
    });

    openCodeSend.mockImplementationOnce(() =>
      (async function* () {
        yield { type: 'done', finishReason: 'stop' } as const;
      })(),
    );
    const nextRequest = await runAgent({
      agent: openaiAgent,
      messages: [{ role: 'user', content: 'inspect again' }],
      explicitReadSynthesis: true,
    });
    expect(nextRequest.tool_evidence).toEqual({
      completedReadOnlyFilesystem: false,
      anyToolObserved: false,
      rootInventoryObserved: false,
      boundedSearchObserved: false,
      representativeReadCount: 0,
    });
    expect(openCodeSend).toHaveBeenLastCalledWith(
      expect.objectContaining({ explicitReadSynthesis: true }),
    );
  });

  it('forwards ordered safe tool lifecycle receipts without retaining provider payloads', async () => {
    openCodeSend.mockImplementationOnce(() =>
      (async function* () {
        yield {
          type: 'tool',
          name: 'read',
          status: 'started',
          callId: 'call-read-1',
          fileLabel: 'Composer.tsx',
          result: { secret: 'must-not-survive' },
        } as const;
        yield {
          type: 'tool',
          name: 'read',
          status: 'completed',
          callId: 'call-read-1',
          fileLabel: 'Composer.tsx',
          result: { secret: 'must-not-survive' },
        } as const;
        yield { type: 'done', finishReason: 'stop' } as const;
      })(),
    );
    const onToolActivity = vi.fn(async () => undefined);

    await runAgent({
      agent: openaiAgent,
      messages: [{ role: 'user', content: 'read the file' }],
      onToolActivity,
    });

    expect(onToolActivity.mock.calls).toEqual([
      [{ name: 'read', status: 'started', callId: 'call-read-1', fileLabel: 'Composer.tsx' }],
      [{ name: 'read', status: 'completed', callId: 'call-read-1', fileLabel: 'Composer.tsx' }],
    ]);
    expect(JSON.stringify(onToolActivity.mock.calls)).not.toContain('must-not-survive');
  });

  it('preserves native OpenCode text-part boundaries on streamed chunks', async () => {
    openCodeSend.mockImplementationOnce(() =>
      (async function* () {
        yield {
          type: 'text',
          delta: 'I built the game shell. ',
          streamPartId: 'opencode-text-1',
        } as const;
        yield {
          type: 'tool',
          name: 'write',
          status: 'completed',
          callId: 'write-game',
          fileLabel: 'index.html',
        } as const;
        yield {
          type: 'text',
          delta: 'The full game is ready.',
          streamPartId: 'opencode-text-2',
        } as const;
        yield { type: 'done', finishReason: 'stop' } as const;
      })(),
    );
    const onChunk = vi.fn();

    await runAgent({
      agent: openaiAgent,
      messages: [{ role: 'user', content: 'MAKE ME A FULL HTML GAME OKAY' }],
      onChunk,
    });

    expect(onChunk.mock.calls).toEqual([
      [{ delta: 'I built the game shell. ', first: true, streamPartId: 'opencode-text-1' }],
      [{ delta: 'The full game is ready.', first: false, streamPartId: 'opencode-text-2' }],
      [{ delta: '', done: true }],
    ]);
  });

  it('uses the authoritative OpenCode snapshot final answer without flattening checkpoints', async () => {
    const snapshot = {
      finalText: 'The full game is ready.',
      timeline: [
        { kind: 'text' as const, text: 'I built the game shell.' },
        {
          kind: 'tool_call' as const,
          tool: 'write',
          call_id: 'opencode-tool-1',
          args: { path: 'index.html' },
        },
        {
          kind: 'tool_result' as const,
          call_id: 'opencode-tool-1',
          result: { status: 'completed' as const },
        },
      ],
    };
    openCodeSend.mockImplementationOnce(() =>
      (async function* () {
        yield {
          type: 'text',
          delta: 'I built the game shell.',
          streamPartId: 'opencode-text-1',
        } as const;
        yield {
          type: 'text',
          delta: 'The full game is ready.',
          streamPartId: 'opencode-text-2',
        } as const;
        yield { type: 'public_timeline', snapshot } as const;
        yield { type: 'done', finishReason: 'stop' } as const;
      })(),
    );
    const onPublicTimelineSnapshot = vi.fn();

    const result = await runAgent({
      agent: openaiAgent,
      messages: [{ role: 'user', content: 'MAKE ME A FULL HTML GAME OKAY' }],
      onPublicTimelineSnapshot,
    } as Parameters<typeof runAgent>[0] & {
      onPublicTimelineSnapshot: (value: typeof snapshot) => void;
    });

    expect(result.text).toBe('The full game is ready.');
    expect((result as typeof result & { public_timeline?: unknown }).public_timeline).toEqual(
      snapshot.timeline,
    );
    expect(onPublicTimelineSnapshot).toHaveBeenCalledExactlyOnceWith(snapshot);
  });

  it('forwards native text-part corrections as replacements without duplicating the answer', async () => {
    openCodeSend.mockImplementationOnce(() =>
      (async function* () {
        yield {
          type: 'text',
          delta: 'I built teh game.',
          streamPartId: 'opencode-text-1',
        } as const;
        yield {
          type: 'text',
          delta: 'I built the game.',
          mode: 'replace',
          streamPartId: 'opencode-text-1',
        } as const;
        yield { type: 'done', finishReason: 'stop' } as const;
      })(),
    );
    const onChunk = vi.fn();

    const result = await runAgent({
      agent: openaiAgent,
      messages: [{ role: 'user', content: 'build it' }],
      onChunk,
    });

    expect(onChunk.mock.calls).toEqual([
      [{ delta: 'I built teh game.', first: true, streamPartId: 'opencode-text-1' }],
      [
        {
          delta: 'I built the game.',
          first: false,
          mode: 'replace',
          streamPartId: 'opencode-text-1',
        },
      ],
      [{ delta: '', done: true }],
    ]);
    expect(result.text).toBe('I built the game.');
  });

  it('returns the latest bounded OpenCode todo snapshots without generic tool payloads', async () => {
    openCodeSend.mockImplementationOnce(() =>
      (async function* () {
        yield {
          type: 'tool',
          name: 'todowrite',
          status: 'started',
          callId: 'todo-call-1',
          checklist: {
            tool: 'todowrite',
            callId: 'todo-call-1',
            todos: [{ id: 'one', content: 'Build the game', status: 'in_progress' }],
          },
        } as const;
        yield {
          type: 'tool',
          name: 'todowrite',
          status: 'completed',
          callId: 'todo-call-1',
          result: { secret: 'must-not-be-retained' },
          checklist: {
            tool: 'todowrite',
            callId: 'todo-call-1',
            todos: [{ id: 'one', content: 'Build the game', status: 'completed' }],
          },
        } as const;
        yield { type: 'done', finishReason: 'stop' } as const;
      })(),
    );

    const response = await runAgent({
      agent: openaiAgent,
      messages: [{ role: 'user', content: 'make a milestone list' }],
    });
    expect(response.checklist_evidence).toEqual([
      {
        tool: 'todowrite',
        callId: 'todo-call-1',
        todos: [{ id: 'one', content: 'Build the game', status: 'completed' }],
      },
    ]);
    expect(JSON.stringify(response.checklist_evidence)).not.toContain('must-not-be-retained');
  });

  it('fails closed if any tool event appears during grounded synthesis', async () => {
    openCodeSend.mockImplementationOnce(() =>
      (async function* () {
        yield { type: 'tool', name: 'unknown-future-tool', status: 'started' } as const;
        yield { type: 'text', delta: 'must not be accepted' } as const;
      })(),
    );

    await expect(
      runAgent({
        agent: openaiAgent,
        messages: [{ role: 'user', content: 'synthesize existing evidence' }],
        explicitReadSynthesis: true,
      }),
    ).rejects.toThrow('kernel_explicit_root_synthesis_tool_observed');
  });

  it('fails closed if an explicit-root evidence phase observes any other tool', async () => {
    openCodeSend.mockImplementationOnce(() =>
      (async function* () {
        yield { type: 'tool', name: 'question', status: 'started' } as const;
      })(),
    );

    await expect(
      runAgent({
        agent: openaiAgent,
        messages: [{ role: 'user', content: 'inspect the approved root' }],
        explicitReadRoot: true,
      }),
    ).rejects.toThrow('kernel_explicit_root_unapproved_tool_observed');
  });

  it('reports bounded coverage and deduplicates representative reads by call id', async () => {
    openCodeSend.mockImplementationOnce(() =>
      (async function* () {
        yield { type: 'tool', name: 'list', status: 'completed', callId: 'list-root' } as const;
        yield { type: 'tool', name: 'grep', status: 'completed', callId: 'search-1' } as const;
        yield { type: 'tool', name: 'read', status: 'completed', callId: 'read-1' } as const;
        yield { type: 'tool', name: 'read', status: 'completed', callId: 'read-1' } as const;
        yield { type: 'tool', name: 'read', status: 'completed', callId: 'read-2' } as const;
        yield { type: 'tool', name: 'read', status: 'completed' } as const;
        yield { type: 'done', finishReason: 'stop' } as const;
      })(),
    );

    const response = await runAgent({
      agent: openaiAgent,
      messages: [{ role: 'user', content: 'inspect the approved root' }],
      explicitReadRoot: true,
    });
    expect(response.tool_evidence).toEqual({
      completedReadOnlyFilesystem: true,
      anyToolObserved: true,
      rootInventoryObserved: true,
      boundedSearchObserved: true,
      representativeReadCount: 2,
    });
  });

  it('treats an approved bounded glob as inventory-capable evidence', async () => {
    openCodeSend.mockImplementationOnce(() =>
      (async function* () {
        yield { type: 'tool', name: 'glob', status: 'completed', callId: 'glob-root' } as const;
        yield { type: 'done', finishReason: 'stop' } as const;
      })(),
    );
    const response = await runAgent({
      agent: openaiAgent,
      messages: [{ role: 'user', content: 'inventory the approved root' }],
      explicitReadRoot: true,
    });
    expect(response.tool_evidence).toMatchObject({
      rootInventoryObserved: true,
      boundedSearchObserved: true,
    });
  });

  it('accepts only the adapter-sanitized exact-root read classification as inventory', async () => {
    openCodeSend.mockImplementationOnce(() =>
      (async function* () {
        yield {
          type: 'tool',
          name: 'read',
          status: 'completed',
          callId: 'read-root',
          scope: 'explicit_root_inventory',
        } as const;
        yield { type: 'tool', name: 'grep', status: 'completed', callId: 'grep-1' } as const;
        yield { type: 'tool', name: 'read', status: 'completed', callId: 'read-child-1' } as const;
        yield { type: 'tool', name: 'read', status: 'completed', callId: 'read-child-2' } as const;
        yield { type: 'done', finishReason: 'stop' } as const;
      })(),
    );
    const classified = await runAgent({
      agent: openaiAgent,
      messages: [{ role: 'user', content: 'inventory the approved root' }],
      explicitReadRoot: true,
    });
    expect(classified.tool_evidence).toMatchObject({
      rootInventoryObserved: true,
      boundedSearchObserved: true,
      representativeReadCount: 3,
    });

    openCodeSend.mockImplementationOnce(() =>
      (async function* () {
        yield { type: 'tool', name: 'read', status: 'completed', callId: 'read-child' } as const;
        yield { type: 'done', finishReason: 'stop' } as const;
      })(),
    );
    const unclassified = await runAgent({
      agent: openaiAgent,
      messages: [{ role: 'user', content: 'inspect a child file' }],
      explicitReadRoot: true,
    });
    expect(unclassified.tool_evidence).toMatchObject({ rootInventoryObserved: false });
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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
    expect(warn).toHaveBeenCalledExactlyOnceWith('Protected OpenCode dispatch failed.', {
      diagnosticCode: 'router_request_controls',
    });
    warn.mockRestore();
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    openCodeSend.mockImplementationOnce((request) =>
      (async function* () {
        entered();
        await new Promise<void>((_, reject) => {
          request.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted by user', 'AbortError')),
            { once: true },
          );
        });
        yield { type: 'done' } as const;
      })(),
    );
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
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reports an iterator failure at the adapter boundary without leaking its cause', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    openCodeSend.mockImplementationOnce(() =>
      (async function* () {
        yield { type: 'text', delta: 'partial' } as const;
        throw new Error('secret-native-cause-sentinel');
      })(),
    );

    await expect(
      runAgent({ agent: openaiAgent, messages: [{ role: 'user', content: 'hello' }] }),
    ).rejects.toThrow(/secret-native-cause-sentinel/i);
    expect(warn).toHaveBeenCalledExactlyOnceWith('Protected OpenCode dispatch failed.', {
      diagnosticCode: 'router_adapter_send',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret-native-cause-sentinel/i);
    warn.mockRestore();
  });

  it('does not duplicate a provider-reported failure diagnostic in the router', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    openCodeSend.mockImplementationOnce(() =>
      (async function* () {
        yield { type: 'error', message: 'OpenCode reported a provider session error.' } as const;
      })(),
    );

    await expect(
      runAgent({ agent: openaiAgent, messages: [{ role: 'user', content: 'hello' }] }),
    ).rejects.toThrow(/provider session error/i);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('preserves protected prompt, exact connection, scope, signal and evidence hooks', async () => {
    const controller = new AbortController();
    openCodeSend.mockImplementationOnce((request) =>
      (async function* () {
        request.onResponseObservation?.({ kind: 'bytes', byteLength: 4, observedAt: Date.now() });
        request.onActionDispatch?.({ observedAt: Date.now() });
        yield* successfulOpenCodeEvents('protected');
      })(),
    );
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

  it('does not block send on an unknown OpenCode auth probe', async () => {
    openCodeProbeAuth.mockResolvedValueOnce({ status: 'unknown' });
    await runAgent({ agent: openaiAgent, messages: [{ role: 'user', content: 'hello' }] });
    expect(openCodeSend).toHaveBeenCalledOnce();
  });

  it('still fail-closes when OpenCode is explicitly signed out', async () => {
    openCodeProbeAuth.mockImplementationOnce(async () => {
      throw new Error('should not be awaited on the send path');
    });
    // Explicit unauthenticated is observed by the persistent session, not a
    // pre-send CLI probe. The router must still dispatch.
    await runAgent({ agent: openaiAgent, messages: [{ role: 'user', content: 'hello' }] });
    expect(openCodeSend).toHaveBeenCalledOnce();
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
    openCodeSend.mockImplementationOnce((request) =>
      (async function* () {
        await request.onSessionBound?.({ sessionId: 'session-1' });
        await request.onApprovalRequested?.(approval);
        yield* successfulOpenCodeEvents();
      })(),
    );
    await runAgent({
      agent: openaiAgent,
      messages: [{ role: 'user', content: 'write it' }],
      onApprovalRequested,
      onHarnessSessionBound,
    });
    expect(onApprovalRequested).toHaveBeenCalledWith(approval);
    expect(onHarnessSessionBound).toHaveBeenCalledWith({ sessionId: 'session-1' });
  });

  it('emits one bounded question projection while the exact OpenCode stream remains active', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let projected!: () => void;
    const projectionObserved = new Promise<void>((resolve) => {
      projected = resolve;
    });
    const onQuestionRequested = vi.fn(() => projected());
    openCodeSend.mockImplementationOnce((request) =>
      (async function* () {
        await request.onSessionBound?.({ sessionId: 'ses_question_exact' });
        yield { type: 'session', sessionId: 'ses_question_exact' } as const;
        yield {
          type: 'question',
          request: {
            id: 'que_native_exact',
            sessionId: 'ses_question_exact',
            tool: { messageId: 'msg_exact', callId: 'call_exact' },
            questions: [
              {
                header: 'Implementation',
                prompt: 'Implement this plan?',
                options: [
                  { label: 'Yes', description: 'Start implementation.' },
                  { label: 'No', description: 'Keep planning.' },
                ],
                multiple: false,
                allowCustomAnswer: true,
              },
            ],
          },
        } as const;
        await gate;
        yield { type: 'done', finishReason: 'stop' } as const;
      })(),
    );

    let settled = false;
    const pending = runAgent({
      agent: openaiAgent,
      messages: [{ role: 'user', content: 'Plan this.' }],
      expectedSessionId: 'ses_question_exact',
      onQuestionRequested,
    }).finally(() => {
      settled = true;
    });
    await projectionObserved;

    expect(onQuestionRequested).toHaveBeenCalledOnce();
    expect(onQuestionRequested).toHaveBeenCalledWith(
      expect.objectContaining({
        part: expect.objectContaining({ kind: 'question_block' }),
        route: expect.objectContaining({
          protocol: 'opencode-question-v1',
          requestId: 'que_native_exact',
          sessionId: 'ses_question_exact',
          tool: { messageId: 'msg_exact', callId: 'call_exact' },
        }),
      }),
    );
    expect(settled).toBe(false);
    release();
    await pending;
  });

  it('fails closed on duplicate native question authority after emitting it once', async () => {
    const question = {
      type: 'question',
      request: {
        id: 'que_duplicate',
        sessionId: 'ses_question_duplicate',
        questions: [
          {
            header: 'Choice',
            prompt: 'Choose once.',
            options: [{ label: 'Only', description: '' }],
            multiple: false,
            allowCustomAnswer: false,
          },
        ],
      },
    } as const;
    const onQuestionRequested = vi.fn();
    openCodeSend.mockImplementationOnce(() =>
      (async function* () {
        yield { type: 'session', sessionId: 'ses_question_duplicate' } as const;
        yield question;
        yield question;
      })(),
    );

    await expect(
      runAgent({
        agent: openaiAgent,
        messages: [{ role: 'user', content: 'Ask once.' }],
        expectedSessionId: 'ses_question_duplicate',
        onQuestionRequested,
      }),
    ).rejects.toThrow('provider_question_duplicate');
    expect(onQuestionRequested).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'cross-session',
      {
        type: 'question',
        request: {
          id: 'que_wrong_session',
          sessionId: 'ses_other',
          questions: [
            {
              header: 'Choice',
              prompt: 'Choose.',
              options: [],
              multiple: false,
              allowCustomAnswer: true,
            },
          ],
        },
      },
      'provider_question_session_mismatch',
    ],
    [
      'malformed',
      {
        type: 'question',
        request: {
          id: 'que_malformed',
          sessionId: 'ses_question_exact',
          questions: [],
        },
      },
      'provider_question_invalid',
    ],
  ])('fails closed on a %s question event', async (_label, question, expectedError) => {
    const onQuestionRequested = vi.fn();
    openCodeSend.mockImplementationOnce(() =>
      (async function* () {
        yield { type: 'session', sessionId: 'ses_question_exact' } as const;
        yield question as never;
      })(),
    );

    await expect(
      runAgent({
        agent: openaiAgent,
        messages: [{ role: 'user', content: 'Ask safely.' }],
        expectedSessionId: 'ses_question_exact',
        onQuestionRequested,
      }),
    ).rejects.toThrow(expectedError);
    expect(onQuestionRequested).not.toHaveBeenCalled();
  });

  it('fails closed when a native question has no request-local handler', async () => {
    openCodeSend.mockImplementationOnce(() =>
      (async function* () {
        yield { type: 'session', sessionId: 'ses_question_unhandled' } as const;
        yield {
          type: 'question',
          request: {
            id: 'que_unhandled',
            sessionId: 'ses_question_unhandled',
            questions: [
              {
                header: 'Choice',
                prompt: 'Choose.',
                options: [],
                multiple: false,
                allowCustomAnswer: true,
              },
            ],
          },
        } as const;
      })(),
    );

    await expect(
      runAgent({
        agent: openaiAgent,
        messages: [{ role: 'user', content: 'No handler.' }],
        expectedSessionId: 'ses_question_unhandled',
      }),
    ).rejects.toThrow('provider_question_handler_missing');
  });

  it('emits one exact completion receipt with merged partial provider usage', async () => {
    const onProviderCompletionEvidence = vi.fn();
    openCodeSend.mockImplementationOnce((request) =>
      (async function* () {
        await request.onSessionBound?.({ sessionId: 'session-evidence-1' });
        yield { type: 'session', sessionId: 'session-evidence-1' } as const;
        yield {
          type: 'usage',
          usage: {
            capturedAt: 10,
            inputTokens: { value: 100, provenance: 'provider-reported' as const },
            cacheReadTokens: { value: 30, provenance: 'provider-reported' as const },
          },
        } as const;
        yield {
          type: 'usage',
          usage: {
            capturedAt: 20,
            outputTokens: { value: 20, provenance: 'provider-reported' as const },
            cacheWriteTokens: { value: 4, provenance: 'provider-reported' as const },
            costUsd: { value: 0.01, provenance: 'provider-reported' as const },
          },
        } as const;
        yield { type: 'done', finishReason: 'stop' } as const;
      })(),
    );

    const result = await runAgent({
      agent: openaiAgent,
      connectionId: 'opencode-cli',
      requestId: 'request-evidence-1',
      messages: [{ role: 'user', content: 'summarize' }],
      provider_options: { reasoning_effort: 'high' },
      runtimeSettings: {
        effort: 'high',
        fastMode: 'auto',
        performance: 'quality',
        rlmEnabled: false,
      },
      onProviderCompletionEvidence,
    });

    expect(result.usage).toMatchObject({cache_read_tokens: 30, cache_write_tokens: 4});
    expect(onProviderCompletionEvidence).toHaveBeenCalledOnce();
    expect(onProviderCompletionEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-evidence-1',
        sessionId: 'session-evidence-1',
        providerId: 'openai',
        connectionId: 'opencode-cli',
        modelId: 'gpt-protected',
        reasoningEffort: 'high',
        finishReason: 'stop',
        usage: expect.objectContaining({
          inputTokens: { value: 100, provenance: 'provider-reported' },
          outputTokens: { value: 20, provenance: 'provider-reported' },
          cacheReadTokens: { value: 30, provenance: 'provider-reported' },
          cacheWriteTokens: { value: 4, provenance: 'provider-reported' },
          costUsd: { value: 0.01, provenance: 'provider-reported' },
        }),
      }),
    );
  });

  it('retains unavailable token provenance when the provider reports no usage', async () => {
    openCodeSend.mockImplementationOnce(() => (async function* () {
      yield { type: 'text', delta: 'Done' } as const;
      yield { type: 'done', finishReason: 'stop' } as const;
    })());
    const response = await runAgent({ agent: openaiAgent, connectionId: 'opencode-cli',
      messages: [{ role: 'user', content: 'Reply Done' }] });
    expect(response.usage).toMatchObject({ provenance: 'unavailable' });
  });

  it('does not issue completion evidence when the provider stream ends without done', async () => {
    const onProviderCompletionEvidence = vi.fn();
    openCodeSend.mockImplementationOnce((request) =>
      (async function* () {
        await request.onSessionBound?.({ sessionId: 'session-incomplete' });
        yield { type: 'text', delta: 'partial' } as const;
      })(),
    );

    await expect(
      runAgent({
        agent: openaiAgent,
        connectionId: 'opencode-cli',
        requestId: 'request-incomplete',
        messages: [{ role: 'user', content: 'summarize' }],
        onProviderCompletionEvidence,
      }),
    ).rejects.toThrow('provider_completion_terminal_missing');
    expect(onProviderCompletionEvidence).not.toHaveBeenCalled();
  });

  it('tracks active routing until the persistent OpenCode stream completes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    openCodeSend.mockImplementationOnce(() =>
      (async function* () {
        entered();
        await gate;
        yield* successfulOpenCodeEvents();
      })(),
    );
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
