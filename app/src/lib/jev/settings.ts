import { JEV_MODEL_ALIAS, type JevNativeResultKind } from './contracts';

type JevCredentialStoreModule = typeof import('../security/jevCredentialStore');

async function credentialStore(): Promise<JevCredentialStoreModule> {
  // Lazy loading keeps settings tests and web previews usable without eagerly
  // importing the Tauri-only secure-store module.
  return import('../security/jevCredentialStore');
}

export type JevSettings = Readonly<{
  modelId: string;
  hasKey: boolean;
  connected: boolean;
  lastTestedAt?: number;
}>;

export type JevSettingsScope = Readonly<{ accountId: string; workspaceId: string }>;

type ScopedJevSettingsMetadata = Readonly<{
  schemaVersion: 1;
  accountId: string;
  workspaceId: string;
  modelId: string;
  credentialEpoch: number;
  lastTestedAt?: number;
}>;

const JEV_SETTINGS_PREFIX = 'jev.settings.v1:';
const JEV_CREDENTIAL_EPOCH_KEY = 'jev.credentials.epoch.v1';

export type JevConnectionTestResult = Readonly<{
  kind: JevNativeResultKind;
  models: readonly Readonly<{ id: string; label?: string }>[];
  status: number | null;
}>;

export type JevLocalUsageRecord = Readonly<{
  recordedAt: number;
  accountId: string;
  workspaceId: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  costProvenance: 'provider-reported' | 'estimated' | 'unavailable';
  status: 'ok' | 'error' | 'unavailable';
}>;

export type JevSettingsBridge = Readonly<{
  loadJevSettings(): Promise<unknown>;
  saveJevApiKey(apiKey: string): Promise<unknown>;
  testJevConnection(): Promise<unknown>;
  removeJevApiKey(): Promise<unknown>;
}>;

function nativeBridge(): JevSettingsBridge {
  return Object.freeze({
    async loadJevSettings() {
      const status = await (await credentialStore()).getJevCredentialStatus();
      return {
        modelId: JEV_MODEL_ALIAS,
        hasKey: status.configured,
        connected: status.available && status.configured,
      };
    },
    async saveJevApiKey(apiKey: string) {
      const result = await (await credentialStore()).saveJevCredential(apiKey);
      if (!result.ok) throw new Error(result.code);
      return undefined;
    },
    async testJevConnection() {
      const result = await (await credentialStore()).requestJevModels();
      return {
        // The models endpoint is connected-or-error. A generic `ok` response
        // is malformed for this fixed endpoint and is failed closed.
        kind: result.kind === 'ok' ? 'malformed' : result.kind,
        models: result.models ?? [],
        status: result.status,
      };
    },
    async removeJevApiKey() {
      const result = await (await credentialStore()).removeJevCredential();
      if (!result.ok) throw new Error(result.code);
      return undefined;
    },
  });
}

let bridge: JevSettingsBridge = nativeBridge();

export function configureJevSettingsBridge(next: JevSettingsBridge): void {
  if (
    !next ||
    typeof next.loadJevSettings !== 'function' ||
    typeof next.saveJevApiKey !== 'function' ||
    typeof next.testJevConnection !== 'function' ||
    typeof next.removeJevApiKey !== 'function'
  ) {
    throw new Error('jev_settings_bridge_invalid');
  }
  bridge = next;
}

const JEV_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function boundedModel(value: unknown): string {
  if (typeof value !== 'string') throw new Error('jev_model_invalid');
  const modelId = value.trim();
  if (!modelId || !JEV_MODEL_ID_PATTERN.test(modelId)) throw new Error('jev_model_invalid');
  return modelId;
}

function boundedScope(scope: JevSettingsScope): JevSettingsScope {
  if (
    typeof scope.accountId !== 'string' ||
    !scope.accountId.trim() ||
    scope.accountId.length > 256
  ) {
    throw new Error('jev_scope_invalid');
  }
  if (
    typeof scope.workspaceId !== 'string' ||
    !scope.workspaceId.trim() ||
    scope.workspaceId.length > 256
  ) {
    throw new Error('jev_scope_invalid');
  }
  return Object.freeze({
    accountId: scope.accountId.trim(),
    workspaceId: scope.workspaceId.trim(),
  });
}

function scopedSettingsKey(scope: JevSettingsScope): string {
  const bounded = boundedScope(scope);
  return `${JEV_SETTINGS_PREFIX}${JSON.stringify([bounded.accountId, bounded.workspaceId])}`;
}

function parseCredentialEpoch(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

async function invalidateScopedSettings(): Promise<number> {
  const { db } = await import('../db');
  return db.transaction('rw', db.settings, async () => {
    const rows = await db.settings.toArray();
    const keys = rows.map((row) => row.key).filter((key) => key.startsWith(JEV_SETTINGS_PREFIX));
    if (keys.length > 0) await db.settings.bulkDelete(keys);
    const epoch =
      parseCredentialEpoch((await db.settings.get(JEV_CREDENTIAL_EPOCH_KEY))?.value) + 1;
    await db.settings.put({ key: JEV_CREDENTIAL_EPOCH_KEY, value: epoch, updated_at: Date.now() });
    return epoch;
  });
}

function parseScopedMetadata(
  value: unknown,
  scope: JevSettingsScope,
): ScopedJevSettingsMetadata | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (
    raw.schemaVersion !== 1 ||
    raw.accountId !== scope.accountId ||
    raw.workspaceId !== scope.workspaceId ||
    typeof raw.modelId !== 'string' ||
    !JEV_MODEL_ID_PATTERN.test(raw.modelId.trim()) ||
    typeof raw.credentialEpoch !== 'number' ||
    !Number.isSafeInteger(raw.credentialEpoch) ||
    raw.credentialEpoch < 0
  )
    return undefined;
  return Object.freeze({
    schemaVersion: 1,
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    modelId: boundedModel(raw.modelId),
    credentialEpoch: raw.credentialEpoch,
    ...(typeof raw.lastTestedAt === 'number' &&
    Number.isSafeInteger(raw.lastTestedAt) &&
    raw.lastTestedAt >= 0
      ? { lastTestedAt: raw.lastTestedAt }
      : {}),
  });
}

async function readScopedState(scope: JevSettingsScope): Promise<
  Readonly<{
    metadata?: ScopedJevSettingsMetadata;
    epoch: number;
  }>
> {
  const bounded = boundedScope(scope);
  const key = scopedSettingsKey(bounded);
  const { db } = await import('../db');
  return db.transaction('r', db.settings, async () => {
    const [metadataRow, epochRow] = await Promise.all([
      db.settings.get(key),
      db.settings.get(JEV_CREDENTIAL_EPOCH_KEY),
    ]);
    return Object.freeze({
      metadata: parseScopedMetadata(metadataRow?.value, bounded),
      epoch: parseCredentialEpoch(epochRow?.value),
    });
  });
}

function sameScopedMetadata(
  left: ScopedJevSettingsMetadata | undefined,
  right: ScopedJevSettingsMetadata | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseSettings(value: unknown): JevSettings {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const modelId = raw.modelId === undefined ? JEV_MODEL_ALIAS : boundedModel(raw.modelId);
  return Object.freeze({
    modelId,
    hasKey: raw.hasKey === true,
    connected: raw.connected === true,
    ...(Number.isSafeInteger(raw.lastTestedAt) ? { lastTestedAt: raw.lastTestedAt as number } : {}),
  });
}

function parseConnection(value: unknown): JevConnectionTestResult {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const kind = raw.kind;
  const kinds: readonly JevNativeResultKind[] = [
    'connected',
    'missing_key',
    'invalid_key',
    'forbidden',
    'network',
    'provider_error',
    'malformed',
    'response_too_large',
    'request_too_large',
    'invalid_request',
    'storage_error',
  ];
  if (!kinds.includes(kind as JevNativeResultKind))
    throw new Error('jev_connection_result_invalid');
  const models = Array.isArray(raw.models)
    ? raw.models.flatMap((model) => {
        if (!model || typeof model !== 'object') return [];
        const item = model as Record<string, unknown>;
        if (typeof item.id !== 'string') return [];
        let id: string;
        try {
          id = boundedModel(item.id);
        } catch {
          return [];
        }
        return [
          {
            id,
            ...(typeof item.label === 'string' && item.label.length <= 256
              ? { label: item.label }
              : {}),
          },
        ];
      })
    : [];
  return Object.freeze({
    kind: kind as JevNativeResultKind,
    models: Object.freeze(models),
    status: Number.isSafeInteger(raw.status) ? (raw.status as number) : null,
  });
}

function parseUsage(
  value: unknown,
  expectedScope?: JevSettingsScope,
): readonly JevLocalUsageRecord[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const raw = item as Record<string, unknown>;
      if (
        !Number.isSafeInteger(raw.recordedAt) ||
        (raw.recordedAt as number) < 0 ||
        typeof raw.accountId !== 'string' ||
        typeof raw.workspaceId !== 'string' ||
        typeof raw.model !== 'string' ||
        (expectedScope &&
          (raw.accountId !== expectedScope.accountId ||
            raw.workspaceId !== expectedScope.workspaceId))
      )
        return [];
      let model: string;
      try {
        model = boundedModel(raw.model);
      } catch {
        return [];
      }
      const costProvenance = raw.costProvenance;
      if (!['provider-reported', 'estimated', 'unavailable'].includes(costProvenance as string))
        return [];
      const status: JevLocalUsageRecord['status'] =
        raw.status === 'ok' || raw.status === 'error' || raw.status === 'unavailable'
          ? raw.status
          : 'unavailable';
      return [
        {
          recordedAt: raw.recordedAt as number,
          accountId: raw.accountId,
          workspaceId: raw.workspaceId,
          model,
          inputTokens:
            Number.isSafeInteger(raw.inputTokens) && (raw.inputTokens as number) >= 0
              ? (raw.inputTokens as number)
              : null,
          outputTokens:
            Number.isSafeInteger(raw.outputTokens) && (raw.outputTokens as number) >= 0
              ? (raw.outputTokens as number)
              : null,
          costUsd:
            typeof raw.costUsd === 'number' && Number.isFinite(raw.costUsd) && raw.costUsd >= 0
              ? raw.costUsd
              : null,
          costProvenance: costProvenance as JevLocalUsageRecord['costProvenance'],
          status,
        },
      ];
    }),
  );
}

export async function loadJevSettings(scope?: JevSettingsScope): Promise<JevSettings> {
  const base = parseSettings(await bridge.loadJevSettings());
  const { lastTestedAt: _lastTestedAt, ...baseWithoutReceipt } = base;
  const unverified = Object.freeze({ ...baseWithoutReceipt, connected: false });
  if (!scope) return unverified;
  const bounded = boundedScope(scope);
  const { metadata, epoch } = await readScopedState(bounded);
  const metadataCurrent = Boolean(metadata && metadata.credentialEpoch === epoch);
  const selectedModel = metadataCurrent && metadata ? metadata.modelId : base.modelId;
  const connected = Boolean(
    base.hasKey &&
    metadataCurrent &&
    metadata?.modelId === selectedModel &&
    metadata.lastTestedAt !== undefined,
  );
  return Object.freeze({
    ...unverified,
    modelId: selectedModel,
    connected,
    ...(connected && metadata?.lastTestedAt !== undefined
      ? { lastTestedAt: metadata.lastTestedAt }
      : {}),
  });
}

export async function saveJevApiKey(apiKey: string): Promise<void> {
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 512)
    throw new Error('jev_api_key_invalid');
  await bridge.saveJevApiKey(apiKey);
  await invalidateScopedSettings();
}

export async function testJevConnection(
  scope?: JevSettingsScope,
): Promise<JevConnectionTestResult> {
  let pendingScopeTest:
    | Readonly<{
        scope: JevSettingsScope;
        epoch: number;
        metadata?: ScopedJevSettingsMetadata;
        modelId: string;
      }>
    | undefined;
  if (scope) {
    const bounded = boundedScope(scope);
    const base = parseSettings(await bridge.loadJevSettings());
    const snapshot = await readScopedState(bounded);
    const metadataCurrent = Boolean(
      snapshot.metadata && snapshot.metadata.credentialEpoch === snapshot.epoch,
    );
    pendingScopeTest = Object.freeze({
      scope: bounded,
      epoch: snapshot.epoch,
      metadata: snapshot.metadata,
      modelId: metadataCurrent && snapshot.metadata ? snapshot.metadata.modelId : base.modelId,
    });
  }
  const result = parseConnection(await bridge.testJevConnection());
  if (pendingScopeTest) {
    const { db } = await import('../db');
    const key = scopedSettingsKey(pendingScopeTest.scope);
    await db.transaction('rw', db.settings, async () => {
      const [currentRow, currentEpochRow] = await Promise.all([
        db.settings.get(key),
        db.settings.get(JEV_CREDENTIAL_EPOCH_KEY),
      ]);
      const currentMetadata = parseScopedMetadata(currentRow?.value, pendingScopeTest!.scope);
      const currentEpoch = parseCredentialEpoch(currentEpochRow?.value);
      if (
        currentEpoch !== pendingScopeTest!.epoch ||
        !sameScopedMetadata(currentMetadata, pendingScopeTest!.metadata)
      ) {
        return;
      }
      if (result.kind !== 'connected') {
        if (!currentMetadata || currentMetadata.lastTestedAt === undefined) return;
        const { lastTestedAt: _lastTestedAt, ...withoutReceipt } = currentMetadata;
        await db.settings.put({ key, value: withoutReceipt, updated_at: Date.now() });
        return;
      }
      await db.settings.put({
        key,
        value: {
          schemaVersion: 1,
          accountId: pendingScopeTest!.scope.accountId,
          workspaceId: pendingScopeTest!.scope.workspaceId,
          modelId: pendingScopeTest!.modelId,
          credentialEpoch: pendingScopeTest!.epoch,
          lastTestedAt: Date.now(),
        } satisfies ScopedJevSettingsMetadata,
        updated_at: Date.now(),
      });
    });
  }
  return result;
}

export async function removeJevApiKey(): Promise<void> {
  await bridge.removeJevApiKey();
  await invalidateScopedSettings();
}

export async function setJevModel(modelId: string, scope?: JevSettingsScope): Promise<void> {
  const boundedModelId = boundedModel(modelId);
  if (!scope) throw new Error('jev_scope_unavailable');
  const bounded = boundedScope(scope);
  const { db } = await import('../db');
  await db.transaction('rw', db.settings, async () => {
    const key = scopedSettingsKey(bounded);
    const previous = parseScopedMetadata((await db.settings.get(key))?.value, bounded);
    const epoch = parseCredentialEpoch((await db.settings.get(JEV_CREDENTIAL_EPOCH_KEY))?.value);
    await db.settings.put({
      key,
      value: {
        schemaVersion: 1,
        accountId: bounded.accountId,
        workspaceId: bounded.workspaceId,
        modelId: boundedModelId,
        credentialEpoch: epoch,
        ...(previous?.credentialEpoch === epoch &&
        previous.modelId === boundedModelId &&
        previous.lastTestedAt !== undefined
          ? { lastTestedAt: previous.lastTestedAt }
          : {}),
      } satisfies ScopedJevSettingsMetadata,
      updated_at: Date.now(),
    });
  });
}

export async function getJevLocalUsage(
  scope?: JevSettingsScope,
): Promise<readonly JevLocalUsageRecord[]> {
  if (!scope) throw new Error('jev_scope_unavailable');
  const bounded = boundedScope(scope);
  const { db } = await import('../db');
  const rows = await db.jev_usage_records
    .where('[accountId+workspaceId]')
    .equals([bounded.accountId, bounded.workspaceId])
    .toArray();
  const newest = [...rows].sort((left, right) => right.recordedAt - left.recordedAt).slice(0, 5000);
  return parseUsage(
    newest.map((row) => ({
      recordedAt: row.recordedAt,
      accountId: row.accountId,
      workspaceId: row.workspaceId,
      model: row.model,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      costUsd: row.costUsd,
      costProvenance: row.costProvenance,
      status: row.status,
    })),
    bounded,
  );
}
