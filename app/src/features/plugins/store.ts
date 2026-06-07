import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { safeLocalStorage } from '@/lib/persistence/safeLocalStorage';
import { enqueueMutation } from '@/lib/sync';
import type { PluginConnection } from './types';

export const PLUGIN_CONNECTIONS_SYNC_TABLE = 'plugin_connections';

type PluginStore = {
  connections: Record<string, PluginConnection>;
  upsertConnection: (connection: PluginConnection) => void;
  removeConnection: (pluginId: string) => void;
  setEnabled: (pluginId: string, enabled: boolean) => void;
};

function queueConnection(connection: PluginConnection, op: 'insert' | 'update' | 'delete'): void {
  void enqueueMutation(
    op,
    PLUGIN_CONNECTIONS_SYNC_TABLE,
    connection.pluginId,
    op === 'delete' ? null : connection,
  ).catch((error) => {
    console.warn('[plugins] failed to queue connection metadata sync', {
      pluginId: connection.pluginId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export const usePluginStore = create<PluginStore>()(
  persist(
    (set, get) => ({
      connections: {},
      upsertConnection: (connection) => {
        const exists = Boolean(get().connections[connection.pluginId]);
        set((state) => ({
          connections: { ...state.connections, [connection.pluginId]: connection },
        }));
        queueConnection(connection, exists ? 'update' : 'insert');
      },
      removeConnection: (pluginId) => {
        const existing = get().connections[pluginId];
        if (!existing) return;
        set((state) => {
          const next = { ...state.connections };
          delete next[pluginId];
          return { connections: next };
        });
        queueConnection(existing, 'delete');
      },
      setEnabled: (pluginId, enabled) => {
        const existing = get().connections[pluginId];
        if (!existing) return;
        const updated = { ...existing, enabled, updatedAt: Date.now() };
        set((state) => ({
          connections: { ...state.connections, [pluginId]: updated },
        }));
        queueConnection(updated, 'update');
      },
    }),
    {
      name: 'jarvis-plugin-connections',
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (state) => ({ connections: state.connections }),
    },
  ),
);
