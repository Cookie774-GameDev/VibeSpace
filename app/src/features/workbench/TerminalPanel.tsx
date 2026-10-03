import * as React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getStoredProjectRoot } from '@/features/files/projectFiles';
import { TerminalView } from '@/features/terminals/TerminalView';
import type { BackendTerminalInfo } from '@/features/terminals/restoreSession';
import { projectRepo, workspaceRepo } from '@/lib/db/repositories';
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
  const workspaceId = useAuthStore((state) => state.workspaceId);
  const accountId = useAuthStore((state) =>
    state.cloudSession ? state.cloudSession.user_id.trim() : state.localUserId?.trim() || '',
  );
  const scopeKey = JSON.stringify([accountId, workspaceId, projectId, panel.id]);
  const admissionKey = JSON.stringify([scopeKey, panel.settings.resourceId ?? null]);
  const [admission, setAdmission] = React.useState<{ key: string; allowed: boolean }>();
  const acceptedSessionRef = React.useRef<{ scopeKey: string; sessionId: string }>();
  const accepted = acceptedSessionRef.current;
  const admitted = Boolean(admission?.allowed && (admission.key === admissionKey || (
    admission.key === JSON.stringify([scopeKey, null]) && accepted?.scopeKey === scopeKey &&
    accepted.sessionId === panel.settings.resourceId
  )));
  const currentAdmissionKeyRef = React.useRef(admissionKey);
  currentAdmissionKeyRef.current = admissionKey;
  const [pending, setPending] = React.useState<WorkbenchTerminalCommand>();
  const commandGateRef = React.useRef(admissionKey);
  const pendingGateRef = React.useRef<string>();
  if (commandGateRef.current !== admissionKey) {
    commandGateRef.current = admissionKey;
    pendingGateRef.current = undefined;
  }
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
  React.useEffect(() => {
    if (admitted) return;
    let cancelled = false;
    void (async () => {
      let allowed = false;
      try {
        if (accountId && workspaceId) {
          const [workspace, project] = await Promise.all([
            workspaceRepo.getById(workspaceId),
            projectId ? projectRepo.getById(projectId) : Promise.resolve(undefined),
          ]);
          allowed = workspace?.owner_id === accountId && (!projectId || project?.workspace_id === workspaceId);
          if (allowed && panel.settings.resourceId) {
            // A live session from another project is not a dead session. Do not
            // mount the restoring view, which would otherwise spawn a replacement.
            // Legacy sessions without a known project also remain untouched.
            if (!projectId) {
              allowed = false;
            } else {
              const sessions = await invoke<BackendTerminalInfo[]>('terminal_list');
              const matches = sessions.filter((session) => session.sessionId === panel.settings.resourceId);
              allowed = matches.length === 1 && matches[0].projectId === projectId;
            }
          }
        }
      } catch {
        // No backend/owner proof means no attachment or replacement spawn.
        allowed = false;
      }
      if (!cancelled && currentAdmissionKeyRef.current === admissionKey) {
        acceptedSessionRef.current = allowed && panel.settings.resourceId
          ? { scopeKey, sessionId: panel.settings.resourceId } : undefined;
        setAdmission({ key: admissionKey, allowed });
      }
    })();
    return () => { cancelled = true; };
  }, [accountId, workspaceId, projectId, admissionKey, admitted, panel.settings.resourceId, scopeKey]);
  React.useEffect(
    () => admitted ? subscribeWorkbenchTerminalCommands(
        () => ({
          paneId: panelRef.current.id,
          sessionId: panelRef.current.settings.resourceId,
          projectId,
        }),
        (command) => {
          if (currentAdmissionKeyRef.current !== admissionKey) return;
          pendingGateRef.current = admissionKey;
          setPending(command);
        },
      ) : undefined,
    [projectId, admitted, admissionKey],
  );

  const handleReady = React.useCallback((sessionId: string) => {
    if (!admitted || currentAdmissionKeyRef.current !== admissionKey) return;
    const current = panelRef.current;
    if (current.settings.resourceId && current.settings.resourceId !== sessionId) return;
    const accepted = acceptedSessionRef.current;
    if (accepted?.scopeKey === scopeKey && accepted.sessionId !== sessionId) return;
    acceptedSessionRef.current = { scopeKey, sessionId };
    // The accepted session retains the fresh admission during its publication,
    // so a parent update cannot unmount the live view between state updates.
    if (current.settings.resourceId === sessionId && current.status === 'ready') return;
    onUpdateRef.current({
      status: 'ready',
      settings: { ...current.settings, resourceId: sessionId },
    });
  }, [admitted, admissionKey, scopeKey]);

  const currentPending =
    pendingGateRef.current === admissionKey &&
    pending?.target.sessionId === panel.settings.resourceId &&
    pending?.target.paneId === panel.id &&
    pending?.target.projectId === projectId
      ? pending
      : undefined;
  return (
    <div className="h-full min-h-0" data-terminal-drop="pane" data-terminal-drop-pane-id={panel.id}>
      {admitted ? <TerminalView
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
      /> : <p role="status" className="p-3 text-xs text-muted-foreground">
        {admission?.key === admissionKey
          ? panel.settings.resourceId
            ? 'This terminal is preserved. Select its original project to reconnect.'
            : 'Select an available workspace to open this terminal.'
          : 'Checking terminal project…'}
      </p>}
    </div>
  );
}
