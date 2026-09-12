import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProviderId } from '@/types';
import { useAuthStore } from '@/stores/auth';
import { getProviderDisplayName } from './providerRegistry';
import { listPromotedAdapters } from '@/features/model-foundry/adapterRegistry';
import {
  CHAT_MODEL_OPTIONS,
  getAccessibleModelOptions,
  getAccessibleProviders,
  useOllamaModelOptions,
} from './models';
import type { ProviderConnection } from './adapters/types';
import {
  OPENCODE_CLI_CONNECTION,
  CONNECTION_MODEL_OPTIONS,
  PROVIDER_CATALOG,
  PROVIDER_CONNECTIONS,
} from './adapters/catalog';
import { ensureExternalConnectionAutoDetection } from './adapters/autoDetectConnections';
import {
  invalidateOpenCodePersistentModelCache,
  openCodePersistentAdapter,
} from './adapters/opencodePersistent';
import {
  AI_CONNECTION_STATE_EVENT,
  deriveAiConnectionHealth,
  isConnectionSessionChecked,
  readConnectionMetadata,
  readConnectionPickerStates,
  readConnectionSessionPickerStates,
  writeConnectionPickerStates,
  type ConnectionPickerState,
} from './connectionState';
import { probeQwenApiCredential, reconcileNativeProbeState } from './nativeConnectionProbe';
import {
  kernelSmokeProvider,
  KERNEL_SMOKE_BINDING_EVENT,
  KERNEL_SMOKE_PROVIDER_ID,
} from './providers/kernelSmoke';
import {
  canonicalModelId,
  canonicalProviderModelId,
  dedupeModelMetadata,
  modelRouteLabel,
  type SimpleModelCatalogRecord,
  type ModelCatalogSource,
} from './catalog/canonicalModelCatalog';
import {
  getDiscoveredOpenAiSubscriptionModels,
  resolveOpenAiSubscriptionModels,
  setDiscoveredOpenAiSubscriptionModels,
  subscribeDiscoveredOpenAiSubscriptionModels,
} from './openCodeOpenAiCatalog';
import {
  getDiscoveredConnectionModels,
  subscribeDiscoveredConnectionModels,
} from './connectionCatalog';

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
  /** Connection-qualified and stable for keyboard navigation. */
  id: string;
  provider: ProviderId;
  modelId: string;
  label: string;
  connection?: Readonly<ProviderConnection>;
  connectionId?: string;
  modeLabel?: string;
  authLabel?: string;
  available?: boolean;
  catalogSource?: ModelCatalogSource;
  lastVerifiedAt?: number;
  variants?: readonly string[];
}

export interface ModelPickerGroup {
  provider: ProviderId;
  label: string;
  options: ModelPickerOption[];
}

export interface PickerCatalogModel extends SimpleModelCatalogRecord {
  id: string;
  label: string;
}

export {
  AI_CONNECTION_STATE_EVENT,
  readConnectionPickerStates,
  writeConnectionPickerStates,
} from './connectionState';
export type { ConnectionPickerState } from './connectionState';

export const CONNECTION_MODE_LABELS = Object.freeze({
  'external-cli': 'Subscription bridge · External agent',
  'native-api': 'Native Jarvis Chat · API billed',
  local: 'Local runtime',
});

/** Explicit model-catalog invalidation used after auth, key, plan, region, or runtime changes. */
export const OPEN_CODE_MODEL_CATALOG_REFRESH_EVENT = 'vibespace:open-code-model-catalog-refresh';

const OPEN_CODE_MODEL_CACHE_TTL_MS = 60_000;
const OPEN_CODE_MODEL_FAILURE_RETRY_MS = 15_000;
let openCodeCatalogGeneration = 0;
let openCodeModelCache:
  | {
      readonly generation: number;
      readonly loadedAt: number;
      readonly models: readonly PickerCatalogModel[];
    }
  | undefined;
let openCodeModelLoad:
  | { readonly generation: number; readonly promise: Promise<readonly PickerCatalogModel[]> }
  | undefined;

function connectionAuthLabel(state: ConnectionPickerState): string {
  if (state.auth === 'authenticated') return 'Ready';
  if (state.auth === 'unauthenticated') return 'Sign in required';
  if (!state.available) return 'Unavailable';
  return 'Authentication unknown';
}

function dedupeModelMetadataInOrder(
  records: readonly Readonly<PickerCatalogModel>[],
): PickerCatalogModel[] {
  const byId = new Map<string, PickerCatalogModel>();
  const order: string[] = [];
  for (const raw of records) {
    const candidate = dedupeModelMetadata([raw])[0];
    if (!candidate) continue;
    const key = canonicalModelId(candidate.id);
    const current = byId.get(key);
    if (!current) {
      order.push(key);
      byId.set(key, candidate);
      continue;
    }
    const merged = dedupeModelMetadata([current, candidate])[0];
    if (merged) byId.set(key, merged);
  }
  return order.map((key) => byId.get(key)!).filter(Boolean);
}

function asCatalogModels(
  models: readonly Readonly<{ id: string; label: string; variants?: readonly string[] }>[],
  source: ModelCatalogSource,
  lastVerifiedAt?: number,
): PickerCatalogModel[] {
  return dedupeModelMetadataInOrder(
    models.map((model) => ({
      ...model,
      source,
      ...(lastVerifiedAt ? { lastVerifiedAt } : {}),
    })),
  );
}

function invalidateOpenCodeModelCatalog(): number {
  openCodeCatalogGeneration += 1;
  return openCodeCatalogGeneration;
}

async function loadOpenCodeModels(force = false): Promise<readonly PickerCatalogModel[]> {
  const now = Date.now();
  const generation = openCodeCatalogGeneration;
  if (
    !force &&
    openCodeModelCache &&
    openCodeModelCache.generation === generation &&
    now - openCodeModelCache.loadedAt < OPEN_CODE_MODEL_CACHE_TTL_MS
  ) {
    return openCodeModelCache.models;
  }
  if (!force && openCodeModelLoad?.generation === generation) {
    return openCodeModelLoad.promise;
  }
  if (!openCodePersistentAdapter.listModels) return openCodeModelCache?.models ?? [];

  const promise = openCodePersistentAdapter
    .listModels()
    .then((models) => {
      const loadedAt = Date.now();
      const normalized = asCatalogModels(models, 'opencode-live', loadedAt);
      // An older auth/refresh request must never overwrite a newer catalog.
      if (generation === openCodeCatalogGeneration) {
        openCodeModelCache = { generation, loadedAt, models: normalized };
      }
      return normalized;
    })
    .catch((error) => {
      // A transient discovery/auth failure must not erase the last verified list.
      if (openCodeModelCache) return openCodeModelCache.models;
      throw error;
    })
    .finally(() => {
      if (openCodeModelLoad?.promise === promise) openCodeModelLoad = undefined;
    });
  openCodeModelLoad = { generation, promise };
  return promise;
}

/** Force the next authenticated model discovery without erasing verified cache. */
export function requestOpenCodeModelCatalogRefresh(): void {
  invalidateOpenCodeModelCatalog();
  invalidateOpenCodePersistentModelCache();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(OPEN_CODE_MODEL_CATALOG_REFRESH_EVENT));
  }
}

function pickerCanonicalModelId(providerId: string, modelId: string): string {
  return canonicalProviderModelId(providerId, modelId);
}

/** Pure connection-qualified picker builder; unavailable entries remain visible but disabled. */
export function buildConnectionPickerGroups(args: {
  connections: readonly Readonly<ProviderConnection>[];
  modelsByProvider: Partial<Record<string, readonly PickerCatalogModel[]>>;
  modelsByConnection?: Partial<Record<string, readonly PickerCatalogModel[]>>;
  stateByConnection?: Partial<Record<string, ConnectionPickerState>>;
  credentialSavedByProvider?: Partial<Record<string, boolean>>;
}): ModelPickerGroup[] {
  const familyByProvider = new Map(
    Object.values(PROVIDER_CATALOG).map((family) => [family.id as string, family]),
  );
  const groups = new Map<string, ModelPickerGroup>();

  for (const connection of args.connections) {
    const models = dedupeModelMetadataInOrder(
      args.modelsByConnection?.[connection.id] ??
        args.modelsByProvider[connection.providerId] ??
        [],
    );
    if (models.length === 0) continue;

    const group = groups.get(connection.providerId) ?? {
      provider: connection.providerId as ProviderId,
      label:
        familyByProvider.get(connection.providerId)?.displayName ??
        getProviderDisplayName(connection.providerId as ProviderId),
      options: [],
    };
    let state = args.stateByConnection?.[connection.id] ?? {
      available: connection.mode !== 'external-cli',
      auth: connection.mode === 'local' ? ('authenticated' as const) : ('unknown' as const),
    };
    if (
      connection.mode === 'native-api' &&
      connection.authSource === 'api-key' &&
      args.credentialSavedByProvider?.[connection.providerId] === false
    ) {
      state = { available: false, auth: 'unauthenticated' };
    }
    const authAllowsUse =
      connection.mode === 'external-cli'
        ? state.auth === 'authenticated'
        : state.auth !== 'unauthenticated';

    for (const model of models) {
      group.options.push({
        id: `${connection.id}:${model.id}`,
        provider: connection.providerId as ProviderId,
        modelId: model.id,
        label: model.label,
        connection,
        connectionId: connection.id,
        modeLabel: CONNECTION_MODE_LABELS[connection.mode],
        authLabel: connectionAuthLabel(state),
        available: state.available && authAllowsUse && model.available !== false,
        catalogSource: model.source,
        lastVerifiedAt: model.lastVerifiedAt,
        variants: model.variants,
      });
    }
    groups.set(connection.providerId, group);
  }

  // Dedupe only within an exact connection+canonical-model route. Distinct
  // API/subscription routes—including unavailable sign-in rows—remain visible
  // so auth, billing, and provider identity are never silently collapsed.
  for (const group of groups.values()) {
    const uniqueByRoute = new Map<string, ModelPickerOption>();
    for (const option of group.options) {
      const modelKey = pickerCanonicalModelId(group.provider, option.modelId);
      const routeKey = `${option.connectionId ?? ''}\u0000${modelKey}`;
      if (!uniqueByRoute.has(routeKey)) uniqueByRoute.set(routeKey, option);
    }
    const visible = [...uniqueByRoute.values()];
    const routeCounts = new Map<string, number>();
    for (const option of visible) {
      const key = pickerCanonicalModelId(group.provider, option.modelId);
      routeCounts.set(key, (routeCounts.get(key) ?? 0) + 1);
    }
    group.options = visible.map((option) => {
      const key = pickerCanonicalModelId(group.provider, option.modelId);
      return {
        ...option,
        label: modelRouteLabel(
          option.label,
          option.connection?.displayName,
          routeCounts.get(key) ?? 1,
        ),
      };
    });
  }

  return [...groups.values()];
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
  ).filter((provider) => provider !== 'local');
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
        catalogSource: 'provider-static',
      })),
    });
  }
  return groups;
}

/** Reactive connection catalog for chat (subscribes to Ollama and connection discovery). */
export function useAccessibleChatModels() {
  const apiKeys = useAuthStore((s) => s.apiKeys);
  const offlineMode = useAuthStore((s) => s.offlineMode);
  const plan = useAuthStore((s) => s.plan);
  const defaultLocalModel = useAuthStore((s) => s.defaultLocalModel);
  const preferredConnections = useAuthStore(
    (s) => s.preferredConnectionIdByProviderFamily ?? {},
  );
  const ollamaOptions = useOllamaModelOptions();
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [foundryRevision, setFoundryRevision] = useState(0);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [openCodeModels, setOpenCodeModels] = useState<readonly PickerCatalogModel[]>([]);

  const openCodeSessionState = readConnectionSessionPickerStates()[OPENCODE_CLI_CONNECTION.id];
  const openCodeSessionChecked = isConnectionSessionChecked(OPENCODE_CLI_CONNECTION.id);
  const openCodeReady =
    !offlineMode &&
    openCodeSessionChecked &&
    openCodeSessionState?.available === true &&
    openCodeSessionState.auth === 'authenticated';
  const openCodeStateSignature = [
    openCodeSessionChecked,
    openCodeSessionState?.available === true,
    openCodeSessionState?.auth ?? 'unknown',
  ].join(':');
  const openCodeStateSignatureRef = useRef(openCodeStateSignature);
  openCodeStateSignatureRef.current = openCodeStateSignature;

  useEffect(() => {
    const updateConnection = () => {
      const sessionState = readConnectionSessionPickerStates()[OPENCODE_CLI_CONNECTION.id];
      const nextSignature = [
        isConnectionSessionChecked(OPENCODE_CLI_CONNECTION.id),
        sessionState?.available === true,
        sessionState?.auth ?? 'unknown',
      ].join(':');
      if (nextSignature !== openCodeStateSignatureRef.current) {
        openCodeStateSignatureRef.current = nextSignature;
        invalidateOpenCodeModelCatalog();
      }
      setConnectionRevision((value) => value + 1);
    };
    const refreshCatalog = () => setCatalogRevision((value) => value + 1);
    window.addEventListener(AI_CONNECTION_STATE_EVENT, updateConnection);
    window.addEventListener(KERNEL_SMOKE_BINDING_EVENT, updateConnection);
    window.addEventListener(OPEN_CODE_MODEL_CATALOG_REFRESH_EVENT, refreshCatalog);
    if (!offlineMode) void ensureExternalConnectionAutoDetection().catch(() => undefined);
    return () => {
      window.removeEventListener(AI_CONNECTION_STATE_EVENT, updateConnection);
      window.removeEventListener(KERNEL_SMOKE_BINDING_EVENT, updateConnection);
      window.removeEventListener(OPEN_CODE_MODEL_CATALOG_REFRESH_EVENT, refreshCatalog);
    };
  }, [offlineMode]);

  useEffect(
    () =>
      subscribeDiscoveredOpenAiSubscriptionModels(() => {
        setConnectionRevision((value) => value + 1);
      }),
    [],
  );

  useEffect(
    () =>
      subscribeDiscoveredConnectionModels(() => {
        setConnectionRevision((value) => value + 1);
      }),
    [],
  );
  useEffect(() => {
    const refreshFoundry = () => setFoundryRevision((value) => value + 1);
    window.addEventListener('vibespace:foundry-adapters-changed', refreshFoundry);
    return () =>
      window.removeEventListener('vibespace:foundry-adapters-changed', refreshFoundry);
  }, []);

  useEffect(() => {
    if (offlineMode) return;
    let cancelled = false;
    void import('@/lib/harness/openCodeHarness')
      .then(async ({ openCodeHarness }) => {
        const openai = await openCodeHarness.listModels('openai');
        if (!cancelled && openai.length > 0) {
          setDiscoveredOpenAiSubscriptionModels(
            openai.map((model) => ({ id: model.id, label: model.name || model.id })),
          );
        }
        const zai = await openCodeHarness.listModels('zai');
        if (cancelled || zai.length === 0) return;
        const { setDiscoveredConnectionModels } = await import('./connectionCatalog');
        setDiscoveredConnectionModels(
          'zai-coding-plan',
          zai.map((model) => ({
            id: model.id,
            label: model.name || model.id,
            source: 'opencode_refresh' as const,
            lastVerifiedAt: Date.now(),
          })),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [offlineMode]);

  useEffect(() => {
    if (offlineMode) return;
    let cancelled = false;
    void import('./providerModelCatalog').then(async ({ loadProviderModels }) => {
      const ctx = { apiKeys, offlineMode, plan, defaultLocalModel };
      for (const provider of [
        'openai',
        'anthropic',
        'google',
        'groq',
        'deepseek',
        'zai',
        'qwen',
        'mistral',
        'together',
        'xai',
        'openrouter',
      ] as const) {
        if (cancelled || !apiKeys[provider]?.trim()) continue;
        await loadProviderModels(provider, ctx).catch(() => undefined);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [apiKeys, offlineMode, plan, defaultLocalModel]);

  useEffect(() => {
    if (offlineMode) return;
    const qwenKey = apiKeys.qwen?.trim();
    if (!qwenKey) return;
    let cancelled = false;
    void probeQwenApiCredential(qwenKey).then((state) => {
      if (cancelled) return;
      const current = readConnectionPickerStates();
      writeConnectionPickerStates({
        ...current,
        'qwen-api': reconcileNativeProbeState(current['qwen-api'], state),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [apiKeys.qwen, offlineMode]);

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    if (!openCodeReady || !openCodePersistentAdapter.listModels) {
      return () => {
        cancelled = true;
      };
    }
    const expectedGeneration = openCodeCatalogGeneration;
    void loadOpenCodeModels()
      .then((models) => {
        if (cancelled || expectedGeneration !== openCodeCatalogGeneration) return;
        setOpenCodeModels(models);
        const age = openCodeModelCache ? Date.now() - openCodeModelCache.loadedAt : 0;
        const delay = Math.max(1_000, OPEN_CODE_MODEL_CACHE_TTL_MS - age);
        refreshTimer = setTimeout(() => {
          if (cancelled) return;
          invalidateOpenCodeModelCatalog();
          setCatalogRevision((value) => value + 1);
        }, delay);
      })
      .catch(() => {
        refreshTimer = setTimeout(() => {
          if (cancelled) return;
          invalidateOpenCodeModelCatalog();
          setCatalogRevision((value) => value + 1);
        }, OPEN_CODE_MODEL_FAILURE_RETRY_MS);
      });
    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [openCodeReady, connectionRevision, catalogRevision]);

  const refreshModels = useCallback(() => requestOpenCodeModelCatalogRefresh(), []);
  const ollamaSignature = ollamaOptions.map((option) => option.id).join('\0');

  const groups = useMemo(() => {
    const pickerConnections = offlineMode
      ? PROVIDER_CONNECTIONS.filter((connection) => connection.mode === 'local')
      : PROVIDER_CONNECTIONS;
    const legacy = buildModelPickerGroups({ apiKeys, offlineMode, plan, defaultLocalModel });
    const modelsByProvider: Record<string, PickerCatalogModel[]> = Object.fromEntries(
      legacy.map((group) => [
        group.provider,
        asCatalogModels(
          group.options.map((option) => ({ id: option.modelId, label: option.label })),
          'provider-static',
        ),
      ]),
    );

    const smokeBindingActive = kernelSmokeProvider.isAvailable();
    if (
      smokeBindingActive &&
      pickerConnections.some((connection) => connection.providerId === KERNEL_SMOKE_PROVIDER_ID)
    ) {
      modelsByProvider[KERNEL_SMOKE_PROVIDER_ID] = asCatalogModels(
        [{ id: 'kernel-smoke-v1', label: 'Kernel Smoke v1' }],
        'provider-live',
        Date.now(),
      );
    }

    for (const connection of pickerConnections) {
      if (connection.mode !== 'external-cli' || modelsByProvider[connection.providerId]?.length)
        continue;
      modelsByProvider[connection.providerId] = asCatalogModels(
        CHAT_MODEL_OPTIONS.filter((option) => option.provider === connection.providerId).map(
          (option) => ({ id: option.id, label: option.label }),
        ),
        'provider-static',
      );
    }

    const scanned = readConnectionPickerStates();
    const sessionScanned = readConnectionSessionPickerStates();
    const metadata = readConnectionMetadata();
    const stateByConnection = Object.fromEntries(
      pickerConnections.map((connection) => {
        let state: ConnectionPickerState;
        if (connection.providerId === KERNEL_SMOKE_PROVIDER_ID && smokeBindingActive) {
          state = { available: true, auth: 'authenticated' };
        } else if (
          connection.mode === 'external-cli' &&
          !isConnectionSessionChecked(connection.id)
        ) {
          state = { available: false, auth: 'unknown' };
        } else if (connection.mode === 'external-cli') {
          const current = sessionScanned[connection.id] ?? { available: false, auth: 'unknown' };
          const health = deriveAiConnectionHealth({
            connection,
            metadata: metadata[connection.id] ?? {
              installation: current.available ? 'installed' : 'not-installed',
              auth: current.auth,
            },
          });
          state = { available: health.usable, auth: current.auth };
        } else {
          const health = deriveAiConnectionHealth({
            connection,
            metadata: metadata[connection.id],
            credentialSaved: Boolean(apiKeys[connection.providerId as ProviderId]),
          });
          state =
            scanned[connection.id] ??
            ({
              available: health.usable,
              auth:
                health.auth === 'authenticated' || health.auth === 'not_required'
                  ? 'authenticated'
                  : health.auth,
            } satisfies ConnectionPickerState);
        }
        return [connection.id, state];
      }),
    );

    const modelsByConnection: Record<string, readonly PickerCatalogModel[]> = Object.fromEntries(
      Object.entries(CONNECTION_MODEL_OPTIONS).map(([connectionId, models]) => [
        connectionId,
        asCatalogModels(models ?? [], 'connection-static'),
      ]),
    );

    const openAiSubscriptionModels = resolveOpenAiSubscriptionModels(
      CONNECTION_MODEL_OPTIONS['openai-codex'],
    );
    modelsByConnection['openai-codex'] = asCatalogModels(
      openAiSubscriptionModels,
      getDiscoveredOpenAiSubscriptionModels().length > 0 ? 'opencode-live' : 'connection-static',
      getDiscoveredOpenAiSubscriptionModels().length > 0 ? Date.now() : undefined,
    );

    for (const connection of pickerConnections) {
      const discovered = getDiscoveredConnectionModels(connection.id);
      if (discovered.length === 0) continue;
      modelsByConnection[connection.id] = dedupeModelMetadataInOrder([
        ...(modelsByConnection[connection.id] ?? []),
        ...discovered.map((model) => ({
          id: model.id,
          label: model.label,
          source:
            model.source === 'opencode_refresh'
              ? ('opencode-live' as const)
              : model.source === 'stale_fallback'
                ? ('offline-cache' as const)
                : ('provider-live' as const),
          lastVerifiedAt: model.lastVerifiedAt,
          available: model.unverified !== true,
        })),
      ]);
    }

    if (openCodeModels.length > 0) {
      modelsByConnection[OPENCODE_CLI_CONNECTION.id] = openCodeModels;
    }

    const connectionGroups = buildConnectionPickerGroups({
      connections: pickerConnections,
      modelsByProvider,
      modelsByConnection,
      stateByConnection,
      credentialSavedByProvider: Object.fromEntries(
        pickerConnections.map((connection) => [
          connection.providerId,
          Boolean(apiKeys[connection.providerId as ProviderId]),
        ]),
      ),
    })
      .map((group) => ({
        ...group,
        options: [...group.options].sort(
          (left, right) =>
            Number(right.connectionId === preferredConnections?.[group.provider]) -
              Number(left.connectionId === preferredConnections?.[group.provider]) ||
            Number(right.available !== false) - Number(left.available !== false) ||
            left.label.localeCompare(right.label),
        ),
      }))
      .sort(
        (a, b) =>
          Number(b.options.some((option) => option.available)) -
            Number(a.options.some((option) => option.available)) || a.label.localeCompare(b.label),
      );
    // Promoted Model Foundry adapters are local, credential-free options.
    // They surface only while their evaluation gate stays passed (fail closed
    // inside listPromotedAdapters), and never through a cloud connection.
    void foundryRevision;
    const foundryAdapters =
      typeof window === 'undefined' ? [] : listPromotedAdapters(window.localStorage);
    if (foundryAdapters.length === 0) return connectionGroups;
    const foundryGroup: ModelPickerGroup = {
      provider: 'foundry',
      label: getProviderDisplayName('foundry'),
      options: foundryAdapters.map((record) => ({
        id: `foundry:${record.projectId}--${record.jobId}`,
        provider: 'foundry' as ProviderId,
        modelId: `${record.projectId}--${record.jobId}`,
        label: record.projectName?.trim()
          ? record.projectName.trim()
          : `Local champion · ${record.jobId}`,
        available: true,
        catalogSource: 'provider-live' as const,
      })),
    };
    return [...connectionGroups, foundryGroup];
  }, [
    apiKeys,
    offlineMode,
    plan,
    defaultLocalModel,
    ollamaSignature,
    connectionRevision,
    openCodeModels,
    openCodeReady,
    preferredConnections,
    foundryRevision,
  ]);

  const flatOptions = useMemo(() => groups.flatMap((group) => group.options), [groups]);
  return {
    groups,
    flatOptions,
    hasAny: flatOptions.some((option) => option.available !== false),
    ollamaCount: ollamaOptions.length,
    refreshModels,
  };
}
