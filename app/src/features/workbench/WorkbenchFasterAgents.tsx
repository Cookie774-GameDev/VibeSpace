import { createPortal } from 'react-dom';
import { FasterAgentsOverlay } from '@/features/terminals/faster-agents/FasterAgentsOverlay';
import { useAuthStore } from '@/stores/auth';
import { useWorkbenchStore } from './store';
import { deliverWorkbenchTerminalCommand } from './workbenchTerminalCommands';

export function WorkbenchFasterAgents() {
  const panels = useWorkbenchStore((state) => state.panels);
  const projectId = useAuthStore((state) => state.projectId);
  const terminals = panels
    .filter((panel) => panel.kind === 'terminal' && !panel.minimized && panel.settings.resourceId)
    .map((panel) => ({
      ref: {
        paneId: panel.id,
        sessionId: panel.settings.resourceId,
        projectId,
        label: panel.title,
      },
      label: panel.title,
      detail: panel.settings.command ?? 'Terminal',
    }));
  // Escape the canvas transform so the dimmer and controls cover the viewport.
  return createPortal(
    <FasterAgentsOverlay
      surface="workbench"
      terminals={terminals}
      deliver={deliverWorkbenchTerminalCommand}
    />,
    document.body,
  );
}
