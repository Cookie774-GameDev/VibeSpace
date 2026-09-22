import { createPortal } from 'react-dom';
import { Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/auth';
import { fromLeaves } from '@/features/terminals/paneTree';
import { readLiveTargetSnapshot } from '@/features/instant-command/targetSnapshot';
import { TerminalFabricOverlay } from '@/features/tools/terminal-peer-fabric/TerminalFabricOverlay';
import { useFabricPresentationStore } from '@/features/tools/terminal-peer-fabric/fabricPresentationStore';
import { useWorkbenchStore } from './store';

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

export function WorkbenchFabric() {
  const projectId = useAuthStore((state) => state.projectId);
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
      {createPortal(
        <TerminalFabricOverlay
          visible
          projectId={projectId}
          readTargets={readWorkbenchFabricTargets}
          paneSelector=".workbench-canvas .workbench-panel:not(.wb-creative-item)"
        />,
        document.body,
      )}
    </>
  );
}
