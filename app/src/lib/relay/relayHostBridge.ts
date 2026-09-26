/**
 * Host-only boundary for the published @agent-relay/sdk@12.4.1 RelayAgentClient.
 * This structural port uses only methods present in its dist/facade.d.ts and
 * dist/messaging/types.d.ts. The SDK is not yet an app dependency; the host
 * supplies an already registered, agent-token-scoped client after installation.
 * Never expose this bridge or its client/token to renderer or model code.
 */

export interface RelayHostSession {
  profileId: string;
  accountId: string;
  workspaceId: string;
  projectId: string;
  sessionId: string;
  generation: number;
  relayWorkspaceId: string;
  relayAgentId: string;
  relayAgentName: string;
  role: 'agent' | 'human';
}

export interface RelayScopePolicy {
  mode: 'off' | 'project' | 'app';
  profileId: string;
  accountId: string;
  workspaceId: string;
  projectId?: string;
  relayWorkspaceId: string;
  excludedProjectIds?: readonly string[];
  excludedSessionIds?: readonly string[];
}

type RelayMessage = {
  id: string;
  messageId?: string;
  text?: string;
  from?: { id?: string; name?: string };
  channel?: { name?: string };
  createdAt?: string;
  replyCount?: number;
};

/** Subset of the upstream live-client declarations, with no credential surface. */
export interface RelayClientPort {
  readonly id: string;
  readonly name: string;
  sendMessage(input: { to: string; text: string }): Promise<unknown>;
  reply(input: { messageId: string; text: string }): Promise<unknown>;
  readonly channels: { join(name: string): Promise<unknown> };
  readonly agents: {
    list(options?: { status?: 'online' | 'offline' }): Promise<unknown[]>;
    me(): Promise<{ id: string; name: string; type: 'agent' | 'human' }>;
  };
  readonly workspace: { info(): Promise<{ id?: string }> };
  readonly messages: {
    list(
      channel: string,
      options?: { limit?: number; before?: string; after?: string },
    ): Promise<unknown[]>;
    get(id: string): Promise<RelayMessage>;
    markRead(messageId: string): Promise<unknown>;
    direct(input: { to: string; text: string }): Promise<unknown>;
  };
  readonly threads: { get(messageId: string, options?: { limit?: number }): Promise<unknown> };
  readonly inbox: { get(options?: { limit?: number }): Promise<unknown> };
}

export const RELAY_GROUP_TOOL_NAMES = [
  'agent.list',
  'message.post',
  'message.list',
  'message.reply',
  'message.get_thread',
  'message.dm.send',
  'message.inbox.check',
  'message.inbox.mark_read',
] as const;

export type RelayGroupToolName = (typeof RELAY_GROUP_TOOL_NAMES)[number];

export interface RelayParticipantHandle {
  readonly role: 'agent' | 'human';
  readonly sessionId: string;
  call(tool: string, args: unknown): Promise<unknown>;
}

type BoundParticipant = {
  token: symbol;
  session: Readonly<RelayHostSession>;
  client: RelayClientPort;
};

function exactArgs(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid Relay tool arguments');
  const args = input as Record<string, unknown>;
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new Error(`Relay tool argument ${key} is not allowed`);
  }
  return args;
}

function requiredString(value: unknown, field: string, max = 8192): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`Invalid Relay ${field}`);
  return value;
}

function optionalLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 50)
    throw new Error('Invalid Relay limit');
  return value as number;
}

function sameSession(a: RelayHostSession, b: RelayHostSession): boolean {
  return (
    a.profileId === b.profileId &&
    a.accountId === b.accountId &&
    a.workspaceId === b.workspaceId &&
    a.projectId === b.projectId &&
    a.sessionId === b.sessionId &&
    a.generation === b.generation &&
    a.relayWorkspaceId === b.relayWorkspaceId &&
    a.relayAgentId === b.relayAgentId &&
    a.relayAgentName === b.relayAgentName &&
    a.role === b.role
  );
}

function inScope(session: RelayHostSession, policy: RelayScopePolicy): boolean {
  if (policy.mode === 'off') return false;
  if (!session.sessionId || !Number.isSafeInteger(session.generation) || session.generation < 0)
    return false;
  if (!session.relayAgentId || !session.relayAgentName || !session.projectId) return false;
  if (
    session.profileId !== policy.profileId ||
    session.accountId !== policy.accountId ||
    session.workspaceId !== policy.workspaceId ||
    session.relayWorkspaceId !== policy.relayWorkspaceId
  )
    return false;
  if (policy.mode === 'project' && session.projectId !== policy.projectId) return false;
  if (
    policy.excludedProjectIds?.includes(session.projectId) ||
    policy.excludedSessionIds?.includes(session.sessionId)
  )
    return false;
  return true;
}

function copyPolicy(value: RelayScopePolicy): RelayScopePolicy {
  return {
    ...value,
    excludedProjectIds: value.excludedProjectIds ? [...value.excludedProjectIds] : undefined,
    excludedSessionIds: value.excludedSessionIds ? [...value.excludedSessionIds] : undefined,
  };
}

/** Host callback must read the authoritative live session, never model or Relay metadata. */
export function createRelayHostBridge(options: {
  channel: string;
  policy: RelayScopePolicy;
  getLiveSession(sessionId: string): RelayHostSession | null;
  /** Host UI authentication authority. Never expose tickets through Relay tools. */
  verifyHumanControlTicket?(ticket: unknown, human: RelayHostSession): boolean | Promise<boolean>;
  /** Existing runtime cancellation authority, not an upstream Relay tool. */
  stopAgent?(target: RelayHostSession): Promise<void>;
}) {
  const channel = requiredString(options.channel, 'channel', 64);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(channel)) throw new Error('Invalid Relay channel');
  let policy = copyPolicy(options.policy);
  let epoch = 0;
  const bound = new Map<string, BoundParticipant>();

  function requireLive(participant: BoundParticipant): void {
    if (bound.get(participant.session.sessionId)?.token !== participant.token)
      throw new Error('Relay participant revoked');
    if (!inScope(participant.session, policy)) throw new Error('Relay participant out of scope');
    const live = options.getLiveSession(participant.session.sessionId);
    if (!live || !sameSession(participant.session, live))
      throw new Error('Relay live session changed');
  }

  function requireGroupMessage(message: RelayMessage): void {
    if (message.channel?.name !== channel) throw new Error('Relay message outside group channel');
  }

  async function call(
    participant: BoundParticipant,
    tool: string,
    input: unknown,
  ): Promise<unknown> {
    requireLive(participant);
    if (!(RELAY_GROUP_TOOL_NAMES as readonly string[]).includes(tool))
      throw new Error(`Relay tool ${tool} is not allowed`);
    const client = participant.client;
    switch (tool as RelayGroupToolName) {
      case 'agent.list': {
        const args = exactArgs(input, ['status']);
        const status = args.status;
        if (status !== undefined && status !== 'online' && status !== 'offline')
          throw new Error('Invalid Relay status');
        return client.agents.list(status ? { status } : undefined);
      }
      case 'message.post': {
        const args = exactArgs(input, ['channel', 'text']);
        if (args.channel !== channel) throw new Error('Relay channel mismatch');
        return client.sendMessage({ to: `#${channel}`, text: requiredString(args.text, 'text') });
      }
      case 'message.list': {
        const args = exactArgs(input, ['channel', 'limit', 'before', 'after']);
        if (args.channel !== channel) throw new Error('Relay channel mismatch');
        const limit = optionalLimit(args.limit) ?? 30;
        const before =
          args.before === undefined ? undefined : requiredString(args.before, 'before', 256);
        const after =
          args.after === undefined ? undefined : requiredString(args.after, 'after', 256);
        return client.messages.list(channel, { limit, before, after });
      }
      case 'message.reply': {
        const args = exactArgs(input, ['message_id', 'text']);
        const messageId = requiredString(args.message_id, 'message_id', 256);
        requireGroupMessage(await client.messages.get(messageId));
        requireLive(participant);
        return client.reply({ messageId, text: requiredString(args.text, 'text') });
      }
      case 'message.get_thread': {
        const args = exactArgs(input, ['message_id', 'limit']);
        const messageId = requiredString(args.message_id, 'message_id', 256);
        requireGroupMessage(await client.messages.get(messageId));
        requireLive(participant);
        return client.threads.get(messageId, { limit: optionalLimit(args.limit) ?? 30 });
      }
      case 'message.dm.send': {
        const args = exactArgs(input, ['to', 'text']);
        return client.messages.direct({
          to: requiredString(args.to, 'to', 128),
          text: requiredString(args.text, 'text'),
        });
      }
      case 'message.inbox.check': {
        const args = exactArgs(input, ['limit']);
        return client.inbox.get({ limit: optionalLimit(args.limit) ?? 30 });
      }
      case 'message.inbox.mark_read': {
        const args = exactArgs(input, ['message_id']);
        const messageId = requiredString(args.message_id, 'message_id', 256);
        requireGroupMessage(await client.messages.get(messageId));
        requireLive(participant);
        return client.messages.markRead(messageId);
      }
    }
  }

  async function authorizedHuman(sessionId: string, ticket: unknown): Promise<BoundParticipant> {
    const participant = bound.get(sessionId);
    if (!participant || participant.session.role !== 'human' || !options.verifyHumanControlTicket) {
      throw new Error('Relay human control denied');
    }
    requireLive(participant);
    if (!(await options.verifyHumanControlTicket(ticket, participant.session)))
      throw new Error('Relay human control denied');
    requireLive(participant);
    return participant;
  }

  return {
    async bind(
      session: RelayHostSession,
      client: RelayClientPort,
    ): Promise<RelayParticipantHandle> {
      if (!inScope(session, policy)) throw new Error('Relay session outside scope');
      const live = options.getLiveSession(session.sessionId);
      if (!live || !sameSession(session, live)) throw new Error('Relay live session mismatch');
      if (client.id !== session.relayAgentId || client.name !== session.relayAgentName)
        throw new Error('Relay client identity mismatch');
      const bindingEpoch = epoch;
      const [workspace, agent] = await Promise.all([client.workspace.info(), client.agents.me()]);
      if (workspace.id !== session.relayWorkspaceId)
        throw new Error('Relay client workspace mismatch');
      if (
        agent.id !== session.relayAgentId ||
        agent.name !== session.relayAgentName ||
        agent.type !== session.role
      ) {
        throw new Error('Relay client identity mismatch');
      }
      if (bindingEpoch !== epoch || !inScope(session, policy))
        throw new Error('Relay scope changed during bind');
      for (const existing of bound.values()) {
        if (
          existing.session.sessionId !== session.sessionId &&
          existing.session.relayAgentId === client.id
        )
          throw new Error('Relay client identity already bound');
      }
      await client.channels.join(channel);
      if (bindingEpoch !== epoch || !inScope(session, policy))
        throw new Error('Relay scope changed during bind');
      const liveAfterJoin = options.getLiveSession(session.sessionId);
      if (!liveAfterJoin || !sameSession(session, liveAfterJoin))
        throw new Error('Relay live session changed during bind');
      for (const existing of bound.values()) {
        if (
          existing.session.sessionId !== session.sessionId &&
          existing.session.relayAgentId === client.id
        )
          throw new Error('Relay client identity already bound');
      }
      const participant: BoundParticipant = {
        token: Symbol(session.sessionId),
        session: { ...session },
        client,
      };
      bound.set(session.sessionId, participant);
      return Object.freeze({
        role: session.role,
        sessionId: session.sessionId,
        call: (tool: string, args: unknown) => call(participant, tool, args),
      });
    },
    setPolicy(next: RelayScopePolicy): void {
      policy = copyPolicy(next);
      epoch += 1;
      bound.clear();
    },
    unbind(sessionId: string): void {
      bound.delete(sessionId);
    },
    /** Verifies the live SDK identity and workspace over the backend connection. */
    async checkConnection(sessionId: string): Promise<{
      connected: boolean;
      reason: 'ready' | 'off' | 'not_bound' | 'stale' | 'backend_unavailable';
    }> {
      if (policy.mode === 'off') return { connected: false, reason: 'off' };
      const participant = bound.get(sessionId);
      if (!participant) return { connected: false, reason: 'not_bound' };
      try {
        requireLive(participant);
      } catch {
        return { connected: false, reason: 'stale' };
      }
      let workspace: { id?: string };
      let agent: { id: string; name: string; type: 'agent' | 'human' };
      try {
        [workspace, agent] = await Promise.all([
          participant.client.workspace.info(),
          participant.client.agents.me(),
        ]);
      } catch {
        return { connected: false, reason: 'backend_unavailable' };
      }
      try {
        requireLive(participant);
      } catch {
        return { connected: false, reason: 'stale' };
      }
      if (
        workspace.id !== participant.session.relayWorkspaceId ||
        agent.id !== participant.session.relayAgentId ||
        agent.name !== participant.session.relayAgentName ||
        agent.type !== participant.session.role
      )
        return { connected: false, reason: 'stale' };
      return { connected: true, reason: 'ready' };
    },
    /** Bounded room view for authenticated VibeSpace UI; tokens/metadata are omitted. */
    async roomSnapshot(humanSessionId: string, ticket: unknown, limit = 30) {
      const human = await authorizedHuman(humanSessionId, ticket);
      const boundedLimit = optionalLimit(limit) ?? 30;
      const [rawMessages, rawAgents] = await Promise.all([
        human.client.messages.list(channel, { limit: boundedLimit }),
        human.client.agents.list(),
      ]);
      requireLive(human);
      const messages = rawMessages.flatMap((value) => {
        if (!value || typeof value !== 'object') return [];
        const message = value as RelayMessage;
        if (typeof message.id !== 'string') return [];
        if (message.channel?.name && message.channel.name !== channel) return [];
        return [
          {
            messageId: message.messageId ?? message.id,
            text: typeof message.text === 'string' ? message.text : '',
            authorId: message.from?.id,
            authorName: message.from?.name ?? 'Unknown',
            authorRole:
              message.from?.id === human.session.relayAgentId
                ? ('human' as const)
                : ('agent' as const),
            createdAt: message.createdAt,
            replyCount: message.replyCount ?? 0,
            authority: 'untrusted-peer' as const,
          },
        ];
      });
      const participants = rawAgents.flatMap((value) => {
        if (!value || typeof value !== 'object') return [];
        const agent = value as Record<string, unknown>;
        if (typeof agent.id !== 'string' || typeof agent.name !== 'string') return [];
        return [
          {
            id: agent.id,
            name: agent.name,
            role: agent.id === human.session.relayAgentId ? ('human' as const) : ('agent' as const),
            status: typeof agent.status === 'string' ? agent.status : 'unknown',
            iconKey: agent.id,
          },
        ];
      });
      return { channel, messages, participants };
    },
    /** Higher-authority local UI action; never exposed in RELAY_GROUP_TOOL_NAMES. */
    async humanBroadcast(humanSessionId: string, ticket: unknown, text: string): Promise<unknown> {
      const human = await authorizedHuman(humanSessionId, ticket);
      return human.client.sendMessage({ to: `#${channel}`, text: requiredString(text, 'text') });
    },
    /** Stops through VibeSpace's existing host authority; Relay peers cannot invoke it. */
    async humanStop(
      humanSessionId: string,
      ticket: unknown,
      targetSessionId: string,
    ): Promise<void> {
      const human = await authorizedHuman(humanSessionId, ticket);
      const target = bound.get(targetSessionId);
      if (!target || target.session.role !== 'agent' || !options.stopAgent)
        throw new Error('Relay stop target denied');
      requireLive(human);
      requireLive(target);
      await options.stopAgent(target.session);
    },
    /** Display only. Never promote upstream message content to user/system authority. */
    peerEnvelope(message: RelayMessage, sourceRelayWorkspaceId: string) {
      if (sourceRelayWorkspaceId !== policy.relayWorkspaceId)
        throw new Error('Relay peer workspace mismatch');
      requireGroupMessage(message);
      return {
        messageId: requiredString(message.messageId ?? message.id, 'message_id', 256),
        text: typeof message.text === 'string' ? message.text : '',
        authorName: message.from?.name ?? 'Unknown',
        authority: 'untrusted-peer' as const,
        channel,
      };
    },
  };
}
