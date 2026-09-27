import * as React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { readRelaySettings } from '@/features/settings/relaySettings';
import { RelayGroupChat } from '@/features/workbench/RelayGroupChat';
import { readLocalRelayProfiles } from '@/lib/relay/relayLocalProfiles';
import { createRelayNativeRoomClient } from '@/lib/relay/relayNativeRoomClient';

/** The Inspector owns its visible native human binding and releases it on tab exit. */
export function InspectorRelayPanel({ projectId, chatId, onClose }: {
  projectId: string | null | undefined;
  chatId?: string | null;
  onClose: () => void;
}) {
  const client = React.useMemo(() => createRelayNativeRoomClient({
    invoke: (command, args) => invoke(command, args),
    readSettings: readRelaySettings,
    expectedChatId: chatId ?? null,
    readLocalProfiles: () => readLocalRelayProfiles(projectId).catch(() => []),
  }), [projectId, chatId]);
  const state = React.useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);

  React.useEffect(() => {
    void client.refresh();
    const timer = window.setInterval(() => void client.refresh(), 5000);
    const onFocus = () => void client.refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      client.dispose();
    };
  }, [client]);

  return <RelayGroupChat
    open
    presentation="inspector"
    room={state.room}
    humanAuthorized={state.humanAuthorized}
    onClose={onClose}
    onSend={(text, parentMessageId) => client.send(text, parentMessageId)}
    onRefresh={() => client.refresh()}
  />;
}
