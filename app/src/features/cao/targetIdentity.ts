import { readChatReasoningPreference } from '@/features/chat/reasoningSlashStore';
import { readChatRuntimePolicyState } from '@/features/chat/runtime/chatRuntimeSettingsStore';
import { supportedEffortPreferences } from '@/features/chat/runtime/runtimeModelControls';
import { CODEX_CLI_CONNECTION, OPENCODE_CLI_CONNECTION } from '@/lib/ai/adapters/catalog';
import { listEffortOptions } from '@/lib/ai/catalog/modelVariants';
import {
  getDiscoveredConnectionModels,
  type DiscoveredConnectionModel,
} from '@/lib/ai/connectionCatalog';
import type { Chat } from '@/types/chat';
import type { CaoExecutionIdentity } from './executionProfile';

type CaoDiscoveredConnectionModel = DiscoveredConnectionModel &
  Readonly<{ defaultReasoningEffort?: string }>;

const CAO_DISCOVERED_CONNECTION_IDS = [
  CODEX_CLI_CONNECTION.id,
  OPENCODE_CLI_CONNECTION.id,
] as const;

function discoveredModelsFor(connectionId: string): readonly CaoDiscoveredConnectionModel[] {
  return getDiscoveredConnectionModels(connectionId);
}

export function caoDiscoveredModelsSnapshot(): string {
  return JSON.stringify(
    CAO_DISCOVERED_CONNECTION_IDS.map((connectionId) => ({
      connectionId,
      models: discoveredModelsFor(connectionId).map((model) => ({
        id: model.id,
        variants: model.variants ?? null,
        defaultReasoningEffort: model.defaultReasoningEffort ?? null,
        source: model.source,
        lastVerifiedAt: model.lastVerifiedAt,
        unverified: model.unverified === true,
      })),
    })),
  );
}

function knownBackendForConnection(
  connectionId: string,
): CaoExecutionIdentity['backend'] | undefined {
  if (connectionId === CODEX_CLI_CONNECTION.id) return 'codex';
  if (connectionId === OPENCODE_CLI_CONNECTION.id) return 'opencode';
  return undefined;
}

/** Resolve the trusted CAO backend from the exact connection and optional persisted affinity. */
export function resolveCaoChatBackend(
  chat: Pick<Chat, 'connection' | 'backend_affinity'>,
): CaoExecutionIdentity['backend'] | undefined {
  const connectionId = chat.connection?.id?.trim() ?? '';
  const inferred = knownBackendForConnection(connectionId);
  if (!inferred) return undefined;
  const persisted = chat.backend_affinity?.backend;
  if (persisted && persisted !== inferred) return undefined;
  return persisted ?? inferred;
}

function normalizedLiveVariants(model: CaoDiscoveredConnectionModel): readonly string[] {
  if (!Array.isArray(model.variants)) return [];
  const seen = new Set<string>();
  const variants: string[] = [];
  for (const value of model.variants) {
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > 64 ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      continue;
    }
    const variant = value.trim();
    if (seen.has(variant)) continue;
    seen.add(variant);
    variants.push(variant);
  }
  return variants;
}

/** Resolve an existing chat only against the current discovered model catalog. */
export function readCaoChatTargetIdentity(chat: Chat): CaoExecutionIdentity | undefined {
  const connection = chat.connection;
  const connectionId = connection?.id?.trim() ?? '';
  const providerId = connection?.providerId?.trim() ?? '';
  const modelId = connection?.modelId?.trim() ?? '';
  const backend = resolveCaoChatBackend(chat);
  if (!connectionId || !providerId || !modelId || !backend) return undefined;

  const model = discoveredModelsFor(connectionId).find(
    (candidate) =>
      candidate.id.trim() === modelId &&
      candidate.source !== 'stale_fallback' &&
      candidate.unverified !== true &&
      Number.isSafeInteger(candidate.lastVerifiedAt) &&
      candidate.lastVerifiedAt >= 0,
  );
  if (!model) return undefined;

  const variants = normalizedLiveVariants(model);
  if (variants.length === 0) return undefined;
  const liveVariants = variants.map((id) => ({ id }));
  const effortOptions = listEffortOptions(liveVariants, modelId);
  const supportedEfforts = new Set<string>(
    supportedEffortPreferences({ connectionId, modelId, variants: liveVariants }),
  );
  const identityForLabel = (label: string): CaoExecutionIdentity | undefined => {
    if (!supportedEfforts.has(label)) return undefined;
    const option = effortOptions.find(
      (candidate) => candidate.label === label && candidate.available && candidate.upstreamVariant,
    );
    if (!option?.upstreamVariant) return undefined;
    return {
      backend,
      providerId,
      connectionId,
      modelId,
      reasoningEffort: option.upstreamVariant,
    };
  };

  const preference = readChatReasoningPreference(String(chat.id));
  if (preference.effortOverride) return identityForLabel(preference.effortOverride);

  const runtimeEffort = readChatRuntimePolicyState(String(chat.id)).settings.effort;
  if (runtimeEffort !== 'auto') return identityForLabel(runtimeEffort);

  const nativeDefault = model.defaultReasoningEffort?.trim();
  if (nativeDefault) {
    const defaultVariant = variants.find((variant) => variant === nativeDefault);
    const defaultOption = effortOptions.find(
      (candidate) =>
        candidate.available &&
        candidate.upstreamVariant === defaultVariant &&
        supportedEfforts.has(candidate.label),
    );
    if (defaultOption?.upstreamVariant) {
      return {
        backend,
        providerId,
        connectionId,
        modelId,
        reasoningEffort: defaultOption.upstreamVariant,
      };
    }
  }

  const advertisedOptions = effortOptions.filter(
    (candidate) => candidate.available && candidate.upstreamVariant,
  );
  if (advertisedOptions.length !== 1 || !advertisedOptions[0]?.upstreamVariant) return undefined;
  return {
    backend,
    providerId,
    connectionId,
    modelId,
    reasoningEffort: advertisedOptions[0].upstreamVariant,
  };
}
