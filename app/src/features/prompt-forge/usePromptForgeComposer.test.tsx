import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatImageAttachment } from '@/lib/ai/vision';
import { syntheticCredentialFixture } from '@/test/syntheticCredentialFixture';
import type { PromptForgeExecutionResult } from './promptForgeExecutor';
import type { PromptForgeModelOption } from './modelSelection';
import {
  createPromptForgeJob,
  transitionPromptForgeJob,
  type PromptForgeAttachmentSnapshot,
  type PromptForgeJob,
} from './contracts';
import type { PromptForgeJobRepository } from './promptForgeService';
import { usePromptForgeComposer } from './usePromptForgeComposer';

function memoryRepository(seed: readonly PromptForgeJob[] = []) {
  const jobs = new Map<string, PromptForgeJob>(seed.map((job) => [job.id, job]));
  const repository: PromptForgeJobRepository = {
    async create(job) {
      if (jobs.has(job.id)) throw new Error('duplicate');
      jobs.set(job.id, job);
      return job;
    },
    async save(job, expectedRevision) {
      const previous = jobs.get(job.id);
      if (!previous || previous.revision !== expectedRevision) throw new Error('revision');
      jobs.set(job.id, job);
      return job;
    },
    async get(accountId, jobId) {
      const job = jobs.get(jobId);
      return job?.accountId === accountId ? job : null;
    },
    async listRecoverable(scope) {
      return [...jobs.values()].filter(
        (job) =>
          job.accountId === scope.accountId &&
          job.chatId === scope.chatId &&
          job.projectId === scope.projectId,
      );
    },
    async remove(accountId, jobId) {
      const job = jobs.get(jobId);
      return job?.accountId === accountId ? jobs.delete(jobId) : false;
    },
  };
  return { jobs, repository };
}

const execution: PromptForgeExecutionResult = Object.freeze({
  upgradedPrompt: 'Build a polished, accessible runner game.',
  validation: Object.freeze({
    passed: true,
    missing: Object.freeze([]),
    preservedCount: 0,
    checkedCount: 0,
  }),
  usage: Object.freeze({ input_tokens: 12, output_tokens: 8, cost_usd: 0 }),
  provider: 'ollama',
  model: 'qwen3:8b',
  finishReason: 'stop',
  startedAt: 100,
  completedAt: 100,
});

describe('usePromptForgeComposer', () => {
  it('previews the upgrade in the composer, then supports accept and undo', async () => {
    const { jobs, repository } = memoryRepository();
    const setDraft = vi.fn();
    let nextId = 0;
    const { result } = renderHook(() =>
      usePromptForgeComposer({
        accountId: 'account-1',
        chatId: 'chat-1',
        projectId: 'project-1',
        draft: 'Build a runner game.',
        setDraft,
        originalAttachments: [],
        contextAttachments: [],
        additionalSources: [],
        modelSelection: { mode: 'prefer_local' },
        modelOptions: [
          {
            id: 'ollama-local:qwen3:8b',
            providerId: 'ollama',
            modelId: 'qwen3:8b',
            label: 'Qwen 3 8B',
            connectionId: 'ollama-local',
            connectionMode: 'local',
            localOnly: true,
            available: true,
          },
        ],
        currentChatSelection: { mode: 'none' },
        offlineMode: false,
        defaultLocalModel: 'qwen3:8b',
        repository,
        executor: { execute: vi.fn(async () => execution) },
        retrieveContext: async () => ({
          queryId: 'query-1',
          mapRevisions: {},
          items: [],
          relatedEntities: [],
          omittedCount: 0,
          staleItems: [],
          warnings: [],
          builtAt: 100,
          sourceLabels: {},
          evidenceKinds: {},
        }),
        now: () => 100,
        createJobId: () => `forge-job-${++nextId}`,
        recordActivity: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.status).toBe('ready');
    expect(result.current.reviewOpen).toBe(true);
    expect(result.current.upgradedDraft).toBe(execution.upgradedPrompt);
    expect(setDraft).toHaveBeenLastCalledWith(execution.upgradedPrompt);

    act(() => result.current.accept());
    expect(result.current.reviewOpen).toBe(false);
    expect(result.current.isDraftApproved(execution.upgradedPrompt)).toBe(true);
    expect(result.current.canUndo).toBe(true);

    act(() => result.current.undo());
    expect(setDraft).toHaveBeenLastCalledWith('Build a runner game.');

    act(() => result.current.toggleSource('context:removed-source'));
    await act(async () => {
      await result.current.regenerate('Keep it shorter.');
    });
    const latest = jobs.get('forge-job-2');
    expect(latest?.originalDraft).toBe('Build a runner game.');
    expect(latest?.regenerationInstructions).toBe('Keep it shorter.');
    expect(result.current.excludedSourceIds).toEqual(['context:removed-source']);

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.excludedSourceIds).toEqual([]);
  });

  it('returns the upgraded Send text without opening review and preserves the original on failure', async () => {
    const modelOptions: readonly PromptForgeModelOption[] = [
      {
        id: 'ollama-local:qwen3:8b',
        providerId: 'ollama',
        modelId: 'qwen3:8b',
        label: 'Qwen 3 8B',
        connectionId: 'ollama-local',
        connectionMode: 'local',
        localOnly: true,
        available: true,
      },
    ];
    const retrieveContext = async () => ({
      queryId: 'query-send',
      mapRevisions: {},
      items: [],
      relatedEntities: [],
      omittedCount: 0,
      staleItems: [],
      warnings: [],
      builtAt: 100,
      sourceLabels: {},
      evidenceKinds: {},
    });
    const setDraft = vi.fn();
    const successful = renderHook(() =>
      usePromptForgeComposer({
        accountId: 'account-1',
        chatId: 'chat-1',
        projectId: 'project-1',
        draft: 'Original composer draft.',
        setDraft,
        originalAttachments: [],
        contextAttachments: [],
        additionalSources: [],
        modelSelection: { mode: 'prefer_local' },
        modelOptions,
        currentChatSelection: { mode: 'none' },
        offlineMode: false,
        defaultLocalModel: 'qwen3:8b',
        repository: memoryRepository().repository,
        executor: { execute: vi.fn(async () => execution) },
        retrieveContext,
        now: () => 100,
        createJobId: () => 'forge-job-send-success',
        recordActivity: vi.fn(),
      }),
    );

    await act(async () => {
      await expect(
        successful.result.current.upgradeForSend('Ship the runner game.'),
      ).resolves.toEqual({
        text: execution.upgradedPrompt,
        upgraded: true,
        requiresReview: true,
      });
    });
    expect(successful.result.current.reviewOpen).toBe(true);
    expect(successful.result.current.status).toBe('ready');
    expect(successful.result.current.isRunning).toBe(false);
    expect(setDraft).toHaveBeenLastCalledWith(execution.upgradedPrompt);

    const failing = renderHook(() =>
      usePromptForgeComposer({
        accountId: 'account-1',
        chatId: 'chat-1',
        projectId: 'project-1',
        draft: 'Original composer draft.',
        setDraft: vi.fn(),
        originalAttachments: [],
        contextAttachments: [],
        additionalSources: [],
        modelSelection: { mode: 'prefer_local' },
        modelOptions,
        currentChatSelection: { mode: 'none' },
        offlineMode: false,
        defaultLocalModel: 'qwen3:8b',
        repository: memoryRepository().repository,
        executor: {
          execute: vi.fn(async () => {
            throw new Error('provider secret must not escape');
          }),
        },
        retrieveContext,
        now: () => 100,
        createJobId: () => 'forge-job-send-failure',
        recordActivity: vi.fn(),
      }),
    );

    await act(async () => {
      const outcome = await failing.result.current.upgradeForSend('Keep my original intent.');
      expect(outcome.text).toBe('Keep my original intent.');
      expect(outcome.upgraded).toBe(false);
      expect(outcome.reason).toMatch(/could not complete|original|failed/i);
      expect(outcome.reason).not.toContain('provider secret');
    });
    expect(failing.result.current.reviewOpen).toBe(false);
    expect(failing.result.current.status).toBe('failed');
    expect(failing.result.current.isRunning).toBe(false);
  });

  it('explains why empty or unauthenticated drafts cannot start', () => {
    const { repository } = memoryRepository();
    const common = {
      chatId: 'chat-1',
      projectId: null,
      setDraft: vi.fn(),
      originalAttachments: [],
      contextAttachments: [],
      additionalSources: [],
      modelSelection: { mode: 'prefer_local' as const },
      modelOptions: [],
      currentChatSelection: { mode: 'none' as const },
      offlineMode: true,
      defaultLocalModel: 'qwen3:8b',
      repository,
      executor: { execute: vi.fn(async () => execution) },
      now: () => 100,
    };
    const empty = renderHook(() =>
      usePromptForgeComposer({ ...common, accountId: 'account-1', draft: '   ' }),
    );
    expect(empty.result.current.disabledReason).toMatch(/write or dictate/i);
    const signedOut = renderHook(() =>
      usePromptForgeComposer({ ...common, accountId: '', draft: 'Upgrade me' }),
    );
    expect(signedOut.result.current.disabledReason).toMatch(/sign in/i);
  });

  it('blocks text-only transports and forwards current images to a native vision run', async () => {
    const image: ChatImageAttachment = Object.freeze({
      id: 'image-1',
      name: 'diagram.png',
      mimeType: 'image/png',
      data: 'iVBORw0KGgo=',
      size: 8,
    });
    const retrieveContext = async () => ({
      queryId: 'query-image',
      mapRevisions: {},
      items: [],
      relatedEntities: [],
      omittedCount: 0,
      staleItems: [],
      warnings: [],
      builtAt: 100,
      sourceLabels: {},
      evidenceKinds: {},
    });
    const textOnlyExecutor = { execute: vi.fn(async () => execution) };
    const textOnly = renderHook(() =>
      usePromptForgeComposer({
        accountId: 'account-1',
        chatId: 'chat-1',
        projectId: null,
        draft: 'Explain this diagram.',
        setDraft: vi.fn(),
        originalAttachments: [],
        contextAttachments: [],
        additionalSources: [],
        imageAttachments: [image],
        modelSelection: {
          mode: 'single',
          providerId: 'openai',
          modelId: 'gpt-5.6-sol',
          connectionId: 'openai-codex',
        },
        modelOptions: [
          {
            id: 'openai-codex:gpt-5.6-sol',
            providerId: 'openai',
            modelId: 'gpt-5.6-sol',
            label: 'GPT-5.6 Sol',
            connectionId: 'openai-codex',
            connectionMode: 'external-cli',
            localOnly: false,
            available: true,
          },
        ],
        currentChatSelection: { mode: 'none' },
        offlineMode: false,
        defaultLocalModel: 'qwen3:8b',
        repository: memoryRepository().repository,
        executor: textOnlyExecutor,
        retrieveContext,
        now: () => 100,
      }),
    );

    act(() => textOnly.result.current.setPrivacyMode('provider_allowed'));
    expect(textOnly.result.current.disabledReason).toMatch(/native.*provider/i);
    await act(async () => {
      await expect(textOnly.result.current.start()).resolves.toBeNull();
    });
    expect(textOnlyExecutor.execute).not.toHaveBeenCalled();

    const nativeExecutor = { execute: vi.fn(async () => execution) };
    const native = renderHook(() =>
      usePromptForgeComposer({
        accountId: 'account-1',
        chatId: 'chat-1',
        projectId: null,
        draft: 'Explain this diagram.',
        setDraft: vi.fn(),
        originalAttachments: [],
        contextAttachments: [],
        additionalSources: [],
        imageAttachments: [image],
        modelSelection: {
          mode: 'single',
          providerId: 'openai',
          modelId: 'gpt-4o',
          connectionId: 'openai-api',
        },
        modelOptions: [
          {
            id: 'openai-api:gpt-4o',
            providerId: 'openai',
            modelId: 'gpt-4o',
            label: 'GPT-4o',
            connectionId: 'openai-api',
            connectionMode: 'native-api',
            localOnly: false,
            available: true,
          },
        ],
        currentChatSelection: { mode: 'none' },
        offlineMode: false,
        defaultLocalModel: 'qwen3:8b',
        repository: memoryRepository().repository,
        executor: nativeExecutor,
        retrieveContext,
        now: () => 100,
        createJobId: () => 'forge-job-image',
      }),
    );

    act(() => native.result.current.setPrivacyMode('provider_allowed'));
    expect(native.result.current.disabledReason).toBeNull();
    await act(async () => {
      await native.result.current.start();
    });
    expect(nativeExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ imageAttachments: [image] }),
    );
  });

  it('rejects a second start synchronously while the first upgrade is still running', async () => {
    const { jobs, repository } = memoryRepository();
    let releaseExecution!: (value: PromptForgeExecutionResult) => void;
    const pendingExecution = new Promise<PromptForgeExecutionResult>((resolve) => {
      releaseExecution = resolve;
    });
    const execute = vi.fn(() => pendingExecution);
    let nextId = 0;
    const { result } = renderHook(() =>
      usePromptForgeComposer({
        accountId: 'account-1',
        chatId: 'chat-1',
        projectId: 'project-1',
        draft: 'Build a runner game.',
        setDraft: vi.fn(),
        originalAttachments: [],
        contextAttachments: [],
        additionalSources: [],
        modelSelection: { mode: 'prefer_local' },
        modelOptions: [
          {
            id: 'ollama-local:qwen3:8b',
            providerId: 'ollama',
            modelId: 'qwen3:8b',
            label: 'Qwen 3 8B',
            connectionId: 'ollama-local',
            connectionMode: 'local',
            localOnly: true,
            available: true,
          },
        ],
        currentChatSelection: { mode: 'none' },
        offlineMode: false,
        defaultLocalModel: 'qwen3:8b',
        repository,
        executor: { execute },
        retrieveContext: async () => ({
          queryId: 'query-1',
          mapRevisions: {},
          items: [],
          relatedEntities: [],
          omittedCount: 0,
          staleItems: [],
          warnings: [],
          builtAt: 100,
          sourceLabels: {},
          evidenceKinds: {},
        }),
        now: () => 100,
        createJobId: () => `forge-job-${++nextId}`,
        recordActivity: vi.fn(),
      }),
    );

    let first!: Promise<PromptForgeJob | null>;
    let second!: Promise<PromptForgeJob | null>;
    await act(async () => {
      first = result.current.start();
      second = result.current.start();
      await vi.waitFor(() => expect(execute).toHaveBeenCalled());
      releaseExecution(execution);
      await first;
      await second;
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(jobs.size).toBe(1);
    await expect(second).resolves.toBeNull();
  });

  it('reports unusable model/privacy selections before creating a job', async () => {
    const { jobs, repository } = memoryRepository();
    const cloudOnly = renderHook(() =>
      usePromptForgeComposer({
        accountId: 'account-1',
        chatId: 'chat-1',
        projectId: null,
        draft: 'Upgrade me.',
        setDraft: vi.fn(),
        originalAttachments: [],
        contextAttachments: [],
        additionalSources: [],
        modelSelection: { mode: 'prefer_local' },
        modelOptions: [
          {
            id: 'openai-codex:gpt-5.6-sol',
            providerId: 'openai',
            modelId: 'gpt-5.6-sol',
            label: 'GPT-5.6 Sol',
            connectionId: 'openai-codex',
            connectionMode: 'external-cli',
            localOnly: false,
            available: true,
          },
        ],
        currentChatSelection: { mode: 'none' },
        offlineMode: false,
        defaultLocalModel: 'qwen3:8b',
        repository,
        executor: { execute: vi.fn(async () => execution) },
        now: () => 100,
      }),
    );

    expect(cloudOnly.result.current.disabledReason).toMatch(/local model/i);
    await act(async () => {
      await expect(cloudOnly.result.current.start()).resolves.toBeNull();
    });
    expect(jobs.size).toBe(0);
  });

  it('offers the built-in real research port and permits an explicit administrative disable', async () => {
    const { repository } = memoryRepository();
    const { result } = renderHook(() =>
      usePromptForgeComposer({
        accountId: 'account-1',
        chatId: 'chat-1',
        projectId: null,
        draft: 'Upgrade me.',
        setDraft: vi.fn(),
        originalAttachments: [],
        contextAttachments: [],
        additionalSources: [],
        modelSelection: { mode: 'prefer_local' },
        modelOptions: [
          {
            id: 'ollama-local:qwen3:8b',
            providerId: 'ollama',
            modelId: 'qwen3:8b',
            label: 'Qwen 3 8B',
            connectionId: 'ollama-local',
            connectionMode: 'local',
            localOnly: true,
            available: true,
          },
        ],
        currentChatSelection: { mode: 'none' },
        offlineMode: false,
        defaultLocalModel: 'qwen3:8b',
        repository,
        executor: { execute: vi.fn(async () => execution) },
        now: () => 100,
      }),
    );

    await waitFor(() => expect(result.current.recoveryLoading).toBe(false));
    act(() => result.current.setPrivacyMode('provider_allowed'));
    act(() => result.current.setAllowPublicResearch(true));
    expect(result.current.publicResearchAvailable).toBe(true);
    expect(result.current.allowPublicResearch).toBe(true);

    const disabled = renderHook(() =>
      usePromptForgeComposer({
        accountId: 'account-1',
        chatId: 'chat-1',
        projectId: null,
        draft: 'Upgrade me.',
        setDraft: vi.fn(),
        originalAttachments: [],
        contextAttachments: [],
        additionalSources: [],
        modelSelection: { mode: 'prefer_local' },
        modelOptions: [
          {
            id: 'ollama-local:qwen3:8b',
            providerId: 'ollama',
            modelId: 'qwen3:8b',
            label: 'Qwen 3 8B',
            connectionId: 'ollama-local',
            connectionMode: 'local',
            localOnly: true,
            available: true,
          },
        ],
        currentChatSelection: { mode: 'none' },
        offlineMode: false,
        defaultLocalModel: 'qwen3:8b',
        repository,
        executor: { execute: vi.fn(async () => execution) },
        researchPublicSources: null,
        now: () => 100,
      }),
    );
    await waitFor(() => expect(disabled.result.current.recoveryLoading).toBe(false));
    expect(disabled.result.current.publicResearchAvailable).toBe(false);
  });

  it('does not expose raw persistence or provider errors in the Composer', async () => {
    const { repository } = memoryRepository();
    const { result } = renderHook(() =>
      usePromptForgeComposer({
        accountId: 'account-1',
        chatId: 'chat-1',
        projectId: null,
        draft: 'Upgrade me.',
        setDraft: vi.fn(),
        originalAttachments: [],
        contextAttachments: [],
        additionalSources: [],
        modelSelection: { mode: 'prefer_local' },
        modelOptions: [
          {
            id: 'ollama-local:qwen3:8b',
            providerId: 'ollama',
            modelId: 'qwen3:8b',
            label: 'Qwen 3 8B',
            connectionId: 'ollama-local',
            connectionMode: 'local',
            localOnly: true,
            available: true,
          },
        ],
        currentChatSelection: { mode: 'none' },
        offlineMode: false,
        defaultLocalModel: 'qwen3:8b',
        repository: {
          ...repository,
          create: vi.fn(async () => {
            throw new Error('database failure included secret-token-value');
          }),
        },
        executor: { execute: vi.fn(async () => execution) },
        now: () => 100,
      }),
    );

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.error).toMatch(/original draft is unchanged/i);
    expect(result.current.error).not.toContain('secret-token-value');
  });

  it('rejects secrets in drafts or regeneration instructions before persistence', async () => {
    const { jobs, repository } = memoryRepository();
    const secret = syntheticCredentialFixture('ghp_', 'SyntheticCredentialValue1234567890');
    const { result } = renderHook(() =>
      usePromptForgeComposer({
        accountId: 'account-1',
        chatId: 'chat-1',
        projectId: null,
        draft: `Deploy with ${secret}.`,
        setDraft: vi.fn(),
        originalAttachments: [],
        contextAttachments: [],
        additionalSources: [],
        modelSelection: { mode: 'prefer_local' },
        modelOptions: [
          {
            id: 'ollama-local:qwen3:8b',
            providerId: 'ollama',
            modelId: 'qwen3:8b',
            label: 'Qwen 3 8B',
            connectionId: 'ollama-local',
            connectionMode: 'local',
            localOnly: true,
            available: true,
          },
        ],
        currentChatSelection: { mode: 'none' },
        offlineMode: false,
        defaultLocalModel: 'qwen3:8b',
        repository,
        executor: { execute: vi.fn(async () => execution) },
        now: () => 100,
      }),
    );

    await act(async () => {
      await expect(result.current.start()).resolves.toBeNull();
    });
    expect(jobs.size).toBe(0);
    expect(result.current.error).toMatch(/remove or replace detected secrets/i);
    expect(result.current.error).not.toContain(secret);

    await act(async () => {
      await expect(
        result.current.start(`Use this token: ${secret}`, 'Safe original draft.'),
      ).resolves.toBeNull();
    });
    expect(jobs.size).toBe(0);
  });

  it('aborts and ignores a stale run when the account, chat, or project scope changes', async () => {
    const { repository } = memoryRepository();
    let releaseExecution!: (value: PromptForgeExecutionResult) => void;
    const pendingExecution = new Promise<PromptForgeExecutionResult>((resolve) => {
      releaseExecution = resolve;
    });
    let executionSignal: AbortSignal | undefined;
    const setDraftOne = vi.fn();
    const setDraftTwo = vi.fn();
    const common = {
      projectId: 'project-1',
      draft: 'Build a runner game.',
      originalAttachments: [],
      contextAttachments: [],
      additionalSources: [],
      modelSelection: { mode: 'prefer_local' as const },
      modelOptions: [
        {
          id: 'ollama-local:qwen3:8b',
          providerId: 'ollama' as const,
          modelId: 'qwen3:8b',
          label: 'Qwen 3 8B',
          connectionId: 'ollama-local',
          connectionMode: 'local' as const,
          localOnly: true,
          available: true,
        },
      ],
      currentChatSelection: { mode: 'none' as const },
      offlineMode: false,
      defaultLocalModel: 'qwen3:8b',
      repository,
      executor: {
        execute: vi.fn(async ({ signal }) => {
          executionSignal = signal;
          return pendingExecution;
        }),
      },
      retrieveContext: async () => ({
        queryId: 'query-1',
        mapRevisions: {},
        items: [],
        relatedEntities: [],
        omittedCount: 0,
        staleItems: [],
        warnings: [],
        builtAt: 100,
        sourceLabels: {},
        evidenceKinds: {},
      }),
      now: () => 100,
      createJobId: () => 'forge-job-scope',
      recordActivity: vi.fn(),
    };
    const { result, rerender } = renderHook(
      ({ accountId, chatId, setDraft }) =>
        usePromptForgeComposer({ ...common, accountId, chatId, setDraft }),
      {
        initialProps: {
          accountId: 'account-1',
          chatId: 'chat-1',
          setDraft: setDraftOne,
        },
      },
    );

    let running!: Promise<PromptForgeJob | null>;
    await act(async () => {
      running = result.current.start();
      await vi.waitFor(() => expect(executionSignal).toBeDefined());
    });
    rerender({
      accountId: 'account-2',
      chatId: 'chat-2',
      setDraft: setDraftTwo,
    });
    const wasAbortedAfterScopeChange = executionSignal?.aborted;
    releaseExecution(execution);
    await act(async () => {
      await running;
    });

    expect(wasAbortedAfterScopeChange).toBe(true);
    expect(result.current.status).toBe('idle');
    expect(result.current.reviewOpen).toBe(false);
    act(() => result.current.replace());
    expect(setDraftOne).not.toHaveBeenCalled();
    expect(setDraftTwo).not.toHaveBeenCalled();
  });

  it('restores and explicitly resumes an interrupted job only in the current scope', async () => {
    const interrupted = transitionPromptForgeJob(
      createPromptForgeJob({
        id: 'forge-job-recovery',
        accountId: 'account-1',
        chatId: 'chat-1',
        projectId: 'project-1',
        originalDraft: 'Restore this interrupted draft.',
        originalAttachments: [],
        modelSelection: { mode: 'prefer_local' },
        privacyMode: 'local_only',
        allowPublicResearch: false,
        now: 100,
      }),
      {
        expectedRevision: 1,
        status: 'collecting_context',
        now: 110,
      },
    );
    const { repository } = memoryRepository([interrupted]);
    const setDraft = vi.fn();
    const { result } = renderHook(() =>
      usePromptForgeComposer({
        accountId: 'account-1',
        chatId: 'chat-1',
        projectId: 'project-1',
        draft: '',
        setDraft,
        originalAttachments: [],
        contextAttachments: [],
        additionalSources: [],
        modelSelection: { mode: 'prefer_local' },
        modelOptions: [
          {
            id: 'ollama-local:qwen3:8b',
            providerId: 'ollama',
            modelId: 'qwen3:8b',
            label: 'Qwen 3 8B',
            connectionId: 'ollama-local',
            connectionMode: 'local',
            localOnly: true,
            available: true,
          },
        ],
        currentChatSelection: { mode: 'none' },
        offlineMode: false,
        defaultLocalModel: 'qwen3:8b',
        repository,
        executor: { execute: vi.fn(async () => execution) },
        retrieveContext: async () => ({
          queryId: 'query-1',
          mapRevisions: {},
          items: [],
          relatedEntities: [],
          omittedCount: 0,
          staleItems: [],
          warnings: [],
          builtAt: 200,
          sourceLabels: {},
          evidenceKinds: {},
        }),
        now: () => 200,
        recordActivity: vi.fn(),
      }),
    );

    await waitFor(() =>
      expect(result.current.recoverableJob).toMatchObject({
        id: 'forge-job-recovery',
        status: 'failed',
        errorCode: 'interrupted',
      }),
    );
    expect(setDraft).toHaveBeenCalledWith('Restore this interrupted draft.');

    await act(async () => {
      await result.current.resumeRecovery();
    });
    expect(result.current.recoverableJob).toBeNull();
    expect(result.current.status).toBe('ready');
    expect(result.current.reviewOpen).toBe(true);
  });

  it('preserves a nonempty composer until the interrupted draft is explicitly restored', async () => {
    const interrupted = transitionPromptForgeJob(
      createPromptForgeJob({
        id: 'forge-job-restore',
        accountId: 'account-1',
        chatId: 'chat-1',
        projectId: 'project-1',
        originalDraft: 'Recovered draft.',
        originalAttachments: [],
        modelSelection: { mode: 'prefer_local' },
        privacyMode: 'local_only',
        allowPublicResearch: false,
        now: 100,
      }),
      {
        expectedRevision: 1,
        status: 'collecting_context',
        now: 110,
      },
    );
    const { repository } = memoryRepository([interrupted]);
    const setDraft = vi.fn();
    const { result } = renderHook(() =>
      usePromptForgeComposer({
        accountId: 'account-1',
        chatId: 'chat-1',
        projectId: 'project-1',
        draft: 'Keep my current draft.',
        setDraft,
        originalAttachments: [],
        contextAttachments: [],
        additionalSources: [],
        modelSelection: { mode: 'prefer_local' },
        modelOptions: [
          {
            id: 'ollama-local:qwen3:8b',
            providerId: 'ollama',
            modelId: 'qwen3:8b',
            label: 'Qwen 3 8B',
            connectionId: 'ollama-local',
            connectionMode: 'local',
            localOnly: true,
            available: true,
          },
        ],
        currentChatSelection: { mode: 'none' },
        offlineMode: false,
        defaultLocalModel: 'qwen3:8b',
        repository,
        executor: { execute: vi.fn(async () => execution) },
        now: () => 200,
        recordActivity: vi.fn(),
      }),
    );

    await waitFor(() => expect(result.current.recoverableJob?.id).toBe('forge-job-restore'));
    expect(setDraft).not.toHaveBeenCalled();

    act(() => result.current.restoreRecoveryDraft());
    expect(setDraft).toHaveBeenLastCalledWith('Recovered draft.');
    expect(result.current.canUndo).toBe(true);

    act(() => result.current.undo());
    expect(setDraft).toHaveBeenLastCalledWith('Keep my current draft.');
  });

  it('discards only the exact scoped interrupted job without changing the composer', async () => {
    const interrupted = transitionPromptForgeJob(
      createPromptForgeJob({
        id: 'forge-job-discard',
        accountId: 'account-1',
        chatId: 'chat-1',
        projectId: 'project-1',
        originalDraft: 'Discard this recovery.',
        originalAttachments: [],
        modelSelection: { mode: 'prefer_local' },
        privacyMode: 'local_only',
        allowPublicResearch: false,
        now: 100,
      }),
      {
        expectedRevision: 1,
        status: 'collecting_context',
        now: 110,
      },
    );
    const { jobs, repository } = memoryRepository([interrupted]);
    const setDraft = vi.fn();
    const { result } = renderHook(() =>
      usePromptForgeComposer({
        accountId: 'account-1',
        chatId: 'chat-1',
        projectId: 'project-1',
        draft: 'Current composer text.',
        setDraft,
        originalAttachments: [],
        contextAttachments: [],
        additionalSources: [],
        modelSelection: { mode: 'prefer_local' },
        modelOptions: [
          {
            id: 'ollama-local:qwen3:8b',
            providerId: 'ollama',
            modelId: 'qwen3:8b',
            label: 'Qwen 3 8B',
            connectionId: 'ollama-local',
            connectionMode: 'local',
            localOnly: true,
            available: true,
          },
        ],
        currentChatSelection: { mode: 'none' },
        offlineMode: false,
        defaultLocalModel: 'qwen3:8b',
        repository,
        executor: { execute: vi.fn(async () => execution) },
        now: () => 200,
        recordActivity: vi.fn(),
      }),
    );

    await waitFor(() => expect(result.current.recoverableJob?.id).toBe('forge-job-discard'));

    await act(async () => {
      await expect(result.current.discardRecovery()).resolves.toBe(true);
    });
    expect(result.current.recoverableJob).toBeNull();
    expect(jobs.has('forge-job-discard')).toBe(false);
    expect(setDraft).not.toHaveBeenCalled();
  });

  it('resumes with the persisted job model instead of the current global selection', async () => {
    const interrupted = transitionPromptForgeJob(
      createPromptForgeJob({
        id: 'forge-job-model-recovery',
        accountId: 'account-1',
        chatId: 'chat-1',
        projectId: 'project-1',
        originalDraft: 'Resume with the saved model.',
        originalAttachments: [],
        modelSelection: {
          mode: 'single',
          providerId: 'openai',
          modelId: 'gpt-5.6-sol',
          connectionId: 'openai-codex',
        },
        privacyMode: 'provider_allowed',
        allowPublicResearch: false,
        now: 100,
      }),
      {
        expectedRevision: 1,
        status: 'collecting_context',
        now: 110,
      },
    );
    const { repository } = memoryRepository([interrupted]);
    const { result } = renderHook(() =>
      usePromptForgeComposer({
        accountId: 'account-1',
        chatId: 'chat-1',
        projectId: 'project-1',
        draft: '',
        setDraft: vi.fn(),
        originalAttachments: [],
        contextAttachments: [],
        additionalSources: [],
        modelSelection: { mode: 'prefer_local' },
        modelOptions: [
          {
            id: 'openai-codex:gpt-5.6-sol',
            providerId: 'openai',
            modelId: 'gpt-5.6-sol',
            label: 'GPT-5.6 Sol',
            connectionId: 'openai-codex',
            connectionMode: 'external-cli',
            localOnly: false,
            available: true,
          },
        ],
        currentChatSelection: { mode: 'none' },
        offlineMode: false,
        defaultLocalModel: 'qwen3:8b',
        repository,
        executor: { execute: vi.fn(async () => execution) },
        now: () => 200,
        recordActivity: vi.fn(),
      }),
    );

    await waitFor(() => expect(result.current.recoverableJob?.id).toBe('forge-job-model-recovery'));
    await act(async () => {
      await expect(result.current.resumeRecovery()).resolves.toMatchObject({
        status: 'ready',
        resolvedModel: {
          providerId: 'openai',
          modelId: 'gpt-5.6-sol',
          connectionId: 'openai-codex',
        },
      });
    });
  });

  it('requires explicit confirmation before resuming with changed attachment context', async () => {
    const interrupted = transitionPromptForgeJob(
      createPromptForgeJob({
        id: 'forge-job-context-recovery',
        accountId: 'account-1',
        chatId: 'chat-1',
        projectId: 'project-1',
        originalDraft: 'Resume with the saved specification.',
        originalAttachments: [
          {
            id: 'attachment-1',
            kind: 'file',
            label: 'SPEC.md',
            reference: 'C:\\project\\SPEC.md',
          },
        ],
        modelSelection: { mode: 'prefer_local' },
        privacyMode: 'local_only',
        allowPublicResearch: false,
        now: 100,
      }),
      {
        expectedRevision: 1,
        status: 'collecting_context',
        now: 110,
      },
    );
    const { repository } = memoryRepository([interrupted]);
    const execute = vi.fn(async () => execution);
    let currentAttachments: PromptForgeAttachmentSnapshot[] = [];
    const { result, rerender } = renderHook(() =>
      usePromptForgeComposer({
        accountId: 'account-1',
        chatId: 'chat-1',
        projectId: 'project-1',
        draft: '',
        setDraft: vi.fn(),
        originalAttachments: currentAttachments,
        contextAttachments: [],
        additionalSources: [],
        modelSelection: { mode: 'prefer_local' },
        modelOptions: [
          {
            id: 'ollama-local:qwen3:8b',
            providerId: 'ollama',
            modelId: 'qwen3:8b',
            label: 'Qwen 3 8B',
            connectionId: 'ollama-local',
            connectionMode: 'local',
            localOnly: true,
            available: true,
          },
        ],
        currentChatSelection: { mode: 'none' },
        offlineMode: false,
        defaultLocalModel: 'qwen3:8b',
        repository,
        executor: { execute },
        now: () => 200,
        recordActivity: vi.fn(),
      }),
    );

    await waitFor(() =>
      expect(result.current.recoverableJob?.id).toBe('forge-job-context-recovery'),
    );
    expect(result.current.recoveryNeedsContextConfirmation).toBe(true);
    await act(async () => {
      await expect(result.current.resumeRecovery()).resolves.toBeNull();
    });
    expect(execute).not.toHaveBeenCalled();

    act(() => result.current.confirmRecoveryContextChange());
    expect(result.current.recoveryNeedsContextConfirmation).toBe(false);

    currentAttachments = [
      {
        id: 'attachment-2',
        kind: 'file',
        label: 'NEW-SPEC.md',
        reference: 'C:\\project\\NEW-SPEC.md',
      },
    ];
    rerender();
    expect(result.current.recoveryNeedsContextConfirmation).toBe(true);

    act(() => result.current.confirmRecoveryContextChange());
    await act(async () => {
      await expect(result.current.resumeRecovery()).resolves.toMatchObject({ status: 'ready' });
    });
    expect(execute).toHaveBeenCalledOnce();
  });
});
