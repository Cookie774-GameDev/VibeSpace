import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { safeLocalStorage } from '@/lib/persistence/safeLocalStorage';
import { captureSyncQueueOwner, type SyncQueueOwnerSnapshot } from '@/lib/cloudSyncQueueOwner';
import type { PluginConnection, PluginConnectionsByAccount } from './types';

export const PLUGIN_CONNECTIONS_SYNC_TABLE = 'plugin_connections';
const EMPTY_PLUGIN_CONNECTIONS: Readonly<Record<string, PluginConnection>> = Object.freeze({});
const EMPTY_PINNED_PLUGIN_IDS: readonly string[] = Object.freeze([]);
const MAX_PINNED_PLUGINS = 10;

export interface PluginStore {
  connectionsByAccount: PluginConnectionsByAccount;
  pinnedPluginIdsByAccount: Record<string, string[]>;
  upsertConnection(connection: PluginConnection): void;
  removeConnection(accountId: string, pluginId: string): void;
  setEnabled(accountId: string, pluginId: string, enabled: boolean): void;
  pinPlugin(accountId: string, pluginId: string): boolean;
  unpinPlugin(accountId: string, pluginId: string): void;
  movePinnedPlugin(accountId: string, pluginId: string, offset: -1 | 1): void;
}

export function selectPinnedPluginIdsForAccount(
  state: Pick<PluginStore, 'pinnedPluginIdsByAccount'>,
  accountId: string,
): readonly string[] {
  if (!accountId || accountId.trim() !== accountId) return EMPTY_PINNED_PLUGIN_IDS;
  return state.pinnedPluginIdsByAccount[accountId] ?? EMPTY_PINNED_PLUGIN_IDS;
}

function exactId(value: string, label: string): string {
  if (!value || value.trim() !== value) throw new Error(`${label} must be a nonblank exact ID.`);
  return value;
}

export function selectPluginConnectionsForAccount(
  state: Pick<PluginStore, 'connectionsByAccount'>,
  accountId: string,
): Readonly<Record<string, PluginConnection>> {
  if (!accountId || accountId.trim() !== accountId) return EMPTY_PLUGIN_CONNECTIONS;
  return state.connectionsByAccount[accountId] ?? EMPTY_PLUGIN_CONNECTIONS;
}

export function pluginConnectionSyncRowId(accountId: string, pluginId: string): string {
  return `v2:${encodeURIComponent(exactId(accountId, 'Account ID'))}:${encodeURIComponent(
    exactId(pluginId, 'Plugin ID'),
  )}`;
}

function decodePluginConnectionSyncRowId(
  rowId: string,
): Readonly<{ accountId: string; pluginId: string }> | undefined {
  const parts = rowId.split(':');
  if (parts.length !== 3 || parts[0] !== 'v2') return undefined;
  try {
    const accountId = decodeURIComponent(parts[1] ?? '');
    const pluginId = decodeURIComponent(parts[2] ?? '');
    if (pluginConnectionSyncRowId(accountId, pluginId) !== rowId) return undefined;
    return { accountId, pluginId };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function persistedConnectionsByAccount(value: unknown): PluginConnectionsByAccount {
  if (!isRecord(value) || !isRecord(value.connectionsByAccount)) return {};
  const result: Record<string, Record<string, PluginConnection>> = {};
  for (const [accountId, rawConnections] of Object.entries(value.connectionsByAccount)) {
    if (!accountId || accountId.trim() !== accountId || !isRecord(rawConnections)) continue;
    const connections: Record<string, PluginConnection> = {};
    for (const [pluginId, candidate] of Object.entries(rawConnections)) {
      if (
        !pluginId ||
        pluginId.trim() !== pluginId ||
        !isRecord(candidate) ||
        candidate.accountId !== accountId ||
        candidate.pluginId !== pluginId
      ) {
        continue;
      }
      connections[pluginId] = candidate as PluginConnection;
    }
    if (Object.keys(connections).length > 0) result[accountId] = connections;
  }
  return result;
}

function persistedPinnedPluginIdsByAccount(value: unknown): Record<string, string[]> {
  if (!isRecord(value) || !isRecord(value.pinnedPluginIdsByAccount)) return {};
  const result: Record<string, string[]> = {};
  for (const [accountId, rawIds] of Object.entries(value.pinnedPluginIdsByAccount)) {
    if (!accountId || accountId.trim() !== accountId || !Array.isArray(rawIds)) continue;
    const ids = [
      ...new Set(
        rawIds.filter(
          (id): id is string => typeof id === 'string' && id.length > 0 && id.trim() === id,
        ),
      ),
    ].slice(0, MAX_PINNED_PLUGINS);
    if (ids.length > 0) result[accountId] = ids;
  }
  return result;
}

function mayQueueForAccount(owner: SyncQueueOwnerSnapshot, accountId: string): boolean {
  return owner.state !== 'cloud' || owner.userId === accountId;
}

function queueConnection(
  connection: PluginConnection,
  op: 'insert' | 'update' | 'delete',
  owner: SyncQueueOwnerSnapshot,
): void {
  if (!mayQueueForAccount(owner, connection.accountId)) return;
  void import('@/lib/sync')
    .then(({ enqueueMutation }) =>
      enqueueMutation(
        op,
        PLUGIN_CONNECTIONS_SYNC_TABLE,
        pluginConnectionSyncRowId(connection.accountId, connection.pluginId),
        connection,
        owner,
      ),
    )
    .catch((error) => {
      console.warn('[plugins] failed to queue connection metadata sync', {
        accountId: connection.accountId,
        pluginId: connection.pluginId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

export const usePluginStore = create<PluginStore>()(
  persist(
    (set, get) => ({
      connectionsByAccount: {},
      pinnedPluginIdsByAccount: {},
      upsertConnection: (connection) => {
        exactId(connection.accountId, 'Account ID');
        exactId(connection.pluginId, 'Plugin ID');
        const existing = selectPluginConnectionsForAccount(get(), connection.accountId)[
          connection.pluginId
        ];
        set((state) => ({
          connectionsByAccount: {
            ...state.connectionsByAccount,
            [connection.accountId]: {
              ...selectPluginConnectionsForAccount(state, connection.accountId),
              [connection.pluginId]: connection,
            },
          },
        }));
        queueConnection(connection, existing ? 'update' : 'insert', captureSyncQueueOwner());
      },
      removeConnection: (accountId, pluginId) => {
        exactId(accountId, 'Account ID');
        exactId(pluginId, 'Plugin ID');
        const existing = selectPluginConnectionsForAccount(get(), accountId)[pluginId];
        if (!existing) return;
        set((state) => {
          const connections = { ...selectPluginConnectionsForAccount(state, accountId) };
          delete connections[pluginId];
          const connectionsByAccount = { ...state.connectionsByAccount };
          if (Object.keys(connections).length > 0) connectionsByAccount[accountId] = connections;
          else delete connectionsByAccount[accountId];
          return { connectionsByAccount };
        });
        queueConnection(existing, 'delete', captureSyncQueueOwner());
      },
      setEnabled: (accountId, pluginId, enabled) => {
        exactId(accountId, 'Account ID');
        exactId(pluginId, 'Plugin ID');
        const existing = selectPluginConnectionsForAccount(get(), accountId)[pluginId];
        if (!existing) return;
        const updated = { ...existing, enabled, updatedAt: Date.now() };
        set((state) => ({
          connectionsByAccount: {
            ...state.connectionsByAccount,
            [accountId]: {
              ...selectPluginConnectionsForAccount(state, accountId),
              [pluginId]: updated,
            },
          },
        }));
        queueConnection(updated, 'update', captureSyncQueueOwner());
      },
      pinPlugin: (accountId, pluginId) => {
        exactId(accountId, 'Account ID');
        exactId(pluginId, 'Plugin ID');
        const current = selectPinnedPluginIdsForAccount(get(), accountId);
        if (current.includes(pluginId)) return true;
        if (current.length >= MAX_PINNED_PLUGINS) return false;
        set((state) => ({
          pinnedPluginIdsByAccount: {
            ...state.pinnedPluginIdsByAccount,
            [accountId]: [...selectPinnedPluginIdsForAccount(state, accountId), pluginId],
          },
        }));
        return true;
      },
      unpinPlugin: (accountId, pluginId) => {
        exactId(accountId, 'Account ID');
        exactId(pluginId, 'Plugin ID');
        set((state) => {
          const next = selectPinnedPluginIdsForAccount(state, accountId).filter(
            (id) => id !== pluginId,
          );
          const pinnedPluginIdsByAccount = { ...state.pinnedPluginIdsByAccount };
          if (next.length > 0) pinnedPluginIdsByAccount[accountId] = next;
          else delete pinnedPluginIdsByAccount[accountId];
          return { pinnedPluginIdsByAccount };
        });
      },
      movePinnedPlugin: (accountId, pluginId, offset) => {
        exactId(accountId, 'Account ID');
        exactId(pluginId, 'Plugin ID');
        set((state) => {
          const current = [...selectPinnedPluginIdsForAccount(state, accountId)];
          const from = current.indexOf(pluginId);
          const to = Math.max(0, Math.min(current.length - 1, from + offset));
          if (from < 0 || from === to) return state;
          [current[from], current[to]] = [current[to]!, current[from]!];
          return {
            pinnedPluginIdsByAccount: {
              ...state.pinnedPluginIdsByAccount,
              [accountId]: current,
            },
          };
        });
      },
    }),
    {
      name: 'jarvis-plugin-connections-v2',
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (state) => ({
        connectionsByAccount: state.connectionsByAccount,
        pinnedPluginIdsByAccount: state.pinnedPluginIdsByAccount,
      }),
      version: 3,
      migrate: (persistedState) => ({
        connectionsByAccount: persistedConnectionsByAccount(persistedState),
        pinnedPluginIdsByAccount: persistedPinnedPluginIdsByAccount(persistedState),
      }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        connectionsByAccount: persistedConnectionsByAccount(persistedState),
        pinnedPluginIdsByAccount: persistedPinnedPluginIdsByAccount(persistedState),
      }),
    },
  ),
);

export function applyCloudPluginConnectionForAccount(
  exactUserId: string,
  rowId: string,
  connection: PluginConnection | null,
): boolean {
  if (!exactUserId || exactUserId.trim() !== exactUserId) return false;
  const decoded = decodePluginConnectionSyncRowId(rowId);
  if (!decoded || decoded.accountId !== exactUserId) return false;
  if (
    connection &&
    (connection.accountId !== exactUserId || connection.pluginId !== decoded.pluginId)
  ) {
    return false;
  }
  usePluginStore.setState((state) => {
    const connections = { ...selectPluginConnectionsForAccount(state, exactUserId) };
    if (connection) connections[decoded.pluginId] = connection;
    else delete connections[decoded.pluginId];
    const connectionsByAccount = { ...state.connectionsByAccount };
    if (Object.keys(connections).length > 0) connectionsByAccount[exactUserId] = connections;
    else delete connectionsByAccount[exactUserId];
    return { connectionsByAccount };
  });
  return true;
}
