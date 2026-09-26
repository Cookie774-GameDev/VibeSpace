import { useEffect, useId, useState } from 'react';
import {
  CornerDownRight,
  ListEnd,
  Layers,
  Pencil,
  Trash2,
  MoreHorizontal,
  MessageSquarePlus,
  Paperclip,
  Loader2,
  ChevronDown,
} from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import {
  queueFlushModeLabel,
  shouldAutoSendQueuedOnRunStatus,
  takeNextQueuedMessage,
  type QueuedChatMessage,
  type QueueFlushMode,
} from './composerQueuePolicy';
import './queued-message-row.css';
export type { QueuedChatMessage, QueueFlushMode };
export { shouldAutoSendQueuedOnRunStatus, takeNextQueuedMessage };
interface Props {
  messages: QueuedChatMessage[];
  onEdit: (id: string) => void;
  onSendNow: (id: string) => void;
  onQueueNative?: (id: string) => void;
  onStartMultitask: (id: string) => void;
  onOpenSideChat?: (id: string) => void;
  busyId?: string | null;
  isModelSwitch?: (message: QueuedChatMessage) => boolean;
  onStopAndRestart?: (id: string) => void;
  steerMode?: 'native' | 'stop-followup';
  onDelete: (id: string) => void;
}
function QueueRow({ message, ...props }: Omit<Props, 'messages'> & { message: QueuedChatMessage }) {
  const [open, setOpen] = useState(false);
  const image = message.attachments?.images[0];
  const attachmentCount = message.attachments
    ? Object.values(message.attachments).reduce((sum, items) => sum + items.length, 0)
    : 0;
  const switching = props.isModelSwitch?.(message);
  const stopAndFollowUp = !switching && props.steerMode === 'stop-followup';
  const action = (callback: ((id: string) => void) | undefined) => {
    setOpen(false);
    callback?.(message.id);
  };
  return (
    <div className="queued-message-row" data-queued-message-id={message.id}>
      <ListEnd className="queue-order-icon" aria-hidden="true" />
      {image ? (
        <img
          className="queue-thumbnail"
          src={`data:${image.mimeType};base64,${image.data}`}
          alt={image.name}
        />
      ) : attachmentCount > 0 ? (
        <span className="queue-attachment-count" title={`${attachmentCount} attachments`}>
          <Paperclip size={13} />
          {attachmentCount}
        </span>
      ) : null}
      <span
        className="queue-message-text"
        title={message.text + ' · ' + queueFlushModeLabel(message.flushMode)}
      >
        {message.text}
      </span>
      <div className="queue-row-actions">
        <button
          type="button"
          className="queue-steer"
          disabled={Boolean(props.busyId) || Boolean(switching && !props.onStopAndRestart)}
          aria-label={
            switching
              ? 'Stop current reply and restart with model switch'
              : stopAndFollowUp
                ? 'Stop current reply and follow up'
                : 'Steer queued message'
          }
          title={stopAndFollowUp
            ? 'Stop the active OpenCode reply and send this message as the next turn.'
            : undefined}
          onClick={() => (switching ? props.onStopAndRestart : props.onSendNow)?.(message.id)}
        >
          {props.busyId === message.id ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <CornerDownRight size={14} />
          )}
          <span>{stopAndFollowUp ? 'Follow up' : 'Steer'}</span>
        </button>
        <button
          type="button"
          aria-label="Delete queued message"
          title="Delete"
          disabled={Boolean(props.busyId)}
          onClick={() => props.onDelete(message.id)}
        >
          <Trash2 size={14} />
        </button>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Queued message options"
              title="More options"
              disabled={Boolean(props.busyId)}
            >
              <MoreHorizontal size={16} />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" side="top" className="queue-options-menu w-56 p-1.5">
            <button
              type="button"
              aria-label="Edit queued message"
              onClick={() => action(props.onEdit)}
            >
              <Pencil size={15} />
              Edit message
            </button>
            <button
              type="button"
              disabled={!props.onOpenSideChat}
              onClick={() => action(props.onOpenSideChat)}
            >
              <MessageSquarePlus size={15} />
              Open in side chat
            </button>
            {!switching && (
              <button
                type="button"
                disabled={!props.onQueueNative}
                aria-label="Queue on active Codex turn"
                onClick={() => action(props.onQueueNative)}
              >
                <ListEnd size={15} />
                Queue on Codex
              </button>
            )}
            {!switching && (
              <button
                type="button"
                aria-label="Start multitask for queued message"
                onClick={() => action(props.onStartMultitask)}
              >
                <Layers size={15} />
                Start multitask
              </button>
            )}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
export function QueuedMessagesBar({ messages, ...props }: Props) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const overflow = Math.max(0, messages.length - 3);
  useEffect(() => {
    if (!overflow) setExpanded(false);
  }, [overflow]);
  if (!messages.length) return null;
  return (
    <div aria-label="Queued messages" className="queued-message-stack">
      <span className="sr-only">
        {messages.length} queued. Enter after tool · Tab after full reply.
      </span>
      <div id={listId} className="queue-visible-messages" data-expanded={expanded}>
        {(expanded ? messages : messages.slice(0, 3)).map((message) => (
          <QueueRow key={message.id} message={message} {...props} />
        ))}
      </div>
      {overflow > 0 && (
        <button
          type="button"
          className="queue-expand-toggle"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronDown size={14} aria-hidden="true" />
          {expanded ? 'Show less' : `Show ${overflow} more`}{' '}
          <span className="queue-total-count">{messages.length} queued</span>
        </button>
      )}
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
