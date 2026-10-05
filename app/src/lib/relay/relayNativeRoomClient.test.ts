import { describe, expect, it, vi } from 'vitest';
import { createRelayNativeRoomClient } from './relayNativeRoomClient';
import type { RelaySettings } from '@/features/settings/relaySettings';

const context = {
  accountId: 'account-1', workspaceId: 'workspace-1', projectId: 'project-1', chatId: 'chat-1',
};

function fixture(workspaceId: string | null = 'workspace-1') {
  let nativeContext = { ...context, workspaceId };
  let settings: RelaySettings = {
    scope: 'project', automaticParticipation: false, excludedParticipants: [],
  };
  let generation = 2;
  const invoke = vi.fn(async (command: string): Promise<unknown> => {
    if (command === 'relay_active_context_snapshot') return { generation, context: nativeContext };
    if (command === 'relay_engine_start') return { running: true, healthy: true };
    if (command === 'relay_participant_bind') return { bindingId: 'human-binding', relayAgentId: 'human-agent' };
    if (command === 'relay_human_room_snapshot') return {
      channel: 'vibespace',
      participants: [
        { id: 'human-agent', name: 'upstream-human', role: 'human', status: 'online' },
        { id: 'old-human', name: 'previous-human-binding', role: 'human', status: 'offline' },
        { id: 'peer-1', name: 'Luna', role: 'agent', status: 'online', persona: 'Helpful' },
      ],
      messages: [
        { id: 'parent-1', authorId: 'peer-1', text: 'Working on Relay.',
          createdAt: '2026-09-26T12:00:00Z', replyCount: 1 },
        { id: 'reply-1', authorId: 'human-agent', text: 'Thanks.',
          parentId: 'parent-1', createdAt: '2026-09-26T12:00:01Z' },
        { id: 'old-human-message', authorId: 'old-human', text: 'Earlier.',
          createdAt: '2026-09-26T11:59:59Z' },
      ],
    };
    if (command === 'relay_human_message') return { messageId: 'message-2' };
    if (command === 'relay_participant_unbind') return {};
    throw new Error(`Unexpected ${command}`);
  });
  const client = createRelayNativeRoomClient({ invoke, readSettings: () => settings });
  return { client, invoke,
    setSettings(value: RelaySettings) { settings = value; },
    setGeneration(value: number) { generation = value; },
    setContext(value: typeof nativeContext) { nativeContext = value; },
  };
}

describe('native Relay human room', () => {
  it('does not bind another chat while native selection is catching up', async () => {
    const f = fixture();
    const client = createRelayNativeRoomClient({ invoke: f.invoke,
      readSettings: () => ({ scope: 'project', automaticParticipation: false, excludedParticipants: [] }),
      expectedChatId: 'new-chat',
    });
    await client.refresh();
    expect(client.getSnapshot().humanAuthorized).toBe(false);
    expect(f.invoke.mock.calls.some(([command]) => command === 'relay_participant_bind')).toBe(false);
    client.dispose();
  });

  it('shows the room before slow optional profile enrichment completes', async () => {
    const f = fixture();
    let finishProfiles: ((value: { relayAgentId: string; model: string }[]) => void) | undefined;
    const client = createRelayNativeRoomClient({ invoke: f.invoke,
      readSettings: () => ({ scope: 'project', automaticParticipation: false, excludedParticipants: [] }),
      readLocalProfiles: () => new Promise((resolve) => { finishProfiles = resolve; }),
    });
    await client.refresh();
    expect(client.getSnapshot().room.connection).toBe('connected');
    expect(client.getSnapshot().humanAuthorized).toBe(true);
    finishProfiles?.([{ relayAgentId: 'peer-1', model: 'gpt-6-luna' }]);
    await vi.waitFor(() => expect(client.getSnapshot().room.participants[1].model).toBe('gpt-6-luna'));
    client.dispose();
  });

  it('binds one verified human identity, projects only real room rows, and sends through the native command', async () => {
    const f = fixture();
    await Promise.all([f.client.refresh(), f.client.refresh()]);
    await f.client.refresh();
    const state = f.client.getSnapshot();
    expect(state.humanAuthorized).toBe(true);
    expect(state.room).toMatchObject({
      connection: 'connected', scope: 'Project',
      participants: [{ id: 'human-agent', name: 'You', kind: 'human' },
        { id: 'peer-1', name: 'Luna', kind: 'agent', persona: 'Helpful' }],
      messages: [{ id: 'parent-1', replyCount: 1 }, { id: 'reply-1', parentId: 'parent-1' },
        { id: 'old-human-message', participantId: 'human-agent' }],
    });
    expect(f.invoke.mock.calls.filter(([name]) => name === 'relay_participant_bind')).toHaveLength(1);
    await f.client.send('  Please report status.  ');
    expect(f.invoke).toHaveBeenCalledWith('relay_human_message', {
      bindingId: 'human-binding', generation: 2, text: 'Please report status.',
    });
    f.client.dispose();
    expect(f.invoke).toHaveBeenCalledWith('relay_participant_unbind', {
      bindingId: 'human-binding', generation: 2,
    });
  });

  it('denies Off and exclusions and revokes a live room after opt-out', async () => {
    const f = fixture();
    await f.client.refresh();
    f.setSettings({ scope: 'off', automaticParticipation: false, excludedParticipants: [] });
    await f.client.refresh();
    expect(f.client.getSnapshot()).toMatchObject({
      humanAuthorized: false, room: { connection: 'offline', participants: [], messages: [] },
    });
    await expect(f.client.send('forged')).rejects.toThrow('not authorized');
    expect(f.invoke.mock.calls.filter(([name]) => name === 'relay_participant_unbind')).toHaveLength(1);
    f.setSettings({ scope: 'project', automaticParticipation: false, excludedParticipants: ['project-1'] });
    await f.client.refresh();
    expect(f.client.getSnapshot().humanAuthorized).toBe(false);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'relay_participant_bind')).toHaveLength(1);
    f.client.dispose();
  });

  it('routes a reply to a visible message through the native parent ID', async () => {
    const f = fixture();
    await f.client.refresh();
    await f.client.send('  Here is the answer.  ', 'parent-1');
    expect(f.invoke).toHaveBeenCalledWith('relay_human_message', {
      bindingId: 'human-binding', generation: 2, text: 'Here is the answer.',
      parentMessageId: 'parent-1',
    });
    await expect(f.client.send('orphan', 'missing-parent')).rejects.toThrow('reply target');
    f.client.dispose();
  });

  it('rebinds only for a new native generation and rejects stale send authority', async () => {
    const f = fixture();
    await f.client.refresh();
    f.setGeneration(3);
    await f.client.refresh();
    expect(f.invoke.mock.calls.filter(([name]) => name === 'relay_participant_bind')).toHaveLength(2);
    expect(f.invoke).toHaveBeenCalledWith('relay_participant_unbind', {
      bindingId: 'human-binding', generation: 2,
    });
    f.client.dispose();
  });

  it.each(['generation', 'chat', 'account', 'project'] as const)(
    'does not send an old-room draft after the native %s changes', async (change) => {
      const f = fixture();
      await f.client.refresh();
      if (change === 'generation') f.setGeneration(3);
      else f.setContext({ ...context, [`${change}Id`]: `${change}-2` });

      await expect(f.client.send('Draft for the original room', 'parent-1')).rejects.toThrow();
      expect(f.invoke.mock.calls.some(([command]) => command === 'relay_human_message')).toBe(false);
      f.client.dispose();
    },
  );

  it.each(['project-1', 'vibespace-human-ui:chat-1'])(
    'discards an in-flight room snapshot after excluding %s', async (excludedId) => {
      const f = fixture();
      await f.client.refresh();
      const original = f.invoke.getMockImplementation()!;
      let releaseSnapshot!: () => void;
      const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
      let snapshotStarted = false;
      f.invoke.mockImplementation(async (command) => {
        const value = await original(command);
        if (command === 'relay_human_room_snapshot') {
          snapshotStarted = true;
          await snapshotGate;
        }
        return value;
      });
      const refresh = f.client.refresh();
      await vi.waitFor(() => expect(snapshotStarted).toBe(true));
      f.setSettings({ scope: 'project', automaticParticipation: false,
        excludedParticipants: [excludedId] });
      releaseSnapshot();
      await refresh;

      expect(f.client.getSnapshot()).toMatchObject({
        humanAuthorized: false, room: { connection: 'offline', participants: [], messages: [] },
      });
      expect(f.invoke).toHaveBeenCalledWith('relay_participant_unbind', {
        bindingId: 'human-binding', generation: 2,
      });
      f.client.dispose();
    },
  );

  it('rechecks exclusions changed while send validates the native context', async () => {
    const f = fixture();
    await f.client.refresh();
    const original = f.invoke.getMockImplementation()!;
    let releaseContext!: () => void;
    const contextGate = new Promise<void>((resolve) => { releaseContext = resolve; });
    f.invoke.mockImplementation(async (command) => {
      if (command === 'relay_active_context_snapshot') await contextGate;
      return original(command);
    });
    const send = f.client.send('Must not send after exclusion');
    const denied = expect(send).rejects.toThrow();
    f.setSettings({ scope: 'project', automaticParticipation: false,
      excludedParticipants: ['project-1'] });
    releaseContext();
    await denied;
    expect(f.invoke.mock.calls.some(([command]) => command === 'relay_human_message')).toBe(false);
    f.client.dispose();
  });

  it.each([undefined, 'parent-1'])(
    'rejects an old visible-room draft during rebind and permits a deliberate fresh send (parent %s)',
    async (parentMessageId) => {
      const f = fixture();
      await f.client.refresh();
      const original = f.invoke.getMockImplementation()!;
      let releaseSnapshot!: () => void;
      const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
      let snapshotStarted = false;
      f.invoke.mockImplementation(async (command) => {
        const value = await original(command);
        if (command === 'relay_human_room_snapshot') {
          snapshotStarted = true;
          await snapshotGate;
        }
        return value;
      });
      f.setContext({ ...context, chatId: 'chat-2' });
      const refresh = f.client.refresh();
      await vi.waitFor(() => expect(snapshotStarted).toBe(true));
      const outcome = f.client.send('Draft authored in chat-1', parentMessageId)
        .then(() => 'sent', () => 'rejected');
      await new Promise((resolve) => setTimeout(resolve, 0));
      const attempted = f.invoke.mock.calls.filter(([command]) => command === 'relay_human_message').length;
      releaseSnapshot();
      await refresh;
      expect(await outcome).toBe('rejected');
      expect(attempted).toBe(0);

      expect(f.client.getSnapshot().room.roomId).toContain('chat-2');
      await f.client.send('Deliberate new chat-2 message');
      expect(f.invoke.mock.calls.filter(([command]) => command === 'relay_human_message')).toHaveLength(1);
      f.client.dispose();
    },
  );

  it.each(['project-excluded', 'session-excluded', 'off', 'generation', 'chat', 'account', 'project'] as const)(
    'revokes late optional profile enrichment after %s changes', async (change) => {
      const f = fixture();
      let settings: RelaySettings = { scope: 'project', automaticParticipation: false, excludedParticipants: [] };
      let finishProfiles!: (profiles: { relayAgentId: string; latestPrompt: string }[]) => void;
      const client = createRelayNativeRoomClient({
        invoke: f.invoke, readSettings: () => settings,
        readLocalProfiles: () => new Promise((resolve) => { finishProfiles = resolve; }),
      });
      await client.refresh();
      const leakedPrompts: string[] = [];
      const unsubscribe = client.subscribe(() => {
        leakedPrompts.push(...client.getSnapshot().room.participants.flatMap((participant) =>
          participant.latestPrompt ? [participant.latestPrompt] : []));
      });
      if (change === 'project-excluded') settings = { ...settings, excludedParticipants: ['project-1'] };
      else if (change === 'session-excluded') settings = { ...settings, excludedParticipants: ['vibespace-human-ui:chat-1'] };
      else if (change === 'off') settings = { ...settings, scope: 'off' };
      else if (change === 'generation') f.setGeneration(3);
      else f.setContext({ ...context, [`${change}Id`]: `${change}-2` });
      finishProfiles([{ relayAgentId: 'peer-1', latestPrompt: 'Synthetic old-room task' }]);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(leakedPrompts).toEqual([]);
      expect(client.getSnapshot()).toMatchObject({
        humanAuthorized: false, room: { connection: 'offline', participants: [], messages: [] },
      });
      expect(f.invoke).toHaveBeenCalledWith('relay_participant_unbind', {
        bindingId: 'human-binding', generation: 2,
      });
      unsubscribe();
      client.dispose();
    },
  );

  it('reads the posted message after an older room refresh finishes', async () => {
    const f = fixture();
    const original = f.invoke.getMockImplementation()!;
    let posted = false;
    let snapshotCount = 0;
    let releaseStale: (() => void) | undefined;
    let releasePost: (() => void) | undefined;
    let postStarted = false;
    f.invoke.mockImplementation(async (command) => {
      if (command === 'relay_human_message') {
        postStarted = true;
        await new Promise<void>((resolve) => { releasePost = resolve; });
        posted = true;
      }
      const value = await original(command) as Record<string, unknown>;
      if (command !== 'relay_human_room_snapshot') return value;
      snapshotCount++;
      if (snapshotCount === 2) await new Promise<void>((resolve) => { releaseStale = resolve; });
      if (snapshotCount > 2 && posted) return { ...value, messages: [
        ...(value.messages as unknown[]),
        { id: 'message-2', authorId: 'human-agent', text: 'hello', createdAt: '2026-09-26T12:00:02Z' },
      ] };
      return value;
    });
    await f.client.refresh();
    const send = f.client.send('hello');
    await vi.waitFor(() => expect(postStarted).toBe(true));
    const oldRefresh = f.client.refresh();
    await vi.waitFor(() => expect(snapshotCount).toBe(2));
    releasePost?.();
    await vi.waitFor(() => expect(posted).toBe(true));
    releaseStale?.();
    await Promise.all([oldRefresh, send]);
    expect(f.client.getSnapshot().room.messages.map((message) => message.id)).toContain('message-2');
    f.client.dispose();
  });
});


it('exposes a stable room identity that survives polling and generation reconnects', async () => {
  const f = fixture();
  await f.client.refresh();
  const identity = f.client.getSnapshot().room.roomId;
  expect(identity).toBe(JSON.stringify(['account-1', 'workspace-1', 'project-1', 'chat-1', 'project']));
  f.setGeneration(3);
  await f.client.refresh();
  expect(f.client.getSnapshot().room.roomId).toBe(identity);
  f.client.dispose();
});


it('connects the native local-workspace room without a cloud workspace ID', async () => {
  const f = fixture(null);
  await f.client.refresh();
  expect(f.client.getSnapshot()).toMatchObject({ humanAuthorized: true, room: { connection: 'connected' } });
  expect(f.invoke).toHaveBeenCalledWith('relay_participant_bind', expect.objectContaining({
    scope: { ...context, workspaceId: null }, role: 'human',
  }));
  f.client.dispose();
});
