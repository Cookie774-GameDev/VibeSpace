import { motion } from 'motion/react';
import { Copy, GitBranch } from 'lucide-react';
import { Avatar, Button, Hint, toast } from '@/components/ui';
import { useAgentStore } from '@/stores/agents';
import { cn, formatRelative, hueFromString } from '@/lib/utils';
import { MessagePart } from './MessagePart';
import type { Message } from '@/types';

export interface MessageBubbleProps {
  message: Message;
}

const spring = { type: 'spring' as const, stiffness: 400, damping: 30, mass: 0.8 };

function extractText(message: Message): string {
  return message.parts
    .filter((p): p is Extract<Message['parts'][number], { kind: 'text' }> => p.kind === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const agent = useAgentStore((s) => (message.agent_id ? s.agents[message.agent_id] : undefined));

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
      new CustomEvent('jarvis:branch', { detail: { messageId: message.id, chatId: message.chat_id } }),
    );
    toast.info('Branched from this message');
  };

  // System: centered, faint, dashed border
  if (message.role === 'system') {
    return (
      <motion.div
        layout
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={spring}
        className="flex w-full justify-center"
      >
        <div className="max-w-[60ch] rounded-md border border-dashed border-border bg-elevated/60 px-3 py-2 text-center">
          <div className="flex flex-col gap-1.5 text-secondary text-muted-foreground">
            {message.parts.map((part, i) => (
              <MessagePart key={i} part={part} allParts={message.parts} />
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
        layout
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={spring}
        className="flex w-full flex-col gap-1.5"
      >
        {message.parts.map((part, i) => (
          <MessagePart key={i} part={part} allParts={message.parts} />
        ))}
      </motion.div>
    );
  }

  // User: right-aligned-ish, muted bg, no avatar
  if (message.role === 'user') {
    return (
      <motion.div
        layout
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={spring}
        className="flex w-full justify-end"
      >
        <div className="group flex max-w-[80%] flex-col items-end gap-1">
          <div className="rounded-lg bg-muted px-3 py-2 text-foreground">
            <div className="flex flex-col gap-2">
              {message.parts.map((part, i) => (
                <MessagePart key={i} part={part} allParts={message.parts} />
              ))}
            </div>
          </div>
          <ActionStrip
            onCopy={handleCopy}
            onBranch={handleBranch}
            timestamp={message.created_at}
            align="end"
          />
        </div>
      </motion.div>
    );
  }

  // Assistant or Agent: left-aligned, with avatar, agent-colored left border.
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
      className="flex w-full justify-start"
    >
      <div className="flex max-w-[88%] items-start gap-2">
        <Avatar seed={slug} size={28} className="mt-0.5 shrink-0" />
        <div className="group flex min-w-0 flex-col gap-1">
          <div className="flex items-baseline gap-2">
            <span className="text-ui-strong text-foreground">{agent?.name ?? 'Assistant'}</span>
            <span className="text-metadata text-muted-foreground">
              {formatRelative(message.created_at)}
            </span>
            {message.usage?.model && (
              <span className="text-metadata text-muted-foreground font-mono truncate max-w-[20ch]">
                {message.usage.model}
              </span>
            )}
          </div>
          <div
            className={cn(
              'border-l pl-3 py-0.5',
              // Subtle agent tint on hover via class? We use inline style for the dynamic color.
            )}
            style={{ borderLeftColor: agentColor, borderLeftWidth: 1 }}
          >
            <div className="flex flex-col gap-2">
              {message.parts.map((part, i) => (
                <MessagePart key={i} part={part} allParts={message.parts} />
              ))}
            </div>
          </div>
          <ActionStrip onCopy={handleCopy} onBranch={handleBranch} align="start" />
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
}: {
  onCopy: () => void;
  onBranch: () => void;
  timestamp?: number;
  align: 'start' | 'end';
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity',
        align === 'end' ? 'justify-end' : 'justify-start',
      )}
    >
      {timestamp !== undefined && align === 'end' && (
        <span className="text-metadata text-muted-foreground mr-1">
          {formatRelative(timestamp)}
        </span>
      )}
      <Hint label="Copy">
        <Button size="icon-sm" variant="ghost" onClick={onCopy} aria-label="Copy message">
          <Copy />
        </Button>
      </Hint>
      <Hint label="Branch from here">
        <Button size="icon-sm" variant="ghost" onClick={onBranch} aria-label="Branch from here">
          <GitBranch />
        </Button>
      </Hint>
    </div>
  );
}
