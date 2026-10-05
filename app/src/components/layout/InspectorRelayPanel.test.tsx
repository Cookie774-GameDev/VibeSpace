import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createRelayNativeRoomClient } from '@/lib/relay/relayNativeRoomClient';
import { InspectorRelayPanel } from './InspectorRelayPanel';
import { invoke } from '@tauri-apps/api/core';
import { readRelaySettings } from '@/features/settings/relaySettings';
import { readLocalRelayProfiles } from '@/lib/relay/relayLocalProfiles';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@/features/settings/relaySettings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/settings/relaySettings')>()),
  readRelaySettings: vi.fn(),
}));
vi.mock('@/lib/relay/relayLocalProfiles', () => ({ readLocalRelayProfiles: vi.fn() }));
vi.mock('@/lib/relay/relayNativeRoomClient', () => ({ createRelayNativeRoomClient: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('mounts the native Relay room in the Inspector and forwards a threaded reply', async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const refresh = vi.fn().mockResolvedValue(undefined);
  const dispose = vi.fn();
  const snapshot = {
    humanAuthorized: true,
    error: null,
    room: {
      connection: 'connected' as const,
      scope: 'Project' as const,
      participants: [
        { id: 'owner', name: 'You', kind: 'human' as const, status: 'online' as const },
        { id: 'agent', name: 'Luna', kind: 'agent' as const, status: 'online' as const },
      ],
      messages: [
        {
          id: 'parent',
          participantId: 'agent',
          text: 'Checking files.',
          at: 1000,
          kind: 'message' as const,
        },
      ],
    },
  };
  vi.mocked(createRelayNativeRoomClient).mockReturnValue({
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    refresh,
    send,
    dispose,
  } as ReturnType<typeof createRelayNativeRoomClient>);

  const close = vi.fn();
  const view = render(<InspectorRelayPanel projectId="project-1" onClose={close} />);
  expect(screen.getByRole('region', { name: 'Agent Relay group chat' })).toBeTruthy();
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'Reply to Luna' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Message Agent Relay' }), {
    target: { value: 'Which files?' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send to group' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith('Which files?', 'parent'));
  fireEvent.click(screen.getByRole('button', { name: 'Close Agent Relay' }));
  expect(close).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(dispose).toHaveBeenCalledTimes(1);
});

it('connects and sends as the verified human after the native app StrictMode effect replay', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/relayNativeRoomClient')>(
    '@/lib/relay/relayNativeRoomClient',
  );
  vi.mocked(createRelayNativeRoomClient).mockImplementation(actual.createRelayNativeRoomClient);
  vi.mocked(readRelaySettings).mockReturnValue({
    scope: 'project',
    automaticParticipation: false,
    excludedParticipants: [],
  });
  vi.mocked(readLocalRelayProfiles).mockResolvedValue([]);
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'relay_active_context_snapshot')
      return {
        generation: 2,
        context: {
          accountId: 'account-1',
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          chatId: 'chat-1',
        },
      } as never;
    if (command === 'relay_engine_start') return { running: true, healthy: true } as never;
    if (command === 'relay_participant_bind')
      return { bindingId: 'live-human-binding', relayAgentId: 'human-agent' } as never;
    if (command === 'relay_human_room_snapshot')
      return {
        channel: 'vibespace',
        participants: [{ id: 'human-agent', name: 'You', role: 'human', status: 'online' }],
        messages: [],
      } as never;
    if (command === 'relay_human_message') return { messageId: 'message-1' } as never;
    if (command === 'relay_participant_unbind') return {} as never;
    throw new Error(`Unexpected native command ${command}`);
  });
  const view = render(
    <StrictMode>
      <InspectorRelayPanel projectId="project-1" chatId="chat-1" onClose={() => {}} />
    </StrictMode>,
  );
  await waitFor(() =>
    expect(
      (screen.getByRole('textbox', { name: 'Message Agent Relay' }) as HTMLTextAreaElement)
        .disabled,
    ).toBe(false),
  );
  const composer = screen.getByRole('textbox', { name: 'Message Agent Relay' });
  expect(screen.queryByText('Owner access unavailable')).toBeNull();
  fireEvent.change(composer, { target: { value: 'Hello agents' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send to group' }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('relay_human_message', {
      bindingId: 'live-human-binding',
      generation: 2,
      text: 'Hello agents',
    }),
  );
  view.unmount();
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('relay_participant_unbind', {
      bindingId: 'live-human-binding',
      generation: 2,
    }),
  );
});
