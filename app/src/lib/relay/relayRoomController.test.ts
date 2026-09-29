import { describe, expect, it, vi } from 'vitest';
import { createRelayRoomController, type RelayRoomControllerOptions } from './relayRoomController';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const sdkRoom = {
  channel: 'vibespace',
  participants: [
    {
      id: 'human-id',
      name: 'Owner',
      role: 'human' as const,
      status: 'online',
      iconKey: 'human-id',
    },
    { id: 'agent-id', name: 'Luna', role: 'agent' as const, status: 'busy', iconKey: 'agent-id' },
  ],
  messages: [
    {
      messageId: 'message-1',
      text: 'Checking the source.',
      authorId: 'agent-id',
      authorName: 'Luna',
      authorRole: 'agent' as const,
      createdAt: '2026-09-25T00:00:00.000Z',
      replyCount: 0,
      authority: 'untrusted-peer' as const,
    },
  ],
};

function fixture() {
  const roomSnapshot = vi.fn().mockResolvedValue(sdkRoom);
  const humanBroadcast = vi.fn().mockResolvedValue({ id: 'ack-1' });
  const humanStop = vi.fn().mockResolvedValue(undefined);
  const ticket = Object.freeze({ control: 'host-only' });
  const getHumanControlTicket = vi.fn().mockResolvedValue(ticket);
  let sdkEvent: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const options: RelayRoomControllerOptions = {
    bridge: { roomSnapshot, humanBroadcast, humanStop },
    humanSessionId: 'human-session',
    getHumanControlTicket,
    scope: 'Project',
    channel: 'vibespace',
    subscribeToSdkRoomEvents: (listener) => {
      sdkEvent = listener;
      return unsubscribe;
    },
    listActiveAgentSessionIds: vi.fn().mockResolvedValue(['agent-session-1', 'agent-session-2']),
  };
  return {
    options,
    roomSnapshot,
    humanBroadcast,
    humanStop,
    getHumanControlTicket,
    ticket,
    emitSdkEvent: () => sdkEvent?.(),
    unsubscribe,
  };
}

describe('Relay room controller', () => {
  it('starts empty and projects only authenticated backend snapshot data', async () => {
    const f = fixture();
    const controller = createRelayRoomController(f.options);
    expect(controller.getSnapshot()).toMatchObject({
      room: { connection: 'offline', participants: [], messages: [] },
      humanAuthorized: false,
    });
    await controller.refresh();
    expect(f.roomSnapshot).toHaveBeenCalledWith('human-session', f.ticket, 30);
    expect(controller.getSnapshot()).toMatchObject({
      humanAuthorized: true,
      room: {
        connection: 'connected',
        scope: 'Project',
        participants: [
          { id: 'human-id', kind: 'human', status: 'online' },
          { id: 'agent-id', kind: 'agent', status: 'busy' },
        ],
        messages: [
          {
            id: 'message-1',
            participantId: 'agent-id',
            text: 'Checking the source.',
            at: Date.parse('2026-09-25T00:00:00.000Z'),
            kind: 'message',
          },
        ],
      },
    });
    controller.dispose();
  });

  it('sends only through verified humanBroadcast and waits for real snapshot data before displaying it', async () => {
    const f = fixture();
    const controller = createRelayRoomController(f.options);
    await controller.refresh();
    await controller.send('Please report.');
    expect(f.humanBroadcast).toHaveBeenCalledWith('human-session', f.ticket, 'Please report.');
    expect(controller.getSnapshot().room.messages).toHaveLength(1);
    expect(controller.getSnapshot().room.messages[0]?.text).toBe('Checking the source.');
    f.roomSnapshot.mockResolvedValueOnce({
      ...sdkRoom,
      messages: [
        ...sdkRoom.messages,
        {
          ...sdkRoom.messages[0],
          messageId: 'message-2',
          text: 'Please report.',
          authorId: 'human-id',
          authorRole: 'human',
        },
      ],
    });
    f.emitSdkEvent();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().room.messages.map((message) => message.text)).toEqual([
        'Checking the source.',
        'Please report.',
      ]),
    );
    controller.dispose();
  });

  it('coalesces SDK event refreshes and discards an older in-flight snapshot', async () => {
    const f = fixture();
    const first = deferred<typeof sdkRoom>();
    f.roomSnapshot
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ ...sdkRoom, messages: [] });
    const controller = createRelayRoomController(f.options);
    const refresh = controller.refresh();
    await vi.waitFor(() => expect(f.roomSnapshot).toHaveBeenCalledTimes(1));
    f.emitSdkEvent();
    f.emitSdkEvent();
    first.resolve(sdkRoom);
    await refresh;
    expect(f.roomSnapshot).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().room.messages).toEqual([]);
    controller.dispose();
  });

  it('fails closed on invalid human authority, without inventing connection or presence', async () => {
    const f = fixture();
    f.roomSnapshot.mockRejectedValueOnce(new Error('secret upstream token=private'));
    const controller = createRelayRoomController(f.options);
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({
      room: { connection: 'offline', participants: [], messages: [] },
      humanAuthorized: false,
    });
    expect(controller.getSnapshot().error).toBe('Relay room unavailable');
    await expect(controller.send('Hello')).rejects.toThrow('Relay room is not authorized');
    expect(f.humanBroadcast).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('does not expose upstream send errors to the room UI', async () => {
    const f = fixture();
    const controller = createRelayRoomController(f.options);
    await controller.refresh();
    f.humanBroadcast.mockRejectedValueOnce(new Error('token=private'));
    await expect(controller.send('Hello')).rejects.toThrow('Relay message could not be sent');
    expect(controller.getSnapshot().room.messages).toHaveLength(1);
    controller.dispose();
  });

  it('does not send with a ticket obtained before Relay authority is revoked, then recovers', async () => {
    const f = fixture();
    const controller = createRelayRoomController(f.options);
    await controller.refresh();

    const delayedTicket = deferred<typeof f.ticket>();
    f.getHumanControlTicket.mockImplementationOnce(() => delayedTicket.promise);
    const pendingSend = controller.send('Do not deliver after revocation.');
    f.roomSnapshot.mockRejectedValueOnce(new Error('access revoked'));
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({
      room: { connection: 'offline', messages: [] },
      humanAuthorized: false,
    });

    delayedTicket.resolve(f.ticket);
    await expect(pendingSend).rejects.toThrow('Relay message could not be sent');
    expect(f.humanBroadcast).not.toHaveBeenCalled();

    await controller.refresh();
    await controller.send('Authorized again.');
    expect(f.humanBroadcast).toHaveBeenCalledOnce();
    expect(f.humanBroadcast).toHaveBeenCalledWith('human-session', f.ticket, 'Authorized again.');
    controller.dispose();
  });

  it('uses host-authoritative session ids for stop-all and never derives them from room participants', async () => {
    const f = fixture();
    const controller = createRelayRoomController(f.options);
    await controller.refresh();
    await controller.stopAll();
    expect(f.humanStop.mock.calls).toEqual([
      ['human-session', f.ticket, 'agent-session-1'],
      ['human-session', f.ticket, 'agent-session-2'],
    ]);
    controller.dispose();
  });

  it('unsubscribes and ignores late SDK data after disposal', async () => {
    const f = fixture();
    const waiting = deferred<typeof sdkRoom>();
    f.roomSnapshot.mockImplementationOnce(() => waiting.promise);
    const controller = createRelayRoomController(f.options);
    const changed = vi.fn();
    controller.subscribe(changed);
    const refresh = controller.refresh();
    await vi.waitFor(() => expect(f.roomSnapshot).toHaveBeenCalledTimes(1));
    const countBeforeDispose = changed.mock.calls.length;
    controller.dispose();
    f.emitSdkEvent();
    waiting.resolve(sdkRoom);
    await refresh;
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.roomSnapshot).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(countBeforeDispose);
    expect(controller.getSnapshot().room.connection).toBe('offline');
  });
});
