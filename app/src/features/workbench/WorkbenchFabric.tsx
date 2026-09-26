import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Link2, MessageCircleMore } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { createRelayRoomController } from '@/lib/relay/relayRoomController';
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
  const subscribeRelay = useCallback(
    (listener: () => void) => relayController?.subscribe(listener) ?? (() => {}),
    [relayController],
  );
  const readRelay = useCallback(
    () => relayController?.getSnapshot() ?? UNBOUND_RELAY_STATE,
    [relayController],
  );
  const relayState = useSyncExternalStore(subscribeRelay, readRelay, readRelay);

  useEffect(() => {
    if (relayOpen && relayController) void relayController.refresh();
  }, [relayOpen, relayController]);

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
        onClick={() => setRelayOpen(true)}
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
            onSend={async (text) => {
              if (!relayController) throw new Error('Relay room unavailable');
              await relayController.send(text);
            }}
            onStopAll={async () => {
              if (!relayController) throw new Error('Relay room unavailable');
              await relayController.stopAll();
            }}
          />,
          document.body,
        )}
    </>
  );
}
