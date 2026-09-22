import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import './cao-controls.css';
import { caoChatCommands } from './chatCommandProduction';
import {
  caoChatCommandKey,
  caoChatCommandLatestKey,
  type CaoChatCommandRecord,
} from './chatCommands';
import type { CaoControlCommand, CaoControlScope } from './controlCommand';
import type { CaoMissionController } from './CaoMissionPanel';
import { CaoWorkspace } from './CaoWorkspace';
import { caoProductionController } from './mission/productionController';

export type CaoCommandInput = { nonce: string; command: CaoControlCommand };
export function CaoCommandPanel({
  scope,
  chatId,
  request,
  missionController,
  open = false,
  onOpenChange,
}: {
  scope: CaoControlScope;
  chatId: string;
  request?: CaoCommandInput;
  missionController?: CaoMissionController;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const started = useRef('');
  const loadedRecord = useLiveQuery(async () => {
    if (!scope.accountId) return undefined;
    const requestId = (await db.settings.get(caoChatCommandLatestKey(scope.accountId, chatId)))
      ?.value;
    if (typeof requestId !== 'string') return undefined;
    const result = (await db.settings.get(caoChatCommandKey(scope.accountId, requestId)))?.value as
      | CaoChatCommandRecord
      | undefined;
    return result?.accountId === scope.accountId && result.callerChatId === chatId
      ? result
      : undefined;
  }, [scope.accountId, chatId]);
  const record =
    loadedRecord?.accountId === scope.accountId && loadedRecord.callerChatId === chatId
      ? loadedRecord
      : undefined;
  const failure = (cause: unknown) =>
    setError(
      cause instanceof Error && /^cao_control_[a-z0-9_]+$/.test(cause.message)
        ? cause.message.replace('cao_control_', '').replaceAll('_', ' ')
        : 'CAO could not complete this command. No completion is assumed.',
    );
  useEffect(() => {
    if (!busy && record && ['preparing', 'running'].includes(record.status))
      void caoChatCommands.recover(scope.accountId, record.requestId).catch(failure);
  }, [busy, record?.requestId, record?.status, scope.accountId]);
  useEffect(() => {
    if (!request || started.current === request.nonce) return;
    started.current = request.nonce;
    setBusy(true);
    setError('');
    void caoChatCommands
      .prepare({ ...scope, callerChatId: chatId, command: request.command })
      .catch(failure)
      .finally(() => setBusy(false));
  }, [request?.nonce, scope.accountId, scope.workspaceId, scope.projectId, chatId]);
  const decide = async (decision: 'approve' | 'deny') => {
    if (!record || busy) return;
    setBusy(true);
    setError('');
    try {
      await caoChatCommands.decide(scope.accountId, record.requestId, decision);
    } catch (cause) {
      failure(cause);
    } finally {
      setBusy(false);
    }
  };
  const missionPanel = (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="cao-mission-dialog max-w-3xl gap-0 overflow-hidden p-0 sm:p-0">
        <div className="border-b border-border px-5 py-4 pr-12">
          <DialogTitle className="text-base">Jarvis CAO · Council</DialogTitle>
          <DialogDescription className="mt-1 text-xs">
            Coordinate your existing chats and terminals.
          </DialogDescription>
        </div>
        <CaoWorkspace
          scope={scope}
          chatId={chatId}
          controller={missionController ?? caoProductionController}
        />
      </DialogContent>
    </Dialog>
  );
  if (!record && !busy && !error) return missionPanel;
  return (
    <>
      <section
        aria-label="CAO command"
        className="m-2 space-y-2 rounded border border-border p-3 text-sm"
      >
        <p className="font-medium">Jarvis CAO{record ? ` · ${record.command.action}` : ''}</p>
        <p role="status">{busy ? 'Working…' : record?.status.replaceAll('_', ' ')}</p>
        {record && (
          <p className="text-xs text-muted-foreground break-all">
            {record.bindings.map((binding) => `chat:${binding.target.targetId}`).join(', ')}
          </p>
        )}
        {record?.status === 'awaiting_approval' && (
          <>
            <p>
              {record.command.action === 'restart'
                ? 'Stop the selected turn and resume its retained request using the same model and context.'
                : record.command.action === 'cancel'
                  ? 'Stop only the selected current turn.'
                  : 'Review the selected chat’s current evidence.'}
            </p>
            <Button size="sm" disabled={busy} onClick={() => void decide('approve')}>
              Approve CAO command
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void caoChatCommands.cancel(scope.accountId, record.requestId).catch(failure)
              }
            >
              Deny CAO command
            </Button>
          </>
        )}
        {busy && record && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void caoChatCommands.cancel(scope.accountId, record.requestId).catch(failure)
            }
          >
            Cancel CAO command
          </Button>
        )}
        {record?.report && <p className="whitespace-pre-wrap">{record.report}</p>}
        {!busy && record && ['preparing', 'running'].includes(record.status) && (
          <p>
            Review is still running or was interrupted. A corrective command is never replayed
            automatically.
          </p>
        )}
        {(error || record?.error) && (
          <p role="alert" className="text-destructive">
            {error || record?.error?.replaceAll('_', ' ')}
          </p>
        )}
      </section>
      {missionPanel}
    </>
  );
}
