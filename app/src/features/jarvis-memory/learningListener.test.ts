import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emojisEnabledFromLearning, startJarvisLearningListener } from './learningListener';
import { useJarvisLearningStore } from './learningStore';
import type { MemoryEvidenceItem } from './types';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value?: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return {
    promise,
    resolve: (value) => resolve?.(value as T),
    reject: (error) => reject?.(error),
  };
}

describe('Jarvis learning event listener', () => {
  let stop: (() => void | Promise<void>) | undefined;

  beforeEach(() => {
    localStorage.clear();
    useJarvisLearningStore.getState().clearForTests();
  });
  afterEach(async () => {
    await stop?.();
  });

  it('persists learning from ten messages in each of two backend chats', async () => {
    const save = vi.fn(async (_accountId: string, _markdown: string) => undefined);
    stop = startJarvisLearningListener({
      getAccountId: () => 'two-chat-account',
      save,
      load: async () => null,
      debounceMs: 0,
    });
    for (const backend of ['opencode', 'codex']) {
      for (let index = 0; index < 10; index++) {
        window.dispatchEvent(
          new CustomEvent('jarvis:send', {
            detail: {
              chatId: `chat-${backend}`,
              messageId: `${backend}-${index}`,
              text: `I prefer ${backend === 'opencode' ? 'concise responses' : 'focused terminal checks'} for project task ${index}.`,
            },
          }),
        );
      }
    }
    await vi.waitFor(() =>
      expect(useJarvisLearningStore.getState().currentProfile().lastEvaluationCount).toBe(20),
    );
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    await stop();
    stop = undefined;
    const markdown = save.mock.calls.at(-1)![1];
    expect(markdown).toContain('# Jarvis Learning');
    expect(markdown).toContain('concise responses');
    expect(markdown).toContain('focused terminal checks');
    expect(
      new Set(
        useJarvisLearningStore
          .getState()
          .currentProfile()
          .items.map((item) => item.source.chatId),
      ),
    ).toEqual(new Set(['chat-opencode', 'chat-codex']));
  });

  it('reviews completed turns only and aborts model learning on listener disposal', async () => {
    const review = vi.fn(async (_account: string, _chat: string, _signal: AbortSignal) => {});
    stop = startJarvisLearningListener({
      getAccountId: () => 'account-a',
      save: async () => {},
      load: async () => null,
      reviewCaoLearning: review,
    });
    window.dispatchEvent(
      new CustomEvent('jarvis:run-state', { detail: { chatId: 'chat1', status: 'running' } }),
    );
    expect(review).not.toHaveBeenCalled();
    window.dispatchEvent(
      new CustomEvent('jarvis:run-state', { detail: { chatId: 'chat1', status: 'done' } }),
    );
    await vi.waitFor(() => expect(review).toHaveBeenCalledOnce());
    expect(review.mock.calls[0]?.slice(0, 2)).toEqual(['account-a', 'chat1']);
    await stop();
    stop = undefined;
    expect(review.mock.calls[0]?.[2].aborted).toBe(true);
  });

  it('persists explicit memory immediately and applies response preferences', async () => {
    const save = vi.fn(async (_accountId: string, _markdown: string) => undefined);
    const statuses: string[] = [];
    const onStatus = (event: Event) =>
      statuses.push((event as CustomEvent<{ state: string }>).detail.state);
    window.addEventListener('jarvis:memory-status', onStatus);
    stop = startJarvisLearningListener({
      getAccountId: () => 'account-a',
      save,
      debounceMs: 0,
      load: async () => null,
    });

    window.dispatchEvent(
      new CustomEvent('jarvis:send', {
        detail: { chatId: 'chat-1', text: 'Remember that I prefer no emojis in responses.' },
      }),
    );

    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(emojisEnabledFromLearning()).toBe(false);
    const saveCalls = save.mock.calls as unknown as Array<[string, string]>;
    expect(saveCalls.at(-1)?.[0]).toBe('account-a');
    expect(saveCalls.at(-1)?.[1]).toContain('I prefer no emojis');
    expect(statuses).toEqual(expect.arrayContaining(['updating', 'updated']));
    window.removeEventListener('jarvis:memory-status', onStatus);
  });

  it('hydrates and persists curated evidence only through the active account repository', async () => {
    const durable: MemoryEvidenceItem = {
      id: 'evidence-durable',
      ownerId: 'account-a',
      workspaceId: 'workspace-a',
      category: 'workflow_lesson',
      content: 'Run focused tests before the release matrix.',
      sourceType: 'chat',
      sourceRef: {
        kind: 'message',
        id: 'message-durable',
        label: 'Release notes',
        occurredAt: 100,
      },
      confidence: 0.9,
      durabilityScore: 0.8,
      sensitivity: 'normal',
      status: 'approved',
      reinforcedCount: 1,
      createdAt: 100,
      updatedAt: 100,
    };
    const evidenceRepository = {
      list: vi.fn(async (ownerId: string) => (ownerId === 'account-a' ? [durable] : [])),
      create: vi.fn(async (_ownerId: string, item: MemoryEvidenceItem) => item),
      replace: vi.fn(async (_ownerId: string, item: MemoryEvidenceItem) => item),
      delete: vi.fn(async (_ownerId: string, _id: string) => undefined),
    };

    stop = startJarvisLearningListener({
      getAccountId: () => 'account-a',
      save: async () => undefined,
      load: async () => null,
      evidenceRepository,
    });

    await vi.waitFor(() =>
      expect(useJarvisLearningStore.getState().currentEvidence()).toEqual([durable]),
    );
    expect(evidenceRepository.create).not.toHaveBeenCalled();

    expect(useJarvisLearningStore.getState().archiveEvidence(durable.id)).toBe(true);
    await vi.waitFor(() =>
      expect(evidenceRepository.replace).toHaveBeenCalledWith(
        'account-a',
        expect.objectContaining({ id: durable.id, status: 'archived' }),
      ),
    );

    const newId = useJarvisLearningStore.getState().captureEvidence({
      workspaceId: 'workspace-a',
      category: 'correction',
      content: 'Do not rerun unchanged broad suites.',
      sourceType: 'manual',
      sourceRef: {
        kind: 'manual',
        id: 'manual-1',
        label: 'User correction',
        occurredAt: 200,
      },
      confidence: 1,
      durabilityScore: 1,
    });
    await vi.waitFor(() =>
      expect(evidenceRepository.create).toHaveBeenCalledWith(
        'account-a',
        expect.objectContaining({ id: newId }),
      ),
    );

    expect(useJarvisLearningStore.getState().deleteEvidence(durable.id)).toBe(true);
    await vi.waitFor(() =>
      expect(evidenceRepository.delete).toHaveBeenCalledWith('account-a', durable.id),
    );
  });

  it('removes the deprecated localStorage profile copy on startup', () => {
    localStorage.setItem('jarvis-learning-memory-v1', '{"legacy":"private profile"}');
    stop = startJarvisLearningListener({
      getAccountId: () => 'account-a',
      save: async () => undefined,
      load: async () => null,
    });
    expect(localStorage.getItem('jarvis-learning-memory-v1')).toBeNull();
  });

  it('does not announce completion before the physical save resolves', async () => {
    let finishSave: (() => void) | undefined;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const statuses: string[] = [];
    const onStatus = (event: Event) =>
      statuses.push((event as CustomEvent<{ state: string }>).detail.state);
    window.addEventListener('jarvis:memory-status', onStatus);
    stop = startJarvisLearningListener({
      getAccountId: () => 'account-a',
      save,
      load: async () => null,
      debounceMs: 0,
    });

    window.dispatchEvent(
      new CustomEvent('jarvis:send', {
        detail: { chatId: 'chat-1', text: 'Remember that I prefer direct answers.' },
      }),
    );
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(statuses).toEqual(['updating']);

    finishSave?.();
    await vi.waitFor(() => expect(statuses).toEqual(['updating', 'updated']));
    window.removeEventListener('jarvis:memory-status', onStatus);
  });

  it('waits for account recovery before applying a new memory update', async () => {
    let finishLoad: ((value: string | null) => void) | undefined;
    const load = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          finishLoad = resolve;
        }),
    );
    const save = vi.fn(async (_accountId: string, _markdown: string) => undefined);
    stop = startJarvisLearningListener({
      getAccountId: () => 'account-a',
      load,
      save,
      debounceMs: 0,
    });

    window.dispatchEvent(
      new CustomEvent('jarvis:send', {
        detail: { chatId: 'chat-1', text: 'Remember that I prefer verified results.' },
      }),
    );
    await Promise.resolve();
    expect(save).not.toHaveBeenCalled();

    finishLoad?.(null);
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls.at(-1)?.[1]).toContain('I prefer verified results');
  });

  it('does not learn against an empty profile after hydration fails and retries on the next send', async () => {
    let attempts = 0;
    const save = vi.fn(async () => undefined);
    const onError = vi.fn();
    stop = startJarvisLearningListener({
      getAccountId: () => 'account-a',
      load: async () => {
        attempts += 1;
        if (attempts <= 2) throw new Error('durable profile unavailable');
        return null;
      },
      save,
      debounceMs: 0,
      onError,
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    window.dispatchEvent(
      new CustomEvent('jarvis:send', {
        detail: { chatId: 'chat-1', text: 'Remember that I prefer verified hydration.' },
      }),
    );
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    expect(attempts).toBe(2);
    expect(save).not.toHaveBeenCalled();
    expect(useJarvisLearningStore.getState().exportMarkdown()).not.toContain('verified hydration');

    window.dispatchEvent(
      new CustomEvent('jarvis:send', {
        detail: { chatId: 'chat-1', text: 'Remember that I prefer verified hydration.' },
      }),
    );
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(attempts).toBe(3);
  });

  it('publishes truthful recovery status after hydrating a repaired durable profile', async () => {
    const statuses: string[] = [];
    const onStatus = (event: Event) =>
      statuses.push((event as CustomEvent<{ state: string }>).detail.state);
    window.addEventListener('jarvis:memory-status', onStatus);
    stop = startJarvisLearningListener({
      getAccountId: () => 'account-a',
      save: async () => undefined,
      load: async () => ({
        path: 'private-path-must-not-be-published',
        markdown: '# Jarvis Learning\n\n## Preferences\n- Recovered preference',
        recovered: true,
        recoverySource: 'backup' as const,
      }),
    });

    await vi.waitFor(() => expect(statuses).toContain('recovered'));
    expect(JSON.stringify(statuses)).not.toContain('private-path');
    window.removeEventListener('jarvis:memory-status', onStatus);
  });

  it('publishes unavailable truth when durable profile recovery fails', async () => {
    const statuses: string[] = [];
    const onStatus = (event: Event) =>
      statuses.push((event as CustomEvent<{ state: string }>).detail.state);
    window.addEventListener('jarvis:memory-status', onStatus);
    stop = startJarvisLearningListener({
      getAccountId: () => 'account-a',
      save: async () => undefined,
      load: async () => {
        throw new Error('corrupt durable profile');
      },
      onError: vi.fn(),
    });

    await vi.waitFor(() => expect(statuses).toContain('error'));
    window.removeEventListener('jarvis:memory-status', onStatus);
  });

  it('publishes unavailable truth when curated evidence persistence fails', async () => {
    const statuses: string[] = [];
    const onStatus = (event: Event) =>
      statuses.push((event as CustomEvent<{ state: string }>).detail.state);
    window.addEventListener('jarvis:memory-status', onStatus);
    const evidenceRepository = {
      list: vi.fn(async () => []),
      create: vi.fn(async () => {
        throw new Error('repository unavailable');
      }),
      replace: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    stop = startJarvisLearningListener({
      getAccountId: () => 'account-a',
      save: async () => undefined,
      load: async () => null,
      evidenceRepository,
      onError: vi.fn(),
    });
    await vi.waitFor(() => expect(evidenceRepository.list).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    useJarvisLearningStore.getState().captureEvidence({
      workspaceId: 'workspace-a',
      category: 'correction',
      content: 'Keep receipt truth visible.',
      sourceType: 'manual',
      sourceRef: {
        kind: 'manual',
        id: 'manual-failure',
        label: 'Persistence failure test',
        occurredAt: 1,
      },
      confidence: 1,
      durabilityScore: 1,
    });

    await vi.waitFor(() => expect(statuses).toContain('error'));
    await vi.waitFor(() => expect(statuses).toContain('recovered'));
    expect(useJarvisLearningStore.getState().currentEvidence()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(evidenceRepository.list).toHaveBeenCalledTimes(2);
    expect(evidenceRepository.delete).not.toHaveBeenCalled();
    expect(evidenceRepository.replace).not.toHaveBeenCalled();
    window.removeEventListener('jarvis:memory-status', onStatus);
  });

  it('cancels queued and during-recovery evidence writes, then permits fresh post-recovery work', async () => {
    let finishRecovery: ((items: readonly MemoryEvidenceItem[]) => void) | undefined;
    let listCalls = 0;
    const create = vi
      .fn<(ownerId: string, item: MemoryEvidenceItem) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('repository unavailable'))
      .mockResolvedValue(undefined);
    const evidenceRepository = {
      list: vi.fn(async () => {
        listCalls += 1;
        if (listCalls === 1) return [];
        return new Promise<readonly MemoryEvidenceItem[]>((resolve) => {
          finishRecovery = resolve;
        });
      }),
      create,
      replace: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    stop = startJarvisLearningListener({
      getAccountId: () => 'account-a',
      load: async () => null,
      save: async () => undefined,
      evidenceRepository,
      onError: vi.fn(),
    });
    await vi.waitFor(() => expect(evidenceRepository.list).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const capture = (id: string) =>
      useJarvisLearningStore.getState().captureEvidence({
        workspaceId: 'workspace-a',
        category: 'correction',
        content: `Evidence ${id}`,
        sourceType: 'manual',
        sourceRef: { kind: 'manual', id, label: id, occurredAt: 1 },
        confidence: 1,
        durabilityScore: 1,
      });
    capture('first');
    await vi.waitFor(() => expect(evidenceRepository.list).toHaveBeenCalledTimes(2));
    capture('during-recovery');
    finishRecovery?.([]);
    await vi.waitFor(() => expect(useJarvisLearningStore.getState().currentEvidence()).toEqual([]));
    expect(create).toHaveBeenCalledTimes(1);

    capture('after-recovery');
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  });

  it('restores the last durable profile after an optimistic save fails', async () => {
    const statuses: string[] = [];
    const onStatus = (event: Event) =>
      statuses.push((event as CustomEvent<{ state: string }>).detail.state);
    window.addEventListener('jarvis:memory-status', onStatus);
    useJarvisLearningStore.getState().setAccount('account-a');
    useJarvisLearningStore.getState().remember({
      value: 'I prefer durable answers',
      category: 'response-style',
      source: { kind: 'explicit' },
    });
    const durable = useJarvisLearningStore.getState().exportMarkdown();
    useJarvisLearningStore.getState().clearForTests();
    stop = startJarvisLearningListener({
      getAccountId: () => 'account-a',
      load: async () => durable,
      save: async () => {
        throw new Error('write unavailable');
      },
      debounceMs: 0,
      onError: vi.fn(),
    });
    await vi.waitFor(() =>
      expect(useJarvisLearningStore.getState().exportMarkdown()).toContain('durable answers'),
    );
    window.dispatchEvent(
      new CustomEvent('jarvis:send', {
        detail: { chatId: 'chat-1', text: 'Remember that I prefer optimistic answers.' },
      }),
    );

    await vi.waitFor(() => expect(statuses).toContain('error'));
    await vi.waitFor(() => expect(statuses).toContain('recovered'));
    expect(useJarvisLearningStore.getState().exportMarkdown()).toContain('durable answers');
    expect(useJarvisLearningStore.getState().exportMarkdown()).not.toContain('optimistic answers');
    window.removeEventListener('jarvis:memory-status', onStatus);
  });

  it('cancels stale profile writes across recovery and permits fresh durable work afterward', async () => {
    useJarvisLearningStore.getState().setAccount('account-a');
    useJarvisLearningStore.getState().remember({
      value: 'Keep the durable profile',
      category: 'workflow',
      source: { kind: 'explicit' },
    });
    const durable = useJarvisLearningStore.getState().exportMarkdown();
    useJarvisLearningStore.getState().clearForTests();
    const firstWrite = deferred();
    const recoveryLoad = deferred<string>();
    const load = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(durable)
      .mockImplementationOnce(() => recoveryLoad.promise);
    const save = vi
      .fn<(_accountId: string, _markdown: string) => Promise<void>>()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValue(undefined);
    stop = startJarvisLearningListener({
      getAccountId: () => 'account-a',
      load,
      save,
      debounceMs: 0,
      onError: vi.fn(),
    });
    await vi.waitFor(() =>
      expect(useJarvisLearningStore.getState().exportMarkdown()).toContain('durable profile'),
    );

    window.dispatchEvent(
      new CustomEvent('jarvis:send', {
        detail: { chatId: 'chat-1', text: 'Remember that the first optimistic write fails.' },
      }),
    );
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    window.dispatchEvent(
      new CustomEvent('jarvis:send', {
        detail: { chatId: 'chat-1', text: 'Remember that this queued snapshot is stale.' },
      }),
    );
    await vi.waitFor(() =>
      expect(useJarvisLearningStore.getState().exportMarkdown()).toContain('queued snapshot'),
    );

    firstWrite.reject(new Error('write unavailable'));
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    useJarvisLearningStore.getState().remember({
      value: 'This reconciliation-time snapshot is stale',
      category: 'workflow',
      source: { kind: 'explicit' },
    });
    recoveryLoad.resolve(durable);
    await vi.waitFor(() =>
      expect(useJarvisLearningStore.getState().exportMarkdown()).toContain('durable profile'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(save).toHaveBeenCalledTimes(1);

    useJarvisLearningStore.getState().remember({
      value: 'Fresh work after recovery persists',
      category: 'workflow',
      source: { kind: 'explicit' },
    });
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]?.[1]).toContain('Fresh work after recovery persists');
  });

  it('persists progress before twenty messages without prematurely inferring preferences', async () => {
    const save = vi.fn(async (_accountId: string, _markdown: string) => undefined);
    stop = startJarvisLearningListener({
      getAccountId: () => 'account-a',
      save,
      debounceMs: 0,
      load: async () => null,
    });

    for (let index = 0; index < 19; index += 1) {
      window.dispatchEvent(
        new CustomEvent('jarvis:send', {
          detail: {
            chatId: 'chat-1',
            text: `I prefer concise status updates for workflow ${index}.`,
          },
        }),
      );
    }

    await vi.waitFor(() => {
      expect(useJarvisLearningStore.getState().currentProfile().meaningfulMessageCount).toBe(19);
    });
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]?.[1]).toContain('No saved learning yet.');
    expect(useJarvisLearningStore.getState().currentProfile().items).toEqual([]);

    window.dispatchEvent(
      new CustomEvent('jarvis:send', {
        detail: {
          chatId: 'chat-1',
          text: 'I prefer concise status updates for workflow 19.',
        },
      }),
    );

    await vi.waitFor(() => {
      expect(useJarvisLearningStore.getState().currentProfile().lastEvaluationCount).toBe(20);
    });
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenCalledWith('account-a', expect.stringContaining('Jarvis Learning'));
    expect(
      useJarvisLearningStore
        .getState()
        .currentProfile()
        .items.some(
          (item) => item.source.kind === 'inferred' && item.category === 'response-style',
        ),
    ).toBe(true);
  });

  it('loads the correct account immediately when authentication changes', async () => {
    let accountId = 'account-a';
    let accountChanged: () => void = () => {};
    const load = vi.fn(async (id: string) =>
      id === 'account-b'
        ? '# Jarvis Learning\n\n<!-- jarvis-learning-v1:%7B%22accountId%22%3A%22account-b%22%2C%22enabled%22%3Atrue%2C%22items%22%3A%5B%5D%2C%22meaningfulMessageCount%22%3A0%2C%22lastEvaluationCount%22%3A0%2C%22updatedAt%22%3A1%7D -->'
        : null,
    );
    stop = startJarvisLearningListener({
      getAccountId: () => accountId,
      subscribeAccount: (listener) => {
        accountChanged = listener;
        return () => undefined;
      },
      save: async () => undefined,
      load,
    });
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith('account-a'));

    accountId = 'account-b';
    accountChanged();

    await vi.waitFor(() =>
      expect(useJarvisLearningStore.getState().activeAccountId).toBe('account-b'),
    );
    expect(load).toHaveBeenCalledWith('account-b');
  });

  it('flushes pre-review progress only to its original account when switching accounts', async () => {
    let accountId = 'account-a';
    let accountChanged: () => void = () => undefined;
    const save = vi.fn(async (_accountId: string, _markdown: string) => undefined);
    stop = startJarvisLearningListener({
      getAccountId: () => accountId,
      subscribeAccount: (listener) => {
        accountChanged = listener;
        return () => undefined;
      },
      save,
      load: async () => null,
      debounceMs: 25,
    });
    await vi.waitFor(() =>
      expect(useJarvisLearningStore.getState().activeAccountId).toBe('account-a'),
    );

    window.dispatchEvent(
      new CustomEvent('jarvis:send', {
        detail: {
          chatId: 'chat-1',
          text: 'This is a meaningful account A workflow preference message.',
        },
      }),
    );
    await vi.waitFor(() =>
      expect(useJarvisLearningStore.getState().currentProfile().meaningfulMessageCount).toBe(1),
    );
    accountId = 'account-b';
    accountChanged();

    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]?.[0]).toBe('account-a');
    expect(save.mock.calls[0]?.[1]).toContain('No saved learning yet.');
    await vi.waitFor(() =>
      expect(useJarvisLearningStore.getState().activeAccountId).toBe('account-b'),
    );
    expect(useJarvisLearningStore.getState().currentProfile().meaningfulMessageCount).toBe(0);
  });

  it('flushes the latest debounced account write before stop resolves', async () => {
    const save = vi.fn(async (_accountId: string, _markdown: string) => undefined);
    const load = vi.fn(async () => null);
    stop = startJarvisLearningListener({
      getAccountId: () => 'account-a',
      save,
      load,
      debounceMs: 60_000,
    });
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith('account-a'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    useJarvisLearningStore.getState().remember({
      value: 'Keep account A review notes concise',
      category: 'response-style',
      source: { kind: 'explicit' },
    });
    expect(save).not.toHaveBeenCalled();

    const stopping = stop();
    stop = undefined;
    await stopping;

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(
      'account-a',
      expect.stringContaining('Keep account A review notes concise'),
    );
  });

  it('serializes a latest stop flush behind an older in-flight write', async () => {
    const completions = [deferred(), deferred()];
    let nextCompletion = 0;
    let durableMarkdown = '';
    const save = vi.fn((_accountId: string, markdown: string) => {
      const completion = completions[nextCompletion++];
      if (!completion) throw new Error('Unexpected learning save.');
      return completion.promise.then(() => {
        durableMarkdown = markdown;
      });
    });
    stop = startJarvisLearningListener({
      getAccountId: () => 'account-a',
      save,
      load: async () => null,
      debounceMs: 60_000,
    });

    window.dispatchEvent(
      new CustomEvent('jarvis:send', {
        detail: { chatId: 'chat-1', text: 'Remember that the older preference comes first.' },
      }),
    );
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    useJarvisLearningStore.getState().remember({
      value: 'The latest preference must remain durable',
      category: 'response-style',
      source: { kind: 'explicit' },
    });

    const stopping = stop();
    stop = undefined;
    await new Promise((resolve) => setTimeout(resolve, 0));
    completions[1]!.resolve();
    await Promise.resolve();
    completions[0]!.resolve();
    await stopping;

    expect(save).toHaveBeenCalledTimes(2);
    expect(durableMarkdown).toContain('The latest preference must remain durable');
  });

  it('quarantines learning state synchronously when the account becomes blank', async () => {
    let accountId = 'account-a';
    let accountChanged: () => void = () => undefined;
    const completion = deferred();
    const save = vi.fn(() => completion.promise);
    stop = startJarvisLearningListener({
      getAccountId: () => accountId,
      subscribeAccount: (listener) => {
        accountChanged = listener;
        return () => undefined;
      },
      save,
      load: async () => null,
      debounceMs: 60_000,
    });
    await vi.waitFor(() =>
      expect(useJarvisLearningStore.getState().activeAccountId).toBe('account-a'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    useJarvisLearningStore.getState().remember({
      value: 'Private learning pending a slow flush',
      category: 'personal',
      source: { kind: 'explicit' },
    });

    let sameTurnState:
      | {
          activeAccountId: string;
          profileIds: string[];
          historyIds: string[];
        }
      | undefined;
    accountId = '';
    accountChanged();
    const state = useJarvisLearningStore.getState();
    sameTurnState = {
      activeAccountId: state.activeAccountId,
      profileIds: Object.keys(state.profiles),
      historyIds: Object.keys(state.history),
    };

    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    completion.resolve();
    await vi.waitFor(() => expect(useJarvisLearningStore.getState().activeAccountId).toBe(''));
    await stop();
    stop = undefined;

    expect(sameTurnState).toEqual({
      activeAccountId: '',
      profileIds: [],
      historyIds: [],
    });
    expect(useJarvisLearningStore.getState().profiles).toEqual({});
  });

  it('rejects a blank persistence scope instead of fabricating local-unassigned', () => {
    const load = vi.fn(async () => null);
    const save = vi.fn(async () => undefined);

    expect(() =>
      startJarvisLearningListener({
        getAccountId: () => '   ',
        load,
        save,
      }),
    ).toThrow(/account id/i);
    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});
