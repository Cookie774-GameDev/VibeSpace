export type ModelCatalogSource =
  | 'opencode-live'
  | 'provider-live'
  | 'connection-static'
  | 'provider-static'
  | 'offline-cache';

export interface ModelVariantRecord {
  id: string;
  label?: string;
  kind?: 'reasoning' | 'latency' | 'combined' | 'other';
  reasoningEffort?: string;
  fast?: boolean;
}

export interface SimpleModelCatalogRecord {
  id: string;
  label: string;
  source?: ModelCatalogSource;
  lastVerifiedAt?: number;
  variants?: readonly string[];
  available?: boolean;
}

export interface ConnectionModelRecord {
  connectionId: string;
  providerId: string;
  modelId: string;
  displayName: string;
  available: boolean;
  unavailableReason?: string;
  source: ModelCatalogSource;
  lastVerifiedAt: number;
  variants?: readonly ModelVariantRecord[];
  capabilities?: Readonly<Record<string, boolean>>;
  serviceTiers?: readonly string[];
  legacyTransport?: boolean;
}

export interface PickerRoute {
  connectionId: string;
  available: boolean;
  unavailableReason?: string;
  source: ModelCatalogSource;
  lastVerifiedAt: number;
  variants: readonly ModelVariantRecord[];
  capabilities: Readonly<Record<string, boolean>>;
  serviceTiers: readonly string[];
  legacyTransport: boolean;
}

export interface CanonicalModelPickerRow {
  key: string;
  providerId: string;
  modelId: string;
  displayName: string;
  available: boolean;
  preferredConnectionId: string;
  routes: readonly PickerRoute[];
}

const SOURCE_PRIORITY: Readonly<Record<ModelCatalogSource, number>> = Object.freeze({
  'opencode-live': 50,
  'provider-live': 40,
  'connection-static': 30,
  'provider-static': 20,
  'offline-cache': 10,
});

function cleanIdentifier(value: string, field: string): string {
  const clean = value.trim();
  if (!clean || clean.length > 512 || /[\u0000-\u001f\u007f]/u.test(clean)) {
    throw new Error(`invalid_${field}`);
  }
  return clean;
}

export function canonicalIdentifier(value: string): string {
  return cleanIdentifier(value, 'identifier').toLocaleLowerCase('en-US').replace(/\s+/gu, '');
}

/**
 * OpenCode commonly returns a qualified ID such as `openai/gpt-5.6-sol`, while
 * a direct provider catalog may return `gpt-5.6-sol`. Strip only the exact
 * provider prefix; never guess across providers or erase meaningful suffixes.
 */
export function canonicalProviderModelId(providerId: string, modelId: string): string {
  const provider = canonicalIdentifier(providerId);
  const model = canonicalIdentifier(modelId);
  const exactPrefix = `${provider}/`;
  return model.startsWith(exactPrefix) ? model.slice(exactPrefix.length) : model;
}

export function canonicalModelId(modelId: string): string {
  return canonicalIdentifier(modelId);
}

function simpleRecordScore(record: Readonly<SimpleModelCatalogRecord>): number {
  const source = record.source ? SOURCE_PRIORITY[record.source] : 0;
  const available = record.available === false ? 0 : 1_000_000;
  const freshness = Math.max(0, Math.min(999_999, Math.floor((record.lastVerifiedAt ?? 0) / 1_000)));
  return available + source * 1_000_000 + freshness;
}

function mergeStringVariants(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): readonly string[] | undefined {
  const values = [...(left ?? []), ...(right ?? [])]
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) return undefined;
  return [...new Map(values.map((value) => [canonicalIdentifier(value), value])).values()].sort((a, b) =>
    a.localeCompare(b),
  );
}

/** Deduplicate metadata inside one exact connection. */
export function dedupeModelMetadata(
  records: readonly Readonly<SimpleModelCatalogRecord>[],
): SimpleModelCatalogRecord[] {
  const byId = new Map<string, SimpleModelCatalogRecord>();
  for (const raw of records) {
    const id = raw.id.trim();
    if (!id) continue;
    const candidate: SimpleModelCatalogRecord = { ...raw, id, label: raw.label.trim() || id };
    const key = canonicalModelId(id);
    const current = byId.get(key);
    if (!current) {
      byId.set(key, candidate);
      continue;
    }
    const winner = simpleRecordScore(candidate) > simpleRecordScore(current) ? candidate : current;
    const loser = winner === candidate ? current : candidate;
    byId.set(key, {
      ...loser,
      ...winner,
      variants: mergeStringVariants(current.variants, candidate.variants),
    });
  }
  return [...byId.values()].sort(
    (a, b) => a.label.localeCompare(b.label) || canonicalModelId(a.id).localeCompare(canonicalModelId(b.id)),
  );
}

/** Backward-compatible alias for the older picker helper. */
export const dedupeConnectionModelMetadata = dedupeModelMetadata;

export function modelRouteLabel(
  modelLabel: string,
  connectionDisplayName: string | undefined,
  duplicateRouteCount: number,
): string {
  const label = modelLabel.trim();
  if (duplicateRouteCount <= 1 || !connectionDisplayName?.trim()) return label;
  return `${label} · ${connectionDisplayName.trim()}`;
}

export function connectionModelKey(
  record: Pick<ConnectionModelRecord, 'connectionId' | 'providerId' | 'modelId'>,
): string {
  return `${canonicalIdentifier(record.connectionId)}\u0000${canonicalProviderModelId(record.providerId, record.modelId)}`;
}

export function providerModelKey(
  record: Pick<ConnectionModelRecord, 'providerId' | 'modelId'>,
): string {
  return `${canonicalIdentifier(record.providerId)}\u0000${canonicalProviderModelId(record.providerId, record.modelId)}`;
}

function normalizeVariants(input: readonly ModelVariantRecord[] | undefined): ModelVariantRecord[] {
  const byId = new Map<string, ModelVariantRecord>();
  for (const candidate of input ?? []) {
    const id = cleanIdentifier(candidate.id, 'variant_id');
    const key = canonicalIdentifier(id);
    const current = byId.get(key);
    const normalized: ModelVariantRecord = {
      id,
      ...(candidate.label?.trim() ? { label: candidate.label.trim() } : {}),
      ...(candidate.kind ? { kind: candidate.kind } : {}),
      ...(candidate.reasoningEffort?.trim()
        ? { reasoningEffort: candidate.reasoningEffort.trim() }
        : {}),
      ...(candidate.fast === true ? { fast: true } : {}),
    };
    if (!current) {
      byId.set(key, normalized);
      continue;
    }
    byId.set(key, {
      ...current,
      ...normalized,
      label: normalized.label ?? current.label,
      kind: normalized.kind ?? current.kind,
      reasoningEffort: normalized.reasoningEffort ?? current.reasoningEffort,
      fast: current.fast === true || normalized.fast === true || undefined,
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeCapabilities(
  input: Readonly<Record<string, boolean>> | undefined,
): Readonly<Record<string, boolean>> {
  const output: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    const clean = key.trim();
    if (clean && clean.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(clean)) {
      output[clean] = Boolean(value);
    }
  }
  return Object.freeze(output);
}

function normalizeServiceTiers(input: readonly string[] | undefined): readonly string[] {
  return Object.freeze(
    [...new Map((input ?? [])
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => [canonicalIdentifier(value), value])).values()].sort((a, b) => a.localeCompare(b)),
  );
}

function normalizedRecord(record: ConnectionModelRecord): ConnectionModelRecord {
  return {
    ...record,
    connectionId: cleanIdentifier(record.connectionId, 'connection_id'),
    providerId: cleanIdentifier(record.providerId, 'provider_id'),
    modelId: cleanIdentifier(record.modelId, 'model_id'),
    displayName: record.displayName.trim() || record.modelId.trim(),
    unavailableReason: record.unavailableReason?.trim() || undefined,
    lastVerifiedAt: Number.isFinite(record.lastVerifiedAt) ? Math.max(0, record.lastVerifiedAt) : 0,
    variants: normalizeVariants(record.variants),
    capabilities: normalizeCapabilities(record.capabilities),
    serviceTiers: normalizeServiceTiers(record.serviceTiers),
    legacyTransport: Boolean(record.legacyTransport),
  };
}

function recordPriority(record: ConnectionModelRecord): readonly number[] {
  return [
    record.available ? 1 : 0,
    SOURCE_PRIORITY[record.source],
    record.legacyTransport ? 0 : 1,
    record.lastVerifiedAt,
  ];
}

function comparePriority(a: ConnectionModelRecord, b: ConnectionModelRecord): number {
  const left = recordPriority(a);
  const right = recordPriority(b);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function mergeDuplicateRecords(a: ConnectionModelRecord, b: ConnectionModelRecord): ConnectionModelRecord {
  const preferred = comparePriority(a, b) >= 0 ? a : b;
  const fallback = preferred === a ? b : a;
  return {
    ...fallback,
    ...preferred,
    available: a.available || b.available,
    unavailableReason: a.available || b.available
      ? undefined
      : preferred.unavailableReason ?? fallback.unavailableReason,
    variants: normalizeVariants([...(preferred.variants ?? []), ...(fallback.variants ?? [])]),
    capabilities: normalizeCapabilities({
      ...(fallback.capabilities ?? {}),
      ...(preferred.capabilities ?? {}),
    }),
    serviceTiers: normalizeServiceTiers([
      ...(preferred.serviceTiers ?? []),
      ...(fallback.serviceTiers ?? []),
    ]),
    lastVerifiedAt: Math.max(a.lastVerifiedAt, b.lastVerifiedAt),
  };
}

/** Deduplicate exact connection-qualified models, including provider-qualified aliases. */
export function dedupeConnectionModels(records: readonly ConnectionModelRecord[]): ConnectionModelRecord[] {
  const byKey = new Map<string, ConnectionModelRecord>();
  for (const raw of records) {
    const record = normalizedRecord(raw);
    const key = connectionModelKey(record);
    const current = byKey.get(key);
    byKey.set(key, current ? mergeDuplicateRecords(current, record) : record);
  }
  return [...byKey.values()].sort((a, b) =>
    a.providerId.localeCompare(b.providerId)
      || a.displayName.localeCompare(b.displayName)
      || a.connectionId.localeCompare(b.connectionId),
  );
}

export interface LegacySuppressionPolicy {
  modernConnectionIds: readonly string[];
  legacyConnectionIds: readonly string[];
}

/** Hide obsolete Codex/legacy rows only after a supported modern OpenCode route is healthy. */
export function suppressHealthyLegacyRoutes(
  records: readonly ConnectionModelRecord[],
  policy: LegacySuppressionPolicy,
): ConnectionModelRecord[] {
  const modern = new Set(policy.modernConnectionIds.map(canonicalIdentifier));
  const legacy = new Set(policy.legacyConnectionIds.map(canonicalIdentifier));
  const healthyModernExists = records.some(
    (record) => modern.has(canonicalIdentifier(record.connectionId)) && record.available,
  );
  if (!healthyModernExists) return [...records];
  return records.filter((record) => !legacy.has(canonicalIdentifier(record.connectionId)));
}

function routePriority(route: PickerRoute): readonly number[] {
  return [
    route.available ? 1 : 0,
    SOURCE_PRIORITY[route.source],
    route.legacyTransport ? 0 : 1,
    route.lastVerifiedAt,
  ];
}

function compareRoutePriority(a: PickerRoute, b: PickerRoute): number {
  const left = routePriority(a);
  const right = routePriority(b);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return right[index] - left[index];
  }
  return a.connectionId.localeCompare(b.connectionId);
}

/**
 * One visible model row, with exact API/subscription/local routes retained below
 * it. The UI may default to the preferred route but must never silently switch a
 * stored explicit route after send.
 */
export function buildCanonicalModelRows(
  records: readonly ConnectionModelRecord[],
): CanonicalModelPickerRow[] {
  const byModel = new Map<string, ConnectionModelRecord[]>();
  for (const record of dedupeConnectionModels(records)) {
    const key = providerModelKey(record);
    const group = byModel.get(key) ?? [];
    group.push(record);
    byModel.set(key, group);
  }

  const rows: CanonicalModelPickerRow[] = [];
  for (const [key, group] of byModel) {
    const routes: PickerRoute[] = group
      .map((record) => ({
        connectionId: record.connectionId,
        available: record.available,
        unavailableReason: record.unavailableReason,
        source: record.source,
        lastVerifiedAt: record.lastVerifiedAt,
        variants: normalizeVariants(record.variants),
        capabilities: normalizeCapabilities(record.capabilities),
        serviceTiers: normalizeServiceTiers(record.serviceTiers),
        legacyTransport: Boolean(record.legacyTransport),
      }))
      .sort(compareRoutePriority);

    const preferredRoute = routes[0];
    const preferred = group.find((record) => record.connectionId === preferredRoute?.connectionId) ?? group[0];
    rows.push({
      key,
      providerId: preferred.providerId,
      modelId: canonicalProviderModelId(preferred.providerId, preferred.modelId),
      displayName: preferred.displayName,
      available: routes.some((route) => route.available),
      preferredConnectionId: preferredRoute?.connectionId ?? preferred.connectionId,
      routes,
    });
  }

  return rows.sort((a, b) =>
    a.providerId.localeCompare(b.providerId) || a.displayName.localeCompare(b.displayName),
  );
}

export type ModelRefreshReason =
  | 'initial'
  | 'explicit'
  | 'auth-change'
  | 'credential-change'
  | 'plan-region-change'
  | 'runtime-version-change'
  | 'app-version-change'
  | 'local-model-change'
  | 'cache-expired';

export interface ModelCatalogSnapshot {
  generation: number;
  refreshedAt: number;
  reason: ModelRefreshReason;
  records: readonly ConnectionModelRecord[];
}

/** Deterministic refresh generation; never refresh just because React rendered. */
export class ModelCatalogController {
  #generation = 0;
  #snapshot: ModelCatalogSnapshot = Object.freeze({
    generation: 0,
    refreshedAt: 0,
    reason: 'initial',
    records: Object.freeze([]),
  });

  snapshot(): ModelCatalogSnapshot {
    return this.#snapshot;
  }

  replace(
    records: readonly ConnectionModelRecord[],
    reason: ModelRefreshReason,
    now = Date.now(),
  ): ModelCatalogSnapshot {
    this.#generation += 1;
    this.#snapshot = Object.freeze({
      generation: this.#generation,
      refreshedAt: now,
      reason,
      records: Object.freeze(dedupeConnectionModels(records)),
    });
    return this.#snapshot;
  }

  isExpired(ttlMs: number, now = Date.now()): boolean {
    return !this.#snapshot.refreshedAt || now - this.#snapshot.refreshedAt >= Math.max(0, ttlMs);
  }
}
