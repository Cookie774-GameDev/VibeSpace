/**
 * Shared Prompt Upgrade Engine — reusable by Chat (this prompt) and Terminal (Prompt 31).
 *
 * Thin, stable facade over Prompt Forge preparation + execution. Callers supply
 * context collectors and model options; this module never dumps full history
 * blindly (retrieval is delegated to the existing context preparer).
 */

import type { ChatImageAttachment } from '@/lib/ai/vision';
import {
  createPromptForgeJob,
  type PromptForgeAttachmentSnapshot,
  type PromptForgeJob,
  type PromptForgeModelSelection,
  type PromptForgePrivacyMode,
} from './contracts';
import {
  createPromptForgeContextPreparer,
  type PromptForgeAdditionalSourceCollector,
  type PromptForgePublicResearchPort,
} from './contextPreparation';
import {
  resolvePromptForgeModelSelection,
  type PromptForgeCurrentChatSelection,
  type PromptForgeModelOption,
} from './modelSelection';
import { promptForgeExecutor } from './promptForgeExecutor';
import {
  createPromptForgeService,
  type PromptForgeExecutorPort,
  type PromptForgeJobRepository,
  type PromptForgePreparer,
} from './promptForgeService';
import type { PromptForgeSourceCandidate } from './sourcePack';
import { githubPublicResearchPort } from './publicResearch';

export type PromptUpgradeEngineInput = Readonly<{
  accountId: string;
  /** Chat id for chat upgrades; use a stable terminal session id for terminal reuse. */
  chatId: string;
  projectId: string | null;
  originalDraft: string;
  originalAttachments?: readonly PromptForgeAttachmentSnapshot[];
  modelSelection: PromptForgeModelSelection;
  modelOptions: readonly PromptForgeModelOption[];
  currentChatSelection: PromptForgeCurrentChatSelection;
  offlineMode: boolean;
  defaultLocalModel: string;
  privacyMode: PromptForgePrivacyMode;
  allowPublicResearch: boolean;
  imageAttachments?: readonly ChatImageAttachment[];
  workingDirectory?: string;
  additionalSources?: readonly PromptForgeSourceCandidate[];
  collectAdditionalSources?: PromptForgeAdditionalSourceCollector;
  researchPublicSources?: PromptForgePublicResearchPort | null;
  repository: PromptForgeJobRepository;
  executor?: PromptForgeExecutorPort;
  prepare?: PromptForgePreparer;
  signal?: AbortSignal;
  jobId?: string;
  now?: () => number;
  onStatus?: (status: PromptForgeJob['status']) => void;
}>;

export type PromptUpgradeEngineSuccess = Readonly<{
  ok: true;
  upgradedPrompt: string;
  originalDraft: string;
  job: PromptForgeJob;
  usedPublicResearch: boolean;
  modelLabel: string;
}>;

export type PromptUpgradeEngineFailure = Readonly<{
  ok: false;
  originalDraft: string;
  reason: string;
  errorCode: string | null;
  job: PromptForgeJob | null;
}>;

export type PromptUpgradeEngineResult = PromptUpgradeEngineSuccess | PromptUpgradeEngineFailure;

function jobIdDefault(): string {
  return `prompt-upgrade-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

function failureReason(job: PromptForgeJob | null, fallback: string): string {
  if (!job) return fallback;
  if (job.errorCode === 'model_unavailable') return 'The upgrade model is unavailable.';
  if (job.errorCode === 'offline_cloud_blocked')
    return 'Cloud upgrade models are blocked offline. Choose a local model.';
  if (job.errorCode === 'privacy_violation')
    return 'Local-only privacy blocked the selected cloud model.';
  if (job.errorCode === 'provider_failed') return 'The upgrade model failed. Sending your original text.';
  if (job.errorCode === 'sensitive_input')
    return 'Secrets were detected in the draft; upgrade was blocked.';
  if (job.status === 'cancelled') return 'Upgrade cancelled.';
  return fallback;
}

/**
 * Run one full upgrade pass. On any failure, callers should send `originalDraft`.
 * Does not open UI — host owns preview/edit/cancel presentation.
 */
export async function runPromptUpgrade(
  input: PromptUpgradeEngineInput,
): Promise<PromptUpgradeEngineResult> {
  const originalDraft = input.originalDraft;
  const trimmed = originalDraft.trim();
  if (!input.accountId || !trimmed) {
    return {
      ok: false,
      originalDraft,
      reason: !input.accountId ? 'Sign in required.' : 'Nothing to upgrade.',
      errorCode: 'empty',
      job: null,
    };
  }

  try {
    // Validate model access up front (only accessible options resolve).
    resolvePromptForgeModelSelection(input.modelSelection, {
      currentChatSelection: input.currentChatSelection,
      options: input.modelOptions,
      offlineMode: input.offlineMode,
      defaultLocalModel: input.defaultLocalModel,
    });
  } catch {
    return {
      ok: false,
      originalDraft,
      reason: 'No accessible upgrade model is available.',
      errorCode: 'model_unavailable',
      job: null,
    };
  }

  if (input.privacyMode === 'local_only') {
    try {
      const model = resolvePromptForgeModelSelection(input.modelSelection, {
        currentChatSelection: input.currentChatSelection,
        options: input.modelOptions,
        offlineMode: input.offlineMode,
        defaultLocalModel: input.defaultLocalModel,
      });
      if (!model.local) {
        return {
          ok: false,
          originalDraft,
          reason: 'Local-only mode requires a local upgrade model.',
          errorCode: 'privacy_violation',
          job: null,
        };
      }
    } catch {
      /* resolve already validated above */
    }
  }

  const clock = input.now ?? Date.now;
  const research =
    input.researchPublicSources === undefined
      ? githubPublicResearchPort
      : input.researchPublicSources;
  const allowPublic =
    research !== null &&
    !input.offlineMode &&
    input.privacyMode === 'provider_allowed' &&
    input.allowPublicResearch;

  const prepare =
    input.prepare ??
    createPromptForgeContextPreparer({
      contextAttachments: [],
      modelOptions: input.modelOptions,
      currentChatSelection: input.currentChatSelection,
      offlineMode: input.offlineMode,
      defaultLocalModel: input.defaultLocalModel,
      additionalSources: input.additionalSources ?? [],
      ...(input.collectAdditionalSources
        ? { collectAdditionalSources: input.collectAdditionalSources }
        : {}),
      ...(research === null ? {} : { researchPublicSources: research }),
      now: clock,
    });

  const service = createPromptForgeService({
    repository: input.repository,
    prepare,
    executor: input.executor ?? promptForgeExecutor,
    now: clock,
    onActivity: (activity) => {
      input.onStatus?.(activity.status);
    },
  });

  const initial = createPromptForgeJob({
    id: input.jobId ?? jobIdDefault(),
    accountId: input.accountId,
    chatId: input.chatId,
    projectId: input.projectId,
    originalDraft,
    regenerationInstructions: null,
    originalAttachments: input.originalAttachments ?? [],
    modelSelection: input.modelSelection,
    privacyMode: input.privacyMode,
    allowPublicResearch: allowPublic,
    now: clock(),
  });

  try {
    const completed = await service.start(initial, {
      ...(input.imageAttachments ? { imageAttachments: input.imageAttachments } : {}),
      ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    if (completed.status === 'ready' && completed.generatedDraft?.trim()) {
      return {
        ok: true,
        upgradedPrompt: completed.generatedDraft.trim(),
        originalDraft,
        job: completed,
        usedPublicResearch: allowPublic,
        modelLabel: completed.resolvedModel?.label ?? 'Prompt Forge',
      };
    }

    return {
      ok: false,
      originalDraft,
      reason: failureReason(
        completed,
        'Prompt upgrade failed. Sending your original text.',
      ),
      errorCode: completed.errorCode,
      job: completed,
    };
  } catch {
    return {
      ok: false,
      originalDraft,
      reason: 'Prompt upgrade failed. Sending your original text.',
      errorCode: 'provider_failed',
      job: null,
    };
  }
}

/** True when the user has at least one available upgrade model option. */
export function hasAccessiblePromptUpgradeModel(
  options: readonly PromptForgeModelOption[],
): boolean {
  return options.some((option) => option.available);
}

/** Filter picker rows to models the user can actually use. */
export function accessiblePromptUpgradeModels(
  options: readonly PromptForgeModelOption[],
): readonly PromptForgeModelOption[] {
  return Object.freeze(options.filter((option) => option.available));
}
