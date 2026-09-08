import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { CaoChatProposal, CaoSendMode } from '@/features/jarvis-memory/caoChatControl';
import {
  caoTerminalControl,
  caoTerminalLifecycleControls,
  listCaoTerminals,
  reviewCaoTerminal,
} from './terminalControlProduction';

export function CaoTerminalControls({
  accountId,
  enabled,
  mode,
}: {
  accountId: string;
  enabled: boolean;
  mode: CaoSendMode;
}) {
  const [targets, setTargets] = useState<Awaited<ReturnType<typeof listCaoTerminals>>>([]);
  const [terminalId, setTerminalId] = useState('');
  const [objective, setObjective] = useState('');
  const [action, setAction] = useState<
    'draft' | 'diagnose' | 'supervise' | 'verify' | 'grade' | 'force-check' | 'restart' | 'cancel'
  >('draft');
  const [proposal, setProposal] = useState<CaoChatProposal>();
  const [report, setReport] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController>();
  const pending = useRef<CaoChatProposal>();
  const pendingControl = useRef(caoTerminalControl);
  const lifecycle = action === 'restart' || action === 'cancel';
  const refresh = async () => {
    try {
      setTargets(await listCaoTerminals(accountId));
    } catch {
      setTargets([]);
    }
  };
  const discard = () => {
    if (pending.current) pendingControl.current.reject(pending.current.id);
    pending.current = undefined;
    setProposal(undefined);
  };
  useEffect(() => {
    let active = true;
    void listCaoTerminals(accountId)
      .then((rows) => {
        if (active) setTargets(rows);
      })
      .catch(() => {});
    setTerminalId('');
    setReport('');
    setError('');
    return () => {
      active = false;
      controller.current?.abort();
      if (pending.current) pendingControl.current.reject(pending.current.id);
    };
  }, [accountId]);
  const perform = async (approve = false) => {
    setBusy(true);
    setError('');
    setReport('');
    const aborter = new AbortController();
    controller.current = aborter;
    try {
      if (approve && proposal) {
        await pendingControl.current.approve(proposal.id, aborter.signal);
        if (!aborter.signal.aborted) setProposal({ ...proposal, status: 'sent' });
      } else {
        discard();
        if (action === 'draft' || action === 'restart' || action === 'cancel') {
          const control =
            action === 'draft' ? caoTerminalControl : caoTerminalLifecycleControls[action];
          pendingControl.current = control;
          const next = await control.prepare(accountId, terminalId, objective, aborter.signal);
          if (!aborter.signal.aborted) {
            pending.current = next;
            setProposal(next);
          }
        } else {
          const result = await reviewCaoTerminal(
            accountId,
            terminalId,
            objective,
            action,
            aborter.signal,
          );
          if (!aborter.signal.aborted) setReport(result.text);
        }
      }
    } catch {
      if (!aborter.signal.aborted)
        setError(
          'CAO could not confirm this operation. Refresh the target and inspect its output before retrying. Messages require a directly launched OpenCode agent with no user input pending.',
        );
      discard();
    } finally {
      if (controller.current === aborter) setBusy(false);
      if (lifecycle) void refresh();
    }
  };
  const selected = targets.find((row) => row.sessionId === terminalId);
  return (
    <section aria-label="CAO terminal management" className="space-y-3 border-t border-border pt-3">
      <h4 className="font-medium">CAO terminal management</h4>
      <p className="text-sm text-muted-foreground">
        Uses the same learned guidance and message permission above. Reviews use the selected
        terminal’s current output. Agent tool permissions still apply.
      </p>
      <label className="block text-sm">
        Target terminal
        <select
          aria-label="CAO target terminal"
          value={terminalId}
          disabled={busy}
          onChange={(event) => {
            discard();
            setTerminalId(event.target.value);
            setReport('');
          }}
        >
          <option value="">Choose a terminal in the current project</option>
          {targets.map((target) => (
            <option key={target.sessionId} value={target.sessionId}>
              {target.label || target.sessionId}
            </option>
          ))}
        </select>
      </label>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
        Refresh terminals
      </Button>
      <label className="block text-sm">
        Action
        <select
          aria-label="CAO terminal action"
          value={action}
          disabled={busy}
          onChange={(event) => {
            discard();
            setAction(event.target.value as typeof action);
          }}
        >
          <option value="draft">Message agent</option>
          <option value="cancel">Stop OpenCode process</option>
          <option value="restart">Restart OpenCode process</option>
          {(['diagnose', 'supervise', 'verify', 'grade', 'force-check'] as const).map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <textarea
        aria-label="CAO terminal objective"
        className="w-full rounded border border-border bg-background p-2 text-sm"
        value={objective}
        maxLength={8000}
        disabled={busy}
        onChange={(event) => setObjective(event.target.value)}
        placeholder="Describe the goal and what CAO should inspect or improve."
      />
      {selected && (action === 'draft' || lifecycle) && !selected.canMessage && (
        <p className="text-sm">
          Launch OpenCode directly as the terminal command to enable agent messaging. Shell
          terminals support read-only reviews.
        </p>
      )}
      <Button
        size="sm"
        disabled={
          !enabled ||
          busy ||
          !selected ||
          !objective.trim() ||
          ((action === 'draft' || lifecycle) && !selected.canMessage)
        }
        onClick={() => void perform()}
      >
        {busy
          ? 'Working…'
          : lifecycle
            ? mode === 'full-access'
              ? 'Review and apply terminal control'
              : 'Prepare terminal control'
            : action !== 'draft'
              ? 'Review terminal'
              : mode === 'full-access'
                ? 'Prepare and send to terminal'
                : 'Prepare terminal message'}
      </Button>
      {busy && (
        <Button size="sm" variant="ghost" onClick={() => controller.current?.abort()}>
          Cancel terminal operation
        </Button>
      )}
      {proposal && (
        <div className="space-y-2">
          <p className="text-sm whitespace-pre-wrap">{proposal.text}</p>
          {proposal.status === 'approval-required' ? (
            <>
              <Button size="sm" disabled={busy} onClick={() => void perform(true)}>
                {lifecycle ? 'Approve terminal control' : 'Approve terminal message'}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={discard}>
                {lifecycle ? 'Discard terminal control' : 'Discard terminal message'}
              </Button>
            </>
          ) : (
            <p role="status" className="text-sm">
              {lifecycle
                ? 'Terminal process control verified. Restart creates a fresh OpenCode session; previous prompts are not replayed.'
                : 'Message delivered to the selected terminal. Agent completion and game quality still need verification.'}
            </p>
          )}
        </div>
      )}
      {report && (
        <p role="status" className="text-sm whitespace-pre-wrap">
          {report}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
