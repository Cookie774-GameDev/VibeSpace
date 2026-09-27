import { describe, expect, it, vi } from 'vitest';
import { createRelayNativeRoomClient } from './relayNativeRoomClient';
import type { RelaySettings } from '@/features/settings/relaySettings';

const context = {
  accountId: 'account-1', workspaceId: 'workspace-1', projectId: 'project-1', chatId: 'chat-1',
};

function fixture() {
  let settings: RelaySettings = {
    scope: 'project', automaticParticipation: false, excludedParticipants: [],
  };
  let generation = 2;
  const invoke = vi.fn(async (command: string): Promise<unknown> => {
    if (command === 'relay_active_context_snapshot') return { generation, context };
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
