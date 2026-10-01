import { ArrowUp, Layers, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  queueFlushModeLabel,
  shouldAutoSendQueuedOnRunStatus,
  takeNextQueuedMessage,
  type QueuedChatMessage,
  type QueueFlushMode,
} from './composerQueuePolicy';

export type { QueuedChatMessage, QueueFlushMode };
export { shouldAutoSendQueuedOnRunStatus, takeNextQueuedMessage };

export function QueuedMessagesBar({
  messages,
  onEdit,
  onSendNow,
  onStartMultitask,
  isModelSwitch,
  onStopAndRestart,
  onDelete,
}: {
  messages: QueuedChatMessage[];
  onEdit: (id: string) => void;
  onSendNow: (id: string) => void;
  /** Launch /multitask for this queued message (parallel agent). */
  onStartMultitask: (id: string) => void;
  isModelSwitch?: (message: QueuedChatMessage) => boolean;
  onStopAndRestart?: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (messages.length === 0) return null;
  return (
    <div
      aria-label="Queued messages"
      className="mb-1.5 min-w-0 max-w-full rounded-lg border border-accent-copper/20 bg-background/70 px-1.5 py-1 shadow-[0_8px_20px_rgba(0,0,0,0.18)]"
    >
      <div className="mb-0.5 flex items-center justify-between gap-2 px-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        <span className="min-w-0 truncate normal-case tracking-normal">
          Enter after tool · Tab after full reply · Esc send now · Esc×3 cancel
        </span>
        <span>{messages.length} queued</span>
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        {messages.map((message) => (
          <div
            key={message.id}
            className={cn(
              // Grid keeps action buttons visible: text shrinks, actions never get covered.
              'group grid min-w-0 max-w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5',
              'rounded-md border border-border/50 bg-panel/80 px-2 py-0.5',
            )}
          >
            <div className="min-w-0">
              <span
                className={cn(
                  'mr-1.5 inline-flex shrink-0 rounded border px-1 py-px text-[9px] font-medium uppercase tracking-wide',
                  message.flushMode === 'after-tool'
                    ? 'border-accent-copper/40 bg-accent-copper/10 text-accent-copper'
                    : 'border-border bg-muted/60 text-muted-foreground',
                )}
                title={
                  message.flushMode === 'after-tool'
                    ? 'Sends after the current tool finishes'
                    : 'Sends when the full reply finishes'
                }
              >
                {queueFlushModeLabel(message.flushMode)}
              </span>
              <span
                className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] leading-5 text-foreground"
                title={message.text}
              >
                {message.text}
              </span>
            </div>
            <div className="flex shrink-0 flex-nowrap items-center justify-end gap-0.5 opacity-90 transition-opacity group-hover:opacity-100">
              {!isModelSwitch?.(message) ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={cn(
                    'h-7 shrink-0 gap-1 rounded-md border border-accent-copper/30 bg-accent-copper/10 px-1.5 text-[11px] font-medium sm:px-2',
                    'text-accent-copper hover:bg-accent-copper/20 hover:text-foreground',
                  )}
                  aria-label="Start multitask for queued message"
                  title="Start multitask — runs /multitask for this message"
                  onClick={() => onStartMultitask(message.id)}
                >
                  <Layers className="h-3 w-3 shrink-0" />
                  <span className="hidden min-[420px]:inline">Multitask</span>
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                aria-label="Edit queued message"
                onClick={() => onEdit(message.id)}
              >
                <Pencil className="h-3 w-3" />
              </Button>
              {isModelSwitch?.(message) ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  aria-label="Stop current reply and restart with model switch"
                  title="Stop the current reply, then review and apply this model switch"
                  disabled={!onStopAndRestart}
                  onClick={() => onStopAndRestart?.(message.id)}
                >
                  <RotateCcw className="h-3 w-3" />
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  aria-label="Send queued message now"
                  onClick={() => onSendNow(message.id)}
                >
                  <ArrowUp className="h-3 w-3" />
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                aria-label="Delete queued message"
                onClick={() => onDelete(message.id)}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Build the slash payload used when starting multitask from a queue row. */
export function buildQueuedMultitaskCommand(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '/multitask';
  const body = trimmed.replace(/^\/(?:multitask|subagents)\s+/i, '').trim() || trimmed;
  return `/multitask ${body}`;
}

/**
 * Preserve a queued item until its resend is accepted. This keeps cancellation
 * and persistence/validation failures retryable instead of silently dropping work.
 */
export async function dispatchQueuedMessageAfterAcceptance(
  message: QueuedChatMessage,
  payload: string,
  send: (payload: string) => Promise<boolean>,
  remove: (id: string) => void,
): Promise<boolean> {
  const accepted = await send(payload);
  if (!accepted) return false;
  remove(message.id);
  return true;
}
