import * as React from 'react';
import { getStoredProjectRoot } from '@/features/files/projectFiles';
import { TerminalView } from '@/features/terminals/TerminalView';
import { useAuthStore } from '@/stores/auth';
import type { WorkbenchPanel } from './types';
import {
  subscribeWorkbenchTerminalCommands,
  type WorkbenchTerminalCommand,
} from './workbenchTerminalCommands';

interface TerminalPanelProps {
  panel: WorkbenchPanel;
  onUpdate: (patch: Partial<WorkbenchPanel>) => void;
}

export function TerminalPanel({ panel, onUpdate }: TerminalPanelProps) {
  const projectId = useAuthStore((state) => state.projectId);
  const [pending, setPending] = React.useState<WorkbenchTerminalCommand>();
  const projectRoot = React.useMemo(
    () => getStoredProjectRoot(projectId).trim() || undefined,
    [projectId],
  );
  const panelRef = React.useRef(panel);
  const onUpdateRef = React.useRef(onUpdate);
  React.useEffect(() => {
    panelRef.current = panel;
    onUpdateRef.current = onUpdate;
  }, [onUpdate, panel]);
  React.useEffect(
    () =>
      subscribeWorkbenchTerminalCommands(
        () => ({
          paneId: panelRef.current.id,
          sessionId: panelRef.current.settings.resourceId,
          projectId,
        }),
        setPending,
      ),
    [projectId],
  );

  const handleReady = React.useCallback((sessionId: string) => {
    const current = panelRef.current;
    if (current.settings.resourceId === sessionId && current.status === 'ready') return;
    onUpdateRef.current({
      status: 'ready',
      settings: { ...current.settings, resourceId: sessionId },
    });
  }, []);

  const currentPending =
    pending?.target.sessionId === panel.settings.resourceId &&
    pending?.target.paneId === panel.id &&
    pending?.target.projectId === projectId
      ? pending
      : undefined;
  return (
    <div className="h-full min-h-0" data-terminal-drop="pane" data-terminal-drop-pane-id={panel.id}>
      <TerminalView
        pendingCommand={currentPending?.command}
        pendingCommandId={currentPending?.id}
        className="h-full min-h-0 rounded-none border-0 shadow-none"
        hideChrome
        preserveExisting
        paneId={panel.id}
        projectId={projectId}
        sessionId={panel.settings.resourceId}
        startupCommand={panel.settings.resourceId ? undefined : panel.settings.command}
        cwd={panel.settings.cwd || projectRoot}
        rows={24}
        cols={92}
        fontSize={10}
        onReady={handleReady}
        onFocus={() => onUpdate({ status: 'busy' })}
        onBlur={() => onUpdate({ status: 'ready' })}
        onExit={() => onUpdate({ status: 'attention' })}
      />
    </div>
  );
}
