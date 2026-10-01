import * as React from 'react';
import { useAuthStore } from '@/stores/auth';
import { getSupabaseClient } from '@/lib/supabase/client';
import {
  markDesktopPresenceOffline,
  publishDesktopPresence,
  type DesktopPresenceInput,
} from '@/lib/supabase/desktopPresence';

const HEARTBEAT_MS = 60_000;

type PresenceClient = NonNullable<ReturnType<typeof getSupabaseClient>>;

interface HeartbeatOptions {
  readonly client: PresenceClient | { rpc: PresenceClient['rpc'] };
  readonly expectedUserId: string;
  readonly collect: () => Promise<DesktopPresenceInput>;
  readonly publish?: typeof publishDesktopPresence;
  readonly markOffline?: typeof markDesktopPresenceOffline;
  readonly isCurrent?: () => boolean;
  readonly setInterval?: (callback: () => void, delay: number) => ReturnType<typeof setInterval>;
  readonly clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

export function startDesktopPresenceHeartbeat({
  client,
  expectedUserId,
  collect,
  publish = publishDesktopPresence,
  markOffline = markDesktopPresenceOffline,
  isCurrent = () => true,
  setInterval: schedule = globalThis.setInterval,
  clearInterval: unschedule = globalThis.clearInterval,
}: HeartbeatOptions): () => void {
  let active = true;
  let running = false;
  let lastDeviceId: string | null = null;

  const pulse = async () => {
    if (!active || running || !isCurrent()) return;
    running = true;
    try {
      const snapshot = await collect();
      if (!active || !isCurrent()) return;
      lastDeviceId = snapshot.deviceId;
      await publish(client, expectedUserId, snapshot);
    } catch {
      // The website will age the last heartbeat into an offline state.
    } finally {
      running = false;
    }
  };

  void pulse();
  const timer = schedule(() => void pulse(), HEARTBEAT_MS);

  return () => {
    active = false;
    unschedule(timer);
    if (lastDeviceId && isCurrent()) {
      void markOffline(client, expectedUserId, lastDeviceId).catch(() => undefined);
    }
  };
}

function presenceStatus(value: unknown): string {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized === 'done' || normalized === 'failed' || normalized === 'blocked') {
    return normalized;
  }
  return normalized === 'idle' ? 'idle' : 'running';
}

export async function collectDesktopPresenceSnapshot(input: {
  readonly deviceId: string;
  readonly displayName: string;
  readonly appVersion: string;
}): Promise<DesktopPresenceInput> {
  const [terminalModule, repositoryModule, agentModule] = await Promise.all([
    import('@/features/terminals/transcriptStore'),
    import('@/lib/db/repositories'),
    import('@/stores/agents'),
  ]);
  const terminalSessions = Object.values(
    terminalModule.useTerminalTranscriptStore.getState().sessions,
  );
  const chats = await repositoryModule.chatRepo.list({ archived: false, limit: 50 });
  const agentState = agentModule.useAgentStore.getState();
  const agents = agentState.getActiveAgents().slice(0, 50);
  const auth = useAuthStore.getState();

  const activeRuntime = auth.offlineMode
    ? `Ollama · ${auth.defaultLocalModel}`
    : `${auth.defaultProvider} · ${auth.selectedModels[auth.defaultProvider] || 'default model'}`;

  return {
    deviceId: input.deviceId,
    displayName: input.displayName,
    appVersion: input.appVersion,
    terminals: terminalSessions.slice(0, 50).map((session, index) => ({
      id: session.sessionId,
      name: session.agentSlug ? `${session.agentSlug} terminal` : `Terminal ${index + 1}`,
      status: Date.now() - session.lastWriteAt <= 120_000 ? 'active' : 'idle',
    })),
    chats: chats.map((chat) => ({
      id: chat.id,
      name: chat.title || 'Untitled chat',
      status: 'open',
    })),
    agentJobs: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      status: presenceStatus(agentState.runStates[agent.id]),
    })),
    activeRuntime,
    providerUsage: {},
    backgroundTaskCount: agents.length,
    recentSyncAt: null,
  };
}

export function DesktopPresencePublisher({ appVersion }: { appVersion: string }) {
  const cloudUserId = useAuthStore((state) => state.cloudSession?.user_id.trim() ?? '');
  const localUserId = useAuthStore((state) => state.localUserId?.trim() ?? '');
  const displayName = useAuthStore((state) => state.displayName.trim());

  React.useEffect(() => {
    if (!cloudUserId || !localUserId) return undefined;
    const client = getSupabaseClient();
    if (!client) return undefined;

    return startDesktopPresenceHeartbeat({
      client,
      expectedUserId: cloudUserId,
      isCurrent: () => (useAuthStore.getState().cloudSession?.user_id.trim() ?? '') === cloudUserId,
      collect: () =>
        collectDesktopPresenceSnapshot({
          deviceId: localUserId,
          displayName: displayName || 'VibeSpace desktop',
          appVersion,
        }),
    });
  }, [appVersion, cloudUserId, displayName, localUserId]);

  return null;
}
