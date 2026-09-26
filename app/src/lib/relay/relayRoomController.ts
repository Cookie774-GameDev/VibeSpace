import type { RelayRoomView } from '@/features/workbench/RelayGroupChat';
import type { createRelayHostBridge } from './relayHostBridge';

type RelayRoomBridge = Pick<
  ReturnType<typeof createRelayHostBridge>,
  'roomSnapshot' | 'humanBroadcast' | 'humanStop'
>;

export interface RelayRoomControllerOptions {
  /** The host owns this bridge and resolves the ticket from its UI authority, never Relay peers. */
  bridge: RelayRoomBridge;
  humanSessionId: string;
  getHumanControlTicket(): unknown | Promise<unknown>;
  scope: RelayRoomView['scope'];
  channel: string;
  /** Host-normalized events for this exact workspace and room. No timer polling. */
  subscribeToSdkRoomEvents?(listener: () => void): () => void;
  /** Existing host runtime authority, never inferred from Relay participant rows. */
  listActiveAgentSessionIds?(): readonly string[] | Promise<readonly string[]>;
}

export interface RelayRoomControllerState {
  room: RelayRoomView;
  humanAuthorized: boolean;
  error: string | null;
}

const ROOM_LIMIT = 30;
const PARTICIPANT_LIMIT = 64;
const STOP_LIMIT = 32;

function emptyRoom(scope: RelayRoomView['scope']): RelayRoomView {
  return { connection: 'offline', scope, participants: [], messages: [] };
}

function projectRoom(
  snapshot: Awaited<ReturnType<RelayRoomBridge['roomSnapshot']>>,
  scope: RelayRoomView['scope'],
  channel: string,
): RelayRoomView {
  if (snapshot.channel !== channel) throw new Error('Relay room channel changed');
  return {
    connection: 'connected',
    scope,
    participants: snapshot.participants.slice(0, PARTICIPANT_LIMIT).map((participant) => ({
      id: participant.id,
      name: participant.name,
      kind: participant.role,
      status:
        participant.status === 'online' ||
        participant.status === 'busy' ||
        participant.status === 'offline'
          ? participant.status
          : 'unknown',
    })),
    messages: snapshot.messages.slice(0, ROOM_LIMIT).map((message) => ({
      id: message.messageId,
      participantId: message.authorId ?? '',
      text: message.text.slice(0, 8192),
      at: message.createdAt ? Date.parse(message.createdAt) : Number.NaN,
      kind: 'message',
    })),
  };
}

/** No optimistic messages or presence: every visible row comes from roomSnapshot. */
export function createRelayRoomController(options: RelayRoomControllerOptions) {
  let disposed = false;
  let refreshRequested = false;
  let activeRefresh: Promise<void> | null = null;
  let state: RelayRoomControllerState = {
    room: emptyRoom(options.scope),
    humanAuthorized: false,
    error: null,
  };
  const listeners = new Set<() => void>();

  function publish(next: RelayRoomControllerState): void {
    if (disposed) return;
    state = next;
    for (const listener of listeners) listener();
  }

  async function drainRefreshes(): Promise<void> {
    while (refreshRequested && !disposed) {
      refreshRequested = false;
      publish({ ...state, room: { ...state.room, connection: 'connecting' }, error: null });
      try {
        const ticket = await options.getHumanControlTicket();
        if (disposed) return;
        const snapshot = await options.bridge.roomSnapshot(
          options.humanSessionId,
          ticket,
          ROOM_LIMIT,
        );
        if (disposed) return;
        if (refreshRequested) continue;
        publish({
          room: projectRoom(snapshot, options.scope, options.channel),
          humanAuthorized: true,
          error: null,
        });
      } catch {
        if (disposed) return;
        if (refreshRequested) continue;
        publish({
          room: emptyRoom(options.scope),
          humanAuthorized: false,
          error: 'Relay room unavailable',
        });
      }
    }
  }

  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    refreshRequested = true;
    if (!activeRefresh) {
      activeRefresh = drainRefreshes().finally(() => {
        activeRefresh = null;
        if (refreshRequested && !disposed) void refresh();
      });
    }
    return activeRefresh;
  }

  function requireReady(): void {
    if (disposed || !state.humanAuthorized || state.room.connection !== 'connected') {
      throw new Error('Relay room is not authorized');
    }
  }

  const unsubscribeSdk = options.subscribeToSdkRoomEvents?.(() => {
    void refresh();
  });

  return {
    getSnapshot(): RelayRoomControllerState {
      return state;
    },
    subscribe(listener: () => void): () => void {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    async send(text: string): Promise<void> {
      requireReady();
      try {
        const ticket = await options.getHumanControlTicket();
        requireReady();
        await options.bridge.humanBroadcast(options.humanSessionId, ticket, text);
      } catch {
        throw new Error('Relay message could not be sent');
      }
      if (!disposed) await refresh();
    },
    async stopAll(): Promise<void> {
      requireReady();
      if (!options.listActiveAgentSessionIds) throw new Error('Relay stop authority unavailable');
      let ticket: unknown;
      let rawIds: readonly string[];
      try {
        ticket = await options.getHumanControlTicket();
        rawIds = await options.listActiveAgentSessionIds();
      } catch {
        throw new Error('Relay stop authority unavailable');
      }
      requireReady();
      if (
        !Array.isArray(rawIds) ||
        rawIds.length > STOP_LIMIT ||
        rawIds.some(
          (id) => typeof id !== 'string' || !id || id.length > 256 || id === options.humanSessionId,
        )
      ) {
        throw new Error('Relay stop targets invalid');
      }
      const failures: unknown[] = [];
      for (const sessionId of new Set(rawIds)) {
        if (disposed) throw new Error('Relay room disposed');
        try {
          await options.bridge.humanStop(options.humanSessionId, ticket, sessionId);
        } catch (cause) {
          failures.push(cause);
        }
      }
      if (!disposed) await refresh();
      if (failures.length) throw new Error(`Failed to stop ${failures.length} Relay agent(s)`);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      refreshRequested = false;
      unsubscribeSdk?.();
      listeners.clear();
      state = { room: emptyRoom(options.scope), humanAuthorized: false, error: null };
    },
  };
}
