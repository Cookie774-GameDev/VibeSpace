export type RlmPreferenceSource = 'chat' | 'workspace' | 'user';
export type RlmSlashAction = 'on' | 'off' | 'status' | 'refresh' | 'trace';
export type RlmLastRoute = 'direct' | 'retrieval' | 'rlm';

export interface ResolvedRlmPreference {
  enabled: boolean;
  source: RlmPreferenceSource;
  lastRefreshAt: number | null;
  lastRoute: RlmLastRoute | null;
  lastRunStatus: 'idle' | 'ok' | 'failed' | null;
}

const STORAGE_KEY = 'vibespace.rlm-preference.v1';
const MAX_KEYS = 128;

interface LayerRecord {
  enabled: boolean;
  updatedAt: number;
}

interface StoredRlmPreferences {
  version: 1;
  userDefault: boolean;
  chats: Record<string, LayerRecord>;
  workspaces: Record<string, LayerRecord>;
  lastRefreshAt: number | null;
  lastRoute: RlmLastRoute | null;
  lastRunStatus: 'idle' | 'ok' | 'failed' | null;
}

function emptyState(): StoredRlmPreferences {
  return {
    version: 1,
    userDefault: true,
    chats: {},
    workspaces: {},
    lastRefreshAt: null,
    lastRoute: null,
    lastRunStatus: null,
  };
}

function defaultStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

function asLayer(value: unknown): LayerRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.enabled !== 'boolean') return undefined;
  return {
    enabled: record.enabled,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
  };
}

function readState(storage: Pick<Storage, 'getItem'> | null | undefined): StoredRlmPreferences {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null') as unknown;
    if (!parsed || typeof parsed !== 'object') return emptyState();
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1) return emptyState();
    const chats: Record<string, LayerRecord> = {};
    const workspaces: Record<string, LayerRecord> = {};
    if (record.chats && typeof record.chats === 'object') {
      for (const [id, value] of Object.entries(record.chats as Record<string, unknown>)) {
        const layer = asLayer(value);
        if (layer) chats[id] = layer;
      }
    }
    if (record.workspaces && typeof record.workspaces === 'object') {
      for (const [id, value] of Object.entries(record.workspaces as Record<string, unknown>)) {
        const layer = asLayer(value);
        if (layer) workspaces[id] = layer;
      }
    }
    return {
      version: 1,
      userDefault: record.userDefault !== false,
      chats,
      workspaces,
      lastRefreshAt: typeof record.lastRefreshAt === 'number' ? record.lastRefreshAt : null,
      lastRoute:
        record.lastRoute === 'direct' ||
        record.lastRoute === 'retrieval' ||
        record.lastRoute === 'rlm'
          ? record.lastRoute
          : null,
      lastRunStatus:
        record.lastRunStatus === 'idle' ||
        record.lastRunStatus === 'ok' ||
        record.lastRunStatus === 'failed'
          ? record.lastRunStatus
          : null,
    };
  } catch {
    return emptyState();
  }
}

function trimLayers(layers: Record<string, LayerRecord>): Record<string, LayerRecord> {
  return Object.fromEntries(
    Object.entries(layers)
      .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_KEYS),
  );
}

function writeState(
  state: StoredRlmPreferences,
  storage: Pick<Storage, 'setItem'> | null | undefined,
): void {
  try {
    storage?.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...state,
        chats: trimLayers(state.chats),
        workspaces: trimLayers(state.workspaces),
      }),
    );
  } catch {
    // RLM preference is optional when storage is unavailable; default stays ON.
  }
}

export function resolveRlmEnabled(input: {
  chatId?: string;
  workspaceId?: string;
  storage?: Pick<Storage, 'getItem'> | null;
} = {}): ResolvedRlmPreference {
  const state = readState(input.storage ?? defaultStorage());
  const chat = input.chatId ? state.chats[input.chatId] : undefined;
  if (chat) {
    return {
      enabled: chat.enabled,
      source: 'chat',
      lastRefreshAt: state.lastRefreshAt,
      lastRoute: state.lastRoute,
      lastRunStatus: state.lastRunStatus,
    };
  }
  const workspace = input.workspaceId ? state.workspaces[input.workspaceId] : undefined;
  if (workspace) {
    return {
      enabled: workspace.enabled,
      source: 'workspace',
      lastRefreshAt: state.lastRefreshAt,
      lastRoute: state.lastRoute,
      lastRunStatus: state.lastRunStatus,
    };
  }
  return {
    enabled: state.userDefault,
    source: 'user',
    lastRefreshAt: state.lastRefreshAt,
    lastRoute: state.lastRoute,
    lastRunStatus: state.lastRunStatus,
  };
}

export function setChatRlmEnabled(
  chatId: string,
  enabled: boolean,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = defaultStorage(),
): ResolvedRlmPreference {
  const state = readState(storage);
  state.chats[chatId] = { enabled, updatedAt: Date.now() };
  writeState(state, storage);
  return resolveRlmEnabled({ chatId, storage });
}

export function markRlmIndexRefreshed(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = defaultStorage(),
): number {
  const state = readState(storage);
  state.lastRefreshAt = Date.now();
  writeState(state, storage);
  return state.lastRefreshAt;
}

export function recordRlmRoute(
  route: RlmLastRoute,
  status: 'ok' | 'failed' | 'idle' = 'ok',
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = defaultStorage(),
): void {
  const state = readState(storage);
  state.lastRoute = route;
  state.lastRunStatus = status;
  writeState(state, storage);
}

export function parseRlmSlashArgument(raw: string): RlmSlashAction | undefined {
  const token = raw.trim().toLowerCase();
  if (!token) return undefined;
  if (token === 'on' || token === 'enable' || token === 'enabled') return 'on';
  if (token === 'off' || token === 'disable' || token === 'disabled') return 'off';
  if (token === 'status' || token === 'state') return 'status';
  if (token === 'refresh' || token === 'reindex' || token === 'index') return 'refresh';
  if (token === 'trace' || token === 'map' || token === 'context') return 'trace';
  return undefined;
}

export function formatRlmStatus(
  resolved: ResolvedRlmPreference,
  extra: { projectId?: string | null; workspaceId?: string | null } = {},
): string {
  const freshness = resolved.lastRefreshAt
    ? new Date(resolved.lastRefreshAt).toISOString()
    : 'never';
  const scope = extra.projectId || extra.workspaceId || 'current workspace';
  return [
    `RLM ${resolved.enabled ? 'ON' : 'OFF'} (${resolved.source} default).`,
    `Scope: ${scope}.`,
    `Route: ${resolved.lastRoute ?? 'Direct (lazy until a broad lookup)'}.`,
    `Index freshness: ${freshness}.`,
    `Last run: ${resolved.lastRunStatus ?? 'idle'}.`,
    resolved.enabled
      ? 'ON means eligible: short chat stays Direct; broad questions may retrieve or investigate.'
      : 'OFF: no project search and no recursive RLM. Chat and explicit attachments still work.',
  ].join(' ');
}

export const RLM_SLASH_OPTIONS = Object.freeze([
  {
    id: 'on',
    label: 'On',
    description: 'Eligible for adaptive Direct, Retrieval, or RLM',
  },
  {
    id: 'off',
    label: 'Off',
    description: 'No project search or recursive RLM',
  },
  {
    id: 'status',
    label: 'Status',
    description: 'Show current RLM state',
  },
  {
    id: 'refresh',
    label: 'Refresh Index',
    description: 'Mark the context index as refreshed',
  },
  {
    id: 'trace',
    label: 'Open Trace',
    description: 'Open the Context Map',
  },
] as const);
