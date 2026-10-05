import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createRelayRoomController } from '@/lib/relay/relayRoomController';
import { StrictMode } from 'react';
import { writeRelaySettings } from '@/features/settings/relaySettings';
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  panels: [] as any[],
  overlay: vi.fn(),
  relay: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/stores/auth', () => ({
  useAuthStore: Object.assign((selector: any) => selector({ projectId: 'project-k24' }), {
    getState: () => ({ projectId: 'project-k24' }),
  }),
}));
vi.mock('./store', () => ({ useWorkbenchStore: { getState: () => ({ panels: mocks.panels }) } }));
vi.mock('@/features/tools/terminal-peer-fabric/TerminalFabricOverlay', () => ({
  TerminalFabricOverlay: (props: any) => {
    mocks.overlay(props);
    return null;
  },
}));
vi.mock('./RelayGroupChat', () => ({
  RelayGroupChat: (props: any) => {
    mocks.relay(props);
    return null;
  },
}));
import { readWorkbenchFabricTargets, WorkbenchFabric } from './WorkbenchFabric';
import { useFabricPresentationStore } from '@/features/tools/terminal-peer-fabric/fabricPresentationStore';
afterEach(() => {
  cleanup();
  mocks.relay.mockClear();
  writeRelaySettings({ scope: 'off', automaticParticipation: false, excludedParticipants: [] });
});
it('connects the visible Workbench room and sends as the human after StrictMode startup', async () => {
  writeRelaySettings({ scope: 'project', automaticParticipation: false, excludedParticipants: [] });
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === 'relay_active_context_snapshot')
      return {
        generation: 2,
        context: {
          accountId: 'account-1',
          workspaceId: 'workspace-1',
          projectId: 'project-k24',
          chatId: 'chat-1',
        },
      };
    if (command === 'relay_engine_start') return { running: true, healthy: true };
    if (command === 'relay_participant_bind')
      return { bindingId: 'workbench-human-binding', relayAgentId: 'human-agent' };
    if (command === 'relay_human_room_snapshot')
      return {
        channel: 'vibespace',
        participants: [{ id: 'human-agent', name: 'You', role: 'human', status: 'online' }],
        messages: [],
      };
    if (command === 'relay_human_message') return { messageId: 'workbench-message' };
    if (command === 'relay_participant_unbind') return {};
    throw new Error(`Unexpected native command ${command}`);
  });
  const view = render(
    <StrictMode>
      <WorkbenchFabric />
    </StrictMode>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open Agent Relay group chat' }));
  await waitFor(() =>
    expect(mocks.relay.mock.lastCall?.[0]).toMatchObject({
      humanAuthorized: true,
      room: { connection: 'connected' },
    }),
  );
  await act(async () => mocks.relay.mock.lastCall?.[0].onSend('Hello from Workbench'));
  expect(mocks.invoke).toHaveBeenCalledWith('relay_human_message', {
    bindingId: 'workbench-human-binding',
    generation: 2,
    text: 'Hello from Workbench',
  });
  view.unmount();
  expect(mocks.invoke).toHaveBeenCalledWith('relay_participant_unbind', {
    bindingId: 'workbench-human-binding',
    generation: 2,
  });
});
it('discovers ten real Workbench sessions with native project identities, not the terminal-page tree', async () => {
  mocks.panels = Array.from({ length: 10 }, (_, i) => ({
    id: `wb-${i}`,
    kind: 'terminal',
    title: `Terminal ${i}`,
    settings: { resourceId: `tty-${i}` },
  }));
  mocks.invoke.mockResolvedValue(
    mocks.panels.map((panel, i) => ({
      sessionId: `tty-${i}`,
      projectId: 'project-k24',
      processInstanceId: `process-${i}`,
      runtimeGeneration: 'gen',
      pid: 100 + i,
      processStartedAt: 123,
      startedAt: 123,
    })),
  );
  const targets = await readWorkbenchFabricTargets();
  expect(targets).toHaveLength(10);
  expect(targets.map((t) => t.paneId)).toEqual(mocks.panels.map((p) => p.id));
  mocks.panels[0].minimized = true;
  mocks.panels[1].kind = 'browser';
  mocks.panels[2].settings.resourceId = 'stale';
  expect(await readWorkbenchFabricTargets()).toHaveLength(7);
});
it('opens the shared picker scoped to the Workbench panel frames', () => {
  useFabricPresentationStore.setState({ selecting: false });
  render(<WorkbenchFabric />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect Workbench terminals' }));
  expect(useFabricPresentationStore.getState().selecting).toBe(true);
  expect(mocks.overlay).toHaveBeenCalledWith(
    expect.objectContaining({
      visible: true,
      projectId: 'project-k24',
      readTargets: readWorkbenchFabricTargets,
      paneSelector: '.workbench-canvas .workbench-panel:not(.wb-creative-item)',
    }),
  );
});

it('opens Relay offline with no invented messages, participants, or human authority', async () => {
  render(<WorkbenchFabric />);
  fireEvent.click(screen.getByRole('button', { name: 'Open Agent Relay group chat' }));
  const props = mocks.relay.mock.lastCall?.[0];
  expect(props).toMatchObject({
    open: true,
    humanAuthorized: false,
    room: { connection: 'offline', participants: [], messages: [] },
  });
  await expect(props.onSend('forged message')).rejects.toThrow('Relay room is not authorized');
  expect(props.onStopAll).toBeUndefined();
});

it('projects only host-bound controller data and forwards owner actions through it', async () => {
  const ticket = Object.freeze({ verified: true });
  const roomSnapshot = vi.fn().mockResolvedValue({
    channel: 'vibespace',
    participants: [
      { id: 'human-id', name: 'Owner', role: 'human', status: 'online', iconKey: 'human-id' },
    ],
    messages: [
      {
        messageId: 'sdk-message',
        text: 'Actual SDK text',
        authorId: 'human-id',
        authorName: 'Owner',
        authorRole: 'human',
        createdAt: '2026-09-25T00:00:00Z',
        replyCount: 0,
        authority: 'untrusted-peer',
      },
    ],
  });
  const humanBroadcast = vi.fn().mockResolvedValue({ id: 'sdk-ack' });
  const humanStop = vi.fn().mockResolvedValue(undefined);
  const controller = createRelayRoomController({
    bridge: { roomSnapshot, humanBroadcast, humanStop },
    humanSessionId: 'verified-human-session',
    getHumanControlTicket: () => ticket,
    scope: 'Project',
    channel: 'vibespace',
    listActiveAgentSessionIds: () => ['host-agent-session'],
  });
  const view = render(<WorkbenchFabric relayController={controller} />);
  expect(roomSnapshot).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open Agent Relay group chat' }));
  await waitFor(() =>
    expect(mocks.relay.mock.lastCall?.[0]).toMatchObject({
      humanAuthorized: true,
      room: { connection: 'connected', messages: [{ id: 'sdk-message', text: 'Actual SDK text' }] },
    }),
  );
  expect(roomSnapshot).toHaveBeenCalledWith('verified-human-session', ticket, 30);
  const props = mocks.relay.mock.lastCall?.[0];
  await act(async () => {
    await props.onSend('real request');
  });
  expect(humanBroadcast).toHaveBeenCalledWith('verified-human-session', ticket, 'real request');
  await expect(props.onSend('thread reply', 'sdk-message')).rejects.toThrow(
    'Thread replies are unavailable',
  );
  expect(humanBroadcast).toHaveBeenCalledTimes(1);
  await act(async () => {
    await props.onStopAll();
  });
  expect(humanStop).toHaveBeenCalledWith('verified-human-session', ticket, 'host-agent-session');
  view.unmount();
  controller.dispose();
});
