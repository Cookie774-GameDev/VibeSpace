import { loadLearningFile, saveLearningFile, type LearningFileResult } from './learningFile';
import {
  parseJarvisLearningMarkdown,
  renderMarkdown,
  useJarvisLearningStore,
} from './learningStore';
import type {
  JarvisLearningProfile,
  JarvisMemoryCategory,
  JarvisMemoryItem,
  MemoryEvidenceItem,
} from './types';
import { safeLocalStorage } from '@/lib/persistence/safeLocalStorage';
import { clearJarvisMemoryStatus, publishJarvisMemoryStatus } from './memoryStatusRuntime';
import { reconcileDurableEvidence } from './evidencePersistenceRecovery';
import { reconcileDurableProfile } from './profilePersistenceRecovery';
import { createAccountHydrationAuthority } from './accountHydrationAuthority';
import { createMemoryEvidenceWriteAuthority } from './memoryEvidenceWriteAuthority';

interface PendingLearningControls {
  enabled?: boolean;
  removedIds: ReadonlySet<string>;
  retainedEpoch?: string;
  retainedProfile?: JarvisLearningProfile;
  upsertedItems?: ReadonlyMap<string, JarvisMemoryItem>;
}

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
  const loadingAccounts = new Map<string, number>();
  const unavailableAccounts = new Set<string>();
  let accountScopeEpoch = 0;
  const evidenceWriteAuthority = createMemoryEvidenceWriteAuthority();
  const profileWriteAuthority = createMemoryEvidenceWriteAuthority();
  let suppressAutomaticProfilePersistence = 0;
  // Explicit consent and removal remain authoritative during content recovery.
  const pendingControls = new Map<string, PendingLearningControls>();
  const recoveringProfiles = new Map<string, number>();
  const attemptedRecoveryControls = new Map<string, PendingLearningControls>();
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

  const projectDurableProfile = (
    accountId: string,
    durableMarkdown: string,
    controls = pendingControls.get(accountId),
  ): string | null => {
    if (controls?.retainedProfile) return renderMarkdown(controls.retainedProfile);
    const durable = parseJarvisLearningMarkdown(durableMarkdown, accountId);
    if (!durable) return null;
    const items = new Map(durable.items.map((item) => [item.id, item]));
    for (const [id, item] of controls?.upsertedItems ?? []) items.set(id, item);
    for (const id of controls?.removedIds ?? []) items.delete(id);
    return renderMarkdown({
      ...durable,
      ...(controls?.enabled !== undefined ? { enabled: controls.enabled } : {}),
      items: [...items.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    });
  };
  const applyDurableProfile = (accountId: string, durableMarkdown: string): boolean =>
    mutateAutomaticLearning(() => {
      const projected = projectDurableProfile(accountId, durableMarkdown);
      return projected !== null && store.getState().importMarkdown(projected);
    });

  const loadAccount = (accountId: string) => {
    const scopeEpoch = accountScopeEpoch;
    const isCurrent = () =>
      !disposed && accountScopeEpoch === scopeEpoch && bindings.getAccountId().trim() === accountId;
    clearJarvisMemoryStatus();
    loadingAccounts.set(accountId, scopeEpoch);
    store.getState().setAccount(accountId);
    const pending = Promise.all([
      load(accountId),
      evidenceRepository?.list(accountId) ?? Promise.resolve([]),
    ])
      .then(([loaded, evidence]) => {
        if (!isCurrent()) return;
        store.getState().setAccount(accountId);
        const markdown = typeof loaded === 'string' ? loaded : loaded?.markdown;
        const missing =
          loaded === null || (typeof loaded === 'object' && loaded.missing === true);
        if (!missing) {
          if (
            !markdown ||
            !parseJarvisLearningMarkdown(markdown, accountId) ||
            !applyDurableProfile(accountId, markdown)
          ) {
            throw new Error('memory_profile_hydration_rejected');
          }
        } else if (pendingControls.has(accountId)) {
          applyDurableProfile(accountId, store.getState().exportMarkdown());
        }
        if (evidenceRepository) store.getState().hydrateEvidence(accountId, evidence);
        unavailableAccounts.delete(accountId);
        if (pendingControls.has(accountId)) {
          // Hydration is complete; keep later UI control changes observable during the retry.
          void writeProfile(accountId, store.getState().exportMarkdown(), undefined, true);
        }
        if (!isCurrent()) return;
        if (typeof loaded === 'object' && loaded?.recovered) {
          publishStatus(undefined, 'recovered');
        }
      })
      .catch((error) => {
        if (isCurrent()) {
          unavailableAccounts.add(accountId);
          // Rejected storage is neither a new account nor permission to restart learning.
          mutateAutomaticLearning(() => store.getState().setEnabled(false));
          publishStatus(undefined, 'error');
          report(bindings, error);
        }
        throw error;
      })
      .finally(() => {
        if (loadingAccounts.get(accountId) === scopeEpoch) loadingAccounts.delete(accountId);
      });
    return pending;
  };

  const hydrationAuthority = createAccountHydrationAuthority(loadAccount);
  const accountId = requireAccountId(bindings.getAccountId());
  let activeAccountId = accountId;
  void hydrationAuthority.ready(accountId);

  const writeProfile = (
    active: string,
    markdown: string,
    chatId?: string,
    announceCompletion = false,
    writeToken = profileWriteAuthority.token(active),
  ): Promise<void> => {
    const scopeEpoch = accountScopeEpoch;
    const isCurrent = () =>
      !disposed &&
      accountScopeEpoch === scopeEpoch &&
      bindings.getAccountId().trim() === active &&
      store.getState().activeAccountId === active;
    const pending = writeQueue
      .then(async () => {
        if (unavailableAccounts.has(active) || !profileWriteAuthority.canWrite(writeToken)) return;
        const controls = pendingControls.get(active);
        await save(active, markdown);
        const saved = controls ? parseJarvisLearningMarkdown(markdown, active) : null;
        if (
          controls &&
          saved &&
          pendingControls.get(active) === controls &&
          (controls.enabled === undefined || saved.enabled === controls.enabled) &&
          !saved.items.some((item) => controls.removedIds.has(item.id)) &&
          (!controls.retainedEpoch || saved.caoLearningEpoch === controls.retainedEpoch) &&
          [...(controls.upsertedItems ?? [])].every(
            ([id, item]) =>
              JSON.stringify(saved.items.find((savedItem) => savedItem.id === id)) ===
              JSON.stringify(item),
          )
        ) {
          pendingControls.delete(active);
        }
        if (announceCompletion && isCurrent()) publishStatus(chatId, 'updated');
      })
      .catch(async (error) => {
        if (!isCurrent()) return;
        let attemptedControls: PendingLearningControls | undefined;
        recoveringProfiles.set(active, scopeEpoch);
        profileWriteAuthority.beginRecovery(active);
        publishStatus(chatId, 'error');
        report(bindings, error);
        try {
          const recovery = await reconcileDurableProfile({
            load: () => load(active),
            isCurrent,
            apply: (durableMarkdown) => applyDurableProfile(active, durableMarkdown),
          });
          if (recovery === 'reconciled' && isCurrent()) {
            attemptedControls = pendingControls.get(active);
            if (attemptedControls) {
              // One bounded retry saves recovered content with the latest explicit controls.
              // Failure remains unavailable, without looping or reviving removed authority.
              attemptedRecoveryControls.set(active, attemptedControls);
              await save(active, store.getState().exportMarkdown());
              if (pendingControls.get(active) === attemptedControls) pendingControls.delete(active);
            }
            if (isCurrent() && !pendingControls.has(active)) publishStatus(chatId, 'recovered');
          }
        } catch (recoveryError) {
          if (isCurrent()) {
            publishStatus(chatId, 'error');
            report(bindings, recoveryError);
          }
        } finally {
          attemptedRecoveryControls.delete(active);
          recoveringProfiles.delete(active);
          profileWriteAuthority.endRecovery(active);
          const newerControls = pendingControls.get(active);
          if (
            isCurrent() &&
            newerControls &&
            attemptedControls &&
            newerControls !== attemptedControls
          ) {
            persistProfileNow(active, store.getState().exportMarkdown(), chatId);
          }
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
      (!loadingAccounts.has(active) || unavailableAccounts.has(active)) &&
      state.profiles[active] !== previous.profiles[active]
    ) {
      const current = state.profiles[active];
      const prior = previous.profiles[active];
      if (current && prior) {
        const pending = pendingControls.get(active);
        const currentIds = new Set(current.items.map((item) => item.id));
        const removed = prior.items.filter((item) => !currentIds.has(item.id));
        const restored = pending && [...pending.removedIds].some((id) => currentIds.has(id));
        const epochChanged = current.caoLearningEpoch !== prior.caoLearningEpoch;
        const retainManualItems =
          (unavailableAccounts.has(active) ||
            recoveringProfiles.get(active) === accountScopeEpoch ||
            pending?.upsertedItems) &&
          bindings.getAccountId().trim() === active;
        const priorItems = new Map(prior.items.map((item) => [item.id, item]));
        const changedItems = retainManualItems
          ? current.items.filter((item) => priorItems.get(item.id) !== item)
          : [];
        if (
          current.enabled !== prior.enabled ||
          removed.length ||
          restored ||
          epochChanged ||
          pending?.retainedProfile ||
          changedItems.length
        ) {
          pendingControls.set(active, {
            enabled: current.enabled !== prior.enabled ? current.enabled : pending?.enabled,
            removedIds: new Set([
              ...[...(pending?.removedIds ?? [])].filter((id) => !currentIds.has(id)),
              ...removed.map((item) => item.id),
            ]),
            // Clear and explicit Undo establish a newer profile generation to retain.
            retainedEpoch:
              epochChanged || restored ? current.caoLearningEpoch : pending?.retainedEpoch,
            retainedProfile:
              epochChanged || restored || pending?.retainedProfile ? current : undefined,
            upsertedItems: new Map([
              ...[...(pending?.upsertedItems ?? [])].filter(([id]) => currentIds.has(id)),
              ...changedItems.map((item) => [item.id, item] as const),
            ]),
          });
        }
      }
      // A retry may admit old durable bytes later; retain current intent while writes stay fenced.
      if (!loadingAccounts.has(active) && !unavailableAccounts.has(active))
        persistProfile(active, store.getState().exportMarkdown());
    }
    if (
      suppressAutomaticProfilePersistence === 0 &&
      active &&
      !unavailableAccounts.has(active) &&
      !loadingAccounts.has(active) &&
      state.evidence[active] !== previous.evidence[active]
    ) {
      persistEvidence(active, previous.evidence[active] ?? [], state.evidence[active] ?? []);
    }
  });

  const unsubscribeAccount = bindings.subscribeAccount?.(() => {
    const next = bindings.getAccountId().trim();
    const previous = activeAccountId;
    if (next === previous) return;
    activeAccountId = next;
    accountScopeEpoch += 1;
    if (disposed) return;
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
      if (result.explicitMemoryId && recoveringProfiles.get(currentAccount) === accountScopeEpoch) {
        // A direct Remember command is user intent, although its store mutation bypasses autosave.
        const currentProfile = store.getState().currentProfile();
        const item = currentProfile.items.find((item) => item.id === result.explicitMemoryId);
        if (item) {
          const pending = pendingControls.get(currentAccount);
          pendingControls.set(currentAccount, {
            ...pending,
            removedIds: pending?.removedIds ?? new Set(),
            retainedProfile: pending?.retainedProfile ? currentProfile : undefined,
            upsertedItems: new Map([
              ...[...(pending?.upsertedItems ?? [])].filter(([id]) =>
                currentProfile.items.some((item) => item.id === id),
              ),
              [item.id, item],
            ]),
          });
        }
      }
      if (result.explicitMemoryId && !result.evaluateNow) {
        publishStatus(chatId, 'updating');
        persistProfileNow(currentAccount, store.getState().exportMarkdown(), chatId);
      }
      if (!result.qualifies) return;
      if (!result.evaluateNow && !result.explicitMemoryId) {
        persistProfile(currentAccount, store.getState().exportMarkdown());
      }

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
    caoQueue = caoQueue
      .then(async () => {
        if (disposed || !accountId || bindings.getAccountId().trim() !== accountId) return;
        if (!(await hydrationAuthority.ready(accountId))) return;
        if (disposed || !store.getState().currentProfile().enabled) return;
        await bindings.reviewCaoLearning!(accountId, chatId, learningController.signal);
      })
      .catch((error) => report(bindings, error));
  };
  window.addEventListener('jarvis:run-state', onRunState);
  window.addEventListener(eventName, onSend);
  window.addEventListener('jarvis:user-command', onSend);
  let stopping: Promise<void> | undefined;
  return () => {
    if (stopping) return stopping;
    const drainingAccount = activeAccountId;
    const drainingEpoch = accountScopeEpoch;
    const controls = pendingControls.get(drainingAccount);
    const needsDrain =
      controls &&
      recoveringProfiles.has(drainingAccount) &&
      attemptedRecoveryControls.get(drainingAccount) !== controls;
    const canDrain = () =>
      accountScopeEpoch === drainingEpoch && bindings.getAccountId().trim() === drainingAccount;
    disposed = true;
    learningController.abort();
    window.removeEventListener('jarvis:run-state', onRunState);
    unsubscribe();
    window.removeEventListener(eventName, onSend);
    window.removeEventListener('jarvis:user-command', onSend);
    flushScheduled();
    stopping = (async () => {
      try {
        await writeQueue;
        if (!needsDrain || !canDrain() || pendingControls.get(drainingAccount) !== controls) return;
        // Recovery invalidates its queued epochs. Graceful shutdown still drains the
        // already-authorized intent, without restoring the quarantined visible store.
        let projected: string | null = null;
        const recovery = await reconcileDurableProfile({
          load: () => load(drainingAccount),
          isCurrent: canDrain,
          apply: (markdown) => {
            projected = projectDurableProfile(drainingAccount, markdown, controls);
            return projected !== null;
          },
        });
        if (recovery !== 'reconciled' || !canDrain() || projected === null) return;
        await save(drainingAccount, projected);
        if (pendingControls.get(drainingAccount) === controls)
          pendingControls.delete(drainingAccount);
      } catch (error) {
        report(bindings, error);
      } finally {
        // Keep only transition observation alive until the captured flush has settled.
        unsubscribeAccount?.();
      }
    })();
    return stopping;
  };
}

export function emojisEnabledFromLearning(): boolean {
  const items = useJarvisLearningStore.getState().currentProfile().items;
  const preference = items.find((item) => /\bemoji(?:s)?\b/i.test(item.value));
  if (!preference) return true;
  return !/\b(?:no|without|never|avoid|don't|do not|off)\b/i.test(preference.value);
}
