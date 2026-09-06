import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeOpenCodeMocks = vi.hoisted(() => ({
  request:
    vi.fn<
      (
        generation: string,
        path: string,
        init?: RequestInit,
        timeoutMs?: number,
      ) => Promise<Response>
    >(),
  events:
    vi.fn<
      (
        generation: string,
        path: string,
        signal?: AbortSignal,
      ) => AsyncGenerator<{ type: string; properties?: Readonly<Record<string, unknown>> }>
    >(),
}));

const managedRuntimeMocks = vi.hoisted(() => ({
  refresh: vi.fn(async () => undefined),
  getConnection: vi.fn(() => ({
    version: '1.18.21',
    source: 'system' as const,
    generation: 'opencode-server-question-test',
  })),
}));

vi.mock('@/lib/harness/openCodeNativeTransport', () => ({
  nativeOpenCodeRequest: nativeOpenCodeMocks.request,
  nativeOpenCodeEvents: nativeOpenCodeMocks.events,
}));

vi.mock('@/lib/harness/runtimeManager', () => ({
  harnessRuntimeManager: managedRuntimeMocks,
}));

import {
  assertAuthoritativeOpenCodeCompletion,
  assertAuthoritativeOpenCodeIdentity,
  assertAuthoritativeOpenCodeRuntimeControls,
  bindPersistentOpenCodeQuestionRoute,
  buildObservedOpenCodeGatewayAuthority,
  canonicalOpenCodeTextSuffix,
  classifyExplicitRootInventoryScope,
  combineSystemPrompt,
  contextSystemAddendum,
  currentTurnOpenCodeMessages,
  createGenerationSafeAsyncCache,
  createOpenCodeTextStreamPartTracker,
  createOpenCodeToolCallTracker,
  createPersistentOpenCodeRuntimeSupervisor,
  disposeOpenCodePersistentRuntimes,
  filterOpenCodeModelsToConnectedProviders,
  invalidateOpenCodePersistentCaches,
  managedOpenCodeAuthResult,
  normalizePersistentOpenCodeUsage,
  normalizeQuestionEvent,
  normalizeToolEvent,
  openCodeCatalogRevision,
  openCodeChecklistSnapshotsFromMessages,
  openCodePersistentAdapter,
  parseOpenCodeLiveModels,
  parseConnectedOpenCodeProviderIds,
  publicTextFromTurnMessages,
  persistentOpenCodeSessionErrorMessage,
  requireAuthoritativeOpenCodeModel,
  respondToPersistentOpenCodeApproval,
  respondToPersistentOpenCodeQuestion,
  shouldReportPersistentTurnFailure,
  shouldFailOpenCodeTurnWithoutEvidence,
  shouldReconcileOpenCodeSessionCompletion,
  toolsForPolicy,
  toOpenCodeDiscoveredModels,
} from './opencodePersistent';
import type { HarnessRuntimeManager } from '@/lib/harness/runtimeManager';
import { projectOpenCodeQuestionEvent } from '@/lib/ai/openCodeQuestionProjection';
import {
  buildOpenCodeQuestionRejectRequest,
  buildOpenCodeQuestionReplyRequest,
} from '@/lib/ai/openCodeQuestionReply';
import type { ProviderEvent, ProviderRequest } from './types';
import { readToolGatewayObservedExecutionAuthority } from '@/lib/harness/toolGatewayAuthority';
import { useAuthStore } from '@/stores/auth';
import type { ProjectId, WorkspaceId } from '@/types/common';

const liveModels = parseOpenCodeLiveModels({
  providers: [
    {
      id: 'openai',
      models: {
        'gpt-5.6-sol': {
          name: 'GPT-5.6 Sol',
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          variants: {
            xhigh: {},
            max: {},
          },
        },
      },
    },
    {
      id: 'other',
      models: {
        'gpt-5.6-sol': {
          name: 'Different route, same local ID',
          cost: { input: 0, output: 0, cache: { read: 0 } },
        },
      },
    },
  ],
});

const validNativeQuestions = [
  {
    header: 'Choice',
    question: 'Choose one.',
    options: [{ label: 'One', description: 'Use option one.' }],
  },
];

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    statusText: status === 200 ? 'OK' : 'No Content',
    headers: { 'content-type': 'application/json' },
  });
}

function configureManagedQuestionTransport(
  events: readonly { type: string; properties?: Readonly<Record<string, unknown>> }[],
  options: {
    pendingPermissions?: readonly Readonly<Record<string, unknown>>[];
    pendingQuestions?: readonly Readonly<Record<string, unknown>>[];
    sessionStatuses?: readonly (string | null)[];
    persistedMessages?: readonly Readonly<Record<string, unknown>>[];
    persistedMessagePolls?: readonly (readonly Readonly<Record<string, unknown>>[])[];
    eventStartDelayMs?: number;
    eventBurstCount?: number;
    lifecycle?: string[];
  } = {},
): void {
  let statusReadIndex = 0;
  let messageReadIndex = 0;
  nativeOpenCodeMocks.request.mockImplementation(async (_generation, path, init) => {
    if (path.startsWith('/global/health')) {
      return jsonResponse({ healthy: true, version: '1.18.21' });
    }
    if (path.startsWith('/provider')) return jsonResponse({ connected: ['openai'] });
    if (path.startsWith('/config/providers')) {
      return jsonResponse({
        providers: [
          {
            id: 'openai',
            models: { 'gpt-question-test': { name: 'Question Test' } },
          },
        ],
      });
    }
    if (path.includes('/message?')) {
      const fallbackMessages = options.persistedMessages ?? [
        {
          info: {
            id: 'msg_question_default',
            role: 'assistant',
            providerID: 'openai',
            modelID: 'gpt-question-test',
            time: { completed: 1 },
          },
          parts: [{ type: 'text', text: 'Question handled.' }],
        },
      ];
      const polls = options.persistedMessagePolls ?? [[], fallbackMessages];
      const messages = polls[Math.min(messageReadIndex, polls.length - 1)] ?? [];
      messageReadIndex += 1;
      return jsonResponse(messages);
    }
    if (path.startsWith('/question?')) return jsonResponse(options.pendingQuestions ?? []);
    if (path.startsWith('/question/')) return jsonResponse(true);
    if (path.startsWith('/permission?')) return jsonResponse(options.pendingPermissions ?? []);
    if (path.includes('/permissions/')) return jsonResponse(true);
    if (path.startsWith('/session/status')) {
      const statuses = options.sessionStatuses ?? ['busy'];
      const status = statuses[Math.min(statusReadIndex, statuses.length - 1)]!;
      statusReadIndex += 1;
      return jsonResponse(status === null ? {} : { ses_question_exact: { type: status } });
    }
    if (/^\/session(?:\?|$)/u.test(path) && init?.method === 'POST') {
      return jsonResponse({ id: 'ses_question_exact' });
    }
    if (path.includes('/abort')) return jsonResponse(true);
    if (path.includes('/prompt_async')) {
      options.lifecycle?.push('prompt-async');
      return jsonResponse(true);
    }
    if (path.startsWith('/session/') && init?.method === 'PATCH') return jsonResponse(true);
    if (path.startsWith('/session/')) return jsonResponse({ id: 'ses_question_exact' });
    throw new Error(`Unexpected managed OpenCode test path: ${path}`);
  });
  nativeOpenCodeMocks.events.mockImplementation(async function* (_generation, _path, signal) {
    options.lifecycle?.push('event-subscription-started');
    if (options.eventStartDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.eventStartDelayMs));
    }
    const count = options.eventBurstCount ?? events.length;
    for (let index = 0; index < count; index += 1) {
      if (signal?.aborted) return;
      const event = events[index % events.length];
      if (event) yield event;
    }
  });
}

function pendingPermission() {
  return {
    id: 'perm_external_write',
    sessionID: 'ses_question_exact',
    permission: 'external_directory',
    patterns: ['D:\\VibeSpace-Testing\\temp\\approval.txt'],
    metadata: { title: 'Write the approved file' },
  } as const;
}

function questionAskedEvent(toolCallId = 'call_question_exact') {
  return {
    type: 'question.asked',
    properties: {
      id: 'que_question_exact',
      sessionID: 'ses_question_exact',
      questions: [
        {
          header: 'Approach',
          question: 'Which implementation should I use?',
          options: [
            { label: 'Smallest fix', description: 'Change the narrow boundary.' },
            { label: 'Broader refactor', description: 'Change the surrounding module.' },
          ],
          multiple: false,
          custom: false,
        },
      ],
      tool: { messageID: 'msg_question_exact', callID: toolCallId },
    },
  } as const;
}

function questionProviderRequest(requestId: string, signal?: AbortSignal): ProviderRequest {
  return {
    requestId,
    chatId: `chat-${requestId}`,
    accountId: 'account-question-test',
    workspaceId: 'workspace-question-test',
    prompt: 'Ask the bounded question.',
    modelId: 'openai/gpt-question-test',
    workingDirectory: 'C:\\workspace',
    connection: {
      id: 'opencode-cli',
      adapterId: 'opencode-cli',
      providerId: 'opencode',
      displayName: 'OpenCode',
      mode: 'external-cli',
      authSource: 'managed-runtime',
      capabilities: {
        text: true,
        images: false,
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
        subscriptionQuota: false,
        localOnly: false,
      },
      promptTransport: 'native-system',
      enabled: true,
    },
    ...(signal ? { signal } : {}),
  };
}

async function startWaitingQuestion(requestId: string, signal?: AbortSignal) {
  const iterator = openCodePersistentAdapter.send!(questionProviderRequest(requestId, signal))[
    Symbol.asyncIterator
  ]();
  await expect(iterator.next()).resolves.toEqual({
    done: false,
    value: { type: 'session', sessionId: 'ses_question_exact' },
  });
  const question = await iterator.next();
  expect(question.done).toBe(false);
  expect(question.value).toMatchObject({
    type: 'question',
    request: { id: 'que_question_exact', sessionId: 'ses_question_exact' },
  });
  const projection = projectOpenCodeQuestionEvent(
    question.value as ProviderEvent,
    'ses_question_exact',
  );
  expect(projection).toBeDefined();
  return { iterator, projection: projection! };
}

async function drain(iterator: AsyncIterator<ProviderEvent>): Promise<void> {
  for (;;) {
    const next = await iterator.next();
    if (next.done) return;
  }
}

describe('persistent OpenCode question transport authority', () => {
  beforeEach(async () => {
    await disposeOpenCodePersistentRuntimes();
    invalidateOpenCodePersistentCaches();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    vi.clearAllMocks();
    configureManagedQuestionTransport([questionAskedEvent(), { type: 'session.idle' }]);
  });

  afterEach(async () => {
    await disposeOpenCodePersistentRuntimes();
    invalidateOpenCodePersistentCaches();
  });

  it('binds exact question authority and sends the official reply through the same managed transport', async () => {
    const { iterator, projection } = await startWaitingQuestion('request-question-reply');
    bindPersistentOpenCodeQuestionRoute(projection.route);
    const question = projection.route.questions[0]!;
    const request = buildOpenCodeQuestionReplyRequest({
      route: projection.route,
      expectedSessionId: projection.route.sessionId,
      blockId: projection.route.blockId,
      answers: [
        {
          questionId: question.questionId,
          selectedOptionIds: [question.options[0]!.optionId],
        },
      ],
    });
    expect(request).toBeDefined();

    await expect(
      respondToPersistentOpenCodeQuestion({
        request: request!,
        expectedSessionId: projection.route.sessionId,
        expectedBlockId: projection.route.blockId,
      }),
    ).resolves.toMatchObject({
      protocol: 'opencode-question-dispatch-receipt-v1',
      action: 'reply',
      sessionId: 'ses_question_exact',
      requestId: 'que_question_exact',
      blockId: projection.route.blockId,
      tool: { messageId: 'msg_question_exact', callId: 'call_question_exact' },
      questionCount: 1,
    });

    const transportCall = nativeOpenCodeMocks.request.mock.calls.find(([, path]) =>
      path.startsWith('/question/'),
    );
    expect(transportCall).toEqual([
      'opencode-server-question-test',
      '/question/que_question_exact/reply?directory=C%3A%5Cworkspace',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ answers: [['Smallest fix']] }),
        signal: expect.any(AbortSignal),
      }),
      30_000,
    ]);

    await expect(
      respondToPersistentOpenCodeQuestion({
        request: request!,
        expectedSessionId: projection.route.sessionId,
        expectedBlockId: projection.route.blockId,
      }),
    ).rejects.toThrow(/no longer waiting|no longer active/i);
    expect(
      nativeOpenCodeMocks.request.mock.calls.filter(([, path]) => path.startsWith('/question/')),
    ).toHaveLength(1);

    await drain(iterator);
    expect(() => bindPersistentOpenCodeQuestionRoute(projection.route)).toThrow(
      /no longer active/i,
    );
  });

  it('surfaces an accepted busy turn as interrupted after its renderer observer is reinitialized without redispatching', async () => {
    const request = questionProviderRequest('request-renderer-reload');
    configureManagedQuestionTransport([], {
      sessionStatuses: ['busy'],
      persistedMessagePolls: [
        [],
        [
          {
            info: {
              id: 'msg_renderer_reload_user',
              role: 'user',
              time: { created: 1 },
            },
            parts: [{ type: 'text', text: 'Keep working on the accepted turn.' }],
          },
        ],
      ],
    });

    const original = openCodePersistentAdapter.send!(request)[Symbol.asyncIterator]();
    await expect(original.next()).resolves.toEqual({
      done: false,
      value: { type: 'session', sessionId: 'ses_question_exact' },
    });

    await disposeOpenCodePersistentRuntimes();

    const reinitialized = openCodePersistentAdapter.send!(request)[Symbol.asyncIterator]();
    await expect(reinitialized.next()).resolves.toEqual({
      done: false,
      value: {
        type: 'error',
        message:
          'OpenCode response was interrupted by a renderer restart. Retry to continue the persisted session.',
      },
    });
    await expect(reinitialized.next()).resolves.toEqual({ done: true, value: undefined });
    expect(
      nativeOpenCodeMocks.request.mock.calls.filter(([, path]) => path.includes('/prompt_async')),
    ).toHaveLength(1);

    await original.return?.();
  });

  it('recovers a pending question when the v2 event feed omits question.asked and closes mid-turn', async () => {
    const pending = questionAskedEvent().properties;
    configureManagedQuestionTransport(
      [
        {
          type: 'message.part.updated',
          properties: {
            sessionID: 'ses_question_exact',
            part: {
              id: 'prt_question_exact',
              sessionID: 'ses_question_exact',
              messageID: 'msg_question_exact',
              type: 'tool',
              tool: 'question',
              callID: 'call_question_exact',
              state: { status: 'running', input: { questions: validNativeQuestions } },
            },
          },
        },
      ],
      { pendingQuestions: [pending], sessionStatuses: ['busy'] },
    );

    const iterator = openCodePersistentAdapter.send!(
      questionProviderRequest('request-question-v2-recovery'),
    )[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'session', sessionId: 'ses_question_exact' },
    });

    let recovered: ProviderEvent | undefined;
    for (let index = 0; index < 4 && !recovered; index += 1) {
      const next = await iterator.next();
      if (!next.done && next.value.type === 'question') recovered = next.value;
    }
    expect(recovered).toMatchObject({
      type: 'question',
      request: {
        id: 'que_question_exact',
        sessionId: 'ses_question_exact',
        tool: { messageId: 'msg_question_exact', callId: 'call_question_exact' },
      },
    });
    expect(
      nativeOpenCodeMocks.request.mock.calls.some(([, path]) => path.startsWith('/question?')),
    ).toBe(true);

    await iterator.return?.();
  });

  it('recovers the pending question UI when the optional native event iterator rejects', async () => {
    const pending = questionAskedEvent().properties;
    configureManagedQuestionTransport([], {
      pendingQuestions: [pending],
      sessionStatuses: ['busy'],
    });
    nativeOpenCodeMocks.events.mockImplementation(async function* () {
      throw new Error('OpenCode native event queue exceeded safe limits.');
    });

    const iterator = openCodePersistentAdapter.send!(
      questionProviderRequest('request-question-rejected-stream'),
    )[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'session', sessionId: 'ses_question_exact' },
    });

    let recovered: ProviderEvent | undefined;
    for (let index = 0; index < 4 && !recovered; index += 1) {
      const next = await iterator.next();
      if (!next.done && next.value.type === 'question') recovered = next.value;
    }
    expect(recovered).toMatchObject({
      type: 'question',
      request: {
        id: 'que_question_exact',
        sessionId: 'ses_question_exact',
        tool: { messageId: 'msg_question_exact', callId: 'call_question_exact' },
      },
    });

    await iterator.return?.();
  });

  it('recovers a pending question immediately when heartbeat events starve the status poll', async () => {
    const pending = questionAskedEvent().properties;
    configureManagedQuestionTransport([], {
      pendingQuestions: [pending],
      sessionStatuses: ['busy'],
    });
    nativeOpenCodeMocks.events.mockImplementation(async function* (_generation, _path, signal) {
      yield {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_question_exact',
          part: {
            id: 'prt_question_exact',
            sessionID: 'ses_question_exact',
            messageID: 'msg_question_exact',
            type: 'tool',
            tool: 'question',
            callID: 'call_question_exact',
            state: { status: 'running', input: { questions: validNativeQuestions } },
          },
        },
      };
      while (!signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield { type: 'server.heartbeat' };
      }
    });
    const abort = new AbortController();
    const iterator = openCodePersistentAdapter.send!(
      questionProviderRequest('request-question-heartbeat-recovery', abort.signal),
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'session' } });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'tool', name: 'question', status: 'started' },
    });
    await expect(
      Promise.race([
        iterator.next(),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('question recovery was starved')), 750),
        ),
      ]),
    ).resolves.toMatchObject({
      done: false,
      value: { type: 'question', request: { id: 'que_question_exact' } },
    });

    abort.abort();
    await iterator.return?.();
  });

  it('reconciles pending questions on schedule when the native stream contains only heartbeats', async () => {
    const pending = questionAskedEvent().properties;
    configureManagedQuestionTransport([], {
      pendingQuestions: [pending],
      sessionStatuses: ['busy'],
    });
    nativeOpenCodeMocks.events.mockImplementation(async function* (_generation, _path, signal) {
      while (!signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield { type: 'server.heartbeat' };
      }
    });
    const abort = new AbortController();
    const iterator = openCodePersistentAdapter.send!(
      questionProviderRequest('request-question-heartbeat-only', abort.signal),
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'session' } });
    await expect(
      Promise.race([
        iterator.next(),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('scheduled reconciliation was starved')), 750),
        ),
      ]),
    ).resolves.toMatchObject({
      done: false,
      value: { type: 'question', request: { id: 'que_question_exact' } },
    });

    abort.abort();
    await iterator.return?.();
  });

  it('publishes validated observed execution identity to the exact Tool Gateway session and releases it', async () => {
    useAuthStore.setState({
      localUserId: 'account-question-test',
      workspaceId: 'workspace-question-test' as WorkspaceId,
      projectId: 'project-question-test' as ProjectId,
    });
    configureManagedQuestionTransport([
      {
        type: 'message.updated',
        properties: {
          sessionID: 'ses_question_exact',
          info: {
            role: 'assistant',
            sessionID: 'ses_question_exact',
            providerID: 'openai',
            modelID: 'gpt-question-test',
          },
        },
      },
      questionAskedEvent(),
      { type: 'session.idle' },
    ]);
    const request = questionProviderRequest('request-gateway-observed');
    request.projectId = 'project-question-test';
    request.worktreeId = 'C:\\workspace';
    request.tools = { vibespace_context: true };
    const iterator = openCodePersistentAdapter.send!(request)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'session', sessionId: 'ses_question_exact' },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'model', modelId: 'openai/gpt-question-test' },
    });
    expect(readToolGatewayObservedExecutionAuthority('ses_question_exact')).toMatchObject({
      executionIdentity: {
        transportConnectionId: 'opencode-cli',
        transportAdapterId: 'opencode-cli',
        upstreamProviderId: 'openai',
        upstreamModelId: 'gpt-question-test',
        providerQualifiedModelId: 'openai/gpt-question-test',
        authBillingRoute: 'managed-runtime',
        effort: 'provider-default',
        fastVariant: 'standard',
        catalogRevision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        observedProviderIdentity: 'openai/gpt-question-test',
      },
      performance: 'quality',
    });

    await drain(iterator);
    expect(readToolGatewayObservedExecutionAuthority('ses_question_exact')).toBeNull();
  });

  it('sends official reject without a body and consumes the exact authority once', async () => {
    const { iterator, projection } = await startWaitingQuestion('request-question-reject');
    bindPersistentOpenCodeQuestionRoute(projection.route);
    const request = buildOpenCodeQuestionRejectRequest({
      route: projection.route,
      expectedSessionId: projection.route.sessionId,
      blockId: projection.route.blockId,
    });
    expect(request).toBeDefined();

    await expect(
      respondToPersistentOpenCodeQuestion({
        request: request!,
        expectedSessionId: projection.route.sessionId,
        expectedBlockId: projection.route.blockId,
      }),
    ).resolves.toMatchObject({ action: 'reject', questionCount: 0 });

    const transportCall = nativeOpenCodeMocks.request.mock.calls.find(([, path]) =>
      path.startsWith('/question/'),
    );
    expect(transportCall?.[0]).toBe('opencode-server-question-test');
    expect(transportCall?.[1]).toBe(
      '/question/que_question_exact/reject?directory=C%3A%5Cworkspace',
    );
    expect(transportCall?.[2]).toMatchObject({ method: 'POST' });
    expect(transportCall?.[2]).not.toHaveProperty('body');

    await expect(
      respondToPersistentOpenCodeQuestion({
        request: request!,
        expectedSessionId: projection.route.sessionId,
        expectedBlockId: projection.route.blockId,
      }),
    ).rejects.toThrow(/no longer waiting|no longer active/i);
    await drain(iterator);
  });

  it('fails closed for malformed, cross-session, or cross-tool bindings without transport I/O', async () => {
    const { iterator, projection } = await startWaitingQuestion('request-question-invalid');
    expect(() =>
      bindPersistentOpenCodeQuestionRoute({
        ...projection.route,
        sessionId: 'ses_question_other',
      }),
    ).toThrow(/no longer active/i);
    expect(() =>
      bindPersistentOpenCodeQuestionRoute({
        ...projection.route,
        tool: { messageId: 'msg_question_exact', callId: 'call_question_other' },
      }),
    ).toThrow(/no longer active/i);

    bindPersistentOpenCodeQuestionRoute(projection.route);
    const validRequest = buildOpenCodeQuestionRejectRequest({
      route: projection.route,
      expectedSessionId: projection.route.sessionId,
      blockId: projection.route.blockId,
    });
    expect(validRequest).toBeDefined();
    await expect(
      respondToPersistentOpenCodeQuestion({
        request: { ...validRequest!, path: '/question/que_question_other/reject' },
        expectedSessionId: projection.route.sessionId,
        expectedBlockId: projection.route.blockId,
      }),
    ).rejects.toThrow(/invalid/i);
    await expect(
      respondToPersistentOpenCodeQuestion({
        request: validRequest!,
        expectedSessionId: 'ses_question_other',
        expectedBlockId: projection.route.blockId,
      }),
    ).rejects.toThrow(/no longer active/i);
    expect(
      nativeOpenCodeMocks.request.mock.calls.filter(([, path]) => path.startsWith('/question/')),
    ).toHaveLength(0);
    await iterator.return?.();
  });

  it('rejects a duplicate native question whose tool authority changes and clears the registry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    configureManagedQuestionTransport([
      questionAskedEvent(),
      questionAskedEvent('call_question_changed'),
    ]);
    const { iterator, projection } = await startWaitingQuestion('request-question-duplicate');

    await expect(iterator.next()).rejects.toThrow(/authority changed/i);
    expect(nativeOpenCodeMocks.request.mock.calls).toContainEqual([
      'opencode-server-question-test',
      '/session/ses_question_exact/abort?directory=C%3A%5Cworkspace',
      expect.objectContaining({ method: 'POST', body: '{}' }),
      30_000,
    ]);
    expect(() => bindPersistentOpenCodeQuestionRoute(projection.route)).toThrow(
      /no longer active/i,
    );
    warn.mockRestore();
  });

  it('clears waiting question authority when the owning provider request is cancelled', async () => {
    const controller = new AbortController();
    const { iterator, projection } = await startWaitingQuestion(
      'request-question-cancel',
      controller.signal,
    );
    bindPersistentOpenCodeQuestionRoute(projection.route);

    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(() => bindPersistentOpenCodeQuestionRoute(projection.route)).toThrow(
      /no longer active/i,
    );
    const request = buildOpenCodeQuestionRejectRequest({
      route: projection.route,
      expectedSessionId: projection.route.sessionId,
      blockId: projection.route.blockId,
    });
    await expect(
      respondToPersistentOpenCodeQuestion({
        request: request!,
        expectedSessionId: projection.route.sessionId,
        expectedBlockId: projection.route.blockId,
      }),
    ).rejects.toThrow(/no longer active/i);
  });
});

describe('persistent OpenCode approval recovery', () => {
  beforeEach(async () => {
    await disposeOpenCodePersistentRuntimes();
    invalidateOpenCodePersistentCaches();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await disposeOpenCodePersistentRuntimes();
    invalidateOpenCodePersistentCaches();
  });

  it('recovers a pending permission when the optional event feed closes before permission.asked', async () => {
    const onApprovalRequested = vi.fn(async () => undefined);
    configureManagedQuestionTransport([], {
      pendingPermissions: [pendingPermission()],
      sessionStatuses: ['busy'],
    });
    const iterator = openCodePersistentAdapter.send!({
      ...questionProviderRequest('request-permission-recovery'),
      onApprovalRequested,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'session' } });
    await expect(
      Promise.race([
        iterator.next(),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('permission recovery timed out')), 750),
        ),
      ]),
    ).resolves.toMatchObject({ done: false });
    expect(onApprovalRequested).toHaveBeenCalledOnce();
    expect(onApprovalRequested).toHaveBeenCalledWith({
      id: 'perm_external_write',
      sessionId: 'ses_question_exact',
      title: 'Write the approved file',
      capability: 'external_directory',
      pattern: ['D:\\VibeSpace-Testing\\temp\\approval.txt'],
    });

    await iterator.return?.();
  });

  it('rebinds a persisted exact approval route after the originating iterator is gone', async () => {
    const onApprovalRequested = vi.fn(async () => undefined);
    configureManagedQuestionTransport([], {
      pendingPermissions: [pendingPermission()],
      sessionStatuses: ['busy'],
    });
    const iterator = openCodePersistentAdapter.send!({
      ...questionProviderRequest('request-permission-rebind'),
      onApprovalRequested,
    })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'session' } });
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    expect(onApprovalRequested).toHaveBeenCalledOnce();
    await iterator.return?.();

    await expect(
      respondToPersistentOpenCodeApproval({
        sessionId: 'ses_question_exact',
        approvalId: 'perm_external_write',
        response: 'once',
        route: {
          protocol: 'opencode-approval-v1',
          chatId: 'chat-request-permission-rebind',
          accountId: 'account-question-test',
          workspaceId: 'workspace-question-test',
          workingDirectory: 'C:\\workspace',
          sessionId: 'ses_question_exact',
          approvalId: 'perm_external_write',
          capability: 'external_directory',
        },
      }),
    ).resolves.toBeUndefined();
    expect(
      nativeOpenCodeMocks.request.mock.calls.filter(([, path]) => path.includes('/permissions/')),
    ).toHaveLength(1);

    await expect(
      respondToPersistentOpenCodeApproval({
        sessionId: 'ses_question_exact',
        approvalId: 'perm_external_write',
        response: 'once',
        route: {
          protocol: 'opencode-approval-v1',
          chatId: 'chat-request-permission-rebind',
          accountId: 'account-question-test',
          workspaceId: 'workspace-question-test',
          workingDirectory: 'C:\\workspace',
          sessionId: 'ses_question_exact',
          approvalId: 'perm_external_write',
          capability: 'external_directory',
        },
      }),
    ).rejects.toThrow(/no longer pending|no longer active/i);
  });
});

describe('persistent OpenCode live authority', () => {
  it('preserves exact provider capability fields and combined effort/Fast variant semantics', () => {
    const [model] = parseOpenCodeLiveModels({
      providers: [
        {
          id: 'openai',
          models: {
            'gpt-5.6-sol': {
              variants: { 'high-fast': {} },
              supportsIndependentReasoningEffort: true,
              serviceTiers: ['priority', 'fast', 'priority'],
              supportsOpenCodeFastMode: true,
            },
          },
        },
      ],
    });

    expect(model).toMatchObject({
      supportsIndependentReasoningEffort: true,
      serviceTiers: ['priority', 'fast'],
      supportsOpenCodeFastMode: true,
      variants: [
        {
          id: 'high-fast',
          kind: 'combined',
          reasoningEffort: 'high',
          fast: true,
        },
      ],
    });
  });

  it('rejects malformed live capability claims and does not infer Fast from partial words', () => {
    const [model] = parseOpenCodeLiveModels({
      providers: [{ id: 'openai', models: { 'gpt-5.6-sol': { variants: { breakfast: {} } } } }],
    });
    expect(model.variants).toEqual([{ id: 'breakfast' }]);

    expect(() =>
      parseOpenCodeLiveModels({
        providers: [{ id: 'openai', models: { 'gpt-5.6-sol': { serviceTiers: 'fast' } } }],
      }),
    ).toThrow(/malformed service tier metadata/u);
    expect(() =>
      parseOpenCodeLiveModels({
        providers: [
          {
            id: 'openai',
            models: { 'gpt-5.6-sol': { supportsOpenCodeFastMode: 'yes' } },
          },
        ],
      }),
    ).toThrow(/malformed supportsOpenCodeFastMode capability metadata/u);
  });

  it('publishes an exact observed combined variant instead of provider-default and standard', () => {
    const [model] = parseOpenCodeLiveModels({
      providers: [
        {
          id: 'openai',
          models: { 'gpt-5.6-sol': { variants: { 'high-fast': {} } } },
        },
      ],
    });
    const authority = buildObservedOpenCodeGatewayAuthority({
      connection: questionProviderRequest('gateway-combined-fast').connection,
      model,
      observed: { providerId: 'openai', modelId: 'gpt-5.6-sol', variant: 'high-fast' },
      controls: {
        connectionId: 'opencode-cli',
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        variant: 'high-fast',
        performance: 'quality',
        rlmEnabled: true,
      },
      catalogRevision: `sha256:${'e'.repeat(64)}`,
    });

    expect(authority.executionIdentity).toMatchObject({
      effort: 'high',
      fastVariant: 'high-fast',
      observedProviderIdentity: 'openai/gpt-5.6-sol',
    });
  });

  it('derives a deterministic revision from the exact ordered connected catalog', async () => {
    const first = await openCodeCatalogRevision(liveModels);
    const same = await openCodeCatalogRevision(liveModels.map((model) => ({ ...model })));
    const changed = await openCodeCatalogRevision(liveModels.slice(0, 1));

    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(same).toBe(first);
    expect(changed).not.toBe(first);
  });

  it('preserves variant-backed effort in Gateway authority after matching observed identity', () => {
    const model = requireAuthoritativeOpenCodeModel(liveModels, 'openai/gpt-5.6-sol');
    expect(
      buildObservedOpenCodeGatewayAuthority({
        connection: questionProviderRequest('gateway-authority').connection,
        model,
        observed: {
          providerId: 'openai',
          modelId: 'gpt-5.6-sol',
          variant: 'max',
        },
        controls: {
          connectionId: 'opencode-cli',
          providerId: 'openai',
          modelId: 'gpt-5.6-sol',
          variant: 'max',
          performance: 'quality',
          rlmEnabled: true,
        },
        catalogRevision: `sha256:${'a'.repeat(64)}`,
      }),
    ).toEqual({
      executionIdentity: {
        transportConnectionId: 'opencode-cli',
        transportAdapterId: 'opencode-cli',
        upstreamProviderId: 'openai',
        upstreamModelId: 'gpt-5.6-sol',
        providerQualifiedModelId: 'openai/gpt-5.6-sol',
        authBillingRoute: 'managed-runtime',
        effort: 'max',
        fastVariant: 'standard',
        catalogRevision: `sha256:${'a'.repeat(64)}`,
        observedProviderIdentity: 'openai/gpt-5.6-sol',
      },
      performance: 'quality',
    });
    expect(() =>
      buildObservedOpenCodeGatewayAuthority({
        connection: questionProviderRequest('gateway-authority-mismatch').connection,
        model,
        observed: { providerId: 'other', modelId: 'gpt-5.6-sol', variant: 'max' },
        controls: {
          connectionId: 'opencode-cli',
          providerId: 'openai',
          modelId: 'gpt-5.6-sol',
          effort: 'max',
          variant: 'max',
          performance: 'quality',
          rlmEnabled: true,
        },
        catalogRevision: `sha256:${'a'.repeat(64)}`,
      }),
    ).toThrow(/MODEL_IDENTITY_MISMATCH/);
  });

  it('preserves explicit independent effort without inventing a provider variant', () => {
    const model = requireAuthoritativeOpenCodeModel(liveModels, 'openai/gpt-5.6-sol');
    const authority = buildObservedOpenCodeGatewayAuthority({
      connection: questionProviderRequest('gateway-independent-effort').connection,
      model,
      observed: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
      controls: {
        connectionId: 'opencode-cli',
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        effort: 'high',
        performance: 'quality',
        rlmEnabled: true,
      },
      catalogRevision: `sha256:${'b'.repeat(64)}`,
    });

    expect(authority.executionIdentity.effort).toBe('high');
  });

  it('does not derive effort from an observed variant absent from the selected live catalog', () => {
    const model = requireAuthoritativeOpenCodeModel(liveModels, 'openai/gpt-5.6-sol');
    const authority = buildObservedOpenCodeGatewayAuthority({
      connection: questionProviderRequest('gateway-uncataloged-effort-variant').connection,
      model,
      observed: { providerId: 'openai', modelId: 'gpt-5.6-sol', variant: 'high' },
      controls: {
        connectionId: 'opencode-cli',
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        variant: 'high',
        performance: 'quality',
        rlmEnabled: true,
      },
      catalogRevision: `sha256:${'c'.repeat(64)}`,
    });

    expect(authority.executionIdentity.effort).toBe('provider-default');
  });

  it('does not derive effort from a catalog variant without reasoning semantics', () => {
    const model = requireAuthoritativeOpenCodeModel(liveModels, 'openai/gpt-5.6-sol');
    const authority = buildObservedOpenCodeGatewayAuthority({
      connection: questionProviderRequest('gateway-nonreasoning-variant').connection,
      model: { ...model, variants: [...model.variants, { id: 'creative', kind: 'other' }] },
      observed: { providerId: 'openai', modelId: 'gpt-5.6-sol', variant: 'creative' },
      controls: {
        connectionId: 'opencode-cli',
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        variant: 'creative',
        performance: 'quality',
        rlmEnabled: true,
      },
      catalogRevision: `sha256:${'d'.repeat(64)}`,
    });

    expect(authority.executionIdentity.effort).toBe('provider-default');
  });

  it('maps the native question request as a bounded dedicated provider event', () => {
    const event = normalizeQuestionEvent(
      {
        type: 'question.asked',
        properties: {
          id: 'que_01JQUESTION',
          sessionID: 'ses_exact',
          questions: [
            {
              header: 'Approach',
              question: 'Which implementation should I use?',
              options: [
                { label: 'Smallest fix', description: 'Change only the failing boundary.' },
                { label: 'Broader refactor', description: 'Rework the surrounding module.' },
              ],
              multiple: false,
              custom: false,
            },
          ],
          tool: { messageID: 'msg_01JASSISTANT', callID: 'call_question_1' },
          metadata: { accessToken: 'must-not-survive' },
        },
      },
      'ses_exact',
    );

    expect(event).toEqual({
      type: 'question',
      request: {
        id: 'que_01JQUESTION',
        sessionId: 'ses_exact',
        questions: [
          {
            header: 'Approach',
            prompt: 'Which implementation should I use?',
            options: [
              { label: 'Smallest fix', description: 'Change only the failing boundary.' },
              { label: 'Broader refactor', description: 'Rework the surrounding module.' },
            ],
            multiple: false,
            allowCustomAnswer: false,
          },
        ],
        tool: { messageId: 'msg_01JASSISTANT', callId: 'call_question_1' },
      },
    });
    expect(event?.type).not.toBe('tool');
    expect(JSON.stringify(event)).not.toContain('must-not-survive');
  });

  it('preserves OpenCode custom-answer defaults without inventing tool metadata', () => {
    const event = normalizeQuestionEvent(
      {
        type: 'question.asked',
        properties: {
          id: 'que_01JTEXT',
          sessionID: 'ses_exact',
          questions: [
            {
              header: 'Details',
              question: 'What should the title say?',
              options: [],
            },
          ],
        },
      },
      'ses_exact',
    );

    expect(event).toMatchObject({
      type: 'question',
      request: {
        questions: [{ multiple: false, allowCustomAnswer: true, options: [] }],
      },
    });
    expect(event && 'request' in event ? event.request : undefined).not.toHaveProperty('tool');
  });

  it.each([
    ['cross-session', { id: 'que_1', sessionID: 'ses_other', questions: validNativeQuestions }],
    [
      'legacy request identity',
      { requestID: 'que_1', sessionID: 'ses_exact', questions: validNativeQuestions },
    ],
    [
      'non-question identity',
      { id: 'approval_1', sessionID: 'ses_exact', questions: validNativeQuestions },
    ],
    ['missing questions', { id: 'que_1', sessionID: 'ses_exact' }],
    [
      'malformed option',
      {
        id: 'que_1',
        sessionID: 'ses_exact',
        questions: [
          {
            header: 'Choice',
            question: 'Choose one.',
            options: [{ label: 'One', description: 42 }],
          },
        ],
      },
    ],
    [
      'invalid custom metadata',
      {
        id: 'que_1',
        sessionID: 'ses_exact',
        questions: [{ header: 'Choice', question: 'Choose one.', options: [], custom: 'yes' }],
      },
    ],
    [
      'excessive question count',
      {
        id: 'que_1',
        sessionID: 'ses_exact',
        questions: Array.from({ length: 9 }, (_, index) => ({
          header: `Choice ${index}`,
          question: 'Choose one.',
          options: [],
        })),
      },
    ],
    [
      'excessive option count',
      {
        id: 'que_1',
        sessionID: 'ses_exact',
        questions: [
          {
            header: 'Choice',
            question: 'Choose one.',
            options: Array.from({ length: 9 }, (_, index) => ({
              label: `Option ${index}`,
              description: 'A bounded option.',
            })),
          },
        ],
      },
    ],
  ])('fails closed for %s native question data', (_label, properties) => {
    expect(
      normalizeQuestionEvent({ type: 'question.asked', properties }, 'ses_exact'),
    ).toBeUndefined();
  });

  it('retains only bounded todo milestone evidence from tool updates', () => {
    const event = normalizeToolEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'todowrite',
            callID: 'todo-call-1',
            state: {
              status: 'running',
              input: {
                todos: [
                  {
                    id: 'milestone-1',
                    content: 'Build the first level',
                    status: 'in_progress',
                    path: 'C:/private',
                  },
                ],
                prompt: 'must-not-survive',
              },
            },
          },
        },
      },
      {},
    );

    expect(event).toMatchObject({
      type: 'tool',
      name: 'todowrite',
      status: 'started',
      callId: 'todo-call-1',
      checklist: {
        tool: 'todowrite',
        callId: 'todo-call-1',
        todos: [{ id: 'milestone-1', content: 'Build the first level', status: 'in_progress' }],
      },
    });
    expect(JSON.stringify(event)).not.toMatch(/private|must-not-survive/iu);
  });

  it('retains only a privacy-safe leaf filename for file tool activity', () => {
    const event = normalizeToolEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'read',
            callID: 'read-call-1',
            state: {
              status: 'completed',
              input: {
                filePath: 'C:\\Users\\viper\\private-project\\src\\Composer.tsx',
                content: 'must-not-survive',
              },
              output: 'private file contents',
            },
          },
        },
      },
      {},
    );

    expect(event).toEqual({
      type: 'tool',
      name: 'read',
      status: 'completed',
      callId: 'read-call-1',
      fileLabel: 'Composer.tsx',
    });
    expect(JSON.stringify(event)).not.toMatch(
      /private-project|Users|file contents|must-not-survive/iu,
    );
  });

  it('fails a Context tool event when its bounded semantic response reports failure', () => {
    const event = normalizeToolEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'vibespace_context',
            callID: 'context-call-1',
            state: {
              status: 'completed',
              input: { operation: 'investigate', query: 'private project question' },
              output: JSON.stringify({
                requestId: 'private-request-id',
                ok: false,
                code: 'tool_failed',
                message: 'The semantic tool could not be completed.',
              }),
            },
          },
        },
      },
      {},
    );

    expect(event).toEqual({
      type: 'tool',
      name: 'vibespace_context',
      status: 'failed',
      callId: 'context-call-1',
    });
    expect(JSON.stringify(event)).not.toMatch(/private-request|private project question/iu);
  });

  it('maps native OpenCode text parts to stable bounded opaque stream identities', () => {
    const streamPartId = createOpenCodeTextStreamPartTracker();
    const firstPart = streamPartId('["ses-private","msg-private","part-a","text"]');
    const secondPart = streamPartId('["ses-private","msg-private","part-b","text"]');

    expect(firstPart).toBe('opencode-text-1');
    expect(streamPartId('["ses-private","msg-private","part-a","text"]')).toBe('opencode-text-1');
    expect(secondPart).toBe('opencode-text-2');
    expect(JSON.stringify([firstPart, secondPart])).not.toMatch(
      /ses-private|msg-private|part-a|part-b/iu,
    );
  });

  it('maps native OpenCode tool calls to stable request-local lifecycle identities', () => {
    const callId = createOpenCodeToolCallTracker();

    expect(callId('call-private-read')).toBe('opencode-tool-1');
    expect(callId('call-private-read')).toBe('opencode-tool-1');
    expect(callId('call-private-edit')).toBe('opencode-tool-2');
    expect(JSON.stringify([callId('call-private-read'), callId('call-private-edit')])).not.toMatch(
      /call-private/iu,
    );
  });

  it('activates the native event subscription before prompt dispatch and retains the immediate first text part', async () => {
    const lifecycle: string[] = [];
    configureManagedQuestionTransport(
      [
        {
          type: 'message.updated',
          properties: {
            sessionID: 'ses_question_exact',
            info: {
              role: 'assistant',
              sessionID: 'ses_question_exact',
              providerID: 'openai',
              modelID: 'gpt-question-test',
            },
          },
        },
        {
          type: 'message.part.updated',
          properties: {
            sessionID: 'ses_question_exact',
            part: {
              id: 'part-immediate-first-text',
              sessionID: 'ses_question_exact',
              messageID: 'message-immediate-first-text',
              type: 'text',
              text: 'I started immediately.',
            },
          },
        },
        { type: 'session.idle', properties: { sessionID: 'ses_question_exact' } },
      ],
      { lifecycle },
    );

    const events: ProviderEvent[] = [];
    for await (const event of openCodePersistentAdapter.send!(
      questionProviderRequest('request-subscribe-before-dispatch'),
    )) {
      events.push(event);
      if (event.type === 'done') break;
    }

    expect(lifecycle.indexOf('event-subscription-started')).toBeGreaterThanOrEqual(0);
    expect(lifecycle.indexOf('event-subscription-started')).toBeLessThan(
      lifecycle.indexOf('prompt-async'),
    );
    expect(events).toContainEqual({
      type: 'text',
      delta: 'I started immediately.',
      streamPartId: 'opencode-text-1',
    });
  });

  it('never projects the current user message as assistant output', async () => {
    configureManagedQuestionTransport(
      [
        {
          type: 'message.updated',
          properties: {
            sessionID: 'ses_question_exact',
            info: {
              id: 'message-current-user',
              role: 'user',
              sessionID: 'ses_question_exact',
            },
          },
        },
        {
          type: 'message.part.updated',
          properties: {
            sessionID: 'ses_question_exact',
            part: {
              id: 'part-current-user',
              sessionID: 'ses_question_exact',
              messageID: 'message-current-user',
              type: 'text',
              text: 'Make the game.',
            },
          },
        },
        {
          type: 'message.updated',
          properties: {
            sessionID: 'ses_question_exact',
            info: {
              id: 'message-current-assistant',
              role: 'assistant',
              sessionID: 'ses_question_exact',
              providerID: 'openai',
              modelID: 'gpt-question-test',
              time: { completed: 1 },
            },
          },
        },
        {
          type: 'message.part.updated',
          properties: {
            sessionID: 'ses_question_exact',
            part: {
              id: 'part-current-assistant',
              sessionID: 'ses_question_exact',
              messageID: 'message-current-assistant',
              type: 'text',
              text: 'The game is ready.',
            },
          },
        },
        { type: 'session.idle', properties: { sessionID: 'ses_question_exact' } },
      ],
      {
        persistedMessages: [
          {
            info: {
              id: 'message-current-assistant',
              role: 'assistant',
              providerID: 'openai',
              modelID: 'gpt-question-test',
              time: { completed: 1 },
            },
            parts: [
              {
                id: 'part-current-assistant',
                sessionID: 'ses_question_exact',
                messageID: 'message-current-assistant',
                type: 'text',
                text: 'The game is ready.',
              },
            ],
          },
        ],
      },
    );

    const events: ProviderEvent[] = [];
    for await (const event of openCodePersistentAdapter.send!(
      questionProviderRequest('request-user-echo-filter'),
    )) {
      events.push(event);
      if (event.type === 'done') break;
    }

    expect(events.filter((event) => event.type === 'text')).toEqual([
      {
        type: 'text',
        delta: 'The game is ready.',
        streamPartId: 'opencode-text-1',
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('Make the game.');
  });

  it('emits a native non-prefix text correction as an opaque part replacement', async () => {
    configureManagedQuestionTransport(
      [
        {
          type: 'message.updated',
          properties: {
            sessionID: 'ses_question_exact',
            info: {
              role: 'assistant',
              sessionID: 'ses_question_exact',
              providerID: 'openai',
              modelID: 'gpt-question-test',
            },
          },
        },
        {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part-private',
              sessionID: 'ses_question_exact',
              messageID: 'message-private',
              type: 'text',
              text: 'I built teh game.',
            },
          },
        },
        {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part-private',
              sessionID: 'ses_question_exact',
              messageID: 'message-private',
              type: 'text',
              text: 'I built the game.',
            },
          },
        },
      ],
      { sessionStatuses: ['busy'] },
    );
    const abort = new AbortController();
    const iterator = openCodePersistentAdapter.send!(
      questionProviderRequest('request-text-replacement', abort.signal),
    )[Symbol.asyncIterator]();
    const textEvents: ProviderEvent[] = [];
    for (let index = 0; index < 8 && textEvents.length < 2; index += 1) {
      const next = await iterator.next();
      if (!next.done && next.value.type === 'text') textEvents.push(next.value);
    }
    abort.abort();
    await iterator.return?.();

    expect(textEvents).toEqual([
      { type: 'text', delta: 'I built teh game.', streamPartId: 'opencode-text-1' },
      {
        type: 'text',
        delta: 'I built the game.',
        mode: 'replace',
        streamPartId: 'opencode-text-1',
      },
    ]);
    expect(JSON.stringify(textEvents)).not.toMatch(/ses_question|message-private|part-private/iu);
  });

  it('recovers ordered text and tool receipts when the native event stream is lost', async () => {
    configureManagedQuestionTransport([], {
      sessionStatuses: [null],
      persistedMessages: [
        {
          info: {
            id: 'message-history-recovery',
            role: 'assistant',
            providerID: 'openai',
            modelID: 'gpt-question-test',
            time: { completed: 1 },
          },
          parts: [
            {
              id: 'part-text-1',
              sessionID: 'ses_question_exact',
              messageID: 'message-1',
              type: 'text',
              text: 'I checked the empty project.',
            },
            {
              id: 'part-tool-1',
              sessionID: 'ses_question_exact',
              messageID: 'message-1',
              type: 'tool',
              tool: 'write',
              callID: 'call-write-1',
              state: {
                status: 'completed',
                input: { filePath: 'C:\\private\\index.html', content: 'must-not-survive' },
                output: 'must-not-survive',
              },
            },
            {
              id: 'part-text-2',
              sessionID: 'ses_question_exact',
              messageID: 'message-2',
              type: 'text',
              text: 'The game is ready.',
            },
          ],
        },
      ],
    });
    const iterator = openCodePersistentAdapter.send!(
      questionProviderRequest('request-history-recovery'),
    )[Symbol.asyncIterator]();
    const events: ProviderEvent[] = [];
    for (let index = 0; index < 12; index += 1) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
      if (next.value.type === 'done') break;
    }

    expect(events.filter((event) => event.type === 'text' || event.type === 'tool')).toEqual([
      {
        type: 'text',
        delta: 'I checked the empty project.',
        streamPartId: 'opencode-text-1',
      },
      {
        type: 'tool',
        name: 'write',
        status: 'started',
        callId: 'opencode-tool-1',
        fileLabel: 'index.html',
      },
      {
        type: 'tool',
        name: 'write',
        status: 'completed',
        callId: 'opencode-tool-1',
        fileLabel: 'index.html',
      },
      { type: 'text', delta: 'The game is ready.', streamPartId: 'opencode-text-2' },
    ]);
    expect(events.find((event) => event.type === 'public_timeline')).toEqual({
      type: 'public_timeline',
      snapshot: {
        finalText: 'The game is ready.',
        timeline: [
          { kind: 'text', text: 'I checked the empty project.' },
          {
            kind: 'tool_call',
            tool: 'write',
            call_id: 'opencode-tool-1',
            args: { path: 'index.html' },
          },
          {
            kind: 'tool_result',
            call_id: 'opencode-tool-1',
            result: { status: 'completed' },
          },
        ],
      },
    });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(JSON.stringify(events)).not.toMatch(/must-not-survive|private/iu);
  });

  it('fails the protected turn after projecting a failed Context Gateway envelope truthfully', async () => {
    configureManagedQuestionTransport([], {
      sessionStatuses: [null],
      persistedMessages: [
        {
          info: {
            id: 'message-context-failure',
            role: 'assistant',
            providerID: 'openai',
            modelID: 'gpt-question-test',
            time: { completed: 1 },
          },
          parts: [
            {
              id: 'part-context-tool',
              sessionID: 'ses_question_exact',
              messageID: 'message-context-failure',
              type: 'tool',
              tool: 'vibespace_context',
              callID: 'private-context-call',
              state: {
                status: 'completed',
                input: { operation: 'investigate', query: 'private project question' },
                output: JSON.stringify({
                  requestId: 'private-request-id',
                  ok: false,
                  code: 'tool_failed',
                  message: 'The semantic tool could not be completed.',
                }),
              },
            },
            {
              id: 'part-context-text',
              sessionID: 'ses_question_exact',
              messageID: 'message-context-failure',
              type: 'text',
              text: 'Project context failed safely, so I did not guess.',
            },
          ],
        },
      ],
    });
    const iterator = openCodePersistentAdapter.send!(
      questionProviderRequest('request-context-failure'),
    )[Symbol.asyncIterator]();
    const events: ProviderEvent[] = [];

    await expect(
      (async () => {
        while (true) {
          const next = await iterator.next();
          if (next.done) return;
          events.push(next.value);
        }
      })(),
    ).rejects.toThrow('OpenCode Context Gateway failed safely.');
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool',
          name: 'vibespace_context',
          status: 'failed',
        }),
        {
          type: 'public_timeline',
          snapshot: {
            finalText: 'Project context failed safely, so I did not guess.',
            timeline: [
              {
                kind: 'tool_call',
                tool: 'vibespace_context',
                call_id: 'opencode-tool-1',
                args: {},
              },
              { kind: 'tool_result', call_id: 'opencode-tool-1', error: 'Tool failed' },
            ],
          },
        },
      ]),
    );
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(/private-request|private project question/iu);
  });

  it('continues the same turn after a precise empty Context boundary and preserves later work', async () => {
    configureManagedQuestionTransport([], {
      sessionStatuses: [null],
      persistedMessages: [
        {
          info: {
            id: 'message-context-empty-continued',
            role: 'assistant',
            providerID: 'openai',
            modelID: 'gpt-question-test',
            time: { completed: 1 },
          },
          parts: [
            {
              type: 'tool',
              tool: 'vibespace_context',
              callID: 'private-context-call',
              state: {
                status: 'completed',
                input: { operation: 'investigate', query: 'private project question' },
                output: JSON.stringify({
                  requestId: 'private-request-id',
                  ok: false,
                  code: 'context_unavailable',
                  message: 'Required VibeSpace project context was unavailable.',
                  data: { receiptId: 'private-receipt-id', safeFailure: 'retrieval-failed' },
                }),
              },
            },
            {
              type: 'text',
              text: 'No indexed context was available. I continued only the independent build.',
            },
            {
              type: 'tool',
              tool: 'write',
              callID: 'private-write-call',
              state: {
                status: 'completed',
                input: { filePath: 'C:\\private\\game\\index.html' },
                output: 'must-not-survive',
              },
            },
            { type: 'text', text: 'The independent game files are created and verified.' },
          ],
        },
      ],
    });

    const events: ProviderEvent[] = [];
    for await (const event of openCodePersistentAdapter.send!(
      questionProviderRequest('request-context-empty-continued'),
    )) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(events.find((event) => event.type === 'public_timeline')).toEqual({
      type: 'public_timeline',
      snapshot: {
        finalText: 'The independent game files are created and verified.',
        timeline: [
          {
            kind: 'tool_call',
            tool: 'vibespace_context',
            call_id: 'opencode-tool-1',
            args: {},
          },
          {
            kind: 'tool_result',
            call_id: 'opencode-tool-1',
            error: 'Context unavailable',
          },
          {
            kind: 'text',
            text: 'No indexed context was available. I continued only the independent build.',
          },
          {
            kind: 'tool_call',
            tool: 'write',
            call_id: 'opencode-tool-2',
            args: { path: 'index.html' },
          },
          {
            kind: 'tool_result',
            call_id: 'opencode-tool-2',
            result: { status: 'completed' },
          },
        ],
      },
    });
    expect(JSON.stringify(events)).not.toMatch(/private-request|private-receipt|private\\game/iu);
  });

  it('recovers the persisted turn when the optional native event iterator rejects', async () => {
    configureManagedQuestionTransport([], {
      sessionStatuses: [null],
      persistedMessages: [
        {
          info: {
            id: 'message-rejected-stream-recovery',
            role: 'assistant',
            providerID: 'openai',
            modelID: 'gpt-question-test',
            time: { completed: 1 },
          },
          parts: [
            {
              id: 'part-rejected-stream-text',
              sessionID: 'ses_question_exact',
              messageID: 'message-rejected-stream-recovery',
              type: 'text',
              text: 'The full 3D game is ready.',
            },
          ],
        },
      ],
    });
    nativeOpenCodeMocks.events.mockImplementation(async function* () {
      throw new Error('OpenCode oversized non-tool event exceeded its safe bound.');
    });

    const events: ProviderEvent[] = [];
    for await (const event of openCodePersistentAdapter.send!(
      questionProviderRequest('request-rejected-stream-recovery'),
    )) {
      events.push(event);
      if (event.type === 'done') break;
    }

    expect(events).toContainEqual({
      type: 'text',
      delta: 'The full 3D game is ready.',
      streamPartId: 'opencode-text-1',
    });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('terminates truthfully when polling observes an error after the event iterator rejects', async () => {
    configureManagedQuestionTransport([], {
      sessionStatuses: ['error'],
      persistedMessages: [
        {
          info: {
            id: 'message-rejected-stream-error',
            role: 'assistant',
            providerID: 'openai',
            modelID: 'gpt-question-test',
            time: { created: 1 },
          },
          parts: [{ type: 'text', text: 'I started the requested game.' }],
        },
      ],
    });
    nativeOpenCodeMocks.events.mockImplementation(async function* () {
      throw new Error('OpenCode native event queue exceeded safe limits.');
    });
    const abort = new AbortController();
    const iterator = openCodePersistentAdapter.send!(
      questionProviderRequest('request-rejected-stream-error', abort.signal),
    )[Symbol.asyncIterator]();
    const observed: ProviderEvent[] = [];

    const terminal = await Promise.race([
      (async () => {
        for (let index = 0; index < 6; index += 1) {
          const next = await iterator.next();
          if (next.done) return undefined;
          observed.push(next.value);
          if (next.value.type === 'error') return next.value;
        }
        return undefined;
      })(),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 900)),
    ]);
    abort.abort();
    await iterator.return?.();

    expect(terminal).toEqual({
      type: 'error',
      message: 'OpenCode session entered an error state.',
    });
    expect(observed).toContainEqual({
      type: 'text',
      delta: 'I started the requested game.',
      streamPartId: 'opencode-text-1',
    });
    expect(observed).not.toContainEqual(expect.objectContaining({ type: 'done' }));
  });

  it.each([
    'OpenCode managed server is unavailable.',
    'OpenCode managed server generation is unavailable.',
  ])('ends an accepted turn when its native runtime is lost: %s', async (failure) => {
    configureManagedQuestionTransport([], { persistedMessages: [] });
    const transport = nativeOpenCodeMocks.request.getMockImplementation()!;
    let dispatched = false;
    nativeOpenCodeMocks.request.mockImplementation(async (generation, path, init, timeout) => {
      if (dispatched && path.startsWith('/session/status')) throw failure;
      const response = await transport(generation, path, init, timeout);
      if (path.includes('/prompt_async')) dispatched = true;
      return response;
    });
    const abort = new AbortController();
    const observed: ProviderEvent[] = [];
    const consume = (async () => {
      try {
        for await (const event of openCodePersistentAdapter.send!(questionProviderRequest(`lost-native-runtime-${failure.includes('generation') ? 'generation' : 'missing'}`, abort.signal))) {
          observed.push(event);
        }
        return 'completed';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    const result = await Promise.race([consume, new Promise(resolve => setTimeout(() => resolve('still pending'), 900))]);
    abort.abort();
    await consume;
    expect(dispatched).toBe(true);
    expect(result).toBe('OpenCode runtime disconnected. Retry to reconnect.');
    expect(observed).not.toContainEqual(expect.objectContaining({ type: 'done' }));
  });

  it('reconciles ordered persisted text and tool parts before completing on an immediate idle event', async () => {
    configureManagedQuestionTransport(
      [{ type: 'session.idle', properties: { sessionID: 'ses_question_exact' } }],
      {
        persistedMessagePolls: [
          [],
          [
            {
              info: {
                id: 'message-immediate-idle-recovery',
                tokens: { input: 626, output: 228, total: 41814, cache: {read: 40960} },
                role: 'assistant',
                providerID: 'openai',
                modelID: 'gpt-question-test',
                time: { completed: 1 },
              },
              parts: [
                {
                  id: 'part-idle-text-1',
                  sessionID: 'ses_question_exact',
                  messageID: 'message-immediate-idle-recovery',
                  type: 'text',
                  text: 'I inspected the project. ',
                },
                {
                  id: 'part-idle-tool-1',
                  sessionID: 'ses_question_exact',
                  messageID: 'message-immediate-idle-recovery',
                  type: 'tool',
                  tool: 'write',
                  callID: 'call-private-immediate-idle',
                  state: {
                    status: 'completed',
                    input: {
                      filePath: 'C:\\private\\game.js',
                      content: 'must-not-survive',
                    },
                    output: 'must-not-survive',
                  },
                },
                {
                  id: 'part-idle-text-2',
                  sessionID: 'ses_question_exact',
                  messageID: 'message-immediate-idle-recovery',
                  type: 'text',
                  text: 'The game is ready.',
                },
              ],
            },
          ],
        ],
      },
    );

    const events: ProviderEvent[] = [];
    for await (const event of openCodePersistentAdapter.send!(
      questionProviderRequest('request-immediate-idle-recovery'),
    )) {
      events.push(event);
      if (event.type === 'done') break;
    }

    expect(events.filter((event) => event.type === 'text' || event.type === 'tool')).toEqual([
      {
        type: 'text',
        delta: 'I inspected the project. ',
        streamPartId: 'opencode-text-1',
      },
      {
        type: 'tool',
        name: 'write',
        status: 'started',
        callId: 'opencode-tool-1',
        fileLabel: 'game.js',
      },
      {
        type: 'tool',
        name: 'write',
        status: 'completed',
        callId: 'opencode-tool-1',
        fileLabel: 'game.js',
      },
      { type: 'text', delta: 'The game is ready.', streamPartId: 'opencode-text-2' },
    ]);
    expect(events.filter(event => event.type === 'usage').at(-1)).toMatchObject({type: 'usage', usage: {inputTokens: {value: 626}, outputTokens: {value: 228}, totalTokens: {value: 41814}, cacheReadTokens: {value: 40960}}});
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(JSON.stringify(events)).not.toMatch(
      /must-not-survive|call-private|message-immediate|part-idle|C:\\\\private/iu,
    );
  });

  it('filters persisted recovery to canonical message identities created after dispatch', () => {
    const baseline = [
      { info: { id: 'msg-old-user', role: 'user' }, parts: [{ type: 'text', text: 'Old' }] },
      {
        info: { id: 'msg-old-assistant', role: 'assistant' },
        parts: [{ type: 'text', text: 'Historical answer.' }],
      },
    ];
    const current = [
      ...baseline,
      { info: { id: 'msg-new-user', role: 'user' }, parts: [{ type: 'text', text: 'New' }] },
      {
        info: { id: 'msg-new-a', role: 'assistant' },
        parts: [
          { type: 'text', text: 'First checkpoint. ' },
          { type: 'reasoning', text: 'Private reasoning must not cross.' },
        ],
      },
      {
        info: { id: 'msg-new-b', role: 'assistant' },
        parts: [{ type: 'agent_message', text: 'Final answer.' }],
      },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Missing identity.' }] },
    ];

    const filtered = currentTurnOpenCodeMessages(
      current,
      new Set(['msg-old-user', 'msg-old-assistant']),
    );

    expect(filtered.map((message) => message.info?.id)).toEqual([
      'msg-new-user',
      'msg-new-a',
      'msg-new-b',
    ]);
    expect(publicTextFromTurnMessages(filtered)).toBe('First checkpoint. Final answer.');
  });

  it('never replays or completes from historical messages in a reused persistent session', async () => {
    const historical = [
      { info: { id: 'msg-old-user', role: 'user' }, parts: [{ type: 'text', text: 'Old' }] },
      {
        info: {
          id: 'msg-old-assistant',
          role: 'assistant',
          providerID: 'openai',
          modelID: 'gpt-question-test',
          time: { completed: 1 },
        },
        parts: [
          { type: 'text', text: 'Historical answer must not replay.' },
          {
            type: 'tool',
            tool: 'read',
            callID: 'call-old-read',
            state: { status: 'completed', input: { filePath: 'old.js' } },
          },
        ],
      },
    ];
    configureManagedQuestionTransport([], {
      sessionStatuses: [null],
      persistedMessagePolls: [historical, historical, historical],
    });
    const abort = new AbortController();
    const iterator = openCodePersistentAdapter.send!(
      questionProviderRequest('request-reused-history-only', abort.signal),
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'session' },
    });
    const pending = iterator.next();
    setTimeout(() => abort.abort(), 1_100);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await iterator.return?.();
  });

  it('recovers only the new multi-message turn in exact public text and tool order', async () => {
    const historical = [
      { info: { id: 'msg-old-user', role: 'user' }, parts: [{ type: 'text', text: 'Old' }] },
      {
        info: {
          id: 'msg-old-assistant',
          role: 'assistant',
          providerID: 'openai',
          modelID: 'gpt-question-test',
          time: { completed: 1 },
        },
        parts: [{ type: 'text', text: 'Historical answer.' }],
      },
    ];
    const assistantInfo = (id: string) => ({
      id,
      role: 'assistant',
      providerID: 'openai',
      modelID: 'gpt-question-test',
      time: { completed: 1 },
    });
    const current = [
      ...historical,
      { info: { id: 'msg-current-user', role: 'user' }, parts: [{ type: 'text', text: 'New' }] },
      {
        info: assistantInfo('msg-current-1'),
        parts: [{ id: 'part-current-1', type: 'text', text: 'I inspected the project. ' }],
      },
      {
        info: assistantInfo('msg-current-2'),
        parts: [{ id: 'part-reasoning', type: 'reasoning', text: 'Checking the fixture.' }],
      },
      {
        info: assistantInfo('msg-current-3'),
        parts: [
          {
            id: 'part-read',
            type: 'tool',
            tool: 'read',
            callID: 'call-read-current',
            state: { status: 'completed', input: { filePath: 'C:\\private\\game.js' } },
          },
        ],
      },
      {
        info: assistantInfo('msg-current-4'),
        parts: [{ id: 'part-current-2', type: 'text', text: 'I found the game loop. ' }],
      },
      {
        info: assistantInfo('msg-current-5'),
        parts: [
          {
            id: 'part-edit',
            type: 'tool',
            tool: 'edit',
            callID: 'call-edit-current',
            state: { status: 'completed', input: { filePath: 'C:\\private\\player.js' } },
          },
        ],
      },
      {
        info: assistantInfo('msg-current-6'),
        parts: [{ id: 'part-current-3', type: 'text', text: 'I finished the implementation. ' }],
      },
      {
        info: assistantInfo('msg-current-7'),
        parts: [
          {
            id: 'part-command',
            type: 'tool',
            tool: 'bash',
            callID: 'call-test-current',
            state: { status: 'completed', input: { command: 'private command' } },
          },
        ],
      },
      {
        info: assistantInfo('msg-current-8'),
        parts: [{ id: 'part-current-4', type: 'text', text: 'The game is ready.' }],
      },
    ];
    configureManagedQuestionTransport([], {
      sessionStatuses: [null],
      persistedMessagePolls: [historical, current],
    });

    const events: ProviderEvent[] = [];
    for await (const event of openCodePersistentAdapter.send!(
      questionProviderRequest('request-current-turn-recovery'),
    )) {
      events.push(event);
      if (event.type === 'done') break;
    }

    expect(events.filter((event) => event.type === 'text' || event.type === 'tool')).toEqual([
      { type: 'text', delta: 'I inspected the project. ', streamPartId: 'opencode-text-1' },
      {
        type: 'tool',
        name: 'read',
        status: 'started',
        callId: 'opencode-tool-1',
        fileLabel: 'game.js',
      },
      {
        type: 'tool',
        name: 'read',
        status: 'completed',
        callId: 'opencode-tool-1',
        fileLabel: 'game.js',
      },
      { type: 'text', delta: 'I found the game loop. ', streamPartId: 'opencode-text-2' },
      {
        type: 'tool',
        name: 'edit',
        status: 'started',
        callId: 'opencode-tool-2',
        fileLabel: 'player.js',
      },
      {
        type: 'tool',
        name: 'edit',
        status: 'completed',
        callId: 'opencode-tool-2',
        fileLabel: 'player.js',
      },
      { type: 'text', delta: 'I finished the implementation. ', streamPartId: 'opencode-text-3' },
      { type: 'tool', name: 'bash', status: 'started', callId: 'opencode-tool-3' },
      { type: 'tool', name: 'bash', status: 'completed', callId: 'opencode-tool-3' },
      { type: 'text', delta: 'The game is ready.', streamPartId: 'opencode-text-4' },
    ]);
    expect(events.some((event) => event.type === 'reasoning')).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(
      /Historical answer|private command|C:\\\\private/iu,
    );
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('delivers current-turn tool activity from persisted history while the session remains busy', async () => {
    const historical = [
      { info: { id: 'msg-old-user', role: 'user' }, parts: [{ type: 'text', text: 'Old' }] },
      {
        info: {
          id: 'msg-old-assistant',
          role: 'assistant',
          providerID: 'openai',
          modelID: 'gpt-question-test',
          time: { completed: 1 },
        },
        parts: [{ type: 'text', text: 'Historical answer.' }],
      },
    ];
    const current = [
      ...historical,
      {
        info: {
          id: 'msg-current-tool-first',
          role: 'assistant',
          providerID: 'openai',
          modelID: 'gpt-question-test',
          time: { created: 2 },
        },
        parts: [
          { id: 'part-step-start', type: 'step-start' },
          {
            id: 'part-current-read',
            type: 'tool',
            tool: 'read',
            callID: 'call-current-read',
            state: { status: 'running', input: { filePath: 'C:\\private\\game.js' } },
          },
        ],
      },
    ];
    configureManagedQuestionTransport([], {
      sessionStatuses: ['busy'],
      persistedMessagePolls: [historical, current],
    });
    const abort = new AbortController();
    const iterator = openCodePersistentAdapter.send!(
      questionProviderRequest('request-busy-tool-first', abort.signal),
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'session' },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: 'tool',
        name: 'read',
        status: 'started',
        callId: 'opencode-tool-1',
        fileLabel: 'game.js',
      },
    });
    abort.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
    await iterator.return?.();
  });

  it('does not starve persisted-history recovery behind a busy global event feed', async () => {
    configureManagedQuestionTransport([{ type: 'server.heartbeat' }], {
      sessionStatuses: [null],
      eventStartDelayMs: 750,
      eventBurstCount: 1_000_000,
      persistedMessages: [
        {
          info: {
            id: 'message-busy-feed-recovery',
            role: 'assistant',
            providerID: 'openai',
            modelID: 'gpt-question-test',
            time: { completed: 1 },
          },
          parts: [
            {
              id: 'part-busy-feed-text',
              sessionID: 'ses_question_exact',
              messageID: 'message-busy-feed',
              type: 'text',
              text: 'Recovered after a busy feed.',
            },
          ],
        },
      ],
    });

    const events: ProviderEvent[] = [];
    for await (const event of openCodePersistentAdapter.send!(
      questionProviderRequest('request-busy-feed-recovery'),
    )) {
      events.push(event);
      if (event.type === 'done') break;
    }

    expect(events).toContainEqual({
      type: 'text',
      delta: 'Recovered after a busy feed.',
      streamPartId: 'opencode-text-1',
    });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('reconciles persisted todo evidence when idle polling wins the live-event race', () => {
    const snapshots = openCodeChecklistSnapshotsFromMessages([
      {
        info: { role: 'assistant' },
        parts: [
          {
            type: 'tool',
            tool: 'todowrite',
            callID: 'todo-call-persisted',
            state: {
              status: 'completed',
              input: {
                todos: [
                  { content: 'Build the maze', status: 'in_progress', privatePath: 'C:/private' },
                ],
              },
              output: 'must-not-survive',
            },
          },
        ],
      },
    ]);

    expect(snapshots).toEqual([
      {
        tool: 'todowrite',
        callId: 'todo-call-persisted',
        todos: [{ id: 'item-1', content: 'Build the maze', status: 'in_progress' }],
      },
    ]);
    expect(JSON.stringify(snapshots)).not.toMatch(/private|must-not-survive/iu);
  });

  it('normalizes the full OpenCode usage receipt with provider provenance', () => {
    const usage = normalizePersistentOpenCodeUsage({
      type: 'message.updated',
      properties: {
        info: {
          role: 'assistant',
          tokens: {
            input: 120,
            output: 30,
            reasoning: 11,
            cache: { read: 80, write: 6 },
          },
          cost: 0.012,
        },
      },
    });

    expect(usage).toEqual({
      capturedAt: expect.any(Number),
      inputTokens: { value: 120, provenance: 'provider-reported' },
      outputTokens: { value: 30, provenance: 'provider-reported' },
      cacheReadTokens: { value: 80, provenance: 'provider-reported' },
      cacheWriteTokens: { value: 6, provenance: 'provider-reported' },
      reasoningTokens: { value: 11, provenance: 'provider-reported' },
      costUsd: { value: 0.012, provenance: 'provider-reported' },
    });
  });

  it('keeps a partial OpenCode usage receipt limited to fields the provider observed', () => {
    const usage = normalizePersistentOpenCodeUsage({
      type: 'message.updated',
      properties: {
        info: {
          role: 'assistant',
          tokens: { input: 42, cache: { read: 21 } },
        },
      },
    });

    expect(usage).toEqual({
      capturedAt: expect.any(Number),
      inputTokens: { value: 42, provenance: 'provider-reported' },
      cacheReadTokens: { value: 21, provenance: 'provider-reported' },
    });
    expect(usage).not.toHaveProperty('outputTokens');
    expect(usage).not.toHaveProperty('cacheWriteTokens');
    expect(usage).not.toHaveProperty('reasoningTokens');
    expect(usage).not.toHaveProperty('costUsd');
  });

  it('omits invalid usage fields instead of converting them into zero', () => {
    const usage = normalizePersistentOpenCodeUsage({
      type: 'message.updated',
      properties: {
        info: {
          role: 'assistant',
          tokens: {
            input: -1,
            output: Number.NaN,
            reasoning: Number.POSITIVE_INFINITY,
            cache: { read: -2, write: '7' },
          },
          cost: -0.01,
        },
      },
    });

    expect(usage).toEqual({ capturedAt: expect.any(Number) });
    expect(
      normalizePersistentOpenCodeUsage({
        type: 'message.updated',
        properties: { info: { role: 'assistant' } },
      }),
    ).toBeUndefined();
  });

  it('surfaces the sanitized provider reason for registered-command failures', () => {
    expect(
      persistentOpenCodeSessionErrorMessage(
        {
          type: 'session.error',
          properties: {
            sessionID: 'session-goal',
            error: {
              message: 'AI_APICallError: temporarily rate-limited upstream; api_key=private-value',
            },
          },
        },
        'session-goal',
      ),
    ).toBe('AI_APICallError: temporarily rate-limited upstream; api_key=[REDACTED]');
  });

  it('classifies only a completed exact-root read as sanitized inventory evidence', () => {
    const request = {
      explicitReadRoot: true,
      workingDirectory: 'C:\\Users\\viper',
    } as const;
    expect(
      classifyExplicitRootInventoryScope(
        { name: 'read', status: 'completed', input: { filePath: 'c:/Users/VIPER/' } },
        request,
      ),
    ).toBe('explicit_root_inventory');
    expect(
      classifyExplicitRootInventoryScope(
        { name: 'read', status: 'completed', input: { filePath: 'C:\\Users\\viper\\child' } },
        request,
      ),
    ).toBeUndefined();
    expect(
      classifyExplicitRootInventoryScope(
        { name: 'read', status: 'completed', input: { filePath: 'C:\\Users\\viper\\file.md' } },
        request,
      ),
    ).toBeUndefined();
    expect(
      classifyExplicitRootInventoryScope(
        { name: 'read', status: 'started', input: { filePath: 'C:\\Users\\viper' } },
        request,
      ),
    ).toBeUndefined();
    expect(
      classifyExplicitRootInventoryScope(
        { name: 'read', status: 'completed', input: { filePath: 'C:\\Users\\viper' } },
        { ...request, explicitReadRoot: false },
      ),
    ).toBeUndefined();
  });

  it('emits only provider-safe tool names while keeping Context enabled', () => {
    const tools = toolsForPolicy({
      mode: 'agent',
      access: 'full',
      rlmEnabled: true,
      requested: { vibespace_context: true },
    });

    expect(tools.vibespace_context).toBe(true);
    expect(tools).toMatchObject({ todo: true, todoread: true, todowrite: true });
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(['vibespace_context']));
    expect(Object.keys(tools).every((name) => /^[a-zA-Z0-9_-]+$/u.test(name))).toBe(true);
    expect(tools).not.toHaveProperty('vibespace_context.query');
  });

  it('keeps independent Agent work moving after an optional Context lookup returns no evidence', () => {
    const addendum = contextSystemAddendum(
      {
        prompt:
          'Use the whole project context for requirements, then create and verify the requested local dashboard.',
        workingDirectory: 'D:\\VibeSpace-RLM-UAT\\empty-context-continuation',
        interactionMode: 'agent',
        accessLevel: 'full',
      } as never,
      { rlmEnabled: true, performance: 'quality' } as never,
    );

    expect(addendum).toContain('If the tool returns no evidence');
    expect(addendum).toContain('continue every independent, authorized part of the request');
    expect(addendum).toContain('Do not claim facts that required the missing evidence');
  });

  it('keeps explicit-root evidence filesystem-only and before the final response contract', () => {
    const addendum = contextSystemAddendum(
      {
        prompt: 'C:\\Users\\viper audit this directory',
        workingDirectory: 'C:\\Users\\viper',
        explicitReadRoot: true,
      } as never,
      { rlmEnabled: false, performance: 'quality' } as never,
    );
    expect(addendum).toContain('inventory the root itself with list or read');
    expect(addendum).toContain('bounded glob or grep');
    expect(addendum).toContain('read several representative high-signal entries');
    expect(addendum).toContain('do not treat one child file as a complete audit');
    expect(addendum).toContain('approved working directory');
    expect(addendum).toContain('Do not use Context, RLM, web, shell, or recursive retrieval');
    expect(addendum).not.toContain('Use only the current approved prompt/context');
    const systemPrompt = combineSystemPrompt(
      '## Explicit response contract\nThe final answer must never exceed 750 words.',
      addendum,
      true,
    );
    expect(systemPrompt.indexOf('DIRECT FILESYSTEM EVIDENCE')).toBeLessThan(
      systemPrompt.indexOf('## Explicit response contract'),
    );
    expect(systemPrompt.trimEnd()).toMatch(/must never exceed 750 words\.$/u);

    const tools = toolsForPolicy({
      mode: 'agent',
      access: 'full',
      rlmEnabled: true,
      explicitReadRoot: true,
      requested: { vibespace_context: true },
    });
    expect(tools).toMatchObject({
      read: true,
      glob: true,
      grep: true,
      list: true,
      webfetch: false,
      websearch: false,
      edit: false,
      write: false,
      patch: false,
      bash: false,
      shell: false,
      task: false,
      vibespace_context: false,
    });
    expect(
      Object.entries(tools)
        .filter(([, enabled]) => enabled)
        .map(([name]) => name)
        .sort(),
    ).toEqual(['glob', 'grep', 'list', 'read']);

    const synthesisAddendum = contextSystemAddendum(
      {
        prompt: 'Synthesize the grounded result.',
        explicitReadRoot: true,
        explicitReadSynthesis: true,
      } as never,
      { rlmEnabled: false, performance: 'quality' } as never,
    );
    expect(synthesisAddendum).toContain('GROUNDED SYNTHESIS');
    expect(synthesisAddendum).toContain('evidence already collected in this exact session');
    const synthesisTools = toolsForPolicy({
      mode: 'agent',
      access: 'full',
      rlmEnabled: true,
      explicitReadRoot: true,
      explicitReadSynthesis: true,
      requested: { vibespace_context: true, 'terminal.list': true },
    });
    expect(Object.values(synthesisTools).every((enabled) => enabled === false)).toBe(true);
    expect(synthesisTools).toMatchObject({
      question: false,
      skill: false,
      todowrite: false,
      vibespace_context: false,
      'terminal.list': false,
    });
  });

  it.each([
    { streamed: 'complete', canonical: 'complete', expected: '' },
    { streamed: 'first', canonical: 'first second', expected: ' second' },
    {
      streamed: 'first',
      canonical: 'corrected first [unverified output location omitted]',
      expected: '',
    },
  ])(
    'reconciles canonical completion without appending a divergent full answer',
    ({ streamed, canonical, expected }) => {
      expect(canonicalOpenCodeTextSuffix(streamed, canonical)).toBe(expected);
    },
  );

  it('keeps closed diagnostics free of request and prompt material', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const events = openCodePersistentAdapter.send!({
      requestId: 'secret-request-sentinel',
      prompt: 'secret-prompt-sentinel',
    } as never)[Symbol.asyncIterator]();

    await expect(events.next()).rejects.toThrow(/exact model selection/i);
    expect(warn).toHaveBeenCalledExactlyOnceWith('OpenCode protected turn failed.', {
      diagnosticCode: 'request_identity',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret-(request|prompt)-sentinel/i);
    warn.mockRestore();
  });

  it('does not report ordinary cancellation as a protected-turn failure', () => {
    expect(shouldReportPersistentTurnFailure(new DOMException('cancelled', 'AbortError'))).toBe(
      false,
    );
    expect(shouldReportPersistentTurnFailure({ name: 'AbortError' })).toBe(false);
    expect(shouldReportPersistentTurnFailure(new Error('failed'))).toBe(true);
  });

  it('does not reuse or cache a stale in-flight load after invalidation', async () => {
    const cache = createGenerationSafeAsyncCache<string, string>(60_000);
    let resolveOld: ((value: string) => void) | undefined;
    let resolveFresh: ((value: string) => void) | undefined;
    const old = cache.get(
      'catalog',
      () => new Promise<string>((resolve) => (resolveOld = resolve)),
    );

    cache.invalidate();
    const fresh = cache.get(
      'catalog',
      () => new Promise<string>((resolve) => (resolveFresh = resolve)),
    );
    expect(fresh).not.toBe(old);

    resolveOld?.('stale');
    await expect(old).resolves.toBe('stale');
    expect(cache.peek('catalog')).toBeUndefined();

    resolveFresh?.('fresh');
    await expect(fresh).resolves.toBe('fresh');
    expect(cache.peek('catalog')).toBe('fresh');
    await expect(cache.get('catalog', async () => 'unexpected')).resolves.toBe('fresh');
  });

  it('reuses an already-validated native managed runtime without another refresh', async () => {
    const refresh = vi.fn(async () => undefined);
    const runtime = {
      refresh,
      getConnection: () => ({
        version: '1.18.18',
        source: 'system' as const,
        generation: 'opencode-server-test',
      }),
    } as unknown as HarnessRuntimeManager;

    const handle = await createPersistentOpenCodeRuntimeSupervisor(runtime).start({
      accountId: 'local-desktop-account',
      workingDirectory: 'C:\\workspace',
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(handle).toMatchObject({
      generation: 'opencode-server-test',
      version: '1.18.18',
      scope: {
        accountId: 'local-desktop-account',
        workingDirectory: 'C:\\workspace',
      },
    });
    expect(JSON.stringify(handle)).not.toMatch(/baseUrl|username|password|authorization|basic/i);
    await handle.dispose();
  });

  it('refreshes only when no validated managed runtime is available yet', async () => {
    const connection = {
      version: '1.18.18',
      source: 'system' as const,
      generation: 'opencode-server-after-refresh',
    };
    let current: typeof connection | undefined;
    const refresh = vi.fn(async () => {
      current = connection;
    });
    const runtime = {
      refresh,
      getConnection: () => current,
    } as unknown as HarnessRuntimeManager;

    const handle = await createPersistentOpenCodeRuntimeSupervisor(runtime).start({
      accountId: 'local-desktop-account',
      workingDirectory: 'C:\\workspace',
    });

    expect(refresh).toHaveBeenCalledOnce();
    expect(handle.generation).toBe('opencode-server-after-refresh');
    await handle.dispose();
  });

  it('fails closed when the managed runtime has no private connection', async () => {
    const runtime = {
      refresh: vi.fn(async () => undefined),
      getConnection: () => undefined,
    } as unknown as HarnessRuntimeManager;

    await expect(
      createPersistentOpenCodeRuntimeSupervisor(runtime).start({
        accountId: 'local-desktop-account',
      }),
    ).rejects.toThrow(/private server connection/);
  });

  it('selects only an exact provider-qualified live model', () => {
    expect(requireAuthoritativeOpenCodeModel(liveModels, 'openai/gpt-5.6-sol')).toMatchObject({
      providerId: 'openai',
      upstreamModelId: 'gpt-5.6-sol',
    });
    expect(() => requireAuthoritativeOpenCodeModel(liveModels, 'gpt-5.6-sol')).toThrow(
      /provider-qualified/,
    );
    expect(() => requireAuthoritativeOpenCodeModel(liveModels, 'missing/gpt-5.6-sol')).toThrow(
      /live authenticated catalog/,
    );
  });

  it('keeps nested provider-local model IDs distinct from canonical catalog IDs', () => {
    const [model] = parseOpenCodeLiveModels({
      providers: [{ id: 'openrouter', models: { 'openai/gpt-5.6-luna': { name: 'Luna' } } }],
    });

    expect(model).toMatchObject({
      id: 'openrouter/openai/gpt-5.6-luna',
      providerId: 'openrouter',
      upstreamModelId: 'openai/gpt-5.6-luna',
    });
  });

  it('preserves separate xhigh and max live variants', () => {
    const model = requireAuthoritativeOpenCodeModel(liveModels, 'openai/gpt-5.6-sol');
    expect(model.variants.map(({ id }) => id)).toEqual(['xhigh', 'max']);
  });

  it('carries only complete pricing from the same persistent provider response', () => {
    expect(requireAuthoritativeOpenCodeModel(liveModels, 'openai/gpt-5.6-sol').pricing).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(
      requireAuthoritativeOpenCodeModel(liveModels, 'other/gpt-5.6-sol').pricing,
    ).toBeUndefined();
    expect(
      toOpenCodeDiscoveredModels(liveModels).find(({ id }) => id === 'openai/gpt-5.6-sol'),
    ).toMatchObject({ pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(
      toOpenCodeDiscoveredModels(liveModels).find(({ id }) => id === 'other/gpt-5.6-sol'),
    ).not.toHaveProperty('pricing');
  });

  it('uses managed provider truth for auth and executable catalog authority', () => {
    expect(parseConnectedOpenCodeProviderIds({ connected: ['openai', 'openrouter'] })).toEqual([
      'openai',
      'openrouter',
    ]);
    expect(managedOpenCodeAuthResult({ connected: ['openai'] })).toMatchObject({
      status: 'authenticated',
    });
    expect(managedOpenCodeAuthResult({ connected: [] })).toMatchObject({
      status: 'unauthenticated',
    });
    expect(
      filterOpenCodeModelsToConnectedProviders(liveModels, ['openai']).map(({ id }) => id),
    ).toEqual(['openai/gpt-5.6-sol']);
    expect(() => parseConnectedOpenCodeProviderIds({ connected: ['openai', null] })).toThrow(
      /malformed provider status/,
    );
  });

  it('rejects an unsupported live effort before the coordinator can downgrade it', () => {
    const spark = parseOpenCodeLiveModels({
      providers: [
        {
          id: 'openai',
          models: {
            'gpt-5.3-codex-spark': { variants: { medium: {} } },
          },
        },
      ],
    })[0]!;
    expect(() =>
      assertAuthoritativeOpenCodeRuntimeControls(
        { effort: 'max', fastMode: 'auto' },
        spark,
        'opencode-cli',
      ),
    ).toThrow(/not available/);
  });

  it('requires observed model and variant proof before accepting completion', () => {
    expect(() =>
      assertAuthoritativeOpenCodeIdentity({
        connectionId: 'opencode-cli',
        providerId: 'openai',
        modelId: 'openai/gpt-5.6-sol',
        variant: 'max',
      }),
    ).toThrow(/without authoritative observed model identity/);

    expect(() =>
      assertAuthoritativeOpenCodeIdentity({
        connectionId: 'opencode-cli',
        providerId: 'openai',
        modelId: 'openai/gpt-5.6-sol',
        variant: 'max',
        observed: {
          providerId: 'openai',
          modelId: 'gpt-5.6-sol',
          variant: 'xhigh',
        },
      }),
    ).toThrow(/MODEL_IDENTITY_MISMATCH/);

    expect(
      assertAuthoritativeOpenCodeIdentity({
        connectionId: 'opencode-cli',
        providerId: 'openai',
        modelId: 'openai/gpt-5.6-sol',
        variant: 'max',
        observed: {
          providerId: 'openai',
          modelId: 'gpt-5.6-sol',
          variant: 'max',
        },
      }),
    ).toBe('openai/gpt-5.6-sol');
  });

  it('accepts stream EOF only after authoritative identity and non-empty assistant text', () => {
    expect(() =>
      assertAuthoritativeOpenCodeCompletion({
        observedModelId: 'openai/gpt-5.3-codex-spark',
        streamedText: 'OK',
        canonicalText: '',
      }),
    ).not.toThrow();
    expect(() =>
      assertAuthoritativeOpenCodeCompletion({
        streamedText: 'OK',
        canonicalText: '',
      }),
    ).toThrow(/authoritative observed model identity/);
    expect(() =>
      assertAuthoritativeOpenCodeCompletion({
        observedModelId: 'openai/gpt-5.3-codex-spark',
        streamedText: '',
        canonicalText: '',
      }),
    ).toThrow(/canonical assistant text/);
  });

  it('reconciles omitted idle status only after persisted assistant evidence', () => {
    expect(
      shouldReconcileOpenCodeSessionCompletion({
        statusLookupSucceeded: true,
        streamedText: 'OK',
        hasPersistedAssistantIdentity: true,
        hasPersistedAssistantCompletion: true,
      }),
    ).toBe(true);
    expect(
      shouldReconcileOpenCodeSessionCompletion({
        statusLookupSucceeded: false,
        streamedText: 'OK',
        hasPersistedAssistantIdentity: true,
        hasPersistedAssistantCompletion: true,
      }),
    ).toBe(false);
    expect(
      shouldReconcileOpenCodeSessionCompletion({
        statusLookupSucceeded: true,
        streamedText: '',
        hasPersistedAssistantIdentity: true,
        hasPersistedAssistantCompletion: true,
      }),
    ).toBe(false);
    expect(
      shouldReconcileOpenCodeSessionCompletion({
        statusLookupSucceeded: true,
        streamedText: 'OK',
        hasPersistedAssistantIdentity: false,
        hasPersistedAssistantCompletion: true,
      }),
    ).toBe(false);
    expect(
      shouldReconcileOpenCodeSessionCompletion({
        status: 'idle',
        statusLookupSucceeded: true,
        streamedText: '',
        hasPersistedAssistantIdentity: false,
        hasPersistedAssistantCompletion: true,
      }),
    ).toBe(true);
    expect(
      shouldReconcileOpenCodeSessionCompletion({
        statusLookupSucceeded: true,
        streamedText: 'Still working',
        hasPersistedAssistantIdentity: true,
        hasPersistedAssistantCompletion: false,
      }),
    ).toBe(false);
  });

  it('fails closed only for authoritative idle or bounded undefined status without turn evidence', () => {
    expect(
      shouldFailOpenCodeTurnWithoutEvidence({
        status: 'idle',
        statusLookupSucceeded: true,
        elapsedMs: 0,
        hasTurnEvidence: false,
      }),
    ).toBe(true);
    expect(
      shouldFailOpenCodeTurnWithoutEvidence({
        statusLookupSucceeded: true,
        elapsedMs: 1_999,
        hasTurnEvidence: false,
      }),
    ).toBe(false);
    expect(
      shouldFailOpenCodeTurnWithoutEvidence({
        statusLookupSucceeded: true,
        elapsedMs: 2_000,
        hasTurnEvidence: false,
      }),
    ).toBe(true);
    expect(
      shouldFailOpenCodeTurnWithoutEvidence({
        status: 'idle',
        statusLookupSucceeded: true,
        elapsedMs: 10_000,
        hasTurnEvidence: true,
      }),
    ).toBe(false);
    expect(
      shouldFailOpenCodeTurnWithoutEvidence({
        status: 'busy',
        statusLookupSucceeded: true,
        elapsedMs: 10_000,
        hasTurnEvidence: false,
      }),
    ).toBe(false);
  });
});
