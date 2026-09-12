import * as React from 'react';
import { useJarvisTaskRunStore } from '@/features/jarvis-runs/taskRunStore';
import { useChatActivityStore } from './activityStore';
import type { ChatActivityEvent } from './types';

const EMPTY: readonly ChatActivityEvent[] = Object.freeze([]);
const MAX_UNIFIED_EVENTS = 500;

export function mergeChatActivityEvents(
  canonical: readonly ChatActivityEvent[],
  live: readonly ChatActivityEvent[],
): ChatActivityEvent[] {
  const byId = new Map<string, ChatActivityEvent>();
  for (const event of canonical) byId.set(event.id, event);
  for (const event of live) {
    const existing = byId.get(event.id);
    if (!existing || event.ts >= existing.ts) byId.set(event.id, event);
  }
  return [...byId.values()]
    .sort((left, right) => left.ts - right.ts || left.id.localeCompare(right.id))
    .slice(-MAX_UNIFIED_EVENTS);
}

export function useUnifiedChatActivity(chatId: string): readonly ChatActivityEvent[] {
  const canonical = useJarvisTaskRunStore((state) => state.activityByChat[chatId] ?? EMPTY);
  const live = useChatActivityStore((state) => state.eventsByChat[chatId] ?? EMPTY);
  return React.useMemo(() => mergeChatActivityEvents(canonical, live), [canonical, live]);
}
