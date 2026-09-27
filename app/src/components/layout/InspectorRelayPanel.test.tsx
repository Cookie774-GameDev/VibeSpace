import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createRelayNativeRoomClient } from '@/lib/relay/relayNativeRoomClient';
import { InspectorRelayPanel } from './InspectorRelayPanel';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@/features/settings/relaySettings', () => ({ readRelaySettings: vi.fn() }));
vi.mock('@/lib/relay/relayLocalProfiles', () => ({ readLocalRelayProfiles: vi.fn() }));
vi.mock('@/lib/relay/relayNativeRoomClient', () => ({ createRelayNativeRoomClient: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

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
      messages: [{ id: 'parent', participantId: 'agent', text: 'Checking files.', at: 1000, kind: 'message' as const }],
    },
  };
  vi.mocked(createRelayNativeRoomClient).mockReturnValue({
    getSnapshot: () => snapshot, subscribe: () => () => {}, refresh, send, dispose,
  } as ReturnType<typeof createRelayNativeRoomClient>);

  const close = vi.fn();
  const view = render(<InspectorRelayPanel projectId="project-1" onClose={close} />);
  expect(screen.getByRole('region', { name: 'Agent Relay group chat' })).toBeTruthy();
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'Reply to Luna' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Message Agent Relay' }), { target: { value: 'Which files?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send to group' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith('Which files?', 'parent'));
  fireEvent.click(screen.getByRole('button', { name: 'Close Agent Relay' }));
  expect(close).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(dispose).toHaveBeenCalledTimes(1);
});
