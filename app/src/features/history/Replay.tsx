import * as React from 'react';
import { motion } from 'motion/react';
import { Play, Pause, ExternalLink, MessageSquare } from 'lucide-react';
import { messageRepo, chatRepo } from '@/lib/db';
import { useUIStore } from '@/stores/ui';
import { useAgentStore } from '@/stores/agents';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/tooltip';
import { cn, clamp, formatRelative, hueFromString } from '@/lib/utils';
import type { Agent, Chat, ChatId, Message, Part } from '@/types';

export interface ReplayProps {
  chatId: ChatId | null;
}

const SPEEDS = [0.5, 1, 2, 4] as const;
type Speed = (typeof SPEEDS)[number];

/**
 * Replay surface.
 *
 * Loads the chat header + full message list once when `chatId` changes
 * (replays should be stable; we don't useLiveQuery here so an active
 * conversation can't move under the user mid-scrub). Renders header,
 * scrubber + transport bar, and the bubble stack truncated to the
 * current position.
 *
 * Auto-advance uses real wall-clock gaps between messages, scaled by the
 * chosen speed and clamped to [80, 2500] ms so it never feels stuck on
 * very long pauses or breakneck on very short ones. Reduced-motion does
 * not auto-start playback (we default to paused) and the user can still
 * scrub manually.
 */
export function Replay({ chatId }: ReplayProps) {
  const setActiveChat = useUIStore((s) => s.setActiveChat);
  const setRoute = useUIStore((s) => s.setRoute);

  const [chat, setChat] = React.useState<Chat | null>(null);
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [position, setPosition] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [speed, setSpeed] = React.useState<Speed>(1);
  const [loading, setLoading] = React.useState(false);

  // Load chat + messages whenever the selection changes. Reset transport
  // so each new chat starts fresh at index 0, paused.
  React.useEffect(() => {
    let cancelled = false;
    setPosition(0);
    setPlaying(false);
    if (!chatId) {
      setChat(null);
      setMessages([]);
      return;
    }
    setLoading(true);
    void (async () => {
      try {
        const [c, msgs] = await Promise.all([
          chatRepo.getById(chatId),
          messageRepo.listByChat(chatId),
        ]);
        if (cancelled) return;
        setChat(c ?? null);
        setMessages(msgs);
      } catch (err) {
        // Surface in the dev console; UI shows the empty state below.
        console.error('Replay load failed:', err);
        if (!cancelled) {
          setChat(null);
          setMessages([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  // Auto-advance: schedule the next position based on the wall-clock gap
  // between this and the next message, scaled by speed and clamped.
  React.useEffect(() => {
    if (!playing || messages.length === 0) return;
    if (position >= messages.length - 1) {
      setPlaying(false);
      return;
    }
    const cur = messages[position];
    const next = messages[position + 1];
    const rawGap = next.created_at - cur.created_at;
    const gap = Math.max(80, Math.min(2500, rawGap / speed));
    const t = setTimeout(() => setPosition((p) => p + 1), gap);
    return () => clearTimeout(t);
  }, [playing, position, speed, messages]);

  // Space toggles play/pause when the replay surface owns the focus
  // (or when nothing-input-like is focused). Mounted only when a chat
  // is selected so we don't intercept Space across the rest of the app.
  React.useEffect(() => {
    if (!chatId || messages.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const tgt = e.target as HTMLElement | null;
      if (tgt) {
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName)) return;
        if (tgt.isContentEditable) return;
      }
      e.preventDefault();
      setPlaying((p) => !p);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chatId, messages.length]);

  const onOpenInChat = () => {
    if (!chatId) return;
    setActiveChat(chatId);
    setRoute('chat');
  };

  if (!chatId) return <ReplayEmpty />;
  if (loading) return <ReplayEmpty message="Loading replay…" />;
  if (!chat) return <ReplayEmpty message="That chat couldn't be found." />;
  if (messages.length === 0)
    return (
      <div className="flex h-full flex-col">
        <ReplayHeader chat={chat} messages={messages} onOpenInChat={onOpenInChat} />
        <ReplayEmpty message="This chat has no messages to replay." />
      </div>
    );

  const visible = messages.slice(0, position + 1);

  return (
    <div className="flex h-full flex-col">
      <ReplayHeader chat={chat} messages={messages} onOpenInChat={onOpenInChat} />

      <Scrubber
        position={position}
        total={messages.length}
        playing={playing}
        speed={speed}
        onTogglePlay={() => setPlaying((p) => !p)}
        onSeek={setPosition}
        onSpeed={setSpeed}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[820px] flex-col gap-3 px-4 py-5">
          {visible.map((m) => (
            <ReplayBubble key={m.id as unknown as string} message={m} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function ReplayHeader({
  chat,
  messages,
  onOpenInChat,
}: {
  chat: Chat;
  messages: Message[];
  onOpenInChat: () => void;
}) {
  const agents = useAgentStore((s) => s.agents);

  // Prefer the chat's declared agent set; fall back to whatever agent ids
  // appear on its messages so older chats still surface a sensible label.
  const agentIds = React.useMemo(() => {
    if (chat.active_agent_ids && chat.active_agent_ids.length > 0) {
      return chat.active_agent_ids;
    }
    const seen = new Set<string>();
    for (const m of messages) {
      if (m.agent_id) seen.add(m.agent_id as unknown as string);
    }
    return Array.from(seen) as Chat['active_agent_ids'];
  }, [chat.active_agent_ids, messages]);

  const agentLabels = agentIds
    .map((id) => agents[id]?.name)
    .filter((n): n is string => Boolean(n));

  return (
    <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border bg-paper/40 px-5 py-4">
      <div className="min-w-0">
        <h1 className="font-display text-page-title text-foreground truncate">
          {chat.title || 'Untitled chat'}
        </h1>
        <p className="eyebrow mt-1 truncate">
          <span>{formatRelative(chat.updated_at)}</span>
          {agentLabels.length > 0 && (
            <>
              <span aria-hidden className="mx-1.5 opacity-50">
                ·
              </span>
              <span>{agentLabels.join(' + ')}</span>
            </>
          )}
          <span aria-hidden className="mx-1.5 opacity-50">
            ·
          </span>
          <span>
            {messages.length} message{messages.length === 1 ? '' : 's'}
          </span>
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onOpenInChat}
        aria-label="Open in chat"
        className="shrink-0"
      >
        <ExternalLink />
        Open in chat
      </Button>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Scrubber
// ---------------------------------------------------------------------------

interface ScrubberProps {
  position: number;
  total: number;
  playing: boolean;
  speed: Speed;
  onTogglePlay: () => void;
  onSeek: (next: number) => void;
  onSpeed: (s: Speed) => void;
}

function Scrubber({
  position,
  total,
  playing,
  speed,
  onTogglePlay,
  onSeek,
  onSpeed,
}: ScrubberProps) {
  const railRef = React.useRef<HTMLDivElement>(null);
  const lastIdx = Math.max(0, total - 1);
  const ratio = lastIdx === 0 ? 1 : position / lastIdx;

  const seekFromClientX = React.useCallback(
    (clientX: number) => {
      const el = railRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = clamp(clientX - rect.left, 0, rect.width);
      const pct = rect.width === 0 ? 0 : x / rect.width;
      const next = Math.round(pct * lastIdx);
      onSeek(clamp(next, 0, lastIdx));
    },
    [lastIdx, onSeek],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromClientX(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons === 0) return;
    seekFromClientX(e.clientX);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  // Tick markers — cap the rendered ticks for very long chats to keep the
  // DOM cheap. Visual fidelity is preserved because the gradient fill still
  // reflects the true position.
  const tickIndices = React.useMemo(() => {
    const max = 80;
    if (total <= max) return Array.from({ length: total }, (_, i) => i);
    const step = total / max;
    return Array.from({ length: max }, (_, i) => Math.round(i * step));
  }, [total]);

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border bg-paper/30 px-5 py-2.5">
      <Hint label={playing ? 'Pause (Space)' : 'Play (Space)'}>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onTogglePlay}
          aria-label={playing ? 'Pause replay' : 'Play replay'}
          aria-pressed={playing}
        >
          {playing ? <Pause /> : <Play />}
        </Button>
      </Hint>

      <div
        ref={railRef}
        role="slider"
        aria-label="Replay position"
        aria-valuemin={0}
        aria-valuemax={lastIdx}
        aria-valuenow={position}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            onSeek(Math.max(0, position - 1));
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            onSeek(Math.min(lastIdx, position + 1));
          } else if (e.key === 'Home') {
            e.preventDefault();
            onSeek(0);
          } else if (e.key === 'End') {
            e.preventDefault();
            onSeek(lastIdx);
          }
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className={cn(
          'relative h-2 min-w-0 flex-1 cursor-pointer rounded-full bg-muted',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        )}
      >
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 rounded-full"
          style={{
            background:
              'linear-gradient(90deg, hsl(var(--terracotta)) 0%, hsl(var(--honey)) 100%)',
          }}
          animate={{ width: `${ratio * 100}%` }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
        />
        {/* Tick marks sit above the fill but below the thumb. */}
        <div className="pointer-events-none absolute inset-0 flex items-center">
          {tickIndices.map((idx) => {
            const left = lastIdx === 0 ? 0 : (idx / lastIdx) * 100;
            const reached = idx <= position;
            return (
              <span
                key={idx}
                className={cn(
                  'absolute h-1 w-px -translate-x-1/2 rounded',
                  reached ? 'bg-foreground/40' : 'bg-foreground/15',
                )}
                style={{ left: `${left}%` }}
              />
            );
          })}
        </div>
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent-copper bg-background shadow-soft"
          style={{ left: `${ratio * 100}%` }}
        />
      </div>

      <span className="shrink-0 font-mono text-metadata text-muted-foreground tabular-nums">
        {Math.min(position + 1, total)}/{total}
      </span>

      <label className="flex shrink-0 items-center gap-1.5 text-metadata text-muted-foreground">
        <span className="sr-only">Playback speed</span>
        <select
          value={speed}
          onChange={(e) => onSpeed(Number(e.target.value) as Speed)}
          aria-label="Playback speed"
          className={cn(
            'h-7 rounded-md border border-border bg-elevated px-1.5 text-metadata text-foreground',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          )}
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cozy bubble — minimal reimplementation, isolated from the prod chat canvas.
// ---------------------------------------------------------------------------

function ReplayBubble({ message }: { message: Message }) {
  const agent = useAgentStore((s) =>
    message.agent_id ? s.agents[message.agent_id] : undefined,
  ) as Agent | undefined;

  if (message.role === 'system') {
    return (
      <div className="flex w-full justify-center">
        <div className="max-w-[60ch] rounded-md border border-dashed border-border bg-paper/60 px-3 py-2 text-center text-secondary text-muted-foreground">
          <PartList parts={message.parts} />
        </div>
      </div>
    );
  }

  if (message.role === 'tool') {
    return (
      <div className="flex w-full">
        <div className="w-full rounded-lg border border-border bg-paper/50 px-3 py-2">
          <PartList parts={message.parts} compact />
        </div>
      </div>
    );
  }

  if (message.role === 'user') {
    return (
      <div className="flex w-full justify-end">
        <div className="max-w-[80%] rounded-lg bg-muted px-3 py-2 text-foreground">
          <PartList parts={message.parts} />
          <div className="mt-1 text-metadata text-muted-foreground">
            {formatRelative(message.created_at)}
          </div>
        </div>
      </div>
    );
  }

  // assistant / agent
  const slug = agent?.slug ?? (message.agent_id as unknown as string) ?? 'jarvis';
  const hue = agent?.color_hue ?? hueFromString(slug);
  const borderColor = `hsl(${hue}, 70%, 60%)`;

  return (
    <div className="flex w-full justify-start">
      <div className="flex max-w-[88%] items-start gap-2">
        <Avatar seed={slug} size={28} className="mt-0.5 shrink-0" />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-baseline gap-2">
            <span className="text-ui-strong text-foreground">{agent?.name ?? 'Assistant'}</span>
            <span className="text-metadata text-muted-foreground">
              {formatRelative(message.created_at)}
            </span>
          </div>
          <div
            className="rounded-r-md border-l bg-paper/40 py-1 pl-3 pr-2"
            style={{ borderLeftColor: borderColor, borderLeftWidth: 2 }}
          >
            <PartList parts={message.parts} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Render message parts as plain text with small inline pills for tool I/O,
 * images, and file refs. The production canvas has full-fidelity renderers
 * (markdown, syntax-highlighted code, tool cards) — we deliberately keep
 * this lean so the slice stays self-contained and replays render fast even
 * for very long chats.
 */
function PartList({ parts, compact = false }: { parts: Part[]; compact?: boolean }) {
  return (
    <div className={cn('flex flex-col gap-1.5', compact && 'gap-1')}>
      {parts.map((p, i) => (
        <PartView key={i} part={p} />
      ))}
    </div>
  );
}

function PartView({ part }: { part: Part }) {
  switch (part.kind) {
    case 'text':
      return <p className="whitespace-pre-wrap break-words text-body text-foreground">{part.text}</p>;
    case 'reasoning':
      return (
        <p className="whitespace-pre-wrap break-words text-secondary italic text-muted-foreground">
          {part.text}
        </p>
      );
    case 'tool_call':
      return (
        <span className="inline-flex items-center gap-1 self-start rounded-full border border-border bg-elevated px-2 py-0.5 font-mono text-metadata text-muted-foreground">
          <MessageSquare className="h-3 w-3" /> tool · {part.tool}
        </span>
      );
    case 'tool_result':
      return (
        <span className="inline-flex items-center gap-1 self-start rounded-full border border-border bg-elevated px-2 py-0.5 font-mono text-metadata text-muted-foreground">
          {part.error ? `error · ${truncate(part.error, 40)}` : 'tool result'}
        </span>
      );
    case 'image':
      return (
        <span className="inline-flex items-center gap-1 self-start rounded-md border border-border bg-elevated px-2 py-1 text-metadata text-muted-foreground">
          [image] {part.alt ?? ''}
        </span>
      );
    case 'file_ref':
      return (
        <span className="inline-flex items-center gap-1 self-start rounded-md border border-border bg-elevated px-2 py-1 text-metadata text-muted-foreground">
          [{part.ref.kind}] {part.ref.excerpt ? truncate(part.ref.excerpt, 60) : part.ref.id}
        </span>
      );
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

// ---------------------------------------------------------------------------
// Empty placeholder for the right pane.
// ---------------------------------------------------------------------------

function ReplayEmpty({ message }: { message?: string } = {}) {
  return (
    <div className="flex h-full items-center justify-center px-8 text-center">
      <div className="max-w-[40ch]">
        <div className="font-display text-page-title text-foreground">Pick a chat to replay</div>
        <p className="mt-2 text-secondary text-muted-foreground">
          {message ?? 'Choose a past conversation from the rail to step through it message-by-message.'}
        </p>
      </div>
    </div>
  );
}
