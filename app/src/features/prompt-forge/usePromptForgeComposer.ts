import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContextChatAttachment } from '@/features/context/contextChatIntegration';
import type { SharedContextRetrievalResult } from '@/features/context/contextResponseIntegration';
import type { ContextAttachment } from '@/features/context/tree';
import { useChatActivityStore } from '@/features/chat/activity/activityStore';
import { db } from '@/lib/db';
import type { ChatImageAttachment } from '@/lib/ai/vision';
import { hasDetectedSecret } from '@/lib/security/secretDetector';
import {
  createPromptForgeJob,
  type PromptForgeAttachmentSnapshot,
  type PromptForgeJob,
  type PromptForgeModelSelection,
  type PromptForgePrivacyMode,
  type PromptForgeStatus,
} from './contracts';
import {
  createPromptForgeContextPreparer,
  type PromptForgeAdditionalSourceCollector,
  type PromptForgePublicResearchPort,
} from './contextPreparation';
import { createPromptForgeJobStore } from './jobStore';
import {
  PromptForgeModelSelectionError,
  resolvePromptForgeModelSelection,
  type PromptForgeCurrentChatSelection,
  type PromptForgeModelOption,
} from './modelSelection';
import { promptForgeExecutor, type PromptForgeExecutionResult } from './promptForgeExecutor';
import {
  createPromptForgeService,
  type PromptForgeActivity,
  type PromptForgeExecutorPort,
  type PromptForgeJobRepository,
} from './promptForgeService';
import type { PromptForgeSourceCandidate } from './sourcePack';
import { promptForgeImageDisabledReason } from './promptForgeImages';
import { githubPublicResearchPort } from './publicResearch';

const RUNNING_STATUSES = new Set<PromptForgeStatus>([
  'collecting_context',
  'searching_project',
  'searching_public_sources',
  'building_source_pack',
  'generating',
  'validating',
]);

const STATUS_MESSAGES: Readonly<Record<PromptForgeStatus, string>> = Object.freeze({
  idle: 'Ready to upgrade',
  collecting_context: 'Reading this draft',
  searching_project: 'Reviewing project context',
  searching_public_sources: 'Searching authorized sources',
  building_source_pack: 'Building the source pack',
  generating: 'Building the upgraded prompt',
  validating: 'Verifying protected details',
  ready: 'Ready for review',
  cancelled: 'Upgrade cancelled',
  failed: 'Upgrade failed',
});

type PromptForgeContextRetriever = (input: {
  projectId: string | null;
  chatId?: string;
  userText: string;
  attachments: readonly (ContextAttachment | ContextChatAttachment)[];
  now?: number;
}) => Promise<SharedContextRetrievalResult>;

type PromptForgeComposerScope = Readonly<{
  accountId: string;
  chatId: string;
  projectId: string | null;
}>;

type ActiveComposerRun = {
  readonly scopeKey: string;
  readonly accountId: string;
  readonly jobId: string;
};

type PromptForgeUndoState = Readonly<{ scopeKey: string; value: string }>;

function composerScopeKey(scope: PromptForgeComposerScope): string {
  return JSON.stringify([scope.accountId, scope.chatId, scope.projectId]);
}

function jobMatchesScope(job: PromptForgeJob | null, scope: PromptForgeComposerScope): boolean {
  return (
    job !== null &&
    job.accountId === scope.accountId &&
    job.chatId === scope.chatId &&
    job.projectId === scope.projectId
  );
}

function sameAttachmentSnapshots(
  left: readonly PromptForgeAttachmentSnapshot[],
  right: readonly PromptForgeAttachmentSnapshot[],
): boolean {
  return (
    left.length === right.length &&
    left.every((attachment, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        attachment.id === candidate.id &&
        attachment.kind === candidate.kind &&
        attachment.label === candidate.label &&
        attachment.reference === candidate.reference
      );
    })
  );
}

function recoveryContextConfirmationKey(
  job: PromptForgeJob,
  currentAttachments: readonly PromptForgeAttachmentSnapshot[],
): string {
  return JSON.stringify([
    job.id,
    job.revision,
    job.originalAttachments,
    job.selectedSourceIds,
    job.retrievedSources,
    currentAttachments,
  ]);
}

export interface UsePromptForgeComposerOptions {
  accountId: string;
  chatId: string;
  projectId: string | null;
  draft: string;
  setDraft: (value: string) => void;
  originalAttachments: readonly PromptForgeAttachmentSnapshot[];
  imageAttachments?: readonly ChatImageAttachment[];
  contextAttachments: readonly (ContextAttachment | ContextChatAttachment)[];
  additionalSources: readonly PromptForgeSourceCandidate[];
  collectAdditionalSources?: PromptForgeAdditionalSourceCollector;
  modelSelection: PromptForgeModelSelection;
  modelOptions: readonly PromptForgeModelOption[];
  currentChatSelection: PromptForgeCurrentChatSelection;
  offlineMode: boolean;
  defaultLocalModel: string;
  workingDirectory?: string;
  repository?: PromptForgeJobRepository;
  executor?: PromptForgeExecutorPort;
  retrieveContext?: PromptForgeContextRetriever;
  researchPublicSources?: PromptForgePublicResearchPort | null;
  now?: () => number;
  createJobId?: () => string;
  recordActivity?: (activity: PromptForgeActivity) => void;
}

function defaultJobId(): string {
  return `prompt-forge-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

function activityStatus(status: PromptForgeStatus): 'running' | 'done' | 'cancelled' | 'error' {
  if (status === 'ready') return 'done';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') return 'error';
  return 'running';
}

function recordPromptForgeActivity(activity: PromptForgeActivity): void {
  useChatActivityStore.getState().record({
    id: `prompt-forge:${activity.jobId}`,
    chatId: activity.chatId,
    kind: 'agent',
    status: activityStatus(activity.status),
    title: 'Prompt Forge',
    subtitle: STATUS_MESSAGES[activity.status],
    ts: activity.completedAt ?? activity.startedAt,
    startedAt: activity.startedAt,
    ...(activity.completedAt === undefined ? {} : { endedAt: activity.completedAt }),
    agentSlug: 'prompt-forge',
    detail: `${activity.modelLabel} · ${activity.sourcesUsed} of ${activity.sourcesConsidered} sources`,
  });
}

function errorMessage(job: PromptForgeJob): string | null {
  if (job.status !== 'failed') return null;
  if (job.errorCode === 'model_unavailable')
    return 'The selected Prompt Forge model is unavailable.';
  if (job.errorCode === 'offline_cloud_blocked') {
    return 'Choose an available local model while VibeSpace is offline.';
  }
  if (job.errorCode === 'privacy_violation') {
    return 'Local-only privacy blocked the selected cloud model.';
  }
  if (job.errorCode === 'interrupted') {
    return 'The previous upgrade was interrupted. Resume it or start again.';
  }
  if (job.errorCode === 'provider_failed') {
    return 'The selected model could not complete this upgrade.';
  }
  if (job.errorCode === 'sensitive_input') {
    return 'Remove or replace detected secrets before running Prompt Forge.';
  }
  if (job.errorCode === 'invalid_image') {
    return 'Remove the invalid image attachment and attach it again.';
  }
  if (job.errorCode === 'image_transport_unsupported') {
    return 'Choose a native vision-capable provider model for image attachments.';
  }
  if (job.errorCode === 'image_model_unsupported') {
    return 'Choose a vision-capable Prompt Forge model for image attachments.';
  }
  return 'Prompt Forge could not complete this upgrade. Your original draft is unchanged.';
}

function modelDisabledReason(
  selection: PromptForgeModelSelection,
  modelOptions: readonly PromptForgeModelOption[],
  currentChatSelection: PromptForgeCurrentChatSelection,
  offlineMode: boolean,
  defaultLocalModel: string,
  privacyMode: PromptForgePrivacyMode,
  imageAttachments: readonly ChatImageAttachment[],
): string | null {
  try {
    const model = resolvePromptForgeModelSelection(selection, {
      currentChatSelection,
      options: modelOptions,
      offlineMode,
      defaultLocalModel,
    });
    if (privacyMode === 'local_only' && !model.local) {
      return 'Choose a local model or allow a provider connection for this run.';
    }
    return promptForgeImageDisabledReason(imageAttachments, model);
  } catch (error) {
    if (!(error instanceof PromptForgeModelSelectionError)) {
      return 'Choose an available Prompt Forge model.';
    }
    if (error.code === 'current_chat_not_single') {
      return 'Choose a single chat model or select a separate Prompt Forge model.';
    }
    if (error.code === 'model_unavailable' && selection.mode === 'prefer_local') {
      return 'Connect or start an available local model.';
    }
    if (error.code === 'connection_ambiguous') {
      return 'Choose an exact provider connection for this Prompt Forge model.';
    }
    if (error.code === 'offline_cloud_blocked') {
      return 'Choose an available local model while VibeSpace is offline.';
    }
    return 'The selected Prompt Forge model is unavailable.';
  }
}

export function usePromptForgeComposer(options: UsePromptForgeComposerOptions) {
  const currentScope = useMemo<PromptForgeComposerScope>(
    () => ({
      accountId: options.accountId,
      chatId: options.chatId,
      projectId: options.projectId,
    }),
    [options.accountId, options.chatId, options.projectId],
  );
  const currentScopeKey = useMemo(() => composerScopeKey(currentScope), [currentScope]);
  const currentScopeKeyRef = useRef(currentScopeKey);
  currentScopeKeyRef.current = currentScopeKey;
  const previousScopeKeyRef = useRef(currentScopeKey);
  const [status, setStatus] = useState<PromptForgeStatus>('idle');
  const [job, setJob] = useState<PromptForgeJob | null>(null);
  const [activity, setActivity] = useState<PromptForgeActivity | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [upgradedDraft, setUpgradedDraft] = useState('');
  const [excludedSourceIds, setExcludedSourceIds] = useState<readonly string[]>([]);
  const [privacyMode, setPrivacyModeState] = useState<PromptForgePrivacyMode>('local_only');
  const [allowPublicResearch, setAllowPublicResearchState] = useState(false);
  const [undoValue, setUndoValue] = useState<PromptForgeUndoState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recoverableJob, setRecoverableJob] = useState<PromptForgeJob | null>(null);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryContextConfirmation, setRecoveryContextConfirmation] = useState<string | null>(
    null,
  );
  const serviceRef = useRef<ReturnType<typeof createPromptForgeService> | null>(null);
  const activeRunRef = useRef<ActiveComposerRun | null>(null);
  const draftRef = useRef(options.draft);
  draftRef.current = options.draft;
  const setDraftRef = useRef(options.setDraft);
  setDraftRef.current = options.setDraft;
  const clockRef = useRef(options.now ?? Date.now);
  clockRef.current = options.now ?? Date.now;
  const executorRef = useRef(options.executor ?? promptForgeExecutor);
  executorRef.current = options.executor ?? promptForgeExecutor;
  const [repository] = useState<PromptForgeJobRepository>(
    () => options.repository ?? createPromptForgeJobStore(db),
  );
  const executor = options.executor ?? promptForgeExecutor;
  const clock = options.now ?? Date.now;
  const createJobId = options.createJobId ?? defaultJobId;
  const recordActivity = options.recordActivity ?? recordPromptForgeActivity;
  const isRunning = RUNNING_STATUSES.has(status);
  const currentJobMatchesScope = jobMatchesScope(job, currentScope);
  const researchPublicSources =
    options.researchPublicSources === undefined
      ? githubPublicResearchPort
      : options.researchPublicSources;
  const publicResearchAvailable = researchPublicSources !== null;
  const effectiveAllowPublicResearch =
    publicResearchAvailable &&
    !options.offlineMode &&
    privacyMode === 'provider_allowed' &&
    allowPublicResearch;
  const currentModelDisabledReason = useMemo(
    () =>
      modelDisabledReason(
        options.modelSelection,
        options.modelOptions,
        options.currentChatSelection,
        options.offlineMode,
        options.defaultLocalModel,
        privacyMode,
        options.imageAttachments ?? [],
      ),
    [
      options.currentChatSelection,
      options.defaultLocalModel,
      options.modelOptions,
      options.modelSelection,
      options.offlineMode,
      options.imageAttachments,
      privacyMode,
    ],
  );
  const recoveryModelDisabledReason = useMemo(
    () =>
      recoverableJob === null
        ? null
        : modelDisabledReason(
            recoverableJob.modelSelection,
            options.modelOptions,
            options.currentChatSelection,
            options.offlineMode,
            options.defaultLocalModel,
            recoverableJob.privacyMode,
            options.imageAttachments ?? [],
          ),
    [
      options.currentChatSelection,
      options.defaultLocalModel,
      options.modelOptions,
      options.offlineMode,
      options.imageAttachments,
      recoverableJob,
    ],
  );
  const recoveryContextChanged =
    recoverableJob !== null &&
    (!sameAttachmentSnapshots(recoverableJob.originalAttachments, options.originalAttachments) ||
      recoverableJob.selectedSourceIds.length > 0 ||
      recoverableJob.retrievedSources.length > 0);
  const recoveryContextKey =
    recoverableJob === null
      ? null
      : recoveryContextConfirmationKey(recoverableJob, options.originalAttachments);
  const recoveryNeedsContextConfirmation =
    recoveryContextChanged && recoveryContextConfirmation !== recoveryContextKey;
  const recoveryDisabledReason =
    recoveryModelDisabledReason ??
    (recoveryNeedsContextConfirmation
      ? 'Reattach the saved items or confirm that this resume may use the current context.'
      : null);

  const disabledReason = useMemo(() => {
    if (!options.accountId) return 'Sign in to use Prompt Forge.';
    if (!options.draft.trim()) return 'Write or dictate a prompt first.';
    if (isRunning) return 'Prompt Forge is already upgrading this draft.';
    return currentModelDisabledReason;
  }, [currentModelDisabledReason, isRunning, options.accountId, options.draft]);

  const setPrivacyMode = useCallback((next: PromptForgePrivacyMode) => {
    setPrivacyModeState(next);
    if (next === 'local_only') setAllowPublicResearchState(false);
  }, []);

  const createRunService = useCallback(
    (activeRun: ActiveComposerRun, excludedForRun: readonly string[]) => {
      const prepare = createPromptForgeContextPreparer({
        contextAttachments: options.contextAttachments,
        modelOptions: options.modelOptions,
        currentChatSelection: options.currentChatSelection,
        offlineMode: options.offlineMode,
        defaultLocalModel: options.defaultLocalModel,
        additionalSources: options.additionalSources,
        ...(options.collectAdditionalSources === undefined
          ? {}
          : { collectAdditionalSources: options.collectAdditionalSources }),
        excludedSourceIds: excludedForRun,
        ...(options.retrieveContext === undefined
          ? {}
          : { retrieveContext: options.retrieveContext }),
        ...(researchPublicSources === null ? {} : { researchPublicSources }),
        now: clock,
      });
      return createPromptForgeService({
        repository,
        prepare,
        executor,
        now: clock,
        onActivity: (nextActivity) => {
          if (
            activeRunRef.current !== activeRun ||
            currentScopeKeyRef.current !== activeRun.scopeKey
          ) {
            return;
          }
          setStatus(nextActivity.status);
          setActivity(nextActivity);
          recordActivity(nextActivity);
        },
      });
    },
    [
      clock,
      executor,
      options.additionalSources,
      options.collectAdditionalSources,
      options.contextAttachments,
      options.currentChatSelection,
      options.defaultLocalModel,
      options.modelOptions,
      options.offlineMode,
      researchPublicSources,
      options.retrieveContext,
      recordActivity,
      repository,
    ],
  );

  useEffect(() => {
    const scopeChanged = previousScopeKeyRef.current !== currentScopeKey;
    previousScopeKeyRef.current = currentScopeKey;
    if (scopeChanged) {
      setStatus('idle');
      setJob(null);
      setActivity(null);
      setReviewOpen(false);
      setUpgradedDraft('');
      setExcludedSourceIds([]);
      setUndoValue(null);
      setError(null);
      setRecoverableJob(null);
      setRecoveryLoading(false);
      setRecoveryError(null);
      setRecoveryContextConfirmation(null);
    }

    return () => {
      const active = activeRunRef.current;
      if (!active || active.scopeKey !== currentScopeKey) return;
      activeRunRef.current = null;
      const service = serviceRef.current;
      serviceRef.current = null;
      if (service) void service.cancel(active.accountId, active.jobId);
    };
  }, [currentScopeKey]);

  useEffect(() => {
    if (!currentScope.accountId) return;

    let current = true;
    const scanScopeKey = currentScopeKey;
    const recoveryService = createPromptForgeService({
      repository,
      prepare: async () => {
        throw new Error('Prompt Forge recovery scanner cannot execute jobs.');
      },
      executor: executorRef.current,
      now: clockRef.current,
    });

    void recoveryService
      .recoverInterrupted(currentScope)
      .then((jobs) => {
        if (!current || currentScopeKeyRef.current !== scanScopeKey) return;
        const candidate =
          jobs
            .filter(
              (job) =>
                jobMatchesScope(job, currentScope) &&
                job.status === 'failed' &&
                job.errorCode === 'interrupted',
            )
            .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
        setRecoverableJob(candidate);
        setRecoveryContextConfirmation(null);
        if (candidate && !draftRef.current.trim()) {
          setDraftRef.current(candidate.originalDraft);
        }
      })
      .catch(() => {
        if (!current || currentScopeKeyRef.current !== scanScopeKey) return;
        setRecoverableJob(null);
        setRecoveryError('Prompt Forge could not check for an interrupted upgrade.');
      });

    return () => {
      current = false;
    };
  }, [currentScope, currentScopeKey, repository]);

  const start = useCallback(
    async (
      regenerationInstructions?: string,
      originalDraftOverride?: string,
      runOptions: Readonly<{ openReview?: boolean }> = {},
    ): Promise<PromptForgeJob | null> => {
      const originalDraft = originalDraftOverride ?? options.draft;
      const openReview = runOptions.openReview !== false;
      if (
        !options.accountId ||
        !originalDraft.trim() ||
        currentModelDisabledReason !== null ||
        RUNNING_STATUSES.has(status) ||
        activeRunRef.current !== null
      ) {
        return null;
      }
      if (
        hasDetectedSecret(originalDraft) ||
        (regenerationInstructions !== undefined && hasDetectedSecret(regenerationInstructions))
      ) {
        setError(
          'Remove or replace detected secrets before running Prompt Forge. No model received this draft.',
        );
        return null;
      }
      const activeRun: ActiveComposerRun = {
        scopeKey: currentScopeKey,
        accountId: options.accountId,
        jobId: createJobId(),
      };
      activeRunRef.current = activeRun;
      let activeService: ReturnType<typeof createPromptForgeService> | null = null;
      try {
        const isRegeneration = originalDraftOverride !== undefined && openReview;
        const excludedForRun = isRegeneration ? excludedSourceIds : [];
        if (!isRegeneration) setExcludedSourceIds([]);
        setError(null);
        setReviewOpen(false);
        const createdAt = clock();
        const initial = createPromptForgeJob({
          id: activeRun.jobId,
          accountId: options.accountId,
          chatId: options.chatId,
          projectId: options.projectId,
          originalDraft,
          regenerationInstructions: regenerationInstructions?.trim() || null,
          originalAttachments: options.originalAttachments,
          modelSelection: options.modelSelection,
          privacyMode,
          allowPublicResearch: effectiveAllowPublicResearch,
          now: createdAt,
        });
        setJob(initial);
        setStatus('idle');
        const service = createRunService(activeRun, excludedForRun);
        activeService = service;
        serviceRef.current = service;
        const completed = await service.start(initial, {
          ...(options.imageAttachments === undefined
            ? {}
            : { imageAttachments: options.imageAttachments }),
          ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
        });
        if (
          activeRunRef.current !== activeRun ||
          currentScopeKeyRef.current !== activeRun.scopeKey
        ) {
          return completed;
        }
        setJob(completed);
        setStatus(completed.status);
        if (completed.status === 'ready' && completed.generatedDraft !== null) {
          setUpgradedDraft(completed.generatedDraft);
          if (openReview) setReviewOpen(true);
        } else {
          setError(errorMessage(completed));
        }
        return completed;
      } catch {
        if (
          activeRunRef.current === activeRun &&
          currentScopeKeyRef.current === activeRun.scopeKey
        ) {
          setStatus('failed');
          setError(
            'Prompt Forge could not complete this upgrade. Your original draft is unchanged.',
          );
        }
        return null;
      } finally {
        if (serviceRef.current === activeService) serviceRef.current = null;
        if (activeRunRef.current === activeRun) activeRunRef.current = null;
      }
    },
    [
      clock,
      createJobId,
      createRunService,
      currentScopeKey,
      currentModelDisabledReason,
      effectiveAllowPublicResearch,
      excludedSourceIds,
      options.accountId,
      options.chatId,
      options.draft,
      options.modelSelection,
      options.originalAttachments,
      options.imageAttachments,
      options.projectId,
      options.workingDirectory,
      privacyMode,
      status,
    ],
  );

  /**
   * Upgrade a draft for Send without opening the review dialog.
   * Always returns text to send: upgraded on success, original on failure/cancel.
   */
  const upgradeForSend = useCallback(
    async (
      draft: string,
    ): Promise<Readonly<{ text: string; upgraded: boolean; reason?: string }>> => {
      const original = draft;
      if (!original.trim()) return { text: original, upgraded: false, reason: 'empty' };
      if (currentModelDisabledReason !== null) {
        return {
          text: original,
          upgraded: false,
          reason: currentModelDisabledReason,
        };
      }
      const completed = await start(undefined, original, { openReview: false });
      if (completed?.status === 'ready' && completed.generatedDraft?.trim()) {
        return { text: completed.generatedDraft.trim(), upgraded: true };
      }
      if (completed?.status === 'cancelled') {
        return { text: original, upgraded: false, reason: 'cancelled' };
      }
      return {
        text: original,
        upgraded: false,
        reason:
          (completed ? errorMessage(completed) : null) ??
          'Prompt upgrade failed. Sending your original text.',
      };
    },
    [currentModelDisabledReason, start],
  );

  const resumeRecovery = useCallback(async (): Promise<PromptForgeJob | null> => {
    const recovered = recoverableJob;
    if (
      recovered === null ||
      !jobMatchesScope(recovered, currentScope) ||
      recovered.status !== 'failed' ||
      recovered.errorCode !== 'interrupted' ||
      recoveryDisabledReason !== null ||
      activeRunRef.current !== null
    ) {
      return null;
    }

    const activeRun: ActiveComposerRun = {
      scopeKey: currentScopeKey,
      accountId: recovered.accountId,
      jobId: recovered.id,
    };
    activeRunRef.current = activeRun;
    let activeService: ReturnType<typeof createPromptForgeService> | null = null;
    setRecoveryLoading(true);
    setRecoveryError(null);
    setError(null);
    setReviewOpen(false);
    setJob(recovered);
    setStatus(recovered.status);

    try {
      const service = createRunService(activeRun, excludedSourceIds);
      activeService = service;
      serviceRef.current = service;
      const completed = await service.resume(recovered.accountId, recovered.id, {
        ...(options.imageAttachments === undefined
          ? {}
          : { imageAttachments: options.imageAttachments }),
        ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
      });
      if (activeRunRef.current !== activeRun || currentScopeKeyRef.current !== activeRun.scopeKey) {
        return completed;
      }
      setJob(completed);
      setStatus(completed.status);
      if (completed.status === 'ready' && completed.generatedDraft !== null) {
        setUpgradedDraft(completed.generatedDraft);
        setReviewOpen(true);
        setRecoverableJob(null);
        setRecoveryContextConfirmation(null);
      } else {
        setError(errorMessage(completed));
      }
      return completed;
    } catch {
      if (activeRunRef.current === activeRun && currentScopeKeyRef.current === activeRun.scopeKey) {
        setStatus('failed');
        setRecoveryError(
          'Prompt Forge could not resume the interrupted upgrade. Your draft is unchanged.',
        );
      }
      return null;
    } finally {
      if (serviceRef.current === activeService) serviceRef.current = null;
      if (activeRunRef.current === activeRun) activeRunRef.current = null;
      if (currentScopeKeyRef.current === activeRun.scopeKey) setRecoveryLoading(false);
    }
  }, [
    createRunService,
    currentScope,
    currentScopeKey,
    excludedSourceIds,
    options.imageAttachments,
    options.workingDirectory,
    recoverableJob,
    recoveryDisabledReason,
  ]);

  const confirmRecoveryContextChange = useCallback((): boolean => {
    const recovered = recoverableJob;
    if (recovered === null || !jobMatchesScope(recovered, currentScope)) return false;
    if (recoveryContextKey === null) return false;
    setRecoveryContextConfirmation(recoveryContextKey);
    setRecoveryError(null);
    return true;
  }, [currentScope, recoverableJob, recoveryContextKey]);

  const restoreRecoveryDraft = useCallback((): boolean => {
    const recovered = recoverableJob;
    if (recovered === null || !jobMatchesScope(recovered, currentScope)) return false;
    if (options.draft !== recovered.originalDraft) {
      setUndoValue({ scopeKey: currentScopeKey, value: options.draft });
      options.setDraft(recovered.originalDraft);
    }
    return true;
  }, [currentScope, currentScopeKey, options.draft, options.setDraft, recoverableJob]);

  const discardRecovery = useCallback(async (): Promise<boolean> => {
    const recovered = recoverableJob;
    if (
      recovered === null ||
      !jobMatchesScope(recovered, currentScope) ||
      activeRunRef.current !== null ||
      recoveryLoading
    ) {
      return false;
    }
    setRecoveryLoading(true);
    setRecoveryError(null);
    try {
      const removed = await repository.remove(recovered.accountId, recovered.id);
      if (currentScopeKeyRef.current !== currentScopeKey) return false;
      if (!removed) {
        setRecoveryError('The interrupted Prompt Forge upgrade is no longer available.');
        return false;
      }
      setRecoverableJob(null);
      setRecoveryContextConfirmation(null);
      return true;
    } catch {
      if (currentScopeKeyRef.current === currentScopeKey) {
        setRecoveryError('Prompt Forge could not discard the interrupted upgrade.');
      }
      return false;
    } finally {
      if (currentScopeKeyRef.current === currentScopeKey) setRecoveryLoading(false);
    }
  }, [currentScope, currentScopeKey, recoverableJob, recoveryLoading, repository]);

  const cancel = useCallback(async (): Promise<boolean> => {
    const active = activeRunRef.current;
    const service = serviceRef.current;
    if (!active || !service || active.scopeKey !== currentScopeKey) return false;
    const cancelled = await service.cancel(active.accountId, active.jobId);
    if (
      cancelled &&
      activeRunRef.current === active &&
      currentScopeKeyRef.current === active.scopeKey
    ) {
      setStatus('cancelled');
      setError(null);
    }
    return cancelled;
  }, [currentScopeKey]);

  const replace = useCallback(() => {
    if (!currentJobMatchesScope || !upgradedDraft.trim()) return;
    setUndoValue({ scopeKey: currentScopeKey, value: options.draft });
    options.setDraft(upgradedDraft);
  }, [currentJobMatchesScope, currentScopeKey, options.draft, options.setDraft, upgradedDraft]);

  const insertBelow = useCallback(() => {
    if (!currentJobMatchesScope || !upgradedDraft.trim()) return;
    setUndoValue({ scopeKey: currentScopeKey, value: options.draft });
    const separator = options.draft.length === 0 ? '' : '\n\n';
    options.setDraft(`${options.draft}${separator}${upgradedDraft}`);
  }, [currentJobMatchesScope, currentScopeKey, options.draft, options.setDraft, upgradedDraft]);

  const undo = useCallback(() => {
    if (undoValue === null || undoValue.scopeKey !== currentScopeKey) return;
    options.setDraft(undoValue.value);
    setUndoValue(null);
  }, [currentScopeKey, options.setDraft, undoValue]);

  const regenerate = useCallback(
    (instructions?: string) => {
      const original = currentJobMatchesScope && job ? job.originalDraft : options.draft;
      return start(instructions, original);
    },
    [currentJobMatchesScope, job, options.draft, start],
  );

  const toggleSource = useCallback((sourceId: string) => {
    setExcludedSourceIds((current) =>
      current.includes(sourceId)
        ? current.filter((candidate) => candidate !== sourceId)
        : Object.freeze([...current, sourceId]),
    );
  }, []);

  const copy = useCallback(async (): Promise<void> => {
    if (!upgradedDraft) return;
    await navigator.clipboard.writeText(upgradedDraft);
  }, [upgradedDraft]);

  return {
    status,
    statusMessage: STATUS_MESSAGES[status],
    isRunning,
    disabledReason,
    job: currentJobMatchesScope ? job : null,
    activity,
    error,
    recoverableJob,
    recoveryLoading,
    recoveryError,
    recoveryDisabledReason,
    recoveryNeedsContextConfirmation,
    reviewOpen: reviewOpen && currentJobMatchesScope,
    setReviewOpen,
    upgradedDraft,
    setUpgradedDraft,
    excludedSourceIds,
    toggleSource,
    privacyMode,
    setPrivacyMode,
    allowPublicResearch: effectiveAllowPublicResearch,
    publicResearchAvailable,
    setAllowPublicResearch: (allowed: boolean) =>
      setAllowPublicResearchState(
        publicResearchAvailable &&
          !options.offlineMode &&
          privacyMode === 'provider_allowed' &&
          allowed,
      ),
    start,
    upgradeForSend,
    resumeRecovery,
    confirmRecoveryContextChange,
    restoreRecoveryDraft,
    discardRecovery,
    cancel,
    replace,
    insertBelow,
    regenerate,
    copy,
    undo,
    canUndo: undoValue?.scopeKey === currentScopeKey,
  };
}

export type PromptForgeComposerController = ReturnType<typeof usePromptForgeComposer>;
export type { PromptForgeExecutionResult };
