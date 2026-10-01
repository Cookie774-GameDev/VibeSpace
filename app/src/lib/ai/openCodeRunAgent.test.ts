import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@/types';
import type { ProjectId, WorkspaceId } from '@/types/common';
import { clearToolGatewayAuthorityForTests } from '@/lib/harness/toolGatewayAuthority';
import type { ToolGatewayAuthorityClaim } from '@/lib/harness/toolGatewayAuthority';
import type {
  CreateHarnessSession,
  HarnessEvent,
  HarnessSendRequest,
  VibeSpaceHarness,
} from '@/lib/harness/types';
import { useAuthStore } from '@/stores/auth';
import { createOpenCodeRunAgentAdapter } from './openCodeRunAgent';
import { HarnessError } from '@/lib/harness/errors';

const agent: Agent = {
  id: 'agent_test' as Agent['id'],
  slug: 'test',
  name: 'Test',
  description: '',
  system_prompt: 'SYSTEM',
  model: { provider: 'openai', model: 'gpt-exact' },
  tools_allowed: [],
  memory_scope: 'workspace',
  capabilities: [],
  created_at: 1,
  updated_at: 1,
};

const exactUsageEvent: HarnessEvent = {
  type: 'usage.updated',
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    providerId: 'openai',
    modelId: 'gpt-exact',
  },
};

function authorityClaim(generation: number): ToolGatewayAuthorityClaim {
  return {
    scope: {
      accountId: 'account-a',
      accountSource: 'local',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
    },
    generation,
  };
}

function fakeHarness(eventRuns: readonly (readonly HarnessEvent[])[]) {
  const createSession = vi.fn(async (input: CreateHarnessSession) => ({
    id: `session-${createSession.mock.calls.length}`,
    chatId: input.chatId,
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
  }));
  const send = vi.fn((input: HarnessSendRequest) => {
    const events = eventRuns[send.mock.calls.length - 1] ?? [];
    return (async function* () {
      for (const event of events) yield event;
    })();
  });
  const deleteSession = vi.fn(async () => undefined);
  const harness: VibeSpaceHarness = {
    ensureReady: vi.fn(async () => ({ source: 'managed' as const, version: '1.18.16' })),
    createSession,
    deleteSession,
    send,
    cancel: vi.fn(async () => undefined),
    listProviders: vi.fn(async () => [
      {
        id: 'openai',
        name: 'OpenAI',
        connected: true,
        models: [
          {
            id: 'gpt-exact',
            name: 'gpt-exact',
            variants: ['low', 'medium', 'high', 'xhigh'],
          },
        ],
      },
    ]),
    listModels: vi.fn(async () => []),
    respondToApproval: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
  return { harness, createSession, deleteSession, send };
}

describe('runAgent OpenCode adapter', () => {
  it('refuses send when the live OpenCode catalog is missing or the variant is unsupported', async () => {
    const empty = fakeHarness([[exactUsageEvent, { type: 'done', finishReason: 'stop' }]]);
    empty.harness.listProviders = vi.fn(async () => []);
    const adapter = createOpenCodeRunAgentAdapter(empty.harness);
    await expect(
      adapter.run({
        agent,
        messages: [{ role: 'user', content: 'hello' }],
        selection: { providerId: 'openai', modelId: 'gpt-exact' },
        scopeId: 'scope-catalog-empty',
      }),
    ).rejects.toThrowError(/Static model lists cannot execute/);
    expect(empty.send).not.toHaveBeenCalled();

    const live = fakeHarness([[exactUsageEvent, { type: 'done', finishReason: 'stop' }]]);
    const liveAdapter = createOpenCodeRunAgentAdapter(live.harness);
    await expect(
      liveAdapter.run({
        agent,
        messages: [{ role: 'user', content: 'hello' }],
        selection: { providerId: 'openai', modelId: 'gpt-exact' },
        variant: 'max',
        scopeId: 'scope-live-variant',
      }),
    ).rejects.toThrowError(/unsupported/);
    expect(live.send).not.toHaveBeenCalled();

    await liveAdapter.run({
      agent,
      messages: [{ role: 'user', content: 'hello' }],
      selection: { providerId: 'openai', modelId: 'gpt-exact' },
      variant: 'high',
      scopeId: 'scope-live-ok',
    });
    expect(live.send).toHaveBeenCalledWith(expect.objectContaining({ variant: 'high' }));
  });

  it('fails closed on a Token refresh 401 instead of completing the turn', async () => {
    const fake = fakeHarness([
      [{ type: 'error', code: 'HARNESS_AUTH_FAILED', message: 'Token refresh failed: 401' }],
    ]);
    const adapter = createOpenCodeRunAgentAdapter(fake.harness);
    await expect(
      adapter.run({
        agent,
        messages: [{ role: 'user', content: 'hello' }],
        selection: { providerId: 'openai', modelId: 'gpt-exact' },
        scopeId: 'scope-auth-401',
      }),
    ).rejects.toMatchObject({
      name: 'HarnessError',
      code: 'HARNESS_AUTH_FAILED',
    });
    expect(fake.send).toHaveBeenCalledOnce();
  });

  it('binds a newly created OpenCode session before it can send tools', async () => {
    const fake = fakeHarness([[exactUsageEvent, { type: 'done', finishReason: 'stop' }]]);
    const claim = authorityClaim(1);
    const authority = {
      capture: vi.fn(() => claim),
      bind: vi.fn((_sessionId: string, _claim: unknown) => true),
      release: vi.fn(),
    };
    const adapter = createOpenCodeRunAgentAdapter(fake.harness, authority);

    await adapter.run({
      agent,
      messages: [{ role: 'user', content: 'hello' }],
      selection: { providerId: 'openai', modelId: 'gpt-exact' },
      scopeId: 'scope-authority',
    });

    expect(authority.bind).toHaveBeenCalledWith('session-1', claim);
    expect(authority.bind.mock.invocationCallOrder[0]).toBeLessThan(
      fake.send.mock.invocationCallOrder[0]!,
    );
  });

  it('deletes a session and never sends when authority changes during creation', async () => {
    const fake = fakeHarness([[exactUsageEvent, { type: 'done', finishReason: 'stop' }]]);
    let resolveCreation: ((session: { id: string; chatId: string }) => void) | undefined;
    fake.createSession.mockImplementationOnce(
      (input) =>
        new Promise((resolve) => {
          resolveCreation = resolve;
        }),
    );
    const initialAuthority = authorityClaim(1);
    let currentAuthority = initialAuthority;
    const authority = {
      capture: vi.fn(() => currentAuthority),
      bind: vi.fn((_sessionId: string, claim: unknown) => claim === currentAuthority),
      release: vi.fn(),
    };
    const adapter = createOpenCodeRunAgentAdapter(fake.harness, authority);

    const result = adapter.run({
      agent,
      messages: [{ role: 'user', content: 'hello' }],
      selection: { providerId: 'openai', modelId: 'gpt-exact' },
      scopeId: 'scope-transition',
    });
    await vi.waitFor(() => expect(fake.createSession).toHaveBeenCalledOnce());
    currentAuthority = authorityClaim(2);
    resolveCreation?.({ id: 'session-late', chatId: 'scope-transition' });

    await expect(result).rejects.toThrow(/authority is unavailable/i);
    expect(authority.bind).toHaveBeenCalledWith('session-late', initialAuthority);
    expect(fake.deleteSession).toHaveBeenCalledWith(
      'session-late',
      expect.stringMatching(/^[A-Za-z]:[\\/]|^\//),
    );
    expect(fake.send).not.toHaveBeenCalled();
  });

  it('retires a stale cached parent tree before creating a child in a new authority', async () => {
    const fake = fakeHarness([
      [exactUsageEvent, { type: 'done', finishReason: 'stop' }],
      [exactUsageEvent, { type: 'done', finishReason: 'stop' }],
    ]);
    let currentAuthority = authorityClaim(1);
    const bindings = new Map<string, ToolGatewayAuthorityClaim>();
    const authority = {
      capture: vi.fn(() => currentAuthority),
      bind: vi.fn((sessionId: string, claim: ToolGatewayAuthorityClaim) => {
        if (claim !== currentAuthority) return false;
        const existing = bindings.get(sessionId);
        if (existing && existing !== claim) return false;
        bindings.set(sessionId, claim);
        return true;
      }),
      release: vi.fn((sessionId: string) => {
        bindings.delete(sessionId);
      }),
    };
    const adapter = createOpenCodeRunAgentAdapter(fake.harness, authority);
    const childInput = {
      agent,
      messages: [{ role: 'user' as const, content: 'child turn' }],
      selection: { providerId: 'openai', modelId: 'gpt-exact' },
      scopeId: 'child-scope',
      parentScopeId: 'parent-scope',
    };

    await adapter.run(childInput);
    currentAuthority = authorityClaim(2);
    await adapter.run(childInput);

    expect(fake.deleteSession).toHaveBeenCalledWith(
      'session-1',
      expect.stringMatching(/^[A-Za-z]:[\\/]|^\//),
    );
    expect(fake.deleteSession).toHaveBeenCalledWith(
      'session-2',
      expect.stringMatching(/^[A-Za-z]:[\\/]|^\//),
    );
    expect(fake.createSession).toHaveBeenNthCalledWith(3, {
      chatId: 'parent-scope',
      title: 'Test',
      workingDirectory: expect.stringMatching(/^[A-Za-z]:[\\/]|^\//),
    });
    expect(fake.createSession).toHaveBeenNthCalledWith(4, {
      chatId: 'child-scope',
      title: 'Test',
      parentSessionId: 'session-3',
      workingDirectory: expect.stringMatching(/^[A-Za-z]:[\\/]|^\//),
    });
    expect(fake.send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionId: 'session-4' }),
    );
  });

  it('retires the session and never sends when authority changes in onSessionBound', async () => {
    const fake = fakeHarness([[exactUsageEvent, { type: 'done', finishReason: 'stop' }]]);
    let currentAuthority = authorityClaim(1);
    const bindings = new Map<string, ToolGatewayAuthorityClaim>();
    const authority = {
      capture: vi.fn(() => currentAuthority),
      bind: vi.fn((sessionId: string, claim: ToolGatewayAuthorityClaim) => {
        if (claim !== currentAuthority) return false;
        const existing = bindings.get(sessionId);
        if (existing && existing !== claim) return false;
        bindings.set(sessionId, claim);
        return true;
      }),
      release: vi.fn((sessionId: string) => {
        bindings.delete(sessionId);
      }),
    };
    const adapter = createOpenCodeRunAgentAdapter(fake.harness, authority);

    const result = adapter.run({
      agent,
      messages: [{ role: 'user', content: 'hello' }],
      selection: { providerId: 'openai', modelId: 'gpt-exact' },
      scopeId: 'scope-callback-transition',
      onSessionBound: () => {
        currentAuthority = authorityClaim(2);
      },
    });

    await expect(result).rejects.toThrow(/authority changed/i);
    expect(fake.deleteSession).toHaveBeenCalledWith(
      'session-1',
      expect.stringMatching(/^[A-Za-z]:[\\/]|^\//),
    );
    expect(authority.release).toHaveBeenCalledWith('session-1');
    expect(fake.send).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    useAuthStore.setState({
      localUserId: 'account-a',
      cloudSession: null,
      workspaceId: 'workspace-a' as WorkspaceId,
      projectId: 'project-a' as ProjectId,
    });
    clearToolGatewayAuthorityForTests();
  });

  it('preserves streaming, exact model identity, usage, attachments, and working directory', async () => {
    const fake = fakeHarness([
      [
        { type: 'assistant.delta', text: 'Hel' },
        { type: 'assistant.delta', text: 'lo' },
        {
          type: 'usage.updated',
          usage: {
            inputTokens: 12,
            outputTokens: 2,
            cachedTokens: 4,
            costUsd: 0.25,
            providerId: 'openai',
            modelId: 'gpt-exact',
          },
        },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);
    const adapter = createOpenCodeRunAgentAdapter(fake.harness);
    const chunks: unknown[] = [];

    await expect(
      adapter.run({
        agent,
        scopeId: 'chat-1',
        selection: { providerId: 'openai', modelId: 'gpt-exact' },
        messages: [
          { role: 'assistant', content: 'Earlier' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Look at this' },
              { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png', name: 'tiny.png' },
            ],
          },
        ],
        workingDirectory: 'C:\\workspace',
        variant: 'xhigh',
        onChunk: (chunk) => chunks.push(chunk),
      }),
    ).resolves.toEqual({
      text: 'Hello',
      usage: { input_tokens: 12, output_tokens: 2, cost_usd: 0.25 },
      provider: 'openai',
      model: 'gpt-exact',
      finish_reason: 'stop',
    });

    expect(fake.createSession).toHaveBeenCalledWith({
      chatId: 'chat-1',
      title: 'Test',
      workingDirectory: 'C:\\workspace',
    });
    expect(fake.send).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        selection: { providerId: 'openai', modelId: 'gpt-exact' },
        system: 'SYSTEM',
        workingDirectory: 'C:\\workspace',
        variant: 'xhigh',
        parts: [
          { type: 'text', text: 'Assistant: Earlier\n\nUser: Look at this' },
          {
            type: 'file',
            mime: 'image/png',
            filename: 'tiny.png',
            url: 'data:image/png;base64,aGVsbG8=',
          },
        ],
      }),
    );
    expect(chunks).toEqual([
      { delta: 'Hel', first: true },
      { delta: 'lo' },
      { delta: '', done: true },
    ]);
  });

  it('reuses a scoped session and sends only newly appended conversation messages', async () => {
    const fake = fakeHarness([
      [{ type: 'assistant.delta', text: 'one' }, exactUsageEvent, { type: 'done' }],
      [{ type: 'assistant.delta', text: 'two' }, exactUsageEvent, { type: 'done' }],
    ]);
    const adapter = createOpenCodeRunAgentAdapter(fake.harness);
    const base = {
      agent,
      scopeId: 'chat-1',
      selection: { providerId: 'openai', modelId: 'gpt-exact' },
    } as const;

    await adapter.run({ ...base, messages: [{ role: 'user', content: 'first' }] });
    await adapter.run({
      ...base,
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'one' },
        { role: 'user', content: 'second' },
      ],
    });

    expect(fake.createSession).toHaveBeenCalledTimes(1);
    expect(fake.send.mock.calls[1]?.[0].parts).toEqual([
      { type: 'text', text: 'Assistant: one\n\nUser: second' },
    ]);
  });

  it('binds a child scope to its existing OpenCode parent session', async () => {
    const fake = fakeHarness([
      [{ type: 'assistant.delta', text: 'parent' }, exactUsageEvent, { type: 'done' }],
      [{ type: 'assistant.delta', text: 'child' }, exactUsageEvent, { type: 'done' }],
    ]);
    const adapter = createOpenCodeRunAgentAdapter(fake.harness);
    const onSessionBound = vi.fn();

    await adapter.run({
      agent,
      scopeId: 'chat-parent',
      selection: { providerId: 'openai', modelId: 'gpt-exact' },
      messages: [{ role: 'user', content: 'parent turn' }],
    });
    await adapter.run({
      agent,
      scopeId: 'chat-child',
      parentScopeId: 'chat-parent',
      selection: { providerId: 'openai', modelId: 'gpt-exact' },
      messages: [{ role: 'user', content: 'child task' }],
      onSessionBound,
    });

    expect(fake.createSession).toHaveBeenNthCalledWith(2, {
      chatId: 'chat-child',
      title: 'Test',
      parentSessionId: 'session-1',
      workingDirectory: expect.stringMatching(/^[A-Za-z]:[\\/]|^\//),
    });
    expect(onSessionBound).toHaveBeenCalledWith({
      sessionId: 'session-2',
      parentSessionId: 'session-1',
    });
  });

  it('creates a dormant OpenCode parent before a child and reuses it for a later parent turn', async () => {
    const fake = fakeHarness([
      [{ type: 'assistant.delta', text: 'child' }, exactUsageEvent, { type: 'done' }],
      [{ type: 'assistant.delta', text: 'parent' }, exactUsageEvent, { type: 'done' }],
    ]);
    const adapter = createOpenCodeRunAgentAdapter(fake.harness);

    await adapter.run({
      agent,
      scopeId: 'chat-child',
      parentScopeId: 'chat-parent',
      selection: { providerId: 'openai', modelId: 'gpt-exact' },
      messages: [{ role: 'user', content: 'child task' }],
    });
    await adapter.run({
      agent,
      scopeId: 'chat-parent',
      selection: { providerId: 'openai', modelId: 'gpt-exact' },
      messages: [{ role: 'user', content: 'parent later' }],
    });

    expect(fake.createSession).toHaveBeenCalledTimes(2);
    expect(fake.createSession).toHaveBeenNthCalledWith(1, {
      chatId: 'chat-parent',
      title: 'Test',
      workingDirectory: expect.stringMatching(/^[A-Za-z]:[\\/]|^\//),
    });
    expect(fake.createSession).toHaveBeenNthCalledWith(2, {
      chatId: 'chat-child',
      title: 'Test',
      parentSessionId: 'session-1',
      workingDirectory: expect.stringMatching(/^[A-Za-z]:[\\/]|^\//),
    });
    expect(fake.send.mock.calls[0]?.[0].sessionId).toBe('session-2');
    expect(fake.send.mock.calls[1]?.[0].sessionId).toBe('session-1');
  });

  it('rejects invalid child relationships before creating or prompting', async () => {
    const fake = fakeHarness([]);
    const adapter = createOpenCodeRunAgentAdapter(fake.harness);

    await expect(
      adapter.run({
        agent,
        scopeId: 'chat-self',
        parentScopeId: 'chat-self',
        selection: { providerId: 'openai', modelId: 'gpt-exact' },
        messages: [{ role: 'user', content: 'self parent' }],
      }),
    ).rejects.toThrow(/parent/i);
    expect(fake.createSession).not.toHaveBeenCalled();
    expect(fake.send).not.toHaveBeenCalled();
  });

  it('rejects a child working directory that differs from its mapped parent', async () => {
    const fake = fakeHarness([
      [{ type: 'assistant.delta', text: 'parent' }, exactUsageEvent, { type: 'done' }],
    ]);
    const adapter = createOpenCodeRunAgentAdapter(fake.harness);

    await adapter.run({
      agent,
      scopeId: 'chat-parent',
      selection: { providerId: 'openai', modelId: 'gpt-exact' },
      messages: [{ role: 'user', content: 'parent' }],
      workingDirectory: 'C:\\parent',
    });
    await expect(
      adapter.run({
        agent,
        scopeId: 'chat-child',
        parentScopeId: 'chat-parent',
        selection: { providerId: 'openai', modelId: 'gpt-exact' },
        messages: [{ role: 'user', content: 'child' }],
        workingDirectory: 'C:\\different',
      }),
    ).rejects.toThrow(/working directory/i);
    expect(fake.createSession).toHaveBeenCalledTimes(1);
    expect(fake.send).toHaveBeenCalledTimes(1);
  });

  it('rejects silently reparenting an established child scope', async () => {
    const fake = fakeHarness([
      [{ type: 'assistant.delta', text: 'child' }, exactUsageEvent, { type: 'done' }],
    ]);
    const adapter = createOpenCodeRunAgentAdapter(fake.harness);

    await adapter.run({
      agent,
      scopeId: 'chat-child',
      parentScopeId: 'chat-parent-a',
      selection: { providerId: 'openai', modelId: 'gpt-exact' },
      messages: [{ role: 'user', content: 'child' }],
    });
    await expect(
      adapter.run({
        agent,
        scopeId: 'chat-child',
        parentScopeId: 'chat-parent-b',
        selection: { providerId: 'openai', modelId: 'gpt-exact' },
        messages: [{ role: 'user', content: 'child again' }],
      }),
    ).rejects.toThrow(/parent relationship/i);
    expect(fake.createSession).toHaveBeenCalledTimes(2);
    expect(fake.send).toHaveBeenCalledTimes(1);
  });

  it('replaces a scoped session when earlier conversation history changes', async () => {
    const fake = fakeHarness([
      [{ type: 'assistant.delta', text: 'one' }, exactUsageEvent, { type: 'done' }],
      [{ type: 'assistant.delta', text: 'two' }, exactUsageEvent, { type: 'done' }],
    ]);
    const adapter = createOpenCodeRunAgentAdapter(fake.harness);
    const base = {
      agent,
      scopeId: 'chat-1',
      selection: { providerId: 'openai', modelId: 'gpt-exact' },
    } as const;

    await adapter.run({ ...base, messages: [{ role: 'user', content: 'first' }] });
    await adapter.run({ ...base, messages: [{ role: 'user', content: 'edited' }] });

    expect(fake.deleteSession).toHaveBeenCalledWith(
      'session-1',
      expect.stringMatching(/^[A-Za-z]:[\\/]|^\//),
    );
    expect(fake.createSession).toHaveBeenCalledTimes(2);
    expect(fake.send.mock.calls[1]?.[0]).toMatchObject({
      sessionId: 'session-2',
      parts: [{ type: 'text', text: 'User: edited' }],
    });
  });

  it('rejects model substitution reported by the harness', async () => {
    const fake = fakeHarness([
      [
        {
          type: 'usage.updated',
          usage: { providerId: 'openai', modelId: 'gpt-fallback' },
        },
        { type: 'done' },
      ],
    ]);

    await expect(
      createOpenCodeRunAgentAdapter(fake.harness).run({
        agent,
        scopeId: 'chat-1',
        selection: { providerId: 'openai', modelId: 'gpt-exact' },
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).rejects.toThrow(/model identity/i);
  });

  it('rejects terminal completion without an observed usage event or exact usage identity', async () => {
    const missingUsage = fakeHarness([
      [{ type: 'assistant.delta', text: 'unsupported success' }, { type: 'done' }],
    ]);
    const missingIdentity = fakeHarness([
      [
        {
          type: 'usage.updated',
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        },
        { type: 'done' },
      ],
    ]);
    const input = {
      agent,
      scopeId: 'chat-telemetry',
      selection: { providerId: 'openai', modelId: 'gpt-exact' },
      messages: [{ role: 'user' as const, content: 'hello' }],
    };

    await expect(createOpenCodeRunAgentAdapter(missingUsage.harness).run(input)).rejects.toThrow(
      /usage event/i,
    );
    await expect(createOpenCodeRunAgentAdapter(missingIdentity.harness).run(input)).rejects.toThrow(
      /model identity/i,
    );
  });

  it('rejects a harness event attributed to a different OpenCode session', async () => {
    const fake = fakeHarness([
      [{ type: 'session.updated', sessionId: 'session-other' }, exactUsageEvent, { type: 'done' }],
    ]);

    await expect(
      createOpenCodeRunAgentAdapter(fake.harness).run({
        agent,
        scopeId: 'chat-session-mismatch',
        selection: { providerId: 'openai', modelId: 'gpt-exact' },
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).rejects.toThrow(/session identity/i);
  });

  it('reports exact observed zero usage as immutable completion evidence', async () => {
    const fake = fakeHarness([
      [
        { type: 'assistant.delta', text: 'zero is observed' },
        {
          type: 'usage.updated',
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            reasoningTokens: 0,
            costUsd: 0,
            providerId: 'openai',
            modelId: 'gpt-exact',
            authorization: 'Bearer never-expose',
          } as never,
        },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);
    const onCompletionEvidence = vi.fn();

    await expect(
      createOpenCodeRunAgentAdapter(fake.harness).run({
        agent,
        scopeId: 'chat-observed-zero',
        selection: { providerId: 'openai', modelId: 'gpt-exact' },
        messages: [{ role: 'user', content: 'hello' }],
        onCompletionEvidence,
      }),
    ).resolves.toMatchObject({
      text: 'zero is observed',
      usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    });

    expect(onCompletionEvidence).toHaveBeenCalledOnce();
    const evidence = onCompletionEvidence.mock.calls[0]?.[0];
    expect(evidence).toEqual({
      observedAt: expect.any(Number),
      usageEventObserved: true,
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-exact',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
      },
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.usage)).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain('never-expose');
  });

  it('snapshots the exact selection identity before streaming can mutate caller state', async () => {
    const fake = fakeHarness([
      [{ type: 'assistant.delta', text: 'stable' }, exactUsageEvent, { type: 'done' }],
    ]);
    const selection = { providerId: 'openai', modelId: 'gpt-exact' };
    const onCompletionEvidence = vi.fn();

    await createOpenCodeRunAgentAdapter(fake.harness).run({
      agent,
      scopeId: 'chat-selection-snapshot',
      selection,
      messages: [{ role: 'user', content: 'hello' }],
      onChunk: () => {
        selection.modelId = 'gpt-mutated';
      },
      onCompletionEvidence,
    });

    expect(fake.send.mock.calls[0]?.[0].selection).toEqual({
      providerId: 'openai',
      modelId: 'gpt-exact',
    });
    expect(onCompletionEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'openai', modelId: 'gpt-exact' }),
    );
  });

  it('rejects nonfinite or negative observed usage instead of reporting default zero', async () => {
    const fake = fakeHarness([
      [
        {
          type: 'usage.updated',
          usage: {
            inputTokens: -1,
            outputTokens: Number.NaN,
            costUsd: 0,
            providerId: 'openai',
            modelId: 'gpt-exact',
          },
        },
        { type: 'done' },
      ],
    ]);

    await expect(
      createOpenCodeRunAgentAdapter(fake.harness).run({
        agent,
        scopeId: 'chat-invalid-usage',
        selection: { providerId: 'openai', modelId: 'gpt-exact' },
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).rejects.toThrow(/invalid usage telemetry/i);
  });

  it('reports the same exact OpenCode session for a successful follow-up turn', async () => {
    const observedUsage: HarnessEvent = {
      type: 'usage.updated',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        providerId: 'openai',
        modelId: 'gpt-exact',
      },
    };
    const fake = fakeHarness([
      [{ type: 'assistant.delta', text: 'one' }, observedUsage, { type: 'done' }],
      [{ type: 'assistant.delta', text: 'two' }, observedUsage, { type: 'done' }],
    ]);
    const evidence: unknown[] = [];
    const adapter = createOpenCodeRunAgentAdapter(fake.harness);
    const base = {
      agent,
      scopeId: 'chat-follow-up-evidence',
      selection: { providerId: 'openai', modelId: 'gpt-exact' },
      onCompletionEvidence: (value: unknown) => evidence.push(value),
    } as const;

    await adapter.run({ ...base, messages: [{ role: 'user', content: 'first' }] });
    await adapter.run({
      ...base,
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'one' },
        { role: 'user', content: 'second' },
      ],
    });

    expect(fake.createSession).toHaveBeenCalledTimes(1);
    expect(evidence).toHaveLength(2);
    expect(evidence).toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        providerId: 'openai',
        modelId: 'gpt-exact',
      }),
      expect.objectContaining({
        sessionId: 'session-1',
        providerId: 'openai',
        modelId: 'gpt-exact',
      }),
    ]);
  });

  it('honors cancellation before and during streaming', async () => {
    const before = new AbortController();
    before.abort();
    const fake = fakeHarness([]);
    const adapter = createOpenCodeRunAgentAdapter(fake.harness);
    await expect(
      adapter.run({
        agent,
        scopeId: 'chat-1',
        selection: { providerId: 'openai', modelId: 'gpt-exact' },
        messages: [{ role: 'user', content: 'hello' }],
        signal: before.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.createSession).not.toHaveBeenCalled();

    const during = new AbortController();
    const streaming = fakeHarness([
      [{ type: 'assistant.delta', text: 'partial' }, exactUsageEvent, { type: 'done' }],
    ]);
    await expect(
      createOpenCodeRunAgentAdapter(streaming.harness).run({
        agent,
        scopeId: 'chat-2',
        selection: { providerId: 'openai', modelId: 'gpt-exact' },
        messages: [{ role: 'user', content: 'hello' }],
        signal: during.signal,
        onChunk: () => during.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('supplies a safe absolute working directory when the caller omits one', async () => {
    const fake = fakeHarness([[exactUsageEvent, { type: 'done', finishReason: 'stop' }]]);
    const adapter = createOpenCodeRunAgentAdapter(fake.harness);
    await adapter.run({
      agent,
      scopeId: 'chat-default-cwd',
      selection: { providerId: 'openai', modelId: 'gpt-exact' },
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(fake.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-default-cwd',
        workingDirectory: expect.stringMatching(/^[A-Za-z]:[\\/]|^\//),
      }),
    );
    expect(fake.send).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: expect.stringMatching(/^[A-Za-z]:[\\/]|^\//),
      }),
    );
  });

  it('rejects relative working directories and malformed image payloads before dispatch', async () => {
    const fake = fakeHarness([]);
    const adapter = createOpenCodeRunAgentAdapter(fake.harness);
    await expect(
      adapter.run({
        agent,
        scopeId: 'chat-1',
        selection: { providerId: 'openai', modelId: 'gpt-exact' },
        messages: [{ role: 'user', content: 'hello' }],
        workingDirectory: '..\\relative',
      }),
    ).rejects.toThrow(/absolute working directory/i);
    await expect(
      adapter.run({
        agent,
        scopeId: 'chat-1',
        selection: { providerId: 'openai', modelId: 'gpt-exact' },
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', data: 'not base64!', mimeType: 'image/png' }],
          },
        ],
      }),
    ).rejects.toThrow(/image attachment/i);
    expect(fake.createSession).not.toHaveBeenCalled();
  });

  it('surfaces an exact approval request without auto-approving or ending the turn', async () => {
    const approval = {
      id: 'approval-1',
      sessionId: 'session-1',
      title: 'Write to terminal',
      capability: 'terminal.write',
      pattern: ['terminal:4'],
    };
    const fake = fakeHarness([
      [
        { type: 'approval.requested', approval },
        { type: 'assistant.delta', text: 'continued' },
        exactUsageEvent,
        { type: 'done' },
      ],
    ]);
    const onApprovalRequested = vi.fn(async () => undefined);

    await expect(
      createOpenCodeRunAgentAdapter(fake.harness).run({
        agent,
        scopeId: 'chat-1',
        selection: { providerId: 'openai', modelId: 'gpt-exact' },
        messages: [{ role: 'user', content: 'write it' }],
        onApprovalRequested,
      }),
    ).resolves.toMatchObject({ text: 'continued' });

    expect(onApprovalRequested).toHaveBeenCalledWith(approval);
    expect(fake.harness.respondToApproval).not.toHaveBeenCalled();
  });

  it('forwards the exact caller tool policy without adding a fallback', async () => {
    const fake = fakeHarness([[exactUsageEvent, { type: 'done' }]]);
    const tools = {
      'terminal.list': true,
      'terminal.write': false,
      'app.getState': true,
    } as const;

    await createOpenCodeRunAgentAdapter(fake.harness).run({
      agent,
      scopeId: 'chat-1',
      selection: { providerId: 'openai', modelId: 'gpt-exact' },
      messages: [{ role: 'user', content: 'inspect' }],
      tools,
    });

    expect(fake.send).toHaveBeenCalledWith(expect.objectContaining({ tools }));
  });

  it('uses the minimal VibeSpace OpenCode agent for protected prompts', async () => {
    const fake = fakeHarness([[exactUsageEvent, { type: 'done' }]]);

    await createOpenCodeRunAgentAdapter(fake.harness).run({
      agent,
      scopeId: 'chat-1',
      selection: { providerId: 'openai', modelId: 'gpt-exact' },
      messages: [{ role: 'user', content: 'inspect protected context' }],
      compiledPrompt: {
        schemaVersion: 1,
        layers: [],
        systemText: 'PROTECTED',
        promptHash: 'hash',
        identityVersion: 1,
        profileRevisionId: 'revision',
        diagnostics: { totalChars: 9, omittedSourceRefs: [], warnings: [] },
      },
    });

    expect(fake.send).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'vibespace', system: 'PROTECTED' }),
    );
  });
});
