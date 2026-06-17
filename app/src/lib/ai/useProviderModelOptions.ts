import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProviderId } from '@/types';
import { useAuthStore } from '@/stores/auth';
import {
  getModelsForProvider,
  loadProviderModels,
  type RegistryModelOption,
} from './providerModelCatalog';
import {
  formatProviderOptionLabel,
  getProviderConnectionStatus,
  HIVE_STACK_PROVIDERS,
  isProviderConnected,
  type ProviderConnectionContext,
} from './providerRegistry';
import { syncDiscoveredOllamaModels } from './models';
import { useOllamaModelOptions } from './models';

export interface ProviderModelSelectOption {
  providerId: ProviderId;
  label: string;
  disabled: boolean;
  connectionStatus: ReturnType<typeof getProviderConnectionStatus>;
}

export function useProviderConnectionContext(): ProviderConnectionContext {
  const apiKeys = useAuthStore((s) => s.apiKeys);
  const offlineMode = useAuthStore((s) => s.offlineMode);
  const plan = useAuthStore((s) => s.plan);
  const defaultLocalModel = useAuthStore((s) => s.defaultLocalModel);
  return useMemo(
    () => ({ apiKeys, offlineMode, plan, defaultLocalModel }),
    [apiKeys, offlineMode, plan, defaultLocalModel],
  );
}

export function useProviderModelOptions(args: {
  providerId: ProviderId;
  savedModelId?: string;
  providers?: ProviderId[];
  autoLoadDynamic?: boolean;
}) {
  const ctx = useProviderConnectionContext();
  const ollamaOptions = useOllamaModelOptions();
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const providerOptions: ProviderModelSelectOption[] = useMemo(() => {
    const list = args.providers ?? HIVE_STACK_PROVIDERS;
    return list.map((providerId) => {
      const connectionStatus = getProviderConnectionStatus(providerId, ctx);
      const connected = isProviderConnected(providerId, ctx);
      return {
        providerId,
        label: formatProviderOptionLabel(providerId, ctx),
        disabled: !connected,
        connectionStatus,
      };
    });
  }, [args.providers, ctx]);

  const modelOptions: RegistryModelOption[] = useMemo(
    () => getModelsForProvider(args.providerId, ctx, args.savedModelId),
    [args.providerId, args.savedModelId, ctx, ollamaOptions],
  );

  const loadModels = useCallback(
    async (force = false) => {
      setRefreshing(true);
      setLoadError(null);
      try {
        await loadProviderModels(args.providerId, ctx, { force });
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Could not load models');
      } finally {
        setRefreshing(false);
      }
    },
    [args.providerId, ctx],
  );

  useEffect(() => {
    if (args.autoLoadDynamic === false) return;
    if (!isProviderConnected(args.providerId, ctx)) return;
    void loadModels(false);
  }, [args.autoLoadDynamic, args.providerId, ctx, loadModels]);

  useEffect(() => {
    let cancelled = false;
    void import('@/lib/ai/providers/ollama').then(({ listOllamaModels, isOllamaReachable }) =>
      isOllamaReachable().then((connected) => {
        if (!connected || cancelled) return;
        return listOllamaModels().then((models) => {
          if (!cancelled) syncDiscoveredOllamaModels(models);
        });
      }),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    ctx,
    providerOptions,
    modelOptions,
    refreshing,
    loadError,
    refreshModels: () => loadModels(true),
  };
}
