import { create } from 'zustand';
import type { ChatId } from '@/types/common';
import type { ChatActivityEvent, ChatActivityPatch } from './types';

const MAX_EVENTS_PER_CHAT = 80;
const MAX_DETAIL_CHARS = 4000;
const MAX_THINKING_CHARS = 1_000_000;

function detailLimit(event: ChatActivityPatch): number {
  return event.category === 'thinking' && event.messageId ? MAX_THINKING_CHARS : MAX_DETAIL_CHARS;
}
const MAX_DIFF_CHARS = 12000;

interface ChatActivityState {
  eventsByChat: Record<string, ChatActivityEvent[]>;
  record: (event: ChatActivityEvent) => void;
  update: (chatId: ChatId | string, id: string, patch: ChatActivityPatch) => void;
  clearChat: (chatId: ChatId | string) => void;
}

function key(chatId: ChatId | string): string {
  return String(chatId);
}

function truncatePayload(value: string | undefined, maxChars: number, label: string): string | undefined {
  if (!value || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[${label} truncated by VibeSpace: ${value.length - maxChars} chars hidden]`;
}

function boundedEvent(event: ChatActivityEvent): ChatActivityEvent {
  return {
    ...event,
    detail: truncatePayload(event.detail, detailLimit(event), 'detail'),
    diff: truncatePayload(event.diff, MAX_DIFF_CHARS, 'diff'),
  };
}

function boundedPatch(patch: ChatActivityPatch, event: ChatActivityEvent): ChatActivityPatch {
  return {
    ...patch,
    ...('detail' in patch ? { detail: truncatePayload(patch.detail, detailLimit({ ...event, ...patch }), 'detail') } : {}),
    ...('diff' in patch ? { diff: truncatePayload(patch.diff, MAX_DIFF_CHARS, 'diff') } : {}),
  };
}

export function createChatActivityId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const useChatActivityStore = create<ChatActivityState>((set) => ({
  eventsByChat: {},
  record(event) {
    set((state) => {
      const nextEvent = boundedEvent(event);
      const chatKey = key(nextEvent.chatId);
      const existing = state.eventsByChat[chatKey] ?? [];
      const next = [...existing.filter((item) => item.id !== nextEvent.id), nextEvent]
        .sort((a, b) => a.ts - b.ts)
        .slice(-MAX_EVENTS_PER_CHAT);
      return {
        eventsByChat: {
          ...state.eventsByChat,
          [chatKey]: next,
        },
      };
    });
  },
  update(chatId, id, patch) {
    set((state) => {
      const chatKey = key(chatId);
      const existing = state.eventsByChat[chatKey] ?? [];
      if (!existing.some((event) => event.id === id)) return state;
      const nextPatch = boundedPatch(patch, existing.find(event => event.id === id)!);
      return {
        eventsByChat: {
          ...state.eventsByChat,
          [chatKey]: existing.map((event) =>
            event.id === id ? { ...event, ...nextPatch, ts: nextPatch.ts ?? event.ts } : event,
          ),
        },
      };
    });
  },
  clearChat(chatId) {
    set((state) => {
      const chatKey = key(chatId);
      if (!state.eventsByChat[chatKey]) return state;
      const { [chatKey]: _removed, ...rest } = state.eventsByChat;
      return { eventsByChat: rest };
    });
  },
}));

export function getChatActivityEvents(chatId: ChatId | string): ChatActivityEvent[] {
  return useChatActivityStore.getState().eventsByChat[key(chatId)] ?? [];
}

export function countUnifiedDiffLines(diff: string): { addedLines: number; removedLines: number } {
  let addedLines = 0;
  let removedLines = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) addedLines += 1;
    else if (line.startsWith('-')) removedLines += 1;
  }
  return { addedLines, removedLines };
}

export function recordChatDiffActivity(args: {
  chatId: ChatId | string;
  filePath: string;
  diff: string;
  title?: string;
  agentSlug?: string;
}): void {
  const counts = countUnifiedDiffLines(args.diff);
  useChatActivityStore.getState().record({
    id: createChatActivityId('diff'),
    chatId: args.chatId,
    kind: 'diff',
    status: 'done',
    title: args.title ?? 'Wrote file',
    subtitle: args.filePath,
    filePath: args.filePath,
    diff: args.diff,
    agentSlug: args.agentSlug,
    ts: Date.now(),
    ...counts,
  });
}

