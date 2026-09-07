import { loadLearningFile, saveLearningFile, type LearningFileResult } from './learningFile';
import { useJarvisLearningStore } from './learningStore';
import type { JarvisMemoryCategory, MemoryEvidenceItem } from './types';
import { safeLocalStorage } from '@/lib/persistence/safeLocalStorage';
import { clearJarvisMemoryStatus, publishJarvisMemoryStatus } from './memoryStatusRuntime';
import { reconcileDurableEvidence } from './evidencePersistenceRecovery';
import { reconcileDurableProfile } from './profilePersistenceRecovery';
import { createAccountHydrationAuthority } from './accountHydrationAuthority';
import { createMemoryEvidenceWriteAuthority } from './memoryEvidenceWriteAuthority';

interface LearningSendDetail {
  origin?: string;
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
  load?: (accountId: string) => Promise<string | LearningFileResult | null>;
  evidenceRepository?: MemoryEvidencePersistencePort;
  debounceMs?: number;
  onError?: (error: unknown) => void;
  reviewCaoLearning?: (accountId: string, chatId: string, signal: AbortSignal) => Promise<void>;
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

function defaultAccountLoad(accountId: string): Promise<LearningFileResult | null> {
  return loadLearningFile(accountId);
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

function publishStatus(
  chatId: string | undefined,
  state: 'updating' | 'updated' | 'recovered' | 'error',
): void {
  publishJarvisMemoryStatus({ chatId, state });
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
  const loadingAccounts = new Set<string>();
  const evidenceWriteAuthority = createMemoryEvidenceWriteAuthority();
  const profileWriteAuthority = createMemoryEvidenceWriteAuthority();
  let suppressAutomaticProfilePersistence = 0;
  const timers = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      markdown: string;
      writeToken: ReturnType<typeof profileWriteAuthority.token>;
    }
  >();
  let writeQueue: Promise<void> = Promise.resolve();
  let disposed = false;
  const learningController = new AbortController();
  let caoQueue: Promise<void> = Promise.resolve();

  const mutateAutomaticLearning = <T>(mutation: () => T): T => {
    suppressAutomaticProfilePersistence += 1;
    try {
      return mutation();
    } finally {
      suppressAutomaticProfilePersistence -= 1;
    }
  };

  const loadAccount = (accountId: string) => {
    clearJarvisMemoryStatus();
    loadingAccounts.add(accountId);
    store.getState().setAccount(accountId);
    const pending = Promise.all([
      load(accountId),
      evidenceRepository?.list(accountId) ?? Promise.resolve([]),
    ])
      .then(([loaded, evidence]) => {
        if (disposed || bindings.getAccountId().trim() !== accountId) return;
        store.getState().setAccount(accountId);
        const markdown = typeof loaded === 'string' ? loaded : loaded?.markdown;
        if (markdown) store.getState().importMarkdown(markdown);
        if (evidenceRepository) store.getState().hydrateEvidence(accountId, evidence);
        if (typeof loaded === 'object' && loaded?.recovered) {
          publishStatus(undefined, 'recovered');
        }
      })
      .catch((error) => {
        publishStatus(undefined, 'error');
        report(bindings, error);
        throw error;
      })
      .finally(() => {
        loadingAccounts.delete(accountId);
      });
    return pending;
  };

  const hydrationAuthority = createAccountHydrationAuthority(loadAccount);
  const accountId = requireAccountId(bindings.getAccountId());
  void hydrationAuthority.ready(accountId);

  const writeProfile = (
    active: string,
    markdown: string,
    chatId?: string,
    announceCompletion = false,
    writeToken = profileWriteAuthority.token(active),
  ): Promise<void> => {
    const pending = writeQueue
      .then(async () => {
        if (!profileWriteAuthority.canWrite(writeToken)) return;
        await save(active, markdown);
        if (announceCompletion) publishStatus(chatId, 'updated');
      })
      .catch(async (error) => {
        profileWriteAuthority.beginRecovery(active);
        publishStatus(chatId, 'error');
        report(bindings, error);
        try {
          const recovery = await reconcileDurableProfile({
            load: () => load(active),
            isCurrent: () => !disposed && bindings.getAccountId().trim() === active,
            apply: (durableMarkdown) =>
              mutateAutomaticLearning(() => store.getState().importMarkdown(durableMarkdown)),
          });
          if (recovery === 'reconciled') publishStatus(chatId, 'recovered');
        } catch (recoveryError) {
          publishStatus(chatId, 'error');
          report(bindings, recoveryError);
        } finally {
          profileWriteAuthority.endRecovery(active);
        }
      });
    writeQueue = pending;
    return pending;
  };

  const flushScheduled = (active?: string): Promise<void> => {
    for (const [accountId, pending] of timers) {
      if (active && accountId !== active) continue;
      clearTimeout(pending.timer);
      timers.delete(accountId);
      writeProfile(accountId, pending.markdown, undefined, false, pending.writeToken);
    }
    return writeQueue;
  };

  const persistProfile = (active: string, markdown: string) => {
    const existing = timers.get(active);
    if (existing) clearTimeout(existing.timer);
    const writeToken = profileWriteAuthority.token(active);
    const timer = setTimeout(() => {
      timers.delete(active);
      void writeProfile(active, markdown, undefined, false, writeToken);
    }, debounceMs);
    timers.set(active, { timer, markdown, writeToken });
  };

  const persistProfileNow = (active: string, markdown: string, chatId?: string) => {
    const existing = timers.get(active);
    if (existing) {
      clearTimeout(existing.timer);
      timers.delete(active);
    }
    void writeProfile(active, markdown, chatId, true, profileWriteAuthority.token(active));
  };

  const persistEvidence = (
    active: string,
    previous: readonly MemoryEvidenceItem[],
    current: readonly MemoryEvidenceItem[],
  ) => {
    if (!evidenceRepository) return;
    const previousById = new Map(previous.map((item) => [item.id, item]));
    const currentById = new Map(current.map((item) => [item.id, item]));
    const writeToken = evidenceWriteAuthority.token(active);
    const pending = writeQueue
      .then(async () => {
        if (!evidenceWriteAuthority.canWrite(writeToken)) return;
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
      .catch(async (error) => {
        evidenceWriteAuthority.beginRecovery(active);
        publishStatus(undefined, 'error');
        report(bindings, error);
        try {
          const recovery = await reconcileDurableEvidence({
            ownerId: active,
            list: (ownerId) => evidenceRepository.list(ownerId),
            isCurrent: () => !disposed && bindings.getAccountId().trim() === active,
            apply: (items) =>
              mutateAutomaticLearning(() => store.getState().hydrateEvidence(active, items)),
          });
          if (recovery === 'reconciled') publishStatus(undefined, 'recovered');
        } catch (recoveryError) {
          publishStatus(undefined, 'error');
          report(bindings, recoveryError);
        } finally {
          evidenceWriteAuthority.endRecovery(active);
        }
      });
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
      suppressAutomaticProfilePersistence === 0 &&
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
    evidenceWriteAuthority.invalidate(previous);
    hydrationAuthority.invalidate();
    const pendingFlush = flushScheduled(previous).finally(() => {
      profileWriteAuthority.invalidate(previous);
    });
    if (!next) {
      clearJarvisMemoryStatus();
      store.getState().clearAccountScope();
      void pendingFlush;
      return;
    }
    void pendingFlush.then(() => {
      if (!disposed && bindings.getAccountId().trim() === next) {
        void hydrationAuthority.ready(next);
      }
    });
  });

  const onSend = (event: Event) => {
    const detail = (event as CustomEvent<LearningSendDetail>).detail;
    if (detail?.origin === 'cao') return;
    if (typeof detail?.text !== 'string') return;
    const messageText = detail.text;
    const chatId = detail.chatId;
    const messageId = detail.messageId;
    const currentAccount = bindings.getAccountId().trim();
    if (!currentAccount) return;
    void (async () => {
      if (!(await hydrationAuthority.ready(currentAccount))) return;
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

  const onRunState = (event: Event) => {
    const detail = (event as CustomEvent<{ status?: string; chatId?: string }>).detail;
    if (!bindings.reviewCaoLearning || detail?.status !== 'done' || !detail.chatId) return;
    const accountId = bindings.getAccountId().trim();
    const chatId = detail.chatId;
    caoQueue = caoQueue.then(async () => {
      if (disposed || !accountId || bindings.getAccountId().trim() !== accountId) return;
      if (!(await hydrationAuthority.ready(accountId))) return;
      if (disposed || !store.getState().currentProfile().enabled) return;
      await bindings.reviewCaoLearning!(accountId, chatId, learningController.signal);
    }).catch(error => report(bindings, error));
  };
  window.addEventListener('jarvis:run-state', onRunState);
  window.addEventListener(eventName, onSend);
  return async () => {
    disposed = true;
    learningController.abort();
    window.removeEventListener('jarvis:run-state', onRunState);
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
