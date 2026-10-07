import { FOUNDRY_LOCAL_CONNECTION } from './adapters/nativeCatalog';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ProviderId } from '@/types';
import { useAuthStore } from '@/stores/auth';
import type { ChatBackend } from './backend/chatBackend';
import {
  getProviderDisplayName,
  getProviderRegistryEntry,
  PROVIDER_REGISTRY,
  isLocalProvider,
} from './providerRegistry';
import {
  MODEL_CATALOG_REFRESH_INTERVAL_MS,
  refreshConnectedProviderModels,
} from './providerModelCatalog';
import { listPromotedAdapters } from '@/features/model-foundry/adapterRegistry';
import {
  getAccessibleModelOptions,
  getAccessibleProviders,
  useOllamaModelOptions,
  useFoundryModelOptions,
} from './models';
import type { ProviderConnection, ProviderDiscoveredModel } from './adapters/types';
import {
  CODEX_CLI_CONNECTION,
  OPENCODE_CLI_CONNECTION,
  CONNECTION_MODEL_OPTIONS,
  PROVIDER_CONNECTIONS,
} from './adapters/catalog';
import { ensureExternalConnectionAutoDetection } from './adapters/autoDetectConnections';
import {
  invalidateOpenCodePersistentModelCache,
  openCodePersistentAdapter,
} from './adapters/opencodePersistent';
import {
  codexPersistentAdapter,
  invalidateCodexPersistentModelCache,
} from './adapters/codexPersistent';
import { classifyHarnessModelPricing } from '@/lib/harness/freeModelSelection';
import type { HarnessModelPricing } from '@/lib/harness/types';
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
  openCodeModelRouteOwner,
  canonicalProviderModelId,
  logicalProviderModelId,
  dedupeModelMetadata,
  modelRouteLabel,
  type SimpleModelCatalogRecord,
  type ModelCatalogSource,
} from './catalog/canonicalModelCatalog';
import { subscribeDiscoveredOpenAiSubscriptionModels } from './openCodeOpenAiCatalog';
import {
  getDiscoveredConnectionModels,
  setDiscoveredConnectionModels,
  subscribeDiscoveredConnectionModels,
} from './connectionCatalog';
import { harnessRuntimeManager } from '@/lib/harness/runtimeManager';

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
  pricing?: Readonly<HarnessModelPricing>;
  pricingStatus?: 'free' | 'paid' | 'unknown';
  isFree?: boolean;
  /** Exact live routes for one logical OpenCode model, when more than one exists. */
  alternativeRoutes?: readonly ModelPickerOption[];
}

export interface ModelPickerGroup {
  /** Stable presentation identity; provider alone is not unique across auth/billing surfaces. */
  id?: string;
  provider: ProviderId;
  label: string;
  options: ModelPickerOption[];
}

/**
 * Keep picker routes aligned with the backend's implemented connection
 * surface. The managed OpenCodex bridge currently accepts the exact
 * `opencode-cli` connection; its native resolver still revalidates the
 * selected provider/model and semantic capability before dispatch. Other
 * connections remain available to OpenCode and are not presented as Codex
 * routes merely because they share a model heading.
 */
export function isModelPickerRouteCompatibleWithBackend(
  route: Pick<ModelPickerOption, 'connectionId'> & Partial<Pick<ModelPickerOption, 'provider'>>,
  backend: ChatBackend,
): boolean {
  // Foundry uses its native command boundary before either CLI dispatch branch.
  if (
    route.provider === 'foundry' &&
    (!route.connectionId || route.connectionId === FOUNDRY_LOCAL_CONNECTION.id)
  )
    return true;
  const isOfficialCodexRoute = route.connectionId === CODEX_CLI_CONNECTION.id;
  const isManagedCodexBridgeRoute = route.connectionId === OPENCODE_CLI_CONNECTION.id;
  return backend === 'codex'
    ? isOfficialCodexRoute || isManagedCodexBridgeRoute
    : !isOfficialCodexRoute;
}

function filterModelPickerOptionForBackend(
  option: ModelPickerOption,
  backend: ChatBackend,
): ModelPickerOption | undefined {
  const alternativeRoutes = option.alternativeRoutes;
  const routes = (alternativeRoutes ?? [option]).filter((route) =>
    isModelPickerRouteCompatibleWithBackend(route, backend),
  );
  if (routes.length === 0) return undefined;
  if (!alternativeRoutes) return option;

  const nativeCodexIndex =
    backend === 'codex'
      ? routes.findIndex(
          (route) => route.connectionId === CODEX_CLI_CONNECTION.id && route.available !== false,
        )
      : -1;
  const orderedRoutes =
    nativeCodexIndex > 0
      ? [routes[nativeCodexIndex]!, ...routes.filter((_, index) => index !== nativeCodexIndex)]
      : routes;

  const logicalLabel = option.label.split(' · ')[0]?.trim() || option.label;
  if (orderedRoutes.length === 1) {
    return { ...orderedRoutes[0]!, label: logicalLabel };
  }

  const preferred = orderedRoutes[0]!;
  const allFree = orderedRoutes.every((route) => route.isFree === true);
  return {
    ...preferred,
    label: logicalLabel,
    pricingStatus: allFree ? 'free' : 'unknown',
    isFree: allFree,
    alternativeRoutes: orderedRoutes.map((route) => ({
      ...route,
      label: modelRouteLabel(logicalLabel, route.modeLabel, routes.length),
    })),
  };
}

/**
 * Filter merged picker rows to the backend locked for the current chat. This
 * keeps exact connection metadata intact so the caller cannot silently rename
 * an OpenCode route to Codex or send a Codex route through OpenCode.
 */
export function filterModelPickerGroupsForBackend(
  groups: readonly ModelPickerGroup[],
  backend: ChatBackend | undefined,
): ModelPickerGroup[] {
  if (!backend) return groups.map((group) => ({ ...group, options: [...group.options] }));

  return groups.flatMap((group) => {
    const options = group.options
      .map((option) => filterModelPickerOptionForBackend(option, backend))
      .filter((option): option is ModelPickerOption => option !== undefined);
    return options.length > 0 ? [{ ...group, options }] : [];
  });
}

function modelRouteLeaf(modelId: string): string {
  const normalized = modelId.trim().toLocaleLowerCase('en-US');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function modelRouteOwner(modelId: string, providerId: unknown): string | undefined {
  const normalized = modelId.trim().toLocaleLowerCase('en-US');
  if (!normalized) return undefined;
  const slash = normalized.indexOf('/');
  if (slash > 0) return normalized.slice(0, slash);
  if (typeof providerId !== 'string' || providerId === 'opencode') return undefined;
  return providerId.trim().toLocaleLowerCase('en-US') || undefined;
}

/**
 * Resolve a stale exact selection to the same logical model on the selected
 * chat backend. When switching from the managed OpenCode connection to Codex,
 * prefer a unique native Codex route for the same model if one is available;
 * otherwise retain the supported managed bridge route.
 */
export function findBackendModelPickerRoute(
  selection: Readonly<{
    mode: string;
    providerId?: unknown;
    modelId?: unknown;
    connectionId?: unknown;
  }>,
  options: readonly ModelPickerOption[],
  backend: ChatBackend,
): ModelPickerOption | undefined {
  if (
    selection.mode !== 'single' ||
    typeof selection.modelId !== 'string' ||
    !selection.modelId.trim()
  ) {
    return undefined;
  }

  const currentConnectionId =
    typeof selection.connectionId === 'string' ? selection.connectionId : undefined;
  // A local Foundry selection is already exact; do not repeatedly rebind it to a CLI.
  if (selection.providerId === 'foundry' && currentConnectionId === FOUNDRY_LOCAL_CONNECTION.id)
    return undefined;
  const preferNativeCodexRoute =
    backend === 'codex' && currentConnectionId === OPENCODE_CLI_CONNECTION.id;
  if (
    currentConnectionId &&
    isModelPickerRouteCompatibleWithBackend({ connectionId: currentConnectionId }, backend) &&
    !preferNativeCodexRoute
  ) {
    return undefined;
  }

  const compatible = options.filter(
    (option) =>
      option.available !== false && isModelPickerRouteCompatibleWithBackend(option, backend),
  );
  const selectionOwner = modelRouteOwner(selection.modelId, selection.providerId);
  if (!selectionOwner) return undefined;
  if (preferNativeCodexRoute) {
    const nativeCodexMatches = compatible.filter(
      (option) =>
        option.connectionId === CODEX_CLI_CONNECTION.id &&
        modelRouteLeaf(option.modelId) === modelRouteLeaf(selection.modelId as string) &&
        modelRouteOwner(option.modelId, option.provider) === selectionOwner,
    );
    if (nativeCodexMatches.length === 1) return nativeCodexMatches[0];
  }
  const exact = compatible.filter(
    (option) =>
      option.modelId === selection.modelId &&
      modelRouteOwner(option.modelId, option.provider) === selectionOwner,
  );
  if (exact.length === 1) return exact[0];
  const leaf = modelRouteLeaf(selection.modelId);
  const matches = compatible.filter(
    (option) =>
      modelRouteLeaf(option.modelId) === leaf &&
      modelRouteOwner(option.modelId, option.provider) === selectionOwner,
  );
  const unique = new Map(
    matches.map((option) => [`${option.connectionId}:${option.modelId}`, option]),
  );
  return unique.size === 1 ? unique.values().next().value : undefined;
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

const SUBSCRIPTION_ROUTE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'openai-codex': 'Codex / ChatGPT subscription',
  'anthropic-claude-code': 'Claude Code subscription',
  'google-gemini-cli': 'Gemini CLI subscription',
  'github-copilot-cli': 'GitHub Copilot subscription',
  'qwen-code': 'Qwen Code subscription',
  'zai-coding-plan': 'Z.AI Coding Plan subscription',
});

const UPSTREAM_PROVIDER_LABELS: Readonly<Record<string, string>> = Object.freeze({
  alibaba: 'Alibaba',
  'alibaba-token-plan': 'Alibaba Token Plan',
  azure: 'Azure',
  google: 'Google Gemini',
  moonshot: 'Moonshot',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  qwen: 'Qwen',
  'qwen-coding-plan': 'Qwen Code',
});

function upstreamProviderId(modelId: string): string {
  return canonicalModelId(modelId).split('/').filter(Boolean)[0] ?? '';
}

function upstreamProviderLabel(owner: string): string {
  const exact = UPSTREAM_PROVIDER_LABELS[owner];
  if (exact) return exact;
  const registered = getProviderDisplayName(owner as ProviderId);
  if (registered !== owner) return registered;
  return owner
    .split(/[-_.]+/u)
    .filter(Boolean)
    .map((segment) => `${segment.slice(0, 1).toLocaleUpperCase('en-US')}${segment.slice(1)}`)
    .join(' ');
}

function managedProviderRouteLabel(modelId: string): string {
  const owner = upstreamProviderId(modelId);
  if (owner === 'openai') return 'OpenAI provider connection';
  if (owner === 'google') return 'Gemini CLI subscription';
  if (owner === 'qwen' || owner === 'qwen-coding-plan') return 'Qwen Code subscription';
  if (owner === 'azure') return 'Azure subscription';
  return `${upstreamProviderLabel(owner || 'provider')} provider connection`;
}

export function connectionRouteModeLabel(
  connection: Readonly<ProviderConnection>,
  modelId?: string,
): string {
  if (connection.mode === 'native-api' || connection.mode === 'local') {
    return connection.displayName;
  }
  if (connection.id === OPENCODE_CLI_CONNECTION.id && modelId) {
    return managedProviderRouteLabel(modelId);
  }
  return SUBSCRIPTION_ROUTE_LABELS[connection.id] ?? `${connection.displayName} subscription`;
}

export function connectionRouteProviderLabel(
  connection: Readonly<ProviderConnection>,
  modelId?: string,
): string {
  if (connection.id === OPENCODE_CLI_CONNECTION.id && modelId) {
    return upstreamProviderLabel(upstreamProviderId(modelId) || 'provider');
  }
  return getProviderDisplayName(connection.providerId as ProviderId);
}

/** Explicit model-catalog invalidation used after auth, key, plan, region, or runtime changes. */
export const OPEN_CODE_MODEL_CATALOG_REFRESH_EVENT = 'vibespace:open-code-model-catalog-refresh';
export const OPEN_CODE_CATALOG_EVIDENCE_EVENT = 'vibespace:open-code-catalog-evidence';
export const OPEN_CODE_CATALOG_EVIDENCE_ATTRIBUTE = 'data-vibespace-opencode-catalog-evidence';

const accessibleChatModelRefreshHandlers = new Set<() => Promise<void>>();
let accessibleChatModelRefreshInFlight: Promise<void> | undefined;

/** Refresh the mounted chat catalog before a caller reads its verified CLI routes. */
export function refreshAccessibleChatModelCatalog(): Promise<void> {
  const refresh = [...accessibleChatModelRefreshHandlers].at(-1);
  if (!refresh) {
    return Promise.reject(new Error('The live chat model catalog is not mounted.'));
  }
  if (accessibleChatModelRefreshInFlight) return accessibleChatModelRefreshInFlight;

  const pending = refresh().finally(() => {
    if (accessibleChatModelRefreshInFlight === pending) {
      accessibleChatModelRefreshInFlight = undefined;
    }
  });
  accessibleChatModelRefreshInFlight = pending;
  return pending;
}

export type OpenCodeCatalogRefreshReason =
  | 'initial'
  | 'requested'
  | 'scheduled'
  | 'retry'
  | 'authority-changed';

export interface OpenCodeCatalogEvidence {
  readonly schemaVersion: 1;
  readonly connectionId: typeof OPENCODE_CLI_CONNECTION.id;
  readonly authority: 'current-session-authenticated';
  readonly sessionChecked: true;
  readonly available: true;
  readonly auth: 'authenticated';
  readonly catalogGeneration: number;
  readonly accountGeneration: number;
  readonly refreshReason: OpenCodeCatalogRefreshReason;
  readonly refreshRequestedAt: number;
  readonly lastVerifiedAt: number;
  readonly previousVerifiedAt?: number;
  readonly elapsedSincePreviousVerifiedMs?: number;
  readonly refreshIntervalMs: number;
  readonly routeCount: number;
  readonly catalogSha256: string;
}

const OPEN_CODE_MODEL_CACHE_TTL_MS = MODEL_CATALOG_REFRESH_INTERVAL_MS;
const OPEN_CODE_MODEL_FAILURE_RETRY_MS = 15_000;
const CODEX_MODEL_FAILURE_RETRY_MS = 15_000;
let openCodeCatalogGeneration = 0;
let openCodeAccountGeneration = 0;
let openCodeCatalogRefreshReason: OpenCodeCatalogRefreshReason = 'initial';
let openCodeCatalogRefreshRequestedAt = Date.now();
let openCodeModelCache:
  | {
      readonly generation: number;
      readonly loadedAt: number;
      readonly models: readonly PickerCatalogModel[];
      readonly refreshReason: OpenCodeCatalogRefreshReason;
      readonly refreshRequestedAt: number;
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

const SHA256_ROUND_CONSTANTS = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Browser-safe SHA-256 used only to identify an ordered public catalog without exposing routes. */
function sha256Text(value: string): string {
  const input = new TextEncoder().encode(value);
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15] ?? 0;
      const right = words[index - 2] ?? 0;
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0;
    }

    let a = hash[0] ?? 0;
    let b = hash[1] ?? 0;
    let c = hash[2] ?? 0;
    let d = hash[3] ?? 0;
    let e = hash[4] ?? 0;
    let f = hash[5] ?? 0;
    let g = hash[6] ?? 0;
    let h = hash[7] ?? 0;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 =
        (h + sum1 + choice + (SHA256_ROUND_CONSTANTS[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = ((hash[0] ?? 0) + a) >>> 0;
    hash[1] = ((hash[1] ?? 0) + b) >>> 0;
    hash[2] = ((hash[2] ?? 0) + c) >>> 0;
    hash[3] = ((hash[3] ?? 0) + d) >>> 0;
    hash[4] = ((hash[4] ?? 0) + e) >>> 0;
    hash[5] = ((hash[5] ?? 0) + f) >>> 0;
    hash[6] = ((hash[6] ?? 0) + g) >>> 0;
    hash[7] = ((hash[7] ?? 0) + h) >>> 0;
  }
  return Array.from(hash, (part) => part.toString(16).padStart(8, '0')).join('');
}

function isOpenCodeCatalogEvidence(value: unknown): value is OpenCodeCatalogEvidence {
  if (!value || typeof value !== 'object') return false;
  const evidence = value as Partial<OpenCodeCatalogEvidence>;
  const allowedKeys = new Set([
    'schemaVersion',
    'connectionId',
    'authority',
    'sessionChecked',
    'available',
    'auth',
    'catalogGeneration',
    'accountGeneration',
    'refreshReason',
    'refreshRequestedAt',
    'lastVerifiedAt',
    'previousVerifiedAt',
    'elapsedSincePreviousVerifiedMs',
    'refreshIntervalMs',
    'routeCount',
    'catalogSha256',
  ]);
  const refreshReasons: readonly OpenCodeCatalogRefreshReason[] = [
    'initial',
    'requested',
    'scheduled',
    'retry',
    'authority-changed',
  ];
  const previousPairIsValid =
    evidence.previousVerifiedAt === undefined &&
    evidence.elapsedSincePreviousVerifiedMs === undefined
      ? true
      : Number.isSafeInteger(evidence.previousVerifiedAt) &&
        Number.isSafeInteger(evidence.elapsedSincePreviousVerifiedMs) &&
        (evidence.previousVerifiedAt ?? 0) < (evidence.lastVerifiedAt ?? 0) &&
        evidence.elapsedSincePreviousVerifiedMs ===
          (evidence.lastVerifiedAt ?? 0) - (evidence.previousVerifiedAt ?? 0);
  return (
    Object.keys(value).every((key) => allowedKeys.has(key)) &&
    evidence.schemaVersion === 1 &&
    evidence.connectionId === OPENCODE_CLI_CONNECTION.id &&
    evidence.authority === 'current-session-authenticated' &&
    evidence.sessionChecked === true &&
    evidence.available === true &&
    evidence.auth === 'authenticated' &&
    Number.isSafeInteger(evidence.catalogGeneration) &&
    (evidence.catalogGeneration ?? -1) >= 0 &&
    Number.isSafeInteger(evidence.accountGeneration) &&
    (evidence.accountGeneration ?? -1) >= 0 &&
    refreshReasons.includes(evidence.refreshReason as OpenCodeCatalogRefreshReason) &&
    Number.isSafeInteger(evidence.refreshRequestedAt) &&
    (evidence.refreshRequestedAt ?? 0) > 0 &&
    Number.isSafeInteger(evidence.lastVerifiedAt) &&
    (evidence.lastVerifiedAt ?? 0) >= (evidence.refreshRequestedAt ?? 0) &&
    previousPairIsValid &&
    evidence.refreshIntervalMs === OPEN_CODE_MODEL_CACHE_TTL_MS &&
    Number.isSafeInteger(evidence.routeCount) &&
    (evidence.routeCount ?? 0) > 0 &&
    typeof evidence.catalogSha256 === 'string' &&
    /^[0-9a-f]{64}$/u.test(evidence.catalogSha256)
  );
}

/** Reads the renderer-owned receipt without importing private catalog/session module state. */
export function readOpenCodeCatalogEvidence(): OpenCodeCatalogEvidence | undefined {
  if (typeof document === 'undefined') return undefined;
  const serialized = document.documentElement.getAttribute(OPEN_CODE_CATALOG_EVIDENCE_ATTRIBUTE);
  if (!serialized) return undefined;
  try {
    const evidence: unknown = JSON.parse(serialized);
    return isOpenCodeCatalogEvidence(evidence) ? evidence : undefined;
  } catch {
    return undefined;
  }
}

function clearOpenCodeCatalogEvidence(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.removeAttribute(OPEN_CODE_CATALOG_EVIDENCE_ATTRIBUTE);
}

function publishOpenCodeCatalogEvidence(
  cache: NonNullable<typeof openCodeModelCache>,
  accountGeneration: number,
): void {
  if (typeof document === 'undefined') return;
  const previous = readOpenCodeCatalogEvidence();
  const catalogSha256 = sha256Text(
    cache.models.map((model) => `${OPENCODE_CLI_CONNECTION.id}:${model.id}`).join('\n'),
  );
  if (
    previous?.catalogGeneration === cache.generation &&
    previous.accountGeneration === accountGeneration &&
    previous.lastVerifiedAt === cache.loadedAt &&
    previous.catalogSha256 === catalogSha256
  ) {
    return;
  }
  const previousVerifiedAt = previous?.lastVerifiedAt;
  const evidence: OpenCodeCatalogEvidence = {
    schemaVersion: 1,
    connectionId: OPENCODE_CLI_CONNECTION.id,
    authority: 'current-session-authenticated',
    sessionChecked: true,
    available: true,
    auth: 'authenticated',
    catalogGeneration: cache.generation,
    accountGeneration,
    refreshReason: cache.refreshReason,
    refreshRequestedAt: cache.refreshRequestedAt,
    lastVerifiedAt: cache.loadedAt,
    ...(previousVerifiedAt !== undefined && previousVerifiedAt < cache.loadedAt
      ? {
          previousVerifiedAt,
          elapsedSincePreviousVerifiedMs: cache.loadedAt - previousVerifiedAt,
        }
      : {}),
    refreshIntervalMs: OPEN_CODE_MODEL_CACHE_TTL_MS,
    routeCount: cache.models.length,
    catalogSha256,
  };
  document.documentElement.setAttribute(
    OPEN_CODE_CATALOG_EVIDENCE_ATTRIBUTE,
    JSON.stringify(evidence),
  );
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(OPEN_CODE_CATALOG_EVIDENCE_EVENT, { detail: evidence }));
  }
}

function asCatalogModels(
  models: readonly Readonly<{
    id: string;
    label: string;
    variants?: readonly string[];
    available?: boolean;
    pricing?: Readonly<HarnessModelPricing>;
    pricingStatus?: 'free' | 'paid' | 'unknown';
    isFree?: boolean;
  }>[],
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

/**
 * Build picker rows only from the persistent transport's exact live provider response. Pricing and
 * identity therefore share one runtime, scope, cache generation, and authority boundary.
 */
export function buildLiveOpenCodePickerModels(
  models: readonly Readonly<ProviderDiscoveredModel>[],
  lastVerifiedAt: number,
): PickerCatalogModel[] {
  return dedupeModelMetadataInOrder(
    models.map((model) => {
      const pricingStatus = classifyHarnessModelPricing(model.pricing);
      return {
        id: model.id,
        label: model.label || model.id,
        source: 'opencode-live' as const,
        lastVerifiedAt,
        variants: model.variants,
        available: true,
        ...(pricingStatus === 'unknown' ? {} : { pricing: model.pricing }),
        pricingStatus,
        isFree: pricingStatus === 'free',
      };
    }),
  );
}

function invalidateOpenCodeModelCatalog(
  reason: OpenCodeCatalogRefreshReason = 'requested',
): number {
  openCodeCatalogGeneration += 1;
  openCodeCatalogRefreshReason = reason;
  openCodeCatalogRefreshRequestedAt = Date.now();
  return openCodeCatalogGeneration;
}

async function loadOpenCodeModels(force = false): Promise<readonly PickerCatalogModel[]> {
  const now = Date.now();
  const generation = openCodeCatalogGeneration;
  const refreshReason = openCodeCatalogRefreshReason;
  const refreshRequestedAt = openCodeCatalogRefreshRequestedAt;
  if (
    !force &&
    openCodeModelCache &&
    openCodeModelCache.generation === generation &&
    now - openCodeModelCache.loadedAt < OPEN_CODE_MODEL_CACHE_TTL_MS
  ) {
    return openCodeModelCache.models;
  }
  if (openCodeModelLoad) {
    if (!force && openCodeModelLoad.generation === generation) {
      return openCodeModelLoad.promise;
    }
    // Auth/config invalidation can arrive while the lightweight catalog request is in flight.
    // Join that request, discard its generation-bound result, then start exactly one refresh for
    // the newest generation instead of issuing concurrent provider calls.
    return openCodeModelLoad.promise.catch(() => []).then(() => loadOpenCodeModels(force));
  }
  const promise = (openCodePersistentAdapter.listModels?.() ?? Promise.resolve([]))
    .then((models) => {
      const loadedAt = Date.now();
      const normalized = buildLiveOpenCodePickerModels(models, loadedAt);
      if (normalized.length === 0) {
        throw new Error('The authenticated OpenCode catalog is not ready yet.');
      }
      // An older auth/refresh request must never overwrite a newer catalog.
      if (generation === openCodeCatalogGeneration) {
        openCodeModelCache = {
          generation,
          loadedAt,
          models: normalized,
          refreshReason,
          refreshRequestedAt,
        };
      }
      return normalized;
    })
    .catch((error) => {
      // A cache from an earlier auth/catalog generation is never executable.
      if (openCodeModelCache?.generation === generation) return openCodeModelCache.models;
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
  invalidateOpenCodeModelCatalog('requested');
  invalidateOpenCodePersistentModelCache();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(OPEN_CODE_MODEL_CATALOG_REFRESH_EVENT));
  }
}

type OpenCodeRuntimeCatalogAuthority = Readonly<{
  generation: string | null;
  ready: boolean;
  revision: number;
}>;

let openCodeRuntimeCatalogAuthority: OpenCodeRuntimeCatalogAuthority | undefined;
let releaseOpenCodeRuntimeSubscription: (() => void) | undefined;
const openCodeRuntimeCatalogSubscribers = new Set<() => void>();

function readOpenCodeRuntimeAuthority(): Omit<OpenCodeRuntimeCatalogAuthority, 'revision'> {
  const snapshot = harnessRuntimeManager.getSnapshot();
  const generation =
    snapshot.kind === 'ready' ? (harnessRuntimeManager.getConnection()?.generation ?? null) : null;
  return Object.freeze({
    generation,
    ready: snapshot.kind === 'checking' || generation !== null,
  });
}

function currentOpenCodeRuntimeCatalogAuthority(): OpenCodeRuntimeCatalogAuthority {
  if (!openCodeRuntimeCatalogAuthority) {
    openCodeRuntimeCatalogAuthority = Object.freeze({
      ...readOpenCodeRuntimeAuthority(),
      revision: 0,
    });
  }
  return openCodeRuntimeCatalogAuthority;
}

function reconcileOpenCodeRuntimeCatalogAuthority(): void {
  const current = currentOpenCodeRuntimeCatalogAuthority();
  const next = readOpenCodeRuntimeAuthority();
  if (current.generation === next.generation && current.ready === next.ready) return;
  openCodeRuntimeCatalogAuthority = Object.freeze({
    ...next,
    revision: current.revision + 1,
  });
  openCodeAccountGeneration += 1;
  invalidateOpenCodeModelCatalog('authority-changed');
  invalidateOpenCodePersistentModelCache();
  clearOpenCodeCatalogEvidence();
  openCodeRuntimeCatalogSubscribers.forEach((subscriber) => subscriber());
  if (next.ready && !useAuthStore.getState().offlineMode) {
    // A cold inspection may have finished before the native server was ready.
    // The existing detector queues/deduplicates this generation's fresh scan.
    void ensureExternalConnectionAutoDetection({ force: true }).catch(() => undefined);
  }
}

function subscribeOpenCodeRuntimeCatalogAuthority(subscriber: () => void): () => void {
  openCodeRuntimeCatalogSubscribers.add(subscriber);
  if (!releaseOpenCodeRuntimeSubscription) {
    releaseOpenCodeRuntimeSubscription = harnessRuntimeManager.subscribe(
      reconcileOpenCodeRuntimeCatalogAuthority,
    );
    reconcileOpenCodeRuntimeCatalogAuthority();
  }
  return () => {
    openCodeRuntimeCatalogSubscribers.delete(subscriber);
    if (openCodeRuntimeCatalogSubscribers.size === 0) {
      releaseOpenCodeRuntimeSubscription?.();
      releaseOpenCodeRuntimeSubscription = undefined;
    }
  };
}

function pickerCanonicalModelId(providerId: string, modelId: string): string {
  return canonicalProviderModelId(providerId, modelId);
}

function pickerRouteDisplayName(option: ModelPickerOption): string | undefined {
  const connectionName = option.connection?.displayName?.trim();
  if (option.connectionId !== OPENCODE_CLI_CONNECTION.id) return connectionName;
  return managedProviderRouteLabel(option.modelId);
}

function openCodeBaseLeaf(option: ModelPickerOption): string {
  const segments = canonicalModelId(option.modelId).split('/').filter(Boolean);
  const leaf = segments.at(-1) ?? '';
  const base = leaf.endsWith('-fast') ? leaf.slice(0, -'-fast'.length) : leaf;
  return segments.at(-2) === 'openai' && base === 'gpt-5.6' ? 'gpt-5.6-sol' : base;
}

function openCodeSourceProductKey(option: ModelPickerOption): string {
  const segments = canonicalModelId(option.modelId).split('/').filter(Boolean);
  const leaf = openCodeBaseLeaf(option);
  const providerPath = segments.slice(0, -1);
  if (providerPath[0] === 'qwen-coding-plan') providerPath[0] = 'qwen';
  return [...providerPath, leaf].join('/');
}

function preferOpenCodeRoute(left: ModelPickerOption, right: ModelPickerOption): number {
  const leftSegments = canonicalModelId(left.modelId).split('/').filter(Boolean);
  const rightSegments = canonicalModelId(right.modelId).split('/').filter(Boolean);
  return (
    Number(right.available !== false) - Number(left.available !== false) ||
    Number(right.catalogSource === 'opencode-live') -
      Number(left.catalogSource === 'opencode-live') ||
    Number(canonicalModelId(left.modelId).endsWith('-fast')) -
      Number(canonicalModelId(right.modelId).endsWith('-fast')) ||
    leftSegments.length - rightSegments.length ||
    (leftSegments[0]?.length ?? 0) - (rightSegments[0]?.length ?? 0) ||
    left.id.localeCompare(right.id)
  );
}

function logicalOpenCodeOption(candidateRoutes: readonly ModelPickerOption[]): ModelPickerOption {
  const routes = [...candidateRoutes].sort(preferOpenCodeRoute);
  const preferred = routes[0]!;
  if (routes.length === 1) return preferred;
  const logicalLabel = candidateRoutes[0]!.label.split(' · ')[0]!.trim();
  return { ...preferred, label: logicalLabel, alternativeRoutes: routes };
}

function isDirectOpenAiBaseRoute(option: ModelPickerOption): boolean {
  if (
    option.connectionId !== OPENCODE_CLI_CONNECTION.id ||
    option.catalogSource !== 'opencode-live' ||
    option.available === false
  ) {
    return false;
  }
  const segments = canonicalModelId(option.modelId).split('/').filter(Boolean);
  return segments.length === 2 && segments[0] === 'openai' && !segments[1]!.endsWith('-fast');
}

function isDirectOpenAiRoute(option: ModelPickerOption): boolean {
  if (
    option.connectionId !== OPENCODE_CLI_CONNECTION.id ||
    option.catalogSource !== 'opencode-live' ||
    option.available === false
  ) {
    return false;
  }
  const segments = canonicalModelId(option.modelId).split('/').filter(Boolean);
  return segments.length === 2 && segments[0] === 'openai';
}

function openCodeProviderGroupLabel(owner: string): string {
  if (owner === 'openrouter') return 'OpenRouter Models';
  if (owner === 'qwen') return 'Qwen Models';
  if (owner === 'openai') return 'OpenAI';
  return `${upstreamProviderLabel(owner)} Models`;
}

/**
 * Present one authenticated OpenAI-subscription row per direct live product while preserving every
 * exact OpenCode route. Nested aggregators can be alternatives, but can never seed subscription
 * authority. Unconsumed providers remain selectable under their own truthful source group.
 */
function partitionOpenCodePickerGroup(group: ModelPickerGroup): ModelPickerGroup[] {
  const unconsumed = new Map(group.options.map((option) => [option.id, option]));
  const subscriptionOptions: ModelPickerOption[] = [];
  const subscriptionKeys = new Set<string>();
  // Index eligible exact routes once. Rescanning the whole multi-provider
  // catalog for every OpenAI seed blocks the renderer as the catalog grows.
  const directRoutesByBase = new Map<string, ModelPickerOption[]>();
  for (const route of group.options) {
    if (!isDirectOpenAiRoute(route)) continue;
    const key = openCodeBaseLeaf(route);
    const routes = directRoutesByBase.get(key) ?? [];
    routes.push(route);
    directRoutesByBase.set(key, routes);
  }

  for (const seed of group.options.filter(isDirectOpenAiBaseRoute)) {
    const key = openCodeBaseLeaf(seed);
    if (subscriptionKeys.has(key)) continue;
    subscriptionKeys.add(key);
    const routes = directRoutesByBase.get(key)!;
    for (const route of routes) unconsumed.delete(route.id);
    subscriptionOptions.push(logicalOpenCodeOption(routes));
  }

  const result: ModelPickerGroup[] = [];
  if (subscriptionOptions.length > 0) {
    result.push({
      id: 'opencode:openai-subscription',
      provider: 'openai',
      label: 'OpenAI',
      options: subscriptionOptions,
    });
  }

  const routesByOwner = new Map<string, ModelPickerOption[]>();
  for (const route of unconsumed.values()) {
    const owner = openCodeModelRouteOwner(route.modelId);
    const routes = routesByOwner.get(owner) ?? [];
    routes.push(route);
    routesByOwner.set(owner, routes);
  }
  for (const [owner, providerRoutes] of routesByOwner) {
    const logicalRoutes = new Map<string, ModelPickerOption[]>();
    for (const route of providerRoutes) {
      const key = openCodeSourceProductKey(route);
      const routes = logicalRoutes.get(key) ?? [];
      routes.push(route);
      logicalRoutes.set(key, routes);
    }
    result.push({
      id: `opencode:${owner}`,
      provider: (getProviderRegistryEntry(owner as ProviderId)
        ? owner
        : group.provider) as ProviderId,
      label: openCodeProviderGroupLabel(owner),
      options: [...logicalRoutes.values()].map(logicalOpenCodeOption),
    });
  }
  return result;
}

/** Pure connection-qualified picker builder; unavailable entries remain visible but disabled. */
export function buildConnectionPickerGroups(args: {
  connections: readonly Readonly<ProviderConnection>[];
  modelsByProvider: Partial<Record<string, readonly PickerCatalogModel[]>>;
  modelsByConnection?: Partial<Record<string, readonly PickerCatalogModel[]>>;
  stateByConnection?: Partial<Record<string, ConnectionPickerState>>;
  credentialSavedByProvider?: Partial<Record<string, boolean>>;
}): ModelPickerGroup[] {
  const groups = new Map<string, ModelPickerGroup>();

  for (const connection of args.connections) {
    const models = dedupeModelMetadataInOrder(
      args.modelsByConnection?.[connection.id] ??
        args.modelsByProvider[connection.providerId] ??
        [],
    );
    if (models.length === 0) continue;

    const groupId = `connection:${connection.id}`;
    const group = groups.get(groupId) ?? {
      id: groupId,
      provider: connection.providerId as ProviderId,
      label: connection.displayName,
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
      // The CLI connection owns transport; a verified qualified route owns the model provider.
      // Retain unmapped routes rather than guessing a declared provider from a model label.
      const modelOwner = connection.id === OPENCODE_CLI_CONNECTION.id && model.id.includes('/')
        ? openCodeModelRouteOwner(model.id)
        : undefined;
      const modelProvider = modelOwner
        ? PROVIDER_REGISTRY.find((entry) => entry.id === modelOwner)?.id
        : undefined;
      group.options.push({
        id: `${connection.id}:${model.id}`,
        provider: modelProvider ?? (connection.providerId as ProviderId),
        modelId: model.id,
        label: model.label,
        connection,
        connectionId: connection.id,
        modeLabel: connectionRouteModeLabel(connection, model.id),
        authLabel: model.available === false ? 'Unavailable' : connectionAuthLabel(state),
        available: state.available && authAllowsUse && model.available !== false,
        catalogSource: model.source,
        lastVerifiedAt: model.lastVerifiedAt,
        variants: model.variants,
        pricing: model.pricing,
        pricingStatus: model.pricingStatus,
        isFree: model.isFree,
      });
    }
    groups.set(groupId, group);
  }

  // Present documented aliases once inside an exact connection while retaining
  // every exact upstream route for selection and dispatch.
  for (const group of groups.values()) {
    const routesByLogicalModel = new Map<string, ModelPickerOption[]>();
    for (const option of group.options) {
      const modelKey = logicalProviderModelId(group.provider, option.modelId);
      const routeKey = `${option.connectionId ?? ''}\u0000${modelKey}`;
      const routes = routesByLogicalModel.get(routeKey) ?? [];
      routes.push(option);
      routesByLogicalModel.set(routeKey, routes);
    }
    const visible = [...routesByLogicalModel.values()].map((routes) => {
      const exact = dedupeModelMetadataInOrder(
        routes.map((route) => ({ id: route.id, label: route.label })),
      );
      const exactIds = new Set(exact.map((route) => route.id));
      const uniqueRoutes = routes.filter((route) => exactIds.has(route.id));
      const preferred = uniqueRoutes[0]!;
      return uniqueRoutes.length > 1
        ? { ...preferred, alternativeRoutes: uniqueRoutes }
        : preferred;
    });
    const routeCounts = new Map<string, number>();
    const labelCounts = new Map<string, number>();
    for (const option of visible) {
      const key = pickerCanonicalModelId(group.provider, option.modelId);
      routeCounts.set(key, (routeCounts.get(key) ?? 0) + 1);
      const labelKey = option.label.trim().toLocaleLowerCase('en-US');
      labelCounts.set(labelKey, (labelCounts.get(labelKey) ?? 0) + 1);
    }
    const labeled = visible.map((option) => {
      const key = pickerCanonicalModelId(group.provider, option.modelId);
      const labelKey = option.label.trim().toLocaleLowerCase('en-US');
      return {
        ...option,
        label: modelRouteLabel(
          option.label,
          pickerRouteDisplayName(option),
          Math.max(routeCounts.get(key) ?? 1, labelCounts.get(labelKey) ?? 1),
        ),
      };
    });
    group.options = labeled;
  }

  const partitioned = [...groups.values()].flatMap((group) =>
    group.provider === ('opencode' as ProviderId) ? partitionOpenCodePickerGroup(group) : [group],
  );
  const openAiGroups = partitioned.filter((group) => group.provider === 'openai');
  if (openAiGroups.length === 0) return partitioned;
  const openAiRoutesByModel = new Map<string, ModelPickerOption[]>();
  for (const option of openAiGroups.flatMap((group) => group.options)) {
    const key = logicalProviderModelId('openai', option.modelId);
    for (const route of option.alternativeRoutes ?? [option]) {
      const routes = openAiRoutesByModel.get(key) ?? [];
      if (!routes.some((candidate) => candidate.id === route.id)) routes.push(route);
      openAiRoutesByModel.set(key, routes);
    }
  }
  const mergedOpenAi: ModelPickerGroup = {
    id: 'provider:openai',
    provider: 'openai',
    label: 'OpenAI',
    options: [...openAiRoutesByModel.values()].map((routes) => {
      const preferred = routes[0]!;
      const label = preferred.label.split(' · ')[0]!.trim();
      if (routes.length === 1) return { ...preferred, label };
      const allFree = routes.every((route) => route.isFree === true);
      return {
        ...preferred,
        label,
        pricingStatus: allFree ? ('free' as const) : ('unknown' as const),
        isFree: allFree,
        alternativeRoutes: routes.map((route) => ({
          ...route,
          label: modelRouteLabel(label, route.modeLabel, routes.length),
        })),
      };
    }),
  };
  let inserted = false;
  return partitioned.flatMap((group) => {
    if (group.provider !== 'openai') return [group];
    if (inserted) return [];
    inserted = true;
    return [mergedOpenAi];
  });
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
      id: `provider:${provider}`,
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
  const preferredConnections = useAuthStore((s) => s.preferredConnectionIdByProviderFamily ?? {});
  const ollamaOptions = useOllamaModelOptions();
  const nativeFoundryOptions = useFoundryModelOptions();
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [foundryRevision, setFoundryRevision] = useState(0);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [codexCatalogRevision, setCodexCatalogRevision] = useState(0);
  const openCodeRuntimeAuthority = useSyncExternalStore(
    subscribeOpenCodeRuntimeCatalogAuthority,
    currentOpenCodeRuntimeCatalogAuthority,
    currentOpenCodeRuntimeCatalogAuthority,
  );
  const [openCodeCatalog, setOpenCodeCatalog] = useState<{
    readonly generation: number;
    readonly accountGeneration: number;
    readonly models: readonly PickerCatalogModel[];
  }>({ generation: -1, accountGeneration: openCodeAccountGeneration, models: [] });

  const openCodeSessionState = readConnectionSessionPickerStates()[OPENCODE_CLI_CONNECTION.id];
  const openCodeSessionChecked = isConnectionSessionChecked(OPENCODE_CLI_CONNECTION.id);
  const openCodeReady =
    !offlineMode &&
    openCodeRuntimeAuthority.ready &&
    openCodeSessionChecked &&
    openCodeSessionState?.available === true &&
    openCodeSessionState.auth === 'authenticated';
  const codexSessionState = readConnectionSessionPickerStates()['openai-codex'];
  const codexReady =
    !offlineMode &&
    isConnectionSessionChecked('openai-codex') &&
    codexSessionState?.available === true &&
    codexSessionState.auth === 'authenticated';
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
        openCodeAccountGeneration += 1;
        invalidateOpenCodeModelCatalog('authority-changed');
        invalidateOpenCodePersistentModelCache();
        if (
          !isConnectionSessionChecked(OPENCODE_CLI_CONNECTION.id) ||
          sessionState?.available !== true ||
          sessionState.auth !== 'authenticated'
        ) {
          clearOpenCodeCatalogEvidence();
        }
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
    return () => window.removeEventListener('vibespace:foundry-adapters-changed', refreshFoundry);
  }, []);

  useEffect(() => {
    if (offlineMode) return;
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      const ctx = { apiKeys, offlineMode, plan, defaultLocalModel };
      void refreshConnectedProviderModels(ctx)
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) refreshTimer = setTimeout(refresh, MODEL_CATALOG_REFRESH_INTERVAL_MS);
        });
    };
    refresh();
    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [apiKeys, offlineMode, plan, defaultLocalModel]);

  useEffect(() => {
    const refreshCodexCatalog = () => {
      invalidateCodexPersistentModelCache();
      setCodexCatalogRevision((value) => value + 1);
    };
    window.addEventListener(AI_CONNECTION_STATE_EVENT, refreshCodexCatalog);
    return () => window.removeEventListener(AI_CONNECTION_STATE_EVENT, refreshCodexCatalog);
  }, []);

  useEffect(() => {
    if (!codexReady) {
      setDiscoveredConnectionModels('openai-codex', []);
      return;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const loadCodexModels = codexPersistentAdapter.listModels;
    if (!loadCodexModels) return undefined;
    const scheduleRefresh = (delay: number) => {
      retryTimer = setTimeout(() => {
        if (cancelled) return;
        invalidateCodexPersistentModelCache();
        setCodexCatalogRevision((value) => value + 1);
      }, delay);
    };
    void loadCodexModels()
      .then((models) => {
        if (cancelled) return;
        if (models.length === 0) {
          scheduleRefresh(CODEX_MODEL_FAILURE_RETRY_MS);
          return;
        }
        const verifiedAt = Date.now();
        setDiscoveredConnectionModels(
          'openai-codex',
          models.map((model) => ({
            id: model.id,
            label: model.label,
            ...(model.variants ? { variants: model.variants } : {}),
            ...(model.defaultReasoningEffort
              ? { defaultReasoningEffort: model.defaultReasoningEffort }
              : {}),
            source: 'cli_model' as const,
            lastVerifiedAt: verifiedAt,
          })),
        );
        scheduleRefresh(MODEL_CATALOG_REFRESH_INTERVAL_MS);
      })
      .catch(() => {
        if (!cancelled) scheduleRefresh(CODEX_MODEL_FAILURE_RETRY_MS);
      });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [codexCatalogRevision, codexReady]);

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
    if (!openCodeReady) {
      clearOpenCodeCatalogEvidence();
      return () => {
        cancelled = true;
      };
    }
    const expectedGeneration = openCodeCatalogGeneration;
    const expectedAccountGeneration = openCodeAccountGeneration;
    void loadOpenCodeModels()
      .then((models) => {
        // This load is shared. A retired consumer cannot clear the receipt
        // published by a surviving consumer of the same verified catalog.
        if (cancelled) return;
        const currentSessionState = readConnectionSessionPickerStates()[OPENCODE_CLI_CONNECTION.id];
        if (
          expectedGeneration !== openCodeCatalogGeneration ||
          expectedAccountGeneration !== openCodeAccountGeneration ||
          !isConnectionSessionChecked(OPENCODE_CLI_CONNECTION.id) ||
          currentSessionState?.available !== true ||
          currentSessionState.auth !== 'authenticated'
        ) {
          clearOpenCodeCatalogEvidence();
          return;
        }
        setOpenCodeCatalog({
          generation: expectedGeneration,
          accountGeneration: expectedAccountGeneration,
          models,
        });
        if (openCodeModelCache?.generation === expectedGeneration) {
          publishOpenCodeCatalogEvidence(openCodeModelCache, expectedAccountGeneration);
        }
        const age = openCodeModelCache ? Date.now() - openCodeModelCache.loadedAt : 0;
        const delay = Math.max(1_000, OPEN_CODE_MODEL_CACHE_TTL_MS - age);
        refreshTimer = setTimeout(() => {
          if (cancelled) return;
          invalidateOpenCodeModelCatalog('scheduled');
          setCatalogRevision((value) => value + 1);
        }, delay);
      })
      .catch(() => {
        if (cancelled || expectedGeneration !== openCodeCatalogGeneration) return;
        setOpenCodeCatalog((current) =>
          current.accountGeneration === expectedAccountGeneration
            ? current
            : {
                generation: expectedGeneration,
                accountGeneration: expectedAccountGeneration,
                models: [],
              },
        );
        refreshTimer = setTimeout(() => {
          if (cancelled) return;
          invalidateOpenCodeModelCatalog('retry');
          setCatalogRevision((value) => value + 1);
        }, OPEN_CODE_MODEL_FAILURE_RETRY_MS);
      });
    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [openCodeReady, openCodeRuntimeAuthority.revision, connectionRevision, catalogRevision]);

  const refreshModels = useCallback(async () => {
    await ensureExternalConnectionAutoDetection({ force: true }).catch(() => undefined);

    const isLiveCliReady = (connectionId: string): boolean => {
      const session = readConnectionSessionPickerStates()[connectionId];
      return (
        !useAuthStore.getState().offlineMode &&
        isConnectionSessionChecked(connectionId) &&
        session?.available === true &&
        session.auth === 'authenticated'
      );
    };
    const codexReadyNow = isLiveCliReady(CODEX_CLI_CONNECTION.id);
    const openCodeAuthority = currentOpenCodeRuntimeCatalogAuthority();
    const openCodeReadyNow = isLiveCliReady(OPENCODE_CLI_CONNECTION.id) && openCodeAuthority.ready;

    if (!codexReadyNow) {
      setDiscoveredConnectionModels(CODEX_CLI_CONNECTION.id, []);
    }
    if (!openCodeReadyNow) {
      setDiscoveredConnectionModels(OPENCODE_CLI_CONNECTION.id, []);
      clearOpenCodeCatalogEvidence();
      setOpenCodeCatalog({
        generation: -1,
        accountGeneration: openCodeAccountGeneration,
        models: [],
      });
    }

    const expectedAccountGeneration = openCodeAccountGeneration;
    const expectedGeneration = openCodeReadyNow
      ? invalidateOpenCodeModelCatalog('requested')
      : undefined;
    if (openCodeReadyNow) invalidateOpenCodePersistentModelCache();
    if (codexReadyNow) invalidateCodexPersistentModelCache();

    const codexLoad = codexReadyNow
      ? (codexPersistentAdapter.listModels?.() ?? Promise.resolve([]))
      : Promise.resolve(undefined);
    const openCodeLoad = openCodeReadyNow ? loadOpenCodeModels(true) : Promise.resolve(undefined);
    const [codexResult, openCodeResult] = await Promise.allSettled([codexLoad, openCodeLoad]);

    const currentCodexReady = isLiveCliReady(CODEX_CLI_CONNECTION.id);
    if (!currentCodexReady) {
      setDiscoveredConnectionModels(CODEX_CLI_CONNECTION.id, []);
    } else if (
      codexResult.status === 'fulfilled' &&
      codexResult.value &&
      codexResult.value.length > 0
    ) {
      const verifiedAt = Date.now();
      setDiscoveredConnectionModels(
        CODEX_CLI_CONNECTION.id,
        codexResult.value.map((model) => ({
          id: model.id,
          label: model.label,
          ...(model.variants ? { variants: model.variants } : {}),
          ...(model.defaultReasoningEffort
            ? { defaultReasoningEffort: model.defaultReasoningEffort }
            : {}),
          source: 'cli_model' as const,
          lastVerifiedAt: verifiedAt,
        })),
      );
    }

    const currentOpenCodeAuthority = currentOpenCodeRuntimeCatalogAuthority();
    const currentOpenCodeReady =
      isLiveCliReady(OPENCODE_CLI_CONNECTION.id) && currentOpenCodeAuthority.ready;
    if (!currentOpenCodeReady) {
      setDiscoveredConnectionModels(OPENCODE_CLI_CONNECTION.id, []);
      clearOpenCodeCatalogEvidence();
      setOpenCodeCatalog({
        generation: -1,
        accountGeneration: openCodeAccountGeneration,
        models: [],
      });
    } else if (
      expectedGeneration !== undefined &&
      expectedGeneration === openCodeCatalogGeneration &&
      expectedAccountGeneration === openCodeAccountGeneration &&
      currentOpenCodeAuthority.generation === openCodeAuthority.generation &&
      openCodeResult.status === 'fulfilled' &&
      openCodeResult.value &&
      openCodeResult.value.length > 0
    ) {
      const verifiedAt = Date.now();
      const models = openCodeResult.value;
      setOpenCodeCatalog({
        generation: expectedGeneration,
        accountGeneration: expectedAccountGeneration,
        models,
      });
      setDiscoveredConnectionModels(
        OPENCODE_CLI_CONNECTION.id,
        models.map((model) => ({
          id: model.id,
          label: model.label,
          ...(model.variants ? { variants: model.variants } : {}),
          source: 'opencode_refresh' as const,
          lastVerifiedAt: model.lastVerifiedAt ?? verifiedAt,
        })),
      );
      if (openCodeModelCache?.generation === expectedGeneration) {
        publishOpenCodeCatalogEvidence(openCodeModelCache, expectedAccountGeneration);
      }
    }
  }, []);
  useEffect(() => {
    accessibleChatModelRefreshHandlers.add(refreshModels);
    return () => {
      accessibleChatModelRefreshHandlers.delete(refreshModels);
    };
  }, [refreshModels]);
  const ollamaSignature = ollamaOptions.map((option) => option.id).join('\0');

  const groups = useMemo(() => {
    // Foundry has its own verified artifact catalog below, not a generic discovery probe.
    const pickerConnections = PROVIDER_CONNECTIONS.filter(
      (connection) =>
        connection.id !== FOUNDRY_LOCAL_CONNECTION.id &&
        (!offlineMode || connection.mode === 'local'),
    );
    const legacy = buildModelPickerGroups({ apiKeys, offlineMode, plan, defaultLocalModel });
    const modelsByProvider: Record<string, PickerCatalogModel[]> = Object.fromEntries(
      legacy
        .filter(
          (group) =>
            isLocalProvider(group.provider) ||
            getProviderRegistryEntry(group.provider)?.supportsDynamicListing !== true,
        )
        .map((group) => [
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

    // Subscription CLI hints are not a catalog or an authorization result.
    // The active session plus its live catalog must prove a provider/model
    // route before it is shown anywhere in the picker.
    for (const connection of pickerConnections) {
      if (connection.mode !== 'external-cli') continue;
      if (connection.providerId === KERNEL_SMOKE_PROVIDER_ID && smokeBindingActive) {
        delete modelsByConnection[connection.id];
      } else {
        modelsByConnection[connection.id] = [];
      }
    }

    // Cached rows may survive a transient load failure, but current-session
    // readiness remains the authority for whether they are visible as live.
    const currentLiveOpenCodeModels =
      openCodeReady && openCodeCatalog.accountGeneration === openCodeAccountGeneration
        ? openCodeCatalog.models
        : [];
    for (const connection of pickerConnections) {
      if (
        connection.mode === 'external-cli' &&
        stateByConnection[connection.id]?.auth !== 'authenticated'
      ) {
        continue;
      }
      const discovered = getDiscoveredConnectionModels(connection.id);
      if (discovered.length === 0) continue;
      const discoveredModels = discovered.map((model) => ({
        id: model.id,
        label: model.label,
        ...(model.variants ? { variants: model.variants } : {}),
        source:
          model.source === 'opencode_refresh'
            ? ('opencode-live' as const)
            : model.source === 'stale_fallback'
              ? ('offline-cache' as const)
              : ('provider-live' as const),
        lastVerifiedAt: model.lastVerifiedAt,
        available: model.unverified !== true,
      }));
      const hasCurrentLiveAuthority = discovered.some((model) => model.unverified !== true);
      modelsByConnection[connection.id] = dedupeModelMetadataInOrder(
        hasCurrentLiveAuthority
          ? discoveredModels
          : [...(modelsByConnection[connection.id] ?? []), ...discoveredModels],
      );
    }

    if (currentLiveOpenCodeModels.length > 0) {
      // Live catalog truth replaces static hints; it is never unioned with them.
      modelsByConnection[OPENCODE_CLI_CONNECTION.id] = currentLiveOpenCodeModels;
    } else {
      modelsByConnection[OPENCODE_CLI_CONNECTION.id] = [];
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
    if (foundryAdapters.length === 0 && nativeFoundryOptions.length === 0) return connectionGroups;
    const foundryGroup: ModelPickerGroup = {
      id: 'provider:foundry',
      provider: 'foundry',
      label: getProviderDisplayName('foundry'),
      options: [
        ...nativeFoundryOptions.map((model) => ({
          id: `foundry:${model.id}`,
          provider: 'foundry' as ProviderId,
          connectionId: FOUNDRY_LOCAL_CONNECTION.id,
          connection: FOUNDRY_LOCAL_CONNECTION,
          modelId: model.id,
          label: model.label,
          available: true,
          catalogSource: 'provider-live' as const,
        })),
        ...foundryAdapters.map((record) => ({
          id: `foundry:${record.projectId}--${record.jobId}`,
          provider: 'foundry' as ProviderId,
          connectionId: FOUNDRY_LOCAL_CONNECTION.id,
          connection: FOUNDRY_LOCAL_CONNECTION,
          modelId: `${record.projectId}--${record.jobId}`,
          label: record.projectName?.trim()
            ? record.projectName.trim()
            : `Local champion · ${record.jobId}`,
          available: true,
          catalogSource: 'provider-live' as const,
        })),
      ],
    };
    return [...connectionGroups, foundryGroup];
  }, [
    apiKeys,
    offlineMode,
    plan,
    defaultLocalModel,
    ollamaSignature,
    connectionRevision,
    catalogRevision,
    openCodeCatalog,
    openCodeReady,
    preferredConnections,
    foundryRevision,
    nativeFoundryOptions,
  ]);

  const flatOptions = useMemo(
    () =>
      groups.flatMap((group) =>
        group.options.flatMap((option) => option.alternativeRoutes ?? [option]),
      ),
    [groups],
  );
  return {
    groups,
    flatOptions,
    hasAny: flatOptions.some((option) => option.available !== false),
    ollamaCount: ollamaOptions.length,
    refreshModels,
  };
}
