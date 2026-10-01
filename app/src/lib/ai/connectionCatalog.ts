export type ConnectionCatalogSource =
  | 'provider_list'
  | 'opencode_refresh'
  | 'cli_model'
  | 'local_discover'
  | 'stale_fallback';

export type ConnectionBillingMode =
  | 'payg'
  | 'coding-plan'
  | 'token-plan'
  | 'subscription'
  | 'unknown';

export interface ConnectionCatalogIdentity {
  connectionId: string;
  catalogAuthority: Exclude<ConnectionCatalogSource, 'stale_fallback'> | 'stale_fallback';
  billingMode: ConnectionBillingMode;
}

export interface DiscoveredConnectionModel {
  id: string;
  label: string;
  source: ConnectionCatalogSource;
  lastVerifiedAt: number;
  unverified?: boolean;
}

const store = new Map<string, readonly DiscoveredConnectionModel[]>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function parseOpenAiCompatibleModelList(
  payload: unknown,
  source: ConnectionCatalogSource,
  now: number,
): readonly DiscoveredConnectionModel[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
      ? ((payload as { data: unknown[] }).data)
      : [];
  const seen = new Set<string>();
  const models: DiscoveredConnectionModel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as { id?: unknown; object?: unknown; type?: unknown };
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || seen.has(id)) continue;
    if (id.includes('embed') || id.includes('whisper') || id.includes('tts')) continue;
    const kind = typeof record.type === 'string' ? record.type : typeof record.object === 'string' ? record.object : '';
    if (kind && !['chat', 'language', 'code', 'model'].includes(kind)) continue;
    seen.add(id);
    models.push({ id, label: id, source, lastVerifiedAt: now });
    if (models.length >= 200) break;
  }
  return Object.freeze(models);
}

export function setDiscoveredConnectionModels(
  connectionId: string,
  models: readonly DiscoveredConnectionModel[],
): void {
  store.set(
    connectionId,
    Object.freeze(models.map((model) => Object.freeze({ ...model }))),
  );
  notify();
}

export function getDiscoveredConnectionModels(
  connectionId: string,
): readonly DiscoveredConnectionModel[] {
  return store.get(connectionId) ?? [];
}

export function subscribeDiscoveredConnectionModels(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetDiscoveredConnectionModelsForTests(): void {
  store.clear();
}

/** OpenCode `models <provider> --refresh` and CLI `/model` list output. */
export function parseCliModelList(
  stdout: string,
  source: Extract<ConnectionCatalogSource, 'opencode_refresh' | 'cli_model'>,
  now: number,
): readonly DiscoveredConnectionModel[] {
  const seen = new Set<string>();
  const models: DiscoveredConnectionModel[] = [];
  for (const rawLine of stdout.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || /^error\b/i.test(line)) continue;
    const id = line.replace(/\s+.+$/u, '').replace(/^[*-]\s+/, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: id, source, lastVerifiedAt: now });
    if (models.length >= 200) break;
  }
  return Object.freeze(models);
}

export function connectionCatalogIdentity(connectionId: string): ConnectionCatalogIdentity {
  switch (connectionId) {
    case 'openai-codex':
    case 'zai-coding-plan':
    case 'opencode-cli':
      return {
        connectionId,
        catalogAuthority: 'opencode_refresh',
        billingMode: 'subscription',
      };
    case 'github-copilot-cli':
    case 'google-gemini-cli':
    case 'qwen-code':
    case 'anthropic-claude-code':
      return {
        connectionId,
        catalogAuthority: 'cli_model',
        billingMode: 'subscription',
      };
    case 'ollama-local':
      return {
        connectionId,
        catalogAuthority: 'local_discover',
        billingMode: 'unknown',
      };
    case 'zai-api':
      return {
        connectionId,
        catalogAuthority: 'provider_list',
        billingMode: 'payg',
      };
    default:
      return {
        connectionId,
        catalogAuthority:
          connectionId.endsWith('-api') || connectionId === 'google-vertex'
            ? 'provider_list'
            : 'stale_fallback',
        billingMode: 'payg',
      };
  }
}

export function markStaleFallbackModels(
  models: readonly DiscoveredConnectionModel[],
  now: number,
): readonly DiscoveredConnectionModel[] {
  return Object.freeze(
    models.map((model) =>
      Object.freeze({
        ...model,
        source: 'stale_fallback' as const,
        unverified: true,
        lastVerifiedAt: now,
      }),
    ),
  );
}
