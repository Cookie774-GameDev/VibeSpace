import * as React from 'react';
import { ChevronDown, Globe2, Pause, Play, Square } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  browserGoalChatRuntime,
  type BrowserGoalChatRuntime,
} from './browserGoalChatRuntime';
import {
  browserGoalStore,
  type BrowserGoalChatSnapshot,
  type BrowserGoalStore,
} from './browserGoalStore';
import { useBrowserStore } from './browserStore';

export interface BrowserGoalStatusProps {
  readonly chatId: string;
  readonly store?: BrowserGoalStore;
  readonly runtime?: BrowserGoalChatRuntime;
}

const MODE_LABELS: Record<BrowserGoalChatSnapshot['tokenMode'], string> = {
  'token-saver': 'Token Saver',
  normal: 'Normal',
  'token-final-boss': 'Token Final Boss',
};

function stateLabel(state: BrowserGoalChatSnapshot['state']): string {
  return state.replaceAll('_', ' ');
}

export function BrowserGoalStatus({
  chatId,
  store = browserGoalStore,
  runtime = browserGoalChatRuntime,
}: BrowserGoalStatusProps) {
  const snapshot = React.useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot(chatId),
    () => store.getSnapshot(chatId),
  );
  const pendingApproval = useBrowserStore((state) =>
    snapshot
      ? state.agentActions.find(
          (action) =>
            action.status === 'pending' &&
            action.accountId === snapshot.accountId &&
            action.requester.runId === snapshot.runId,
        )
      : undefined,
  );
  const [expanded, setExpanded] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  if (!snapshot) return null;
  const approval =
    snapshot.approval ??
    (pendingApproval
      ? {
          reviewId: pendingApproval.id,
          risk: pendingApproval.risk,
        }
      : undefined);
  const terminal = ['completed', 'cancelled', 'failed'].includes(snapshot.state);

  const runControl = async (control: 'pause' | 'cancel' | 'resume') => {
    if (busy) return;
    setBusy(true);
    try {
      await runtime[control](chatId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label="Browser goal status"
      data-testid="browser-goal-status"
      className="mx-3 mb-2 overflow-hidden rounded-xl border border-border/80 bg-panel/85 shadow-soft [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:shadow-none"
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <Globe2 className="mt-0.5 h-4 w-4 shrink-0 text-accent-copper" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">Browser goal</span>
            <Badge variant={snapshot.state === 'completed' ? 'success' : 'secondary'}>
              {stateLabel(snapshot.state)}
            </Badge>
            <span className="text-[10px] text-muted-foreground">
              {snapshot.completedActions}/{snapshot.totalActions} actions ·{' '}
              {MODE_LABELS[snapshot.tokenMode]}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{snapshot.objective}</p>
          <p className="mt-0.5 truncate text-[11px] text-foreground/80">
            {approval
              ? `Approval needed · ${approval.risk} · ${approval.reviewId}`
              : snapshot.nextAction
                ? `Next: ${snapshot.nextAction.summary}`
                : terminal
                  ? stateLabel(snapshot.state)
                  : 'Waiting for the next canonical action.'}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 gap-1 px-2 text-[11px]"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Collapse' : 'Expand'}
          <ChevronDown className={cn('h-3.5 w-3.5', expanded && 'rotate-180')} />
        </Button>
      </div>

      {expanded ? (
        <div className="space-y-3 border-t border-border/70 px-3 py-2.5 text-xs">
          <dl className="grid grid-cols-[9rem_1fr] gap-x-2 gap-y-1">
            <dt className="text-muted-foreground">Checkpoint</dt>
            <dd>
              #{snapshot.checkpointSequence} · {snapshot.checkpointState}
            </dd>
            <dt className="text-muted-foreground">Current approved site</dt>
            <dd className="break-all font-mono">
              {snapshot.currentOrigin ?? 'No live approved origin'}
            </dd>
            <dt className="text-muted-foreground">Provider / model</dt>
            <dd className="break-all font-mono">
              {snapshot.providerId} / {snapshot.modelId}
            </dd>
            <dt className="text-muted-foreground">Resume authority</dt>
            <dd>Expires {new Date(snapshot.cursorExpiresAt).toLocaleString()}</dd>
            <dt className="text-muted-foreground">Evidence</dt>
            <dd>{snapshot.evidenceRefs.length} canonical reference(s)</dd>
            <dt className="text-muted-foreground">Provider artifacts</dt>
            <dd>{snapshot.providerArtifactRefs.length} untrusted reference(s)</dd>
          </dl>
          {snapshot.nextAction ? (
            <div className="rounded-md border border-border bg-background/60 p-2">
              <p className="font-medium text-foreground">Next proposed action</p>
              <p className="mt-1 text-muted-foreground">{snapshot.nextAction.summary}</p>
              <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                {snapshot.nextAction.kind}
              </p>
            </div>
          ) : null}
          {snapshot.failureReason ? (
            <p role="alert" className="text-destructive">
              {snapshot.failureReason}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {snapshot.state === 'active' || snapshot.state === 'awaiting_approval' ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void runControl('pause')}
              >
                <Pause className="mr-1 h-3.5 w-3.5" />
                Pause
              </Button>
            ) : null}
            {snapshot.state === 'paused' || snapshot.state === 'recovery_unavailable' ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void runControl('resume')}
              >
                <Play className="mr-1 h-3.5 w-3.5" />
                Resume
              </Button>
            ) : null}
            {!terminal ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void runControl('cancel')}
              >
                <Square className="mr-1 h-3.5 w-3.5" />
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
