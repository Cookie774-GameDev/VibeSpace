import type { RelayRoomView } from '@/features/workbench/RelayGroupChat';
import { canParticipateInRelay, type RelaySettings } from '@/features/settings/relaySettings';

type NativeInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type Context = Readonly<{
  accountId: string;
  workspaceId: string | null;
  projectId: string;
  chatId: string;
}>;
type ContextSnapshot = Readonly<{ generation: number; context: Context | null }>;
type Binding = Readonly<{
  bindingId: string;
  generation: number;
  context: Context;
  sessionId: string;
  relayAgentId: string;
}>;

export interface RelayNativeRoomState {
  room: RelayRoomView;
  humanAuthorized: boolean;
  error: string | null;
}

export interface RelayNativeRoomClientOptions {
  invoke: NativeInvoke;
  readSettings(): RelaySettings;
  expectedChatId?: string | null;
  readLocalProfiles?(): Promise<readonly Readonly<{
    relayAgentId: string;
    harness?: string;
    model?: string;
    task?: string;
    files?: readonly string[];
    latestPrompt?: string;
  }>[]>;
}

const ROOM_LIMIT = 30;
const CHANNEL = 'vibespace';

function scopeLabel(settings: RelaySettings): RelayRoomView['scope'] {
  return settings.scope === 'entire-app' ? 'Entire app' : 'Project';
}

function emptyRoom(settings: RelaySettings): RelayRoomView {
  return { connection: 'offline', scope: scopeLabel(settings), participants: [], messages: [] };
}

function validContext(value: unknown): ContextSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const snapshot = value as ContextSnapshot;
  const context = snapshot.context;
  return Number.isSafeInteger(snapshot.generation) && snapshot.generation > 0 &&
    !!context?.accountId && !!context.projectId && !!context.chatId
    ? snapshot : null;
}

function sameContext(left: Context, right: Context): boolean {
  return left.accountId === right.accountId && left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId && left.chatId === right.chatId;
}

function projectRoom(
  value: unknown,
  binding: Binding,
  settings: RelaySettings,
  localProfiles: ReadonlyMap<string, Readonly<{
    harness?: string; model?: string; task?: string; files?: readonly string[]; latestPrompt?: string;
  }>>,
): RelayRoomView {
  if (!value || typeof value !== 'object') throw new Error('Relay room unavailable');
  const room = value as Record<string, unknown>;
  if (room.channel !== CHANNEL || !Array.isArray(room.messages) || !Array.isArray(room.participants)) {
    throw new Error('Relay room unavailable');
  }
  const humanAuthorIds = new Set(room.participants.flatMap((value) =>
    value && typeof value === 'object' && (value as Record<string, unknown>).role === 'human' &&
      typeof (value as Record<string, unknown>).id === 'string'
      ? [(value as Record<string, unknown>).id as string] : []));
  const participants = room.participants.slice(0, 100).flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    if (typeof item.id !== 'string' || typeof item.name !== 'string') return [];
    // Old human test/UI bindings remain in upstream history after restarts.
    // Only the live binding represents the current owner in this panel.
    if (item.role === 'human' && item.id !== binding.relayAgentId) return [];
    const human = item.id === binding.relayAgentId && item.role === 'human';
    const local = localProfiles.get(item.id);
    const status: RelayRoomView['participants'][number]['status'] =
      item.status === 'online' || item.status === 'offline' || item.status === 'busy'
        ? item.status : 'unknown';
    return [{
      id: item.id,
      name: human ? 'You' : item.name,
      kind: human ? 'human' as const : 'agent' as const,
      status,
      persona: typeof item.persona === 'string' ? item.persona : undefined,
      harness: local?.harness,
      model: local?.model,
      task: local?.task,
      files: local?.files,
      latestPrompt: local?.latestPrompt,
    }];
  });
  const messages = room.messages.slice(0, ROOM_LIMIT).flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    if (typeof item.id !== 'string' || typeof item.text !== 'string') return [];
    const at = typeof item.createdAt === 'string' ? Date.parse(item.createdAt) : Number.NaN;
    return [{
      id: item.id,
      participantId: typeof item.authorId === 'string'
        ? (humanAuthorIds.has(item.authorId) ? binding.relayAgentId : item.authorId) : '',
      text: item.text,
      at,
      kind: 'message' as const,
      parentId: typeof item.parentId === 'string' ? item.parentId : undefined,
      replyCount: typeof item.replyCount === 'number' ? item.replyCount : 0,
    }];
  });
  return { connection: 'connected', scope: scopeLabel(settings), participants, messages,
    roomId: JSON.stringify([binding.context.accountId, binding.context.workspaceId,
      binding.context.projectId, binding.context.chatId, settings.scope]),
  };
}

/** One main-window human binding for the selected native chat; no credentials enter the UI. */
export function createRelayNativeRoomClient(options: RelayNativeRoomClientOptions) {
  let disposed = false;
  let binding: Binding | null = null;
  let publishedBinding: Binding | null = null;
  let activeRefresh: Promise<void> | null = null;
  let state: RelayNativeRoomState = {
    room: emptyRoom(options.readSettings()), humanAuthorized: false, error: null,
  };
  const listeners = new Set<() => void>();

  function publish(next: RelayNativeRoomState): void {
    if (disposed) return;
    state = next;
    for (const listener of listeners) listener();
  }

  function unbind(old: Binding): void {
    void options.invoke('relay_participant_unbind', {
      bindingId: old.bindingId, generation: old.generation,
    }).catch(() => undefined);
  }

  async function readContext(): Promise<ContextSnapshot | null> {
    const snapshot = validContext(await options.invoke('relay_active_context_snapshot'));
    return options.expectedChatId !== undefined && snapshot?.context?.chatId !== options.expectedChatId
      ? null : snapshot;
  }

  async function ensureBinding(): Promise<Binding> {
    const snapshot = await readContext();
    if (!snapshot?.context) throw new Error('No active Relay chat');
    const settings = options.readSettings();
    const context = snapshot.context;
    const sessionId = `vibespace-human-ui:${context.chatId}`;
    if (!canParticipateInRelay(settings, { projectId: context.projectId, sessionId }, context.projectId))
      throw new Error('Relay collaboration is off or excluded');
    if (binding && binding.generation === snapshot.generation &&
        binding.sessionId === sessionId && sameContext(binding.context, context)) return binding;
    if (binding) unbind(binding);
    binding = null;
    await options.invoke('relay_engine_start');
    const result = await options.invoke('relay_participant_bind', {
      scope: context, sessionId, generation: snapshot.generation,
      agentName: 'You', role: 'human',
    }) as Record<string, unknown>;
    if (typeof result?.bindingId !== 'string' || typeof result.relayAgentId !== 'string') {
      throw new Error('Relay human binding failed');
    }
    const current = await readContext();
    if (disposed || !current?.context || current.generation !== snapshot.generation ||
        !sameContext(current.context, context) ||
        !canParticipateInRelay(options.readSettings(), { projectId: context.projectId, sessionId }, context.projectId)) {
      unbind({ bindingId: result.bindingId, relayAgentId: result.relayAgentId,
        generation: snapshot.generation, context, sessionId });
      throw new Error('Relay chat changed while connecting');
    }
    binding = { bindingId: result.bindingId, relayAgentId: result.relayAgentId,
      generation: snapshot.generation, context, sessionId };
    return binding;
  }

  async function refreshOnce(): Promise<void> {
    const settings = options.readSettings();
    if (settings.scope === 'off') {
      if (binding) unbind(binding);
      binding = null;
      publishedBinding = null;
      publish({ room: emptyRoom(settings), humanAuthorized: false, error: null });
      return;
    }
    publish({ ...state, room: { ...state.room, scope: scopeLabel(settings),
      connection: state.room.connection === 'connected' ? 'connected' : 'connecting' } });
    try {
      const human = await ensureBinding();
      const result = await options.invoke('relay_human_room_snapshot', {
        bindingId: human.bindingId, generation: human.generation, limit: ROOM_LIMIT,
      });
      const current = await readContext();
      if (disposed || binding !== human || !current?.context || current.generation !== human.generation ||
          !sameContext(current.context, human.context)) throw new Error('Relay chat changed');
      const currentSettings = options.readSettings();
      if (!canParticipateInRelay(currentSettings, {
        projectId: human.context.projectId, sessionId: human.sessionId,
      }, human.context.projectId))
        throw new Error('Relay collaboration is off or excluded');
      // Room visibility and owner messaging must not wait on optional Dexie profile enrichment.
      publishedBinding = human;
      publish({ room: projectRoom(result, human, currentSettings, new Map()),
        humanAuthorized: true, error: null });
      if (options.readLocalProfiles) {
        void options.readLocalProfiles().then(async (profiles) => {
          if (disposed || binding !== human || publishedBinding !== human || !state.humanAuthorized ||
              state.room.connection !== 'connected') return;
          const current = await readContext().catch(() => null);
          if (disposed || binding !== human || publishedBinding !== human || !state.humanAuthorized ||
              state.room.connection !== 'connected') return;
          const settings = options.readSettings();
          if (!current?.context || current.generation !== human.generation ||
              !sameContext(current.context, human.context) ||
              !canParticipateInRelay(settings, {
                projectId: human.context.projectId, sessionId: human.sessionId,
              }, human.context.projectId)) {
            unbind(human);
            binding = null;
            publishedBinding = null;
            publish({ room: emptyRoom(settings), humanAuthorized: false,
              error: 'Relay room unavailable for this chat.' });
            return;
          }
          const local = new Map(profiles.map((profile) => [profile.relayAgentId, profile]));
          publish({ ...state, room: { ...state.room, participants: state.room.participants.map((participant) => {
            const profile = local.get(participant.id);
            return profile ? { ...participant, harness: profile.harness, model: profile.model,
              task: profile.task, files: profile.files, latestPrompt: profile.latestPrompt } : participant;
          }) } });
        }).catch(() => undefined);
      }
    } catch {
      if (binding) unbind(binding);
      binding = null;
      publishedBinding = null;
      publish({ room: emptyRoom(options.readSettings()),
        humanAuthorized: false, error: 'Relay room unavailable for this chat.' });
    }
  }

  return {
    getSnapshot(): RelayNativeRoomState { return state; },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh(): Promise<void> {
      if (disposed) return Promise.resolve();
      if (!activeRefresh) activeRefresh = refreshOnce().finally(() => { activeRefresh = null; });
      return activeRefresh;
    },
    async send(text: string, parentMessageId?: string): Promise<void> {
      if (disposed || !binding || binding !== publishedBinding ||
          !state.humanAuthorized || state.room.connection !== 'connected' ||
          typeof text !== 'string' || !text.trim() || text.length > 8192) {
        throw new Error('Relay room is not authorized');
      }
      if (parentMessageId && !state.room.messages.some((message) => message.id === parentMessageId)) {
        throw new Error('Relay reply target is no longer in this room');
      }
      // A draft/reply belongs to the visible room. Never rebind a pending send
      // to a newer native context, even if the backend reuses a binding ID.
      const human = binding;
      const current = await readContext();
      if (disposed || binding !== human || publishedBinding !== human || !current?.context ||
          current.generation !== human.generation || !sameContext(current.context, human.context) ||
          !canParticipateInRelay(options.readSettings(), {
            projectId: human.context.projectId, sessionId: human.sessionId,
          }, human.context.projectId)) throw new Error('Relay room changed');
      await options.invoke('relay_human_message', {
        bindingId: human.bindingId, generation: human.generation, text: text.trim(),
        ...(parentMessageId ? { parentMessageId } : {}),
      });
      // An earlier timer refresh may have read the room before this post.
      // Wait for it, then fetch the post-write state for the composer.
      if (activeRefresh) await activeRefresh;
      await this.refresh();
    },
    dispose(): void {
      disposed = true;
      if (binding) unbind(binding);
      binding = null;
      publishedBinding = null;
      listeners.clear();
    },
  };
}
