import type { ProviderId } from '@/types';
import type { ConnectionMode } from '@/lib/ai/adapters/types';
import { normalizePromptForgeModelSelection, type PromptForgeModelSelection } from './contracts';

export const DEFAULT_PROMPT_FORGE_MODEL_SELECTION: PromptForgeModelSelection = Object.freeze({
  mode: 'prefer_local',
});

export interface PromptForgeModelOption {
  id: string;
  providerId: ProviderId;
  modelId: string;
  label: string;
  connectionId?: string;
  connectionMode?: ConnectionMode;
  localOnly: boolean;
  available: boolean;
}

export type PromptForgeCurrentChatSelection =
  | Readonly<{ mode: 'none' }>
  | Readonly<{ mode: 'hive'; hiveId: string }>
  | Readonly<{
      mode: 'single';
      providerId: ProviderId;
      modelId: string;
      connectionId?: string;
    }>;

export type ResolvedPromptForgeModel = Readonly<{
  providerId: ProviderId;
  modelId: string;
  label: string;
  connectionId: string | null;
  connectionMode: ConnectionMode | null;
  local: boolean;
  billingClass: 'local_free' | 'subscription_connection' | 'provider_billed';
}>;

export type PromptForgeModelSelectionErrorCode =
  | 'current_chat_not_single'
  | 'model_unavailable'
  | 'connection_ambiguous'
  | 'offline_cloud_blocked';

export class PromptForgeModelSelectionError extends Error {
  constructor(readonly code: PromptForgeModelSelectionErrorCode) {
    super(
      code === 'current_chat_not_single'
        ? 'Prompt Forge requires a single current chat model.'
        : code === 'model_unavailable'
          ? 'The selected Prompt Forge model is unavailable.'
          : code === 'connection_ambiguous'
            ? 'Choose an exact provider connection for this Prompt Forge model.'
            : 'A cloud Prompt Forge model is unavailable while offline.',
    );
    this.name = 'PromptForgeModelSelectionError';
  }
}

export const PROMPT_UPGRADE_ASSIGN_MODEL_MESSAGE =
  'Please assign a prompt-upgrade model in Settings. You can use the next-best fast model (Spark or Flash) if one is connected.';

function isLocal(option: PromptForgeModelOption): boolean {
  return (
    option.localOnly ||
    option.connectionMode === 'local' ||
    option.providerId === 'ollama' ||
    option.providerId === 'local'
  );
}

function fastFallbackRank(option: PromptForgeModelOption): number {
  const haystack = `${option.modelId} ${option.label}`.toLocaleLowerCase('en-US');
  if (haystack.includes('gpt-5.3-codex-spark')) return 0;
  if (haystack.includes('codex-spark')) return 1;
  if (haystack.includes('spark')) return 2;
  if (haystack.includes('flash-lite') || haystack.includes('flashlite')) return 10;
  if (haystack.includes('flash')) return 11;
  return Number.POSITIVE_INFINITY;
}

/** Next-best prompt-upgrade model when no local/assigned model exists: Spark, then Flash. */
export function pickFastPromptUpgradeFallback(
  options: readonly PromptForgeModelOption[],
): PromptForgeModelOption | undefined {
  return options
    .filter((option) => option.available && !isLocal(option) && fastFallbackRank(option) < 100)
    .sort((left, right) => {
      const rank = fastFallbackRank(left) - fastFallbackRank(right);
      if (rank !== 0) return rank;
      return (
        left.label.localeCompare(right.label, 'en-US') || left.id.localeCompare(right.id, 'en-US')
      );
    })[0];
}

function resolved(option: PromptForgeModelOption): ResolvedPromptForgeModel {
  const local = isLocal(option);
  return Object.freeze({
    providerId: option.providerId,
    modelId: option.modelId,
    label: option.label,
    connectionId: option.connectionId ?? null,
    connectionMode: option.connectionMode ?? null,
    local,
    billingClass: local
      ? 'local_free'
      : option.connectionMode === 'external-cli'
        ? 'subscription_connection'
        : 'provider_billed',
  });
}

function exactMatches(
  selection: Extract<PromptForgeModelSelection, { mode: 'single' }>,
  options: readonly PromptForgeModelOption[],
): PromptForgeModelOption[] {
  return options.filter(
    (option) =>
      option.available &&
      option.providerId === selection.providerId &&
      option.modelId === selection.modelId &&
      (selection.connectionId === undefined || option.connectionId === selection.connectionId),
  );
}

export function resolvePromptForgeModelSelection(
  rawSelection: PromptForgeModelSelection,
  context: Readonly<{
    currentChatSelection: PromptForgeCurrentChatSelection;
    options: readonly PromptForgeModelOption[];
    offlineMode: boolean;
    defaultLocalModel: string;
  }>,
): ResolvedPromptForgeModel {
  const normalized = normalizePromptForgeModelSelection(rawSelection);
  const selection: Exclude<PromptForgeModelSelection, { mode: 'current_chat_model' }> =
    normalized.mode === 'current_chat_model'
      ? (() => {
          if (context.currentChatSelection.mode !== 'single') {
            throw new PromptForgeModelSelectionError('current_chat_not_single');
          }
          return normalizePromptForgeModelSelection({
            mode: 'single',
            providerId: context.currentChatSelection.providerId,
            modelId: context.currentChatSelection.modelId,
            ...(context.currentChatSelection.connectionId
              ? { connectionId: context.currentChatSelection.connectionId }
              : {}),
          }) as Extract<PromptForgeModelSelection, { mode: 'single' }>;
        })()
      : normalized;

  let option: PromptForgeModelOption | undefined;
  if (selection.mode === 'prefer_local') {
    const local = context.options.filter((candidate) => candidate.available && isLocal(candidate));
    option =
      local.find(
        (candidate) =>
          candidate.modelId.toLocaleLowerCase('en-US') ===
          context.defaultLocalModel.toLocaleLowerCase('en-US'),
      ) ??
      [...local].sort(
        (left, right) =>
          left.label.localeCompare(right.label, 'en-US') ||
          left.id.localeCompare(right.id, 'en-US'),
      )[0];
    if (!option && !context.offlineMode) {
      option = pickFastPromptUpgradeFallback(context.options);
    }
  } else {
    const matches = exactMatches(selection, context.options);
    if (matches.length > 1 && selection.connectionId === undefined) {
      throw new PromptForgeModelSelectionError('connection_ambiguous');
    }
    option = matches[0];
    if (!option && !context.offlineMode) {
      option = pickFastPromptUpgradeFallback(context.options);
    }
  }
  if (!option) throw new PromptForgeModelSelectionError('model_unavailable');
  if (context.offlineMode && !isLocal(option)) {
    throw new PromptForgeModelSelectionError('offline_cloud_blocked');
  }
  return resolved(option);
}
