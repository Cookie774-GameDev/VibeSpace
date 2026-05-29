import { useEffect, useMemo, useRef, useState } from 'react';
import { Send, ChevronDown, Sparkles } from 'lucide-react';
import {
  Button,
  Hint,
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui';
import { messageRepo } from '@/lib/db';
import { cn, renderHotkey } from '@/lib/utils';
import { HOTKEYS } from '@/lib/hotkeys';
import { useAgentStore } from '@/stores/agents';
import { useAuthStore } from '@/stores/auth';
import type { Agent, AgentId, ChatId, ProviderId } from '@/types';
import { MentionTypeahead } from './MentionTypeahead';

export interface ComposerProps {
  chatId: ChatId | string;
  /** Optional placeholder override */
  placeholder?: string;
}

const LINE_HEIGHT = 20; // px - matches body type scale
const PADDING_Y = 16; // px - 8px top + 8px bottom
const MIN_LINES = 1;
const MAX_LINES = 8;
const MIN_HEIGHT = MIN_LINES * LINE_HEIGHT + PADDING_Y;
const MAX_HEIGHT = MAX_LINES * LINE_HEIGHT + PADDING_Y;

const PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'google', 'mock', 'local'];
const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  mock: 'Mock',
  local: 'Local',
};

type MentionContext = { start: number; query: string };

/**
 * Find an active "@xxx" mention being typed at the caret.
 * Triggers when '@' is at position 0 or directly after whitespace.
 */
function getMentionContext(value: string, caret: number): MentionContext | null {
  let i = caret - 1;
  while (i >= 0) {
    const c = value[i];
    if (c === '@') {
      if (i === 0 || /\s/.test(value[i - 1] ?? '')) {
        return { start: i, query: value.slice(i + 1, caret) };
      }
      return null;
    }
    if (/\s/.test(c)) return null;
    i--;
  }
  return null;
}

/**
 * Pull all `@slug` tokens from a string and resolve them to known AgentIds.
 */
function extractMentionedAgentIds(text: string, agents: Record<string, Agent>): AgentId[] {
  const slugToId: Record<string, AgentId> = {};
  for (const a of Object.values(agents)) slugToId[a.slug] = a.id;

  const seen = new Set<AgentId>();
  const out: AgentId[] = [];
  const re = /(?:^|\s)@([a-z0-9_-]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = slugToId[(m[1] ?? '').toLowerCase()];
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function Composer({ chatId, placeholder }: ComposerProps) {
  const [text, setText] = useState('');
  const [mentionCtx, setMentionCtx] = useState<MentionContext | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string>('');
  const [sending, setSending] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const agents = useAgentStore((s) => s.agents);
  const provider = useAuthStore((s) => s.defaultProvider);
  const setDefaultProvider = useAuthStore((s) => s.setDefaultProvider);

  // Filtered agent list for the mention typeahead (case-insensitive prefix match,
  // falling back to substring match for forgiving search).
  const filteredAgents = useMemo<Agent[]>(() => {
    const all = Object.values(agents);
    const q = (mentionCtx?.query ?? '').toLowerCase();
    if (!mentionCtx) return [];
    if (!q) return all;
    return all
      .filter((a) => a.slug.toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
      .sort((a, b) => {
        // Prefer slug-prefix matches first
        const aPrefix = a.slug.toLowerCase().startsWith(q) ? 0 : 1;
        const bPrefix = b.slug.toLowerCase().startsWith(q) ? 0 : 1;
        if (aPrefix !== bPrefix) return aPrefix - bPrefix;
        return a.slug.localeCompare(b.slug);
      });
  }, [agents, mentionCtx]);

  // Keep selectedSlug in sync when filtered list changes
  useEffect(() => {
    if (filteredAgents.length === 0) {
      setSelectedSlug('');
      return;
    }
    if (!filteredAgents.some((a) => a.slug === selectedSlug)) {
      setSelectedSlug(filteredAgents[0]!.slug);
    }
  }, [filteredAgents, selectedSlug]);

  // Auto-grow the textarea up to MAX_HEIGHT, then enable internal scroll
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const next = Math.max(MIN_HEIGHT, Math.min(ta.scrollHeight, MAX_HEIGHT));
    ta.style.height = `${next}px`;
    ta.style.overflowY = ta.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
  }, [text]);

  const recomputeMention = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    setMentionCtx(getMentionContext(ta.value, ta.selectionStart));
  };

  const insertMention = (agent: Agent) => {
    if (!mentionCtx || !textareaRef.current) return;
    const ta = textareaRef.current;
    const before = text.slice(0, mentionCtx.start);
    const after = text.slice(ta.selectionStart);
    const insert = `@${agent.slug} `;
    const next = before + insert + after;
    setText(next);
    setMentionCtx(null);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      const pos = before.length + insert.length;
      node.focus();
      node.setSelectionRange(pos, pos);
    });
  };

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      // Repo stamps id + timestamps + bumps parent chat.updated_at
      await messageRepo.create({
        chat_id: chatId as ChatId,
        role: 'user',
        parts: [{ kind: 'text', text: trimmed }],
      });

      const mentionedAgentIds = extractMentionedAgentIds(trimmed, agents);
      window.dispatchEvent(
        new CustomEvent('jarvis:send', {
          detail: { chatId, text: trimmed, mentionedAgentIds },
        }),
      );
      setText('');
      setMentionCtx(null);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Mod+Enter always sends, regardless of mention popover state
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleSend();
      return;
    }

    if (mentionCtx) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionCtx(null);
        return;
      }
      if (filteredAgents.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const i = filteredAgents.findIndex((a) => a.slug === selectedSlug);
          const next = filteredAgents[(i + 1 + filteredAgents.length) % filteredAgents.length]!;
          setSelectedSlug(next.slug);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          const i = filteredAgents.findIndex((a) => a.slug === selectedSlug);
          const baseI = i === -1 ? 0 : i;
          const next =
            filteredAgents[(baseI - 1 + filteredAgents.length) % filteredAgents.length]!;
          setSelectedSlug(next.slug);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const agent =
            filteredAgents.find((a) => a.slug === selectedSlug) ?? filteredAgents[0];
          if (agent) insertMention(agent);
          return;
        }
      }
    }
  };

  const canSend = text.trim().length > 0 && !sending;

  return (
    <div className="border-t border-border bg-panel">
      <div className="px-3 py-2.5">
        <Popover
          open={mentionCtx !== null}
          onOpenChange={(open) => {
            if (!open) setMentionCtx(null);
          }}
        >
          <PopoverAnchor asChild>
            <div
              className={cn(
                'rounded-lg border border-input bg-background',
                'transition-colors focus-within:border-accent-cyan/40 focus-within:ring-1 focus-within:ring-ring',
              )}
            >
              <textarea
                ref={textareaRef}
                value={text}
                rows={1}
                onChange={(e) => {
                  setText(e.target.value);
                  // Recompute on next tick so selectionStart reflects the new value
                  requestAnimationFrame(recomputeMention);
                }}
                onKeyDown={onKeyDown}
                onKeyUp={recomputeMention}
                onClick={recomputeMention}
                placeholder={placeholder ?? 'Message Jarvis...   (use @ to mention an agent)'}
                aria-label="Message"
                style={{ minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT }}
                className={cn(
                  'block w-full resize-none bg-transparent px-3 py-2 text-body text-foreground',
                  'placeholder:text-muted-foreground outline-none',
                  'scrollbar-hidden',
                )}
              />
              <div className="flex items-center gap-1 px-2 pb-2 pt-0.5">
                <ModelPicker
                  provider={provider}
                  onChange={setDefaultProvider}
                />
                <span className="text-metadata text-muted-foreground ml-auto mr-1 hidden sm:inline">
                  <span className="kbd">{renderHotkey(HOTKEYS.SEND)}</span> to send
                </span>
                <Hint label="Send" hotkey={HOTKEYS.SEND}>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant={canSend ? 'accent' : 'ghost'}
                    onClick={() => void handleSend()}
                    disabled={!canSend}
                    aria-label="Send message"
                  >
                    <Send />
                  </Button>
                </Hint>
              </div>
            </div>
          </PopoverAnchor>
          <PopoverContent
            side="top"
            align="start"
            sideOffset={8}
            className="w-[420px] p-0 max-h-[280px] overflow-hidden"
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
            onInteractOutside={(e) => {
              // Keep the popover open while the user is interacting with the textarea
              if (textareaRef.current && textareaRef.current.contains(e.target as Node)) {
                e.preventDefault();
              }
            }}
          >
            <MentionTypeahead
              agents={filteredAgents}
              selectedSlug={selectedSlug}
              query={mentionCtx?.query ?? ''}
              onHoverSlug={setSelectedSlug}
              onSelect={insertMention}
            />
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

interface ModelPickerProps {
  provider: ProviderId;
  onChange: (p: ProviderId) => void;
}

function ModelPicker({ provider, onChange }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="gap-1 px-2 text-muted-foreground"
          aria-label="Choose model"
        >
          <Sparkles />
          <span className="text-metadata">{PROVIDER_LABELS[provider]}</span>
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className="w-[220px] p-1"
      >
        <div className="px-2 py-1 text-metadata text-muted-foreground uppercase tracking-wide">
          Model provider
        </div>
        <ul className="flex flex-col">
          {PROVIDERS.map((p) => (
            <li key={p}>
              <button
                type="button"
                onClick={() => {
                  onChange(p);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center justify-between rounded px-2 py-1.5 text-left',
                  'hover:bg-muted transition-colors',
                  p === provider && 'bg-muted text-foreground',
                )}
              >
                <span className="text-secondary">{PROVIDER_LABELS[p]}</span>
                {p === provider && (
                  <span className="text-metadata text-accent-cyan">active</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
