import * as React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { readRelaySettings } from '@/features/settings/relaySettings';
import { RelayGroupChat } from '@/features/workbench/RelayGroupChat';
import { readLocalRelayProfiles } from '@/lib/relay/relayLocalProfiles';
import { createRelayNativeRoomClient } from '@/lib/relay/relayNativeRoomClient';
import type { RelayNativeRoomState } from '@/lib/relay/relayNativeRoomClient';

const UNBOUND_STATE: RelayNativeRoomState = {
  room: { connection: 'offline', scope: 'Project', participants: [], messages: [] },
  humanAuthorized: false,
  error: null,
};
const readUnboundState = () => UNBOUND_STATE;
const subscribeUnboundState = () => () => {};

/** The Inspector owns its visible native human binding and releases it on tab exit. */
export function InspectorRelayPanel({
  projectId,
  chatId,
  onClose,
}: {
  projectId: string | null | undefined;
  chatId?: string | null;
  onClose: () => void;
}) {
  const [connection, setConnection] = React.useState<{
    projectId: typeof projectId;
    chatId: typeof chatId;
    client: ReturnType<typeof createRelayNativeRoomClient>;
  } | null>(null);
  const client =
    connection && connection.projectId === projectId && connection.chatId === chatId
      ? connection.client
      : null;
  const state = React.useSyncExternalStore(
    client?.subscribe ?? subscribeUnboundState,
    client?.getSnapshot ?? readUnboundState,
    client?.getSnapshot ?? readUnboundState,
  );

  React.useEffect(() => {
    // Each effect setup owns a fresh client, including StrictMode's startup replay.
    const activeClient = createRelayNativeRoomClient({
      invoke: (command, args) => invoke(command, args),
      readSettings: readRelaySettings,
      expectedChatId: chatId ?? null,
      readLocalProfiles: () => readLocalRelayProfiles(projectId).catch(() => []),
    });
    setConnection({ projectId, chatId, client: activeClient });
    void activeClient.refresh();
    const timer = window.setInterval(() => void activeClient.refresh(), 5000);
    const onFocus = () => void activeClient.refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      activeClient.dispose();
    };
  }, [projectId, chatId]);

  return (
    <RelayGroupChat
      open
      presentation="inspector"
      room={state.room}
      humanAuthorized={state.humanAuthorized}
      onClose={onClose}
      onSend={(text, parentMessageId) => {
        if (!client) throw new Error('Relay room is not connected');
        return client.send(text, parentMessageId);
      }}
      onRefresh={() => client?.refresh()}
    />
  );
}
