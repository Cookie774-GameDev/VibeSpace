import { loadLearningFile, saveLearningFile } from './learningFile';
import { useJarvisLearningStore } from './learningStore';
import type { JarvisMemoryCategory, MemoryEvidenceItem } from './types';
import { safeLocalStorage } from '@/lib/persistence/safeLocalStorage';

interface LearningSendDetail {
  chatId?: string;
  text?: string;
  messageId?: string;
}

export interface MemoryEvidencePersistencePort {
  list(ownerId: string): Promise<readonly MemoryEvidenceItem[]>;
  create(ownerId: string, item: MemoryEvidenceItem): Promise<unknown>;
  replace(ownerId: string, item: MemoryEvidenceItem): Promise<unknown>;
  delete(ownerId: string, id: string): Promise<unknown>;
}

interface LearningListenerBindings {
  getAccountId: () => string;
  subscribeAccount?: (listener: () => void) => () => void;
  save?: (accountId: string, markdown: string) => Promise<unknown>;
  load?: (accountId: string) => Promise<string | null>;
  evidenceRepository?: MemoryEvidencePersistencePort;
  debounceMs?: number;
  onError?: (error: unknown) => void;
}

function inferredCandidate(text: string): { value: string; category: JarvisMemoryCategory } | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const match =
    /\bI\s+(?:really\s+)?(?:prefer|like|want)\s+(.+)/i.exec(normalized) ??
    /\bplease\s+(always|never)\s+(.+)/i.exec(normalized);
  if (!match) return null;
  const value = match[2] ? `Please ${match[1]!.toLowerCase()} ${match[2]}` : match[1]!;
  const clean = value.trim().slice(0, 500);
  const category: JarvisMemoryCategory =
    /\b(?:response|reply|concise|verbose|emoji|tone|format|status update)\b/i.test(clean)
      ? 'response-style'
      : /\b(?:never|avoid|do not|don't)\b/i.test(clean)
        ? 'avoid'
        : /\b(?:tool|plugin|mcp|terminal|cli)\b/i.test(clean)
          ? 'tool'
          : /\b(?:project|repo|workspace|codebase)\b/i.test(clean)
            ? 'project'
            : 'workflow';
  return { value: clean, category };
}

function defaultAccountLoad(accountId: string): Promise<string | null> {
  return loadLearningFile(accountId)
    .then((result) => result.markdown)
    .catch(() => null);
}

function report(bindings: LearningListenerBindings, error: unknown): void {
  if (bindings.onError) bindings.onError(error);
  else console.warn('[jarvis-memory] persistence unavailable', error);
}

function requireAccountId(value: string): string {
  const accountId = value.trim();
  if (!accountId) throw new Error('Account id is required for learning persistence.');
  return accountId;
}

function publishStatus(chatId: string | undefined, state: 'updating' | 'updated' | 'error'): void {
  window.dispatchEvent(new CustomEvent('jarvis:memory-status', { detail: { chatId, state } }));
}

export function startJarvisLearningListener(
  bindings: LearningListenerBindings,
  eventName = 'jarvis:send',
): () => Promise<void> {
  safeLocalStorage.removeItem('jarvis-learning-memory-v1');
  const store = useJarvisLearningStore;
  const recentByAccount = new Map<string, Array<{ text: string; chatId?: string }>>();
  const save = bindings.save ?? ((accountId, markdown) => saveLearningFile(accountId, markdown));
  const load = bindings.load ?? defaultAccountLoad;
  const evidenceRepository = bindings.evidenceRepository;
  const debounceMs = bindings.debounceMs ?? 300;
  const accountLoads = new Map<string, Promise<void>>();
  const loadingAccounts = new Set<string>();
  let suppressAutomaticProfilePersistence = 0;
  const timers = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      markdown: string;
    }
  >();
  let writeQueue: Promise<void> = Promise.resolve();
  let disposed = false;

  const mutateAutomaticLearning = <T>(mutation: () => T): T => {
    suppressAutomaticProfilePersistence += 1;
    try {
      return mutation();
    } finally {
      suppressAutomaticProfilePersistence -= 1;
    }
  };

  const loadAccount = (accountId: string) => {
    loadingAccounts.add(accountId);
    store.getState().setAccount(accountId);
    const pending = Promise.all([
      load(accountId),
      evidenceRepository?.list(accountId) ?? Promise.resolve([]),
    ])
      .then(([markdown, evidence]) => {
        if (disposed || bindings.getAccountId().trim() !== accountId) return;
        store.getState().setAccount(accountId);
        if (markdown) store.getState().importMarkdown(markdown);
        if (evidenceRepository) store.getState().hydrateEvidence(accountId, evidence);
      })
      .catch((error) => report(bindings, error))
      .finally(() => {
        loadingAccounts.delete(accountId);
      });
    accountLoads.set(accountId, pending);
    return pending;
  };

  const accountId = requireAccountId(bindings.getAccountId());
  loadAccount(accountId);

  const writeProfile = (
    active: string,
    markdown: string,
    chatId?: string,
    announceCompletion = false,
  ): Promise<void> => {
    const pending = writeQueue
      .then(() => save(active, markdown))
      .then(() => {
        if (announceCompletion) publishStatus(chatId, 'updated');
      })
      .catch((error) => {
        publishStatus(chatId, 'error');
        report(bindings, error);
      });
    writeQueue = pending;
    return pending;
  };

  const flushScheduled = (active?: string): Promise<void> => {
    for (const [accountId, pending] of timers) {
      if (active && accountId !== active) continue;
      clearTimeout(pending.timer);
      timers.delete(accountId);
      writeProfile(accountId, pending.markdown);
    }
    return writeQueue;
  };

  const persistProfile = (active: string, markdown: string) => {
    const existing = timers.get(active);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      timers.delete(active);
      void writeProfile(active, markdown);
    }, debounceMs);
    timers.set(active, { timer, markdown });
  };

  const persistProfileNow = (active: string, markdown: string, chatId?: string) => {
    const existing = timers.get(active);
    if (existing) {
      clearTimeout(existing.timer);
      timers.delete(active);
    }
    void writeProfile(active, markdown, chatId, true);
  };

  const persistEvidence = (
    active: string,
    previous: readonly MemoryEvidenceItem[],
    current: readonly MemoryEvidenceItem[],
  ) => {
    if (!evidenceRepository) return;
    const previousById = new Map(previous.map((item) => [item.id, item]));
    const currentById = new Map(current.map((item) => [item.id, item]));
    const pending = writeQueue
      .then(async () => {
        for (const item of current) {
          const prior = previousById.get(item.id);
          if (!prior) await evidenceRepository.create(active, item);
          else if (JSON.stringify(prior) !== JSON.stringify(item)) {
            await evidenceRepository.replace(active, item);
          }
        }
        for (const item of previous) {
          if (!currentById.has(item.id)) await evidenceRepository.delete(active, item.id);
        }
      })
      .catch((error) => report(bindings, error));
    writeQueue = pending;
  };

  const unsubscribe = store.subscribe((state, previous) => {
    const active = state.activeAccountId;
    if (
      suppressAutomaticProfilePersistence === 0 &&
      !loadingAccounts.has(active) &&
      state.profiles[active] !== previous.profiles[active]
    ) {
      persistProfile(active, store.getState().exportMarkdown());
    }
    if (
      active &&
      !loadingAccounts.has(active) &&
      state.evidence[active] !== previous.evidence[active]
    ) {
      persistEvidence(active, previous.evidence[active] ?? [], state.evidence[active] ?? []);
    }
  });

  const unsubscribeAccount = bindings.subscribeAccount?.(() => {
    const next = bindings.getAccountId().trim();
    const previous = store.getState().activeAccountId;
    if (next === previous) return;
    if (!next) {
      const pendingFlush = flushScheduled(previous);
      store.getState().clearAccountScope();
      void pendingFlush;
      return;
    }
    void flushScheduled(previous).then(() => {
      if (!disposed && bindings.getAccountId().trim() === next) loadAccount(next);
    });
  });

  const onSend = (event: Event) => {
    const detail = (event as CustomEvent<LearningSendDetail>).detail;
    if (typeof detail?.text !== 'string') return;
    const messageText = detail.text;
    const chatId = detail.chatId;
    const messageId = detail.messageId;
    const currentAccount = bindings.getAccountId().trim();
    if (!currentAccount) return;
    const pendingLoad = accountLoads.get(currentAccount) ?? loadAccount(currentAccount);
    void (async () => {
      await pendingLoad;
      if (disposed || bindings.getAccountId().trim() !== currentAccount) return;
      store.getState().setAccount(currentAccount);
      const result = mutateAutomaticLearning(() =>
        store.getState().recordUserMessage({
          text: messageText,
          chatId,
          messageId,
        }),
      );
      if (result.explicitMemoryId && !result.evaluateNow) {
        publishStatus(chatId, 'updating');
        persistProfileNow(currentAccount, store.getState().exportMarkdown(), chatId);
      }
      if (!result.qualifies) return;

      const recent = [
        ...(recentByAccount.get(currentAccount) ?? []),
        {
          text: messageText,
          chatId,
        },
      ].slice(-20);
      recentByAccount.set(currentAccount, recent);
      if (!result.evaluateNow) return;

      publishStatus(chatId, 'updating');
      mutateAutomaticLearning(() => {
        const seen = new Set<string>();
        for (const message of recent) {
          const candidate = inferredCandidate(message.text);
          if (!candidate) continue;
          const key = `${candidate.category}:${candidate.value.toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          store.getState().remember({
            ...candidate,
            confidence: 0.7,
            source: { kind: 'inferred', chatId: message.chatId },
          });
        }
        store.getState().markEvaluated();
      });
      recentByAccount.set(currentAccount, []);
      persistProfileNow(currentAccount, store.getState().exportMarkdown(), chatId);
    })().catch((error) => report(bindings, error));
  };

  window.addEventListener(eventName, onSend);
  return async () => {
    disposed = true;
    unsubscribe();
    unsubscribeAccount?.();
    window.removeEventListener(eventName, onSend);
    flushScheduled();
    await writeQueue;
  };
}

export function emojisEnabledFromLearning(): boolean {
  const items = useJarvisLearningStore.getState().currentProfile().items;
  const preference = items.find((item) => /\bemoji(?:s)?\b/i.test(item.value));
  if (!preference) return true;
  return !/\b(?:no|without|never|avoid|don't|do not|off)\b/i.test(preference.value);
}
