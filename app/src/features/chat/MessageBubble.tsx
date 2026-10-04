import { motion } from 'motion/react';
import { Copy, GitBranch } from 'lucide-react';
import { Avatar, Button, Hint, toast } from '@/components/ui';
import { useThemeMotionLayout, useThemeMotionTransition } from '@/features/appearance/themeMotion';
import { useAgentStore } from '@/stores/agents';
import { cn, formatRelative, hueFromString } from '@/lib/utils';
import { MessagePart } from './MessagePart';
import { AssistantRichText } from './AssistantRichText';
import { parseActiveChatCommandMessage } from './chatActiveCommands';
import { ResponseDetails } from './ResponseDetails';
import { AssistantActivityLedger } from './activity-ledger/AssistantActivityLedger';
import { resolvePluginActionEvidence } from './PluginUsageCard';
import { parseTaskApprovalCallId } from '@/features/jarvis-runs/approvalBridge';
import type { Message } from '@/types';
import type { JarvisCreatorKind } from '@/features/jarvis-creator/contracts';

export interface MessageBubbleProps {
  message: Message;
  compact?: boolean;
  creatorDraftKind?: JarvisCreatorKind;
  showActivityLedger?: boolean;
  showIdentity?: boolean;
}

const SPRING = 'spring' as const;
const MESSAGE_TRANSITION = { type: SPRING, stiffness: 400, damping: 30, mass: 0.8 };

function isOrdinaryAssistantText(
  part: Message['parts'][number],
  creatorDraftKind?: JarvisCreatorKind,
): part is Extract<Message['parts'][number], { kind: 'text' }> {
  return (
    part.kind === 'text' &&
    Boolean(part.text) &&
    !creatorDraftKind &&
    !part.text.includes('```action') &&
    !parseActiveChatCommandMessage(part.text)
  );
}

function extractText(message: Message): string {
  return message.parts
    .filter((p): p is Extract<Message['parts'][number], { kind: 'text' }> => p.kind === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

export function MessageBubble({
  message,
  compact = false,
  creatorDraftKind,
  showActivityLedger = true,
  showIdentity = true,
}: MessageBubbleProps) {
  const agent = useAgentStore((s) => (message.agent_id ? s.agents[message.agent_id] : undefined));
  const messageLayout = useThemeMotionLayout(true);
  const messageTransition = useThemeMotionTransition(MESSAGE_TRANSITION);

  // Creator "Push to agent/skill" buttons belong only on real Jarvis draft
  // replies: assistant messages in a creator thread that are not the seeded
  // question prompt itself. User, system, and tool messages never qualify.
  const isCreatorSeedMessage = message.parts.some((p) => p.kind === 'question_block');
  const assistantCreatorDraftKind =
    message.role === 'assistant' && !isCreatorSeedMessage ? creatorDraftKind : undefined;

  // A Hive ensemble reply carries one or more `stack_step` parts. When present
  // we wrap the response in a soft, warm radiant glow that matches the cozy
  // composer halo.
  const isHiveResponse = message.parts.some((p) => p.kind === 'stack_step');
  const isProviderErrorMessage = message.parts.some((part) => part.kind === 'provider_error');
  const assistantVisibleParts =
    message.role === 'assistant'
      ? message.parts.filter((part) => {
          if (part.kind === 'tool_call' || part.kind === 'tool_result') return false;
          if (
            part.kind === 'action_proposal' &&
            (part.status === 'success' || part.status === 'error' || part.status === 'cancelled') &&
            !parseTaskApprovalCallId(part.call_id) &&
            !resolvePluginActionEvidence(part, message.parts)
          ) {
            return false;
          }
          return true;
        })
      : message.parts;

  const slug = agent?.slug ?? message.agent_id ?? 'jarvis';
  const hue = agent?.color_hue ?? hueFromString(slug);
  const agentColor = `hsl(${hue}, 70%, 60%)`;

  const handleCopy = async () => {
    const text = extractText(message);
    if (!text) {
      toast.warning('Nothing to copy', 'This message has no text.');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied');
    } catch {
      toast.error('Copy failed');
    }
  };

  const handleBranch = () => {
    window.dispatchEvent(
      new CustomEvent('jarvis:branch', {
        detail: { messageId: message.id, chatId: message.chat_id },
      }),
    );
  };

  // System notices stay centered, while a durable provider failure needs the
  // transcript's full width so its route/request/run evidence remains legible.
  if (message.role === 'assistant' && message.parts.every(
    (part) => part.kind === 'text' && !part.text.trim(),
  )) return null;

  if (message.role === 'system') {
    return (
      <motion.div
        layout={messageLayout}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={messageTransition}
        data-provider-error-message={isProviderErrorMessage ? 'true' : undefined}
        className={cn('flex w-full', isProviderErrorMessage ? 'justify-start' : 'justify-center')}
      >
        <div
          className={cn(
            isProviderErrorMessage
              ? 'w-full max-w-none px-0 py-1 text-left'
              : 'rounded-md border border-dashed border-border bg-elevated/60 px-3 py-2 text-center',
            !isProviderErrorMessage && (compact ? 'max-w-full text-metadata' : 'max-w-[60ch]'),
          )}
        >
          <div
            className={cn(
              'flex flex-col gap-1.5 text-secondary text-muted-foreground',
              isProviderErrorMessage ? 'w-full items-stretch text-left' : 'text-center',
            )}
          >
            {message.parts.map((part, i) => (
              <MessagePart
                key={i}
                part={part}
                allParts={message.parts}
                messageId={message.id}
                chatId={message.chat_id}
              />
            ))}
          </div>
        </div>
      </motion.div>
    );
  }

  // Tool: full-width inline (parts are tool cards)
  if (message.role === 'tool') {
    return (
      <motion.div
        layout={messageLayout}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={messageTransition}
        className="flex w-full flex-col gap-1.5"
      >
        {message.parts.map((part, i) => (
          <MessagePart
            key={i}
            part={part}
            allParts={message.parts}
            messageId={message.id}
            chatId={message.chat_id}
          />
        ))}
      </motion.div>
    );
  }

  // User: right-aligned-ish, muted bg, no avatar
  if (message.role === 'user') {
    return (
      <motion.div
        layout={messageLayout}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={messageTransition}
        className="flex w-full justify-end"
      >
        <div
          className={cn(
            'group flex flex-col items-end gap-1 min-w-0',
            compact ? 'max-w-[94%]' : 'max-w-[80%]',
          )}
        >
          <div className="rounded-lg bg-muted px-3 py-2 text-foreground min-w-0 w-full overflow-hidden break-all">
            <div className="flex flex-col gap-2">
              {message.parts.map((part, i) => (
                <MessagePart
                  key={i}
                  part={part}
                  allParts={message.parts}
                  messageId={message.id}
                  chatId={message.chat_id}
                  compactAttachments
                />
              ))}
            </div>
          </div>
          <ActionStrip
            onCopy={handleCopy}
            onBranch={handleBranch}
            timestamp={message.created_at}
            align="end"
            compact={compact}
          />
        </div>
      </motion.div>
    );
  }

  // Assistant or Agent: left-aligned, with avatar, agent-colored left border.
  return (
    <motion.div
      layout={messageLayout}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={messageTransition}
      className="flex w-full justify-start"
    >
      <div
        className={cn(
          'flex min-w-0 items-start',
          compact ? 'max-w-[98%] gap-1.5' : 'max-w-[88%] gap-2',
        )}
      >
        <span
          data-pet-message-avatar={compact ? 'true' : undefined}
          aria-hidden={!showIdentity || undefined}
          className={cn('mt-0.5 shrink-0', !showIdentity && 'invisible')}
        >
          <Avatar seed={slug} size={compact ? 22 : 28} />
        </span>
        <div className="group flex min-w-0 flex-col gap-1">
          {showIdentity ? (
            <div className="flex min-w-0 items-baseline gap-1.5">
              <span className="text-ui-strong text-foreground">{agent?.name ?? 'Assistant'}</span>
              <span className="text-metadata text-muted-foreground">
                {formatRelative(message.created_at)}
              </span>
              {message.usage?.model && (
                <span
                  className={cn(
                    'text-metadata text-muted-foreground font-mono truncate',
                    compact ? 'max-w-[10ch]' : 'max-w-[20ch]',
                  )}
                >
                  {message.usage.model}
                </span>
              )}
            </div>
          ) : null}
          <div
            className={cn(
              'min-w-0',
              isHiveResponse
                ? cn(
                    'hive-response-glow rounded-2xl',
                    compact ? 'px-3 py-2 text-secondary' : 'px-3.5 py-2.5',
                  )
                : cn('border-l py-0.5', compact ? 'pl-2 text-secondary' : 'pl-3'),
              // Subtle agent tint on hover via class? We use inline style for the dynamic color.
            )}
            style={isHiveResponse ? undefined : { borderLeftColor: agentColor, borderLeftWidth: 1 }}
          >
            <div className="flex flex-col gap-2">
              {assistantVisibleParts.map((part, i) => (
                isOrdinaryAssistantText(part, assistantCreatorDraftKind) ? (
                  <AssistantRichText
                    key={i}
                    text={part.text}
                    className={cn('text-body', isHiveResponse && 'hive-words font-medium')}
                  />
                ) : (
                  <MessagePart
                    key={i}
                    part={part}
                    allParts={message.parts}
                    messageId={message.id}
                    chatId={message.chat_id}
                    hiveWords={isHiveResponse}
                    creatorDraftKind={assistantCreatorDraftKind}
                    richText
                  />
                )
              ))}
              {message.role === 'assistant' && showActivityLedger ? (
                <AssistantActivityLedger message={message} compact={compact} />
              ) : null}
              <ResponseDetails usage={message.usage} />
            </div>
          </div>
          <ActionStrip
            onCopy={handleCopy}
            onBranch={handleBranch}
            align="start"
            compact={compact}
          />
        </div>
      </div>
    </motion.div>
  );
}

function ActionStrip({
  onCopy,
  onBranch,
  timestamp,
  align,
  compact = false,
}: {
  onCopy: () => void;
  onBranch: () => void;
  timestamp?: number;
  align: 'start' | 'end';
  /** Pet mini-panel: keep actions visible (no hover) and denser. */
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-0.5 transition-opacity',
        // Hover-reveal on main; always visible in compact pet chat.
        compact ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        align === 'end' ? 'justify-end' : 'justify-start',
      )}
      data-message-actions="true"
      data-compact={compact ? 'true' : undefined}
    >
      {timestamp !== undefined && align === 'end' && (
        <span className="text-metadata text-muted-foreground mr-1">
          {formatRelative(timestamp)}
        </span>
      )}
      <Hint label="Copy">
        <Button size="icon-sm" variant="ghost" onClick={onCopy} aria-label="Copy message">
          <Copy className={compact ? 'h-3 w-3' : undefined} />
        </Button>
      </Hint>
      <Hint label="Branch from here">
        <Button size="icon-sm" variant="ghost" onClick={onBranch} aria-label="Branch from here">
          <GitBranch className={compact ? 'h-3 w-3' : undefined} />
        </Button>
      </Hint>
    </div>
  );
}
