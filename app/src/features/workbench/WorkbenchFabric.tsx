import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Link2, MessageCircleMore } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { invoke } from '@tauri-apps/api/core';
import type { createRelayRoomController } from '@/lib/relay/relayRoomController';
import { createRelayNativeRoomClient } from '@/lib/relay/relayNativeRoomClient';
import { readLocalRelayProfiles } from '@/lib/relay/relayLocalProfiles';
import { readRelaySettings } from '@/features/settings/relaySettings';
import { useAuthStore } from '@/stores/auth';
import { fromLeaves } from '@/features/terminals/paneTree';
import { readLiveTargetSnapshot } from '@/features/instant-command/targetSnapshot';
import { TerminalFabricOverlay } from '@/features/tools/terminal-peer-fabric/TerminalFabricOverlay';
import { useFabricPresentationStore } from '@/features/tools/terminal-peer-fabric/fabricPresentationStore';
import { useWorkbenchStore } from './store';
import { RelayGroupChat, type RelayRoomView } from './RelayGroupChat';

type RelayRoomController = ReturnType<typeof createRelayRoomController>;

const UNBOUND_RELAY_ROOM: RelayRoomView = {
  connection: 'offline',
  scope: 'Project',
  participants: [],
  messages: [],
};
const UNBOUND_RELAY_STATE = {
  room: UNBOUND_RELAY_ROOM,
  humanAuthorized: false,
  error: null,
} as const;

export function readWorkbenchFabricTargets() {
  return readLiveTargetSnapshot({
    readTree: (projectId) =>
      fromLeaves(
        useWorkbenchStore
          .getState()
          .panels.filter(
            (panel) => panel.kind === 'terminal' && !panel.minimized && panel.settings.resourceId,
          )
          .map((panel) => ({
            kind: 'leaf' as const,
            id: panel.id,
            projectId,
            sessionId: panel.settings.resourceId,
            name: panel.title,
          })),
      ),
  });
}

export function WorkbenchFabric({ relayController }: { relayController?: RelayRoomController }) {
  const projectId = useAuthStore((state) => state.projectId);
  const [relayOpen, setRelayOpen] = useState(false);
  const nativeRelayClient = useMemo(() =>
    !relayController && typeof window !== 'undefined'
      ? createRelayNativeRoomClient({
          invoke: (command, args) => invoke(command, args),
          readSettings: readRelaySettings,
          readLocalProfiles: () => readLocalRelayProfiles(projectId).catch(() => []),
        })
      : null,
  [relayController, projectId]);
  const activeRelay = relayController ?? nativeRelayClient;
  const subscribeRelay = useCallback(
    (listener: () => void) => activeRelay?.subscribe(listener) ?? (() => {}),
    [activeRelay],
  );
  const readRelay = useCallback(
    () => activeRelay?.getSnapshot() ?? UNBOUND_RELAY_STATE,
    [activeRelay],
  );
  const relayState = useSyncExternalStore(subscribeRelay, readRelay, readRelay);

  useEffect(() => {
    if (!relayOpen || !activeRelay) return;
    void activeRelay.refresh();
    // A visible room may refresh its read-only upstream snapshot without waking any model.
    const timer = window.setInterval(() => void activeRelay.refresh(), 5000);
    const onFocus = () => void activeRelay.refresh();
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [relayOpen, activeRelay]);

  useEffect(() => () => nativeRelayClient?.dispose(), [nativeRelayClient]);

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Connect Workbench terminals"
        title="Connect up to 10 terminals"
        onClick={() => useFabricPresentationStore.getState().launch()}
      >
        <Link2 />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Open Agent Relay group chat"
        title="Agent Relay group chat"
        onClick={() => { setRelayOpen(true); void activeRelay?.refresh(); }}
      >
        <MessageCircleMore />
      </Button>
      {createPortal(
        <TerminalFabricOverlay
          visible
          projectId={projectId}
          readTargets={readWorkbenchFabricTargets}
          paneSelector=".workbench-canvas .workbench-panel:not(.wb-creative-item)"
        />,
        document.body,
      )}
      {relayOpen &&
        createPortal(
          <RelayGroupChat
            open
            room={relayState.room}
            humanAuthorized={relayState.humanAuthorized}
            onClose={() => setRelayOpen(false)}
            onSend={async (text, parentMessageId) => {
              if (relayController) {
                if (parentMessageId) throw new Error('Thread replies are unavailable in this room.');
                await relayController.send(text);
              } else if (nativeRelayClient) {
                await nativeRelayClient.send(text, parentMessageId);
              } else {
                throw new Error('Relay room unavailable');
              }
            }}
            onRefresh={() => activeRelay?.refresh()}
            onStopAll={relayController ? () => relayController.stopAll() : undefined}
          />,
          document.body,
        )}
    </>
  );
}
