import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emojisEnabledFromLearning, startJarvisLearningListener } from './learningListener';
import { useJarvisLearningStore } from './learningStore';
import type { MemoryEvidenceItem } from './types';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve: () => resolve?.(),
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

  it('keeps automatic learning memory-only through nineteen messages and writes on message twenty', async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(save).not.toHaveBeenCalled();

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
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
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

  it('does not create learning.md when the account changes before twenty messages', async () => {
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

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(save).not.toHaveBeenCalled();
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
