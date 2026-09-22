import type { JarvisDexie } from '@/lib/db/database';
import type { CaoExecutionProfileRow } from '@/lib/db/schema';

export type CaoExecutionBackend = 'codex' | 'opencode';
/** Provider catalog owns the effort vocabulary; this type intentionally does not invent an allowlist. */
export type CaoReasoningEffort = string;

export type CaoExecutionIdentity = Readonly<{
  backend: CaoExecutionBackend;
  providerId: string;
  connectionId: string;
  modelId: string;
  reasoningEffort: CaoReasoningEffort;
}>;

export type CaoLiveExecutionCatalogEntry = CaoExecutionIdentity;

export type CaoLiveExecutionCatalog = Readonly<{
  source: 'live' | 'cached';
  accountId: string;
  workspaceId: string;
  catalogGeneration: string;
  catalogHash: string;
  verifiedAt: number;
  entries: readonly CaoLiveExecutionCatalogEntry[];
}>;

export type CaoExecutionCatalogReceipt = Readonly<{
  source: 'live';
  accountId: string;
  workspaceId: string;
  catalogGeneration: string;
  catalogHash: string;
  verifiedAt: number;
  entries: readonly CaoLiveExecutionCatalogEntry[];
}>;

export type CaoExecutionProfile = Readonly<{
  schemaVersion: 1;
  accountId: string;
  workspaceId: string;
  backend: CaoExecutionBackend;
  providerId: string;
  connectionId: string;
  modelId: string;
  reasoningEffort: CaoReasoningEffort;
  catalogReceipt: CaoExecutionCatalogReceipt;
  updatedAt: number;
}>;

export type CaoExecutionProfileScope = Readonly<{
  accountId: string;
  workspaceId: string;
}>;

function requireText(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error(code);
  return value.trim();
}

function requireTimestamp(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(code);
  return value;
}

function cloneIdentity(identity: CaoExecutionIdentity): CaoExecutionIdentity {
  const backend = identity.backend;
  if (backend !== 'codex' && backend !== 'opencode') throw new Error('cao_execution_profile_backend_invalid');
  const reasoningEffort = requireText(identity.reasoningEffort, 'cao_execution_profile_effort_invalid');
  return Object.freeze({
    backend,
    providerId: requireText(identity.providerId, 'cao_execution_profile_provider_invalid'),
    connectionId: requireText(identity.connectionId, 'cao_execution_profile_connection_invalid'),
    modelId: requireText(identity.modelId, 'cao_execution_profile_model_invalid'),
    reasoningEffort,
  });
}

function cloneCatalogReceipt(catalog: CaoLiveExecutionCatalog): CaoExecutionCatalogReceipt {
  if (catalog.source !== 'live') throw new Error('cao_execution_profile_catalog_unavailable');
  const accountId = requireText(catalog.accountId, 'cao_execution_profile_account_invalid');
  const workspaceId = requireText(catalog.workspaceId, 'cao_execution_profile_workspace_invalid');
  const catalogGeneration = requireText(catalog.catalogGeneration, 'cao_execution_profile_catalog_generation_invalid');
  const catalogHash = requireText(catalog.catalogHash, 'cao_execution_profile_catalog_hash_invalid');
  if (!/^[0-9a-f]{64}$/u.test(catalogHash)) throw new Error('cao_execution_profile_catalog_hash_invalid');
  const verifiedAt = requireTimestamp(catalog.verifiedAt, 'cao_execution_profile_catalog_time_invalid');
  if (!Array.isArray(catalog.entries) || catalog.entries.length === 0) {
    throw new Error('cao_execution_profile_catalog_empty');
  }
  return Object.freeze({
    source: 'live',
    accountId,
    workspaceId,
    catalogGeneration,
    catalogHash,
    verifiedAt,
    entries: Object.freeze(catalog.entries.map(cloneIdentity)),
  });
}

export function createCaoExecutionProfile(input: {
  accountId: string;
  workspaceId: string;
  identity: CaoExecutionIdentity;
  catalogReceipt: CaoExecutionCatalogReceipt;
  updatedAt?: number;
}): CaoExecutionProfile {
  const accountId = requireText(input.accountId, 'cao_execution_profile_account_invalid');
  const workspaceId = requireText(input.workspaceId, 'cao_execution_profile_workspace_invalid');
  const updatedAt = requireTimestamp(input.updatedAt ?? Date.now(), 'cao_execution_profile_time_invalid');
  if (input.catalogReceipt.accountId !== accountId || input.catalogReceipt.workspaceId !== workspaceId) {
    throw new Error('cao_execution_profile_scope_mismatch');
  }
  const identity = cloneIdentity(input.identity);
  if (
    !input.catalogReceipt.entries.some(
      (entry) =>
        entry.backend === identity.backend &&
        entry.providerId === identity.providerId &&
        entry.connectionId === identity.connectionId &&
        entry.modelId === identity.modelId &&
        entry.reasoningEffort === identity.reasoningEffort,
    )
  ) {
    throw new Error('cao_execution_profile_route_unavailable');
  }
  return Object.freeze({
    schemaVersion: 1,
    accountId,
    workspaceId,
    ...identity,
    catalogReceipt: input.catalogReceipt,
    updatedAt,
  });
}

export function selectCaoExecutionProfile(input: {
  accountId: string;
  workspaceId: string;
  catalog: CaoLiveExecutionCatalog;
  modelId: string;
  reasoningEffort: CaoReasoningEffort;
  backend?: CaoExecutionBackend;
  connectionId?: string;
  now?: number;
}): CaoExecutionProfile {
  if (input.catalog.accountId !== input.accountId || input.catalog.workspaceId !== input.workspaceId) {
    throw new Error('cao_execution_profile_scope_mismatch');
  }
  const receipt = cloneCatalogReceipt(input.catalog);
  const selected = receipt.entries.find(
    (entry) =>
      entry.modelId === input.modelId.trim() &&
      entry.reasoningEffort === input.reasoningEffort &&
      (input.backend === undefined || entry.backend === input.backend) &&
      (input.connectionId === undefined || entry.connectionId === input.connectionId),
  );
  if (!selected) throw new Error('cao_execution_profile_route_unavailable');
  return createCaoExecutionProfile({
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    identity: selected,
    catalogReceipt: receipt,
    updatedAt: input.now,
  });
}

export function assertCaoExecutionProfileScope(
  profile: CaoExecutionProfile,
  scope: CaoExecutionProfileScope,
): void {
  if (profile.accountId !== scope.accountId || profile.workspaceId !== scope.workspaceId) {
    throw new Error('cao_execution_profile_scope_mismatch');
  }
}

export function assertCaoExecutionIdentity(
  requested: CaoExecutionIdentity,
  observed: Partial<CaoExecutionIdentity>,
): CaoExecutionIdentity {
  const expected = cloneIdentity(requested);
  if (
    observed.backend !== expected.backend ||
    observed.providerId !== expected.providerId ||
    observed.connectionId !== expected.connectionId ||
    observed.modelId !== expected.modelId ||
    observed.reasoningEffort !== expected.reasoningEffort
  ) {
    throw new Error('cao_execution_identity_mismatch');
  }
  return expected;
}

export function serializeCaoExecutionProfile(profile: CaoExecutionProfile): string {
  return JSON.stringify(profile);
}

export function parseCaoExecutionProfile(value: unknown): CaoExecutionProfile {
  if (!value || typeof value !== 'object') throw new Error('cao_execution_profile_invalid');
  const raw = value as Partial<CaoExecutionProfile>;
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.accountId !== 'string' ||
    typeof raw.workspaceId !== 'string' ||
    !raw.catalogReceipt ||
    typeof raw.catalogReceipt !== 'object'
  ) {
    throw new Error('cao_execution_profile_invalid');
  }
  const receipt = raw.catalogReceipt as CaoExecutionCatalogReceipt;
  if (receipt.source !== 'live') throw new Error('cao_execution_profile_catalog_unavailable');
  if (receipt.accountId !== raw.accountId || receipt.workspaceId !== raw.workspaceId) {
    throw new Error('cao_execution_profile_scope_mismatch');
  }
  return createCaoExecutionProfile({
    accountId: raw.accountId,
    workspaceId: raw.workspaceId,
    identity: {
      backend: raw.backend!,
      providerId: raw.providerId!,
      connectionId: raw.connectionId!,
      modelId: raw.modelId!,
      reasoningEffort: raw.reasoningEffort!,
    },
    catalogReceipt: receipt,
    updatedAt: raw.updatedAt,
  });
}

function profileRowId(scope: CaoExecutionProfileScope): string {
  return JSON.stringify([scope.accountId, scope.workspaceId]);
}

export async function persistCaoExecutionProfile(
  database: JarvisDexie,
  profile: CaoExecutionProfile,
): Promise<void> {
  const row: CaoExecutionProfileRow = {
    id: profileRowId(profile),
    schemaVersion: 1,
    accountId: profile.accountId,
    workspaceId: profile.workspaceId,
    serializedProfile: serializeCaoExecutionProfile(profile),
    updatedAt: profile.updatedAt,
  };
  await database.cao_execution_profiles.put(row);
}

export async function loadCaoExecutionProfile(
  database: JarvisDexie,
  scope: CaoExecutionProfileScope,
): Promise<CaoExecutionProfile | undefined> {
  const row = await database.cao_execution_profiles.get(profileRowId(scope));
  if (!row) return undefined;
  if (row.accountId !== scope.accountId || row.workspaceId !== scope.workspaceId) {
    throw new Error('cao_execution_profile_scope_mismatch');
  }
  let profile: CaoExecutionProfile;
  try {
    profile = parseCaoExecutionProfile(JSON.parse(row.serializedProfile));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('cao_execution_profile_')) throw error;
    throw new Error('cao_execution_profile_invalid');
  }
  assertCaoExecutionProfileScope(profile, scope);
  return profile;
}

export type CaoExecutionProfileCatalogReader = (
  scope: CaoExecutionProfileScope,
) => Promise<CaoLiveExecutionCatalog>;

export function createCaoExecutionProfileResolver(input: {
  database: JarvisDexie;
  readLiveCatalog: CaoExecutionProfileCatalogReader;
}) {
  return async (request: {
    scope: CaoExecutionProfileScope;
    modelId: string;
    reasoningEffort: CaoReasoningEffort;
    backend?: CaoExecutionBackend;
    connectionId?: string;
    now?: number;
  }): Promise<CaoExecutionProfile> => {
    const catalog = await input.readLiveCatalog(request.scope);
    return selectCaoExecutionProfile({
      ...request,
      accountId: request.scope.accountId,
      workspaceId: request.scope.workspaceId,
      catalog,
    });
  };
}
