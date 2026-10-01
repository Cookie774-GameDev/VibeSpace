import * as React from 'react';
import {
  AlertTriangle,
  Check,
  Clock3,
  HelpCircle,
  Loader2,
  X,
  type LucideIcon,
} from 'lucide-react';

import {
  parseTaskApprovalCallId,
  presentJarvisApproval,
} from '@/features/jarvis-runs/approvalBridge';
import { resolveAction } from '@/lib/actions';
import type { ActionRunContext } from '@/lib/actions/types';
import type { JarvisRun } from '@/lib/jarvis/contracts';
import type {
  JarvisCanonicalActionExecutionResult,
  JarvisKernelActionPort,
} from '@/lib/jarvis/approvalEngine';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { getActiveAccountIdentity } from '@/lib/accountIdentity';
import type { ActionStatus, Part } from '@/types';
import type { MessageId } from '@/types/common';
import { isKernelSmokeEnabled } from '@/lib/jarvis/smoke/config';
import { SIK_CONTROL, SIK_EVIDENCE } from '@/lib/jarvis/smoke/evidenceIds';

const KERNEL_SMOKE_ENABLED = isKernelSmokeEnabled({
  devBuild: import.meta.env.DEV,
  explicitFlag: import.meta.env.VITE_SIK_SMOKE,
});

type ActionPart = Extract<Part, { kind: 'action_proposal' }>;
export type CanonicalApprovalPresentation = ReturnType<typeof presentJarvisApproval>;

export interface ActionApprovalCardProps {
  part: ActionPart;
  allParts: Part[];
  messageId: MessageId;
  chatId: string;
  /** Task 16B supplies this from canonical repository readback. */
  presentation?: CanonicalApprovalPresentation;
}

type ApprovalPresentationFailureCode =
  | 'identity_missing'
  | 'host_unavailable'
  | 'host_released'
  | 'request_timed_out'
  | 'client_disposed'
  | 'invalid_response'
  | 'kernel_not_activated'
  | 'request_failed';

/** A native terminal handoff is running truth, never settled success. */
export function actionStatusForCanonicalExecution(
  outcome: JarvisCanonicalActionExecutionResult,
): Extract<ActionStatus, 'queued' | 'success' | 'error'> {
  if (outcome.kind === 'handoff_pending') return 'queued';
  return outcome.result.ok ? 'success' : 'error';
}

/** @internal Pure controller; Task 16B owns production card injection. */
export function createCanonicalApprovalCardController(
  actions: Pick<JarvisKernelActionPort, 'decide' | 'execute'>,
) {
  function canonicalApprovalId(callId: string): string | undefined {
    return parseTaskApprovalCallId(callId)?.approvalId;
  }

  type ApprovalRequest = { parentRun: JarvisRun; callId: string; context: ActionRunContext };
  async function approve(input: ApprovalRequest) {
    const approvalId = canonicalApprovalId(input.callId);
    if (!approvalId) return { kind: 'invalid_approval_call' as const };
    const decision = await actions.decide({
      parentRun: input.parentRun,
      approvalId,
      decision: 'approve',
    });
    if (decision.kind !== 'committed') return decision;
    if (
      decision.value.id !== approvalId ||
      decision.value.runId !== input.parentRun.id ||
      decision.value.status !== 'approved'
    ) {
      return { kind: 'approval_state_mismatch' as const };
    }
    return await actions.execute({
      parentRun: input.parentRun,
      approvalId,
      context: input.context,
    });
  }

  return Object.freeze({
    approve,
    async deny(input: { parentRun: JarvisRun; callId: string }) {
      const approvalId = canonicalApprovalId(input.callId);
      if (!approvalId) return { kind: 'invalid_approval_call' as const };
      const decision = await actions.decide({
        parentRun: input.parentRun,
        approvalId,
        decision: 'deny',
      });
      if (decision.kind !== 'committed') return decision;
      if (
        decision.value.id !== approvalId ||
        decision.value.runId !== input.parentRun.id ||
        decision.value.status !== 'denied'
      ) {
        return { kind: 'approval_state_mismatch' as const };
      }
      return decision;
    },
    async approveAll(requests: readonly ApprovalRequest[]) {
      const outcomes: Awaited<ReturnType<typeof approve>>[] = [];
      for (const request of requests) {
        const outcome = await approve(request);
        outcomes.push(outcome);
        if (outcome.kind !== 'committed') break;
        if (outcome.value.kind === 'settled' && !outcome.value.result.ok) break;
      }
      return Object.freeze(outcomes);
    },
  });
}

interface StatusVisual {
  icon: LucideIcon;
  iconClass: string;
  label: string;
  borderClass: string;
}

const STATUS_VISUALS: Record<ActionStatus, StatusVisual> = {
  pending: {
    icon: Clock3,
    iconClass: 'text-accent-copper',
    label: 'Awaiting approval',
    borderClass: 'border-accent-copper/40',
  },
  queued: {
    icon: Loader2,
    iconClass: 'text-accent-amber animate-spin',
    label: 'Queued',
    borderClass: 'border-accent-amber/40',
  },
  running: {
    icon: Loader2,
    iconClass: 'text-accent-amber animate-spin',
    label: 'Running',
    borderClass: 'border-accent-amber/40',
  },
  success: {
    icon: Check,
    iconClass: 'text-[hsl(var(--sage))]',
    label: 'Done',
    borderClass: 'border-[hsl(var(--sage))]/40',
  },
  error: {
    icon: AlertTriangle,
    iconClass: 'text-destructive',
    label: 'Error',
    borderClass: 'border-destructive/40',
  },
  cancelled: {
    icon: X,
    iconClass: 'text-muted-foreground',
    label: 'Cancelled',
    borderClass: 'border-border',
  },
};

function resultLine(status: ActionStatus, error?: string): string | undefined {
  if (status === 'queued') return 'Execution handed off.';
  if (status === 'running') return 'Execution is still in progress.';
  if (status === 'success') return 'Action completed.';
  if (status === 'error') return error ?? 'The action failed.';
  if (status === 'cancelled') return 'This action was denied or cancelled.';
  return undefined;
}

/** Canonical cards load bounded presentation and mutate only through the host bridge. */
export function ActionApprovalCard({ part, presentation, chatId }: ActionApprovalCardProps) {
  const definition = resolveAction(part.action_id);
  const approvalTitleId = React.useId();
  const approvalId = React.useMemo(
    () => parseTaskApprovalCallId(part.call_id)?.approvalId,
    [part.call_id],
  );
  const [displayStatus, setDisplayStatus] = React.useState<ActionStatus>(part.status);
  const [resolvedPresentation, setResolvedPresentation] = React.useState<
    CanonicalApprovalPresentation | undefined
  >(presentation);
  const [presentationState, setPresentationState] = React.useState<
    'idle' | 'loading' | 'ready' | 'failed'
  >(presentation ? 'ready' : 'idle');
  const [presentationFailureCode, setPresentationFailureCode] =
    React.useState<ApprovalPresentationFailureCode>();
  const visual = STATUS_VISUALS[displayStatus] ?? STATUS_VISUALS.pending;
  const Icon = definition?.icon ?? HelpCircle;
  const StatusIcon = visual.icon;
  const terminalCopy = resultLine(displayStatus, part.error);
  const [decisionState, setDecisionState] = React.useState<
    'idle' | 'busy' | 'submitted' | 'failed'
  >('idle');
  const dangerous =
    resolvedPresentation?.risk === 'dangerous' ||
    part.action_id === 'task.cancel' ||
    part.action_id === 'terminal.run';

  React.useEffect(() => setDisplayStatus(part.status), [part.status]);

  React.useEffect(() => {
    if (!presentation) return;
    setResolvedPresentation(presentation);
    setPresentationState('ready');
    setPresentationFailureCode(undefined);
  }, [presentation]);

  React.useEffect(() => {
    if (!approvalId || resolvedPresentation || displayStatus !== 'pending') return;
    const identity = getActiveAccountIdentity();
    if (!identity) {
      setPresentationState('failed');
      setPresentationFailureCode('identity_missing');
      return;
    }
    let cancelled = false;
    setPresentationState('loading');
    setPresentationFailureCode(undefined);
    void import('@/lib/jarvis/kernelClient')
      .then(({ createJarvisKernelClient }) => {
        const client = createJarvisKernelClient();
        return client
          .getApprovalPresentation({ accountId: identity.accountId, approvalId })
          .then((response) => {
            if (cancelled) return;
            if (response.kind === 'unavailable') {
              setPresentationState('failed');
              setPresentationFailureCode(response.reason);
              return;
            }
            if (response.approvalId !== approvalId) {
              setPresentationState('failed');
              setPresentationFailureCode('invalid_response');
              return;
            }
            setResolvedPresentation(
              Object.freeze({
                actionId: response.actionId,
                expectedEffect: response.expectedEffect,
                risk: response.risk,
                parameters: Object.freeze(
                  response.parameters.map((value) => Object.freeze({ ...value })),
                ),
              }),
            );
            setPresentationState('ready');
            setPresentationFailureCode(undefined);
          })
          .finally(() => client.dispose());
      })
      .catch(() => {
        if (!cancelled) {
          setPresentationState('failed');
          setPresentationFailureCode('request_failed');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [approvalId, displayStatus, resolvedPresentation]);

  const decideCanonical = async (choice: 'approve' | 'deny') => {
    if (!approvalId || !resolvedPresentation || decisionState === 'busy') return;
    const identity = getActiveAccountIdentity();
    if (!identity) {
      setDecisionState('failed');
      return;
    }
    setDecisionState('busy');
    try {
      const { createJarvisKernelClient } = await import('@/lib/jarvis/kernelClient');
      const client = createJarvisKernelClient();
      try {
        const decision = await client.decideApproval({
          accountId: identity.accountId,
          approvalId,
          decision: choice,
        });
        if (
          decision.kind !== 'approval_decided' ||
          decision.approvalId !== approvalId ||
          decision.status !== (choice === 'approve' ? 'approved' : 'denied')
        ) {
          throw new Error('kernel_approval_decision_failed');
        }
        if (choice === 'deny') {
          setDisplayStatus('cancelled');
          setDecisionState('submitted');
          window.dispatchEvent(
            new CustomEvent('jarvis:run-state', {
              detail: { chatId, status: 'cancelled' },
            }),
          );
          return;
        }
        const execution = await client.executeApproval({
          accountId: identity.accountId,
          approvalId,
        });
        if (
          execution.kind !== 'approval_execution' ||
          execution.approvalId !== approvalId ||
          !['queued', 'running', 'completed', 'failed'].includes(execution.status)
        ) {
          throw new Error('kernel_approval_execution_failed');
        }
        setDisplayStatus(
          execution.status === 'queued'
            ? 'queued'
            : execution.status === 'running'
              ? 'running'
              : execution.status === 'completed'
                ? 'success'
                : 'error',
        );
        setDecisionState('submitted');
        if (execution.status === 'completed' || execution.status === 'failed') {
          window.dispatchEvent(
            new CustomEvent('jarvis:run-state', {
              detail: {
                chatId,
                status: execution.status === 'completed' ? 'done' : 'error',
                ...(execution.status === 'failed'
                  ? { errorCode: 'kernel_runtime_action_execution' }
                  : {}),
              },
            }),
          );
        }
      } finally {
        client.dispose();
      }
    } catch {
      setDecisionState('failed');
    }
  };

  return (
    <div
      className={cn(
        'rounded-md border-l-2 border bg-elevated px-3 py-2.5',
        'flex flex-col gap-1.5',
        visual.borderClass,
      )}
      data-action-id={part.action_id}
      data-approval-id={approvalId}
      data-status={displayStatus}
      data-approval-kind={approvalId ? 'canonical' : 'legacy'}
      role={approvalId ? 'group' : undefined}
      aria-labelledby={approvalId ? approvalTitleId : undefined}
      tabIndex={approvalId ? -1 : undefined}
      data-sik-evidence={KERNEL_SMOKE_ENABLED ? SIK_EVIDENCE.approvalCard : undefined}
      data-presentation-state={KERNEL_SMOKE_ENABLED && approvalId ? presentationState : undefined}
      data-presentation-code={
        KERNEL_SMOKE_ENABLED && presentationState === 'failed' ? presentationFailureCode : undefined
      }
    >
      <div className="flex items-center gap-2 text-secondary">
        <Icon className="h-4 w-4 shrink-0 text-accent-copper" />
        <span id={approvalId ? approvalTitleId : undefined} className="font-medium text-foreground">
          {resolvedPresentation?.actionId ?? definition?.label ?? part.action_id}
        </span>
        <span
          className={cn(
            'ml-auto inline-flex items-center gap-1 text-metadata uppercase tracking-wide',
            visual.iconClass,
          )}
        >
          <StatusIcon className="h-3 w-3" />
          {visual.label}
        </span>
      </div>

      {approvalId && resolvedPresentation ? (
        <>
          <p className="text-secondary italic leading-relaxed text-muted-foreground">
            {resolvedPresentation.expectedEffect}
          </p>
          {resolvedPresentation.parameters.length > 0 && (
            <ul className="flex flex-col gap-0.5 font-mono text-metadata text-muted-foreground">
              {resolvedPresentation.parameters.map(({ field, safeValue }) => (
                <li key={field} className="truncate">
                  <span className="text-foreground/80">{field}</span>
                  <span className="opacity-60"> = </span>
                  <span>{safeValue}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : displayStatus === 'pending' ? (
        <p className="text-secondary leading-relaxed text-muted-foreground">
          {approvalId
            ? presentationState === 'failed'
              ? 'Canonical approval details are unavailable. Retry after the protected host reconnects.'
              : 'Loading protected approval details…'
            : 'This historical action card is view-only. Review current state and retry manually.'}
        </p>
      ) : null}

      {terminalCopy && (
        <p
          className={cn(
            'text-secondary leading-relaxed',
            displayStatus === 'error' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {terminalCopy}
        </p>
      )}

      {approvalId && resolvedPresentation && displayStatus === 'pending' ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant={dangerous ? 'destructive' : 'secondary'}
            disabled={decisionState === 'busy' || decisionState === 'submitted'}
            onClick={() => void decideCanonical('approve')}
            data-sik-evidence={
              KERNEL_SMOKE_ENABLED
                ? dangerous
                  ? SIK_CONTROL.approvalConfirmDangerous
                  : SIK_CONTROL.approvalConfirm
                : undefined
            }
            data-approval-submit-state={decisionState}
          >
            {decisionState === 'busy' ? 'Approving…' : 'Approve fixed action'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={decisionState === 'busy' || decisionState === 'submitted'}
            onClick={() => void decideCanonical('deny')}
          >
            Deny action
          </Button>
        </div>
      ) : null}
    </div>
  );
}
