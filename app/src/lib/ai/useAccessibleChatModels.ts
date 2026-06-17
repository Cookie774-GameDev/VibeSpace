import { useMemo } from 'react';
import type { ProviderId } from '@/types';
import { useAuthStore } from '@/stores/auth';
import { getProviderDisplayName } from './providerRegistry';
import {
  getAccessibleModelOptions,
  getAccessibleProviders,
  useOllamaModelOptions,
} from './models';

/** @deprecated Use getProviderDisplayName from providerRegistry */
export const MODEL_PROVIDER_LABELS: Partial<Record<ProviderId, string>> = new Proxy(
  {} as Partial<Record<ProviderId, string>>,
  {
    get(_target, prop: string) {
      return getProviderDisplayName(prop as ProviderId);
    },
  },
);

export interface ModelPickerOption {
  /** `${provider}:${modelId}` — stable for keyboard nav */
  id: string;
  provider: ProviderId;
  modelId: string;
  label: string;
}

export interface ModelPickerGroup {
  provider: ProviderId;
  label: string;
  options: ModelPickerOption[];
}

export function buildModelPickerGroups(args: {
  apiKeys: Partial<Record<ProviderId, string>>;
  offlineMode: boolean;
  plan: ReturnType<typeof useAuthStore.getState>['plan'];
  defaultLocalModel: string;
}): ModelPickerGroup[] {
  const providers = getAccessibleProviders(
    args.apiKeys,
    args.offlineMode,
    args.plan,
    args.defaultLocalModel,
  ).filter(
    (provider) => provider !== 'local',
  );

  const groups: ModelPickerGroup[] = [];
  for (const provider of providers) {
    const models = getAccessibleModelOptions(
      provider,
      args.apiKeys,
      args.offlineMode,
      args.defaultLocalModel,
      args.plan,
    );
    if (models.length === 0) continue;
    groups.push({
      provider,
      label: getProviderDisplayName(provider),
      options: models.map((model) => ({
        id: `${provider}:${model.id}`,
        provider,
        modelId: model.id,
        label: model.label,
      })),
    });
  }
  return groups;
}

/** Reactive model catalog for chat + agent pickers (subscribes to Ollama discovery). */
export function useAccessibleChatModels() {
  const apiKeys = useAuthStore((s) => s.apiKeys);
  const offlineMode = useAuthStore((s) => s.offlineMode);
  const plan = useAuthStore((s) => s.plan);
  const defaultLocalModel = useAuthStore((s) => s.defaultLocalModel);
  const ollamaOptions = useOllamaModelOptions();
  const ollamaSignature = ollamaOptions.map((option) => option.id).join('\0');

  const groups = useMemo(
    () =>
      buildModelPickerGroups({
        apiKeys,
        offlineMode,
        plan,
        defaultLocalModel,
      }),
    [apiKeys, offlineMode, plan, defaultLocalModel, ollamaSignature],
  );

  const flatOptions = useMemo(() => groups.flatMap((group) => group.options), [groups]);

  return {
    groups,
    flatOptions,
    hasAny: flatOptions.length > 0,
    ollamaCount: ollamaOptions.length,
  };
}
