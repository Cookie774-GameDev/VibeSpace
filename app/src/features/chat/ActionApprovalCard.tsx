/**
 * Inline approval card for an `action_proposal` chat part.
 *
 * Renders inside an assistant message bubble whenever the AI proposed
 * an action via a fenced ```action {...}``` block (see
 * `lib/actions/parse.ts` + the splice in `lib/ai/runtime.ts`). The user
 * sees one card per proposal: action label, rationale, params, and
 * Approve/Cancel buttons.
 *
 * Lifecycle (mirrors `ActionStatus` in `types/chat.ts`):
 *   pending   -> running     (Approve clicked)
 *   running   -> success     (runner returned ok)
 *   running   -> error       (runner returned not-ok)
 *   pending   -> cancelled   (Cancel clicked)
 *
 * State updates are persisted by mutating the parent `Message`'s
 * `parts` array via `messageRepo`. The chat thread re-renders
 * automatically because `useChatMessages` is a Dexie live-query, so we
 * don't need any local state in this component beyond a transient
 * `busy` flag while a click is in-flight.
 */

import { useState } from 'react';
import {
  AlertTriangle,
  Check,
  Loader2,
  Play,
  X,
  type LucideIcon,
  HelpCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { messageRepo } from '@/lib/db/repositories';
import { resolveAction, runAction } from '@/lib/actions';
import type { Part, ActionStatus } from '@/types';
import type { MessageId } from '@/types/common';

type ActionPart = Extract<Part, { kind: 'action_proposal' }>;

export interface ActionApprovalCardProps {
  part: ActionPart;
  allParts: Part[];
  messageId: MessageId;
  chatId: string;
}

/* --------------------------------------------------------------------------
 * Status visuals
 * --------------------------------------------------------------------------*/

interface StatusVisual {
  icon: LucideIcon;
  /** Tailwind class for the icon colour. */
  iconClass: string;
  /** Short status word shown next to the icon. */
  label: string;
  /** Border accent (left edge). */
  borderClass: string;
}

const STATUS_VISUALS: Record<ActionStatus, StatusVisual> = {
  pending: {
    icon: Play,
    iconClass: 'text-accent-copper',
    label: 'Awaiting approval',
    borderClass: 'border-accent-copper/40',
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

/* --------------------------------------------------------------------------
 * Param formatting
 * --------------------------------------------------------------------------*/

/**
 * Render a single param value as a short, copy-friendly string. We
 * deliberately avoid pretty-printing JSON because the user is scanning
 * for "what would this do" — `cwd: C:\...` reads better than a multi-
 * line block.
 */
function formatParamValue(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'string') return v.length > 80 ? v.slice(0, 77) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/* --------------------------------------------------------------------------
 * Component
 * --------------------------------------------------------------------------*/

export function ActionApprovalCard({
  part,
  allParts,
  messageId,
  chatId,
}: ActionApprovalCardProps) {
  const def = resolveAction(part.action_id);
  const visual = STATUS_VISUALS[part.status] ?? STATUS_VISUALS.pending;
  const Icon = def?.icon ?? HelpCircle;
  const StatusIcon = visual.icon;

  const [busy, setBusy] = useState(false);
  const pendingActions = allParts.filter(
    (p): p is ActionPart => p.kind === 'action_proposal' && p.status === 'pending',
  );
  const isFirstPending = pendingActions[0]?.call_id === part.call_id;

  /** Persist a status patch onto the matching part inside the message. */
  const writeStatus = async (patch: Partial<ActionPart>): Promise<void> => {
    const msg = await messageRepo.getById(messageId);
    if (!msg) return;
    const nextParts: Part[] = msg.parts.map((p) =>
      p.kind === 'action_proposal' && p.call_id === part.call_id
        ? { ...p, ...patch }
        : p,
    );
    await messageRepo.update(messageId, { parts: nextParts });
  };

  const handleApprove = async () => {
    if (busy || part.status !== 'pending') return;
    setBusy(true);
    await writeStatus({ status: 'running' });
    const result = await runAction(
      part.action_id,
      part.params,
      {
        source: 'ai',
        chatId,
        messageId,
        callId: part.call_id,
      },
      { emitToast: false },
    );
    if (result.ok) {
      await writeStatus({
        status: 'success',
        result: result.data,
        error: undefined,
      });
    } else {
      await writeStatus({ status: 'error', error: result.error });
    }
    setBusy(false);
  };

  const handleCancel = async () => {
    if (busy || part.status !== 'pending') return;
    await writeStatus({ status: 'cancelled' });
  };

  const handleApproveAll = async () => {
    if (busy || part.status !== 'pending' || pendingActions.length <= 1) return;
    setBusy(true);
    const runnable = pendingActions.filter((p) => resolveAction(p.action_id));
    if (runnable.length === 0) {
      setBusy(false);
      return;
    }

    const mark = async (callId: string, patch: Partial<ActionPart>) => {
      const msg = await messageRepo.getById(messageId);
      if (!msg) return;
      await messageRepo.update(messageId, {
        parts: msg.parts.map((p) =>
          p.kind === 'action_proposal' && p.call_id === callId
            ? { ...p, ...patch }
            : p,
        ),
      });
    };

    for (const action of runnable) {
      await mark(action.call_id, { status: 'running' });
      const result = await runAction(
        action.action_id,
        action.params,
        {
          source: 'ai',
          chatId,
          messageId,
          callId: action.call_id,
        },
        { emitToast: false },
      );
      await mark(
        action.call_id,
        result.ok
          ? { status: 'success', result: result.data, error: undefined }
          : { status: 'error', error: result.error },
      );
    }
    setBusy(false);
  };

  // Body text for the inline result line shown after a non-pending run.
  const resultLine = (() => {
    if (part.status === 'success') {
      const data = part.result as { summary?: string } | undefined;
      return data?.summary ?? 'Action completed.';
    }
    if (part.status === 'error') return part.error ?? 'Unknown error.';
    if (part.status === 'cancelled') return 'You cancelled this action.';
    return null;
  })();

  return (
    <div
      className={cn(
        'rounded-md border-l-2 border bg-elevated px-3 py-2.5',
        'flex flex-col gap-1.5',
        visual.borderClass,
      )}
      data-action-id={part.action_id}
      data-status={part.status}
    >
      {/* Header: action icon + label + status badge */}
      <div className="flex items-center gap-2 text-secondary">
        <Icon className="h-4 w-4 text-accent-copper shrink-0" />
        <span className="font-medium text-foreground">
          {def?.label ?? part.action_id}
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

      {/* Rationale (italic muted) — AI's "why this action?" */}
      {part.rationale && (
        <div className="text-secondary italic text-muted-foreground leading-relaxed">
          {part.rationale}
        </div>
      )}

      {/* Params summary, only for actions that take any. */}
      {Object.keys(part.params).length > 0 && (
        <ul className="flex flex-col gap-0.5 text-metadata text-muted-foreground font-mono">
          {Object.entries(part.params).map(([k, v]) => (
            <li key={k} className="truncate">
              <span className="text-foreground/80">{k}</span>
              <span className="opacity-60"> = </span>
              <span>{formatParamValue(v)}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Footer: buttons (pending) or result text (anything else) */}
      {part.status === 'pending' ? (
        <div className="mt-1 flex items-center gap-2">
          {isFirstPending && pendingActions.length > 1 && (
            <Button
              size="sm"
              variant="accent"
              onClick={handleApproveAll}
              disabled={busy}
              title={`Run all ${pendingActions.length} pending actions in this message`}
            >
              <Check className="h-3.5 w-3.5" /> Approve all ({pendingActions.length})
            </Button>
          )}
          <Button
            size="sm"
            variant="default"
            onClick={handleApprove}
            disabled={busy || !def}
            title={
              def
                ? `Run ${def.label}`
                : `Unknown action: ${part.action_id}. Cannot run.`
            }
          >
            <Check className="h-3.5 w-3.5" /> Approve
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleCancel}
            disabled={busy}
          >
            <X className="h-3.5 w-3.5" /> Cancel
          </Button>
          {!def && (
            <span className="text-metadata text-destructive">
              Action <span className="font-mono">{part.action_id}</span> isn't
              registered. The AI may have hallucinated the id.
            </span>
          )}
        </div>
      ) : (
        resultLine && (
          <div
            className={cn(
              'text-secondary leading-relaxed',
              part.status === 'error'
                ? 'text-destructive'
                : 'text-muted-foreground',
            )}
          >
            {resultLine}
          </div>
        )
      )}
    </div>
  );
}
