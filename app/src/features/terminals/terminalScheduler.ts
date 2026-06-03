import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { enqueueTerminalCommand } from './terminalCommandQueue';
import type { TerminalRef } from './terminalRefs';
import { terminalRefLabel } from './terminalRefs';
import { useUIStore } from '@/stores/ui';

export interface ScheduledTerminalMessage {
  id: string;
  refs: TerminalRef[];
  command: string;
  runAt: number;
  createdAt: number;
  status: 'pending' | 'sent' | 'failed';
  lastError?: string;
}

interface TerminalSchedulerState {
  messages: ScheduledTerminalMessage[];
  schedule: (input: { refs: TerminalRef[]; command: string; runAt: number }) => string;
  markSent: (id: string) => void;
  markFailed: (id: string, error: string) => void;
  pending: () => ScheduledTerminalMessage[];
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function newId(): string {
  return `tsch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const useTerminalSchedulerStore = create<TerminalSchedulerState>()(
  persist(
    (set, get) => ({
      messages: [],
      schedule: ({ refs, command, runAt }) => {
        const id = newId();
        const msg: ScheduledTerminalMessage = {
          id,
          refs,
          command,
          runAt,
          createdAt: Date.now(),
          status: 'pending',
        };
        set((state) => ({ messages: [...state.messages, msg] }));
        armTerminalMessage(msg);
        return id;
      },
      markSent: (id) => set((state) => ({
        messages: state.messages.map((m) => (m.id === id ? { ...m, status: 'sent', lastError: undefined } : m)),
      })),
      markFailed: (id, error) => set((state) => ({
        messages: state.messages.map((m) => (m.id === id ? { ...m, status: 'failed', lastError: error } : m)),
      })),
      pending: () => get().messages.filter((m) => m.status === 'pending'),
    }),
    { name: 'jarvis-terminal-scheduler-v1' },
  ),
);

export function scheduleTerminalCommandFromChat(refs: TerminalRef[], command: string, runAt: number): string {
  return useTerminalSchedulerStore.getState().schedule({ refs, command, runAt });
}

export function initTerminalScheduler(): () => void {
  const rearm = () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const msg of useTerminalSchedulerStore.getState().pending()) armTerminalMessage(msg);
  };
  rearm();
  const unsub = useTerminalSchedulerStore.subscribe(rearm);
  return () => {
    unsub();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}

const WORD_NUMBERS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
};

function parseScheduleAmount(raw: string): number {
  const normalized = raw.trim().toLowerCase().replace(/-/g, ' ');
  if (/^\d+$/.test(normalized)) return Number(normalized);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return Number.NaN;
  let total = 0;
  for (const token of tokens) {
    const value = WORD_NUMBERS[token];
    if (value === undefined) return Number.NaN;
    total += value;
  }
  return total;
}

function fallbackTerminalCheckIn(): string {
  return 'echo "Jarvis scheduled check-in for this terminal."';
}

function armTerminalMessage(msg: ScheduledTerminalMessage): void {
  if (timers.has(msg.id)) return;
  const delay = Math.max(0, msg.runAt - Date.now());
  const timer = setTimeout(() => fireTerminalMessage(msg.id), delay);
  timers.set(msg.id, timer);
}

function fireTerminalMessage(id: string): void {
  timers.delete(id);
  const store = useTerminalSchedulerStore.getState();
  const msg = store.messages.find((m) => m.id === id);
  if (!msg || msg.status !== 'pending') return;
  try {
    enqueueTerminalCommand({
      command: msg.command,
      label: `scheduled: ${terminalRefLabel(msg.refs[0] ?? {})}`,
      target: 'refs',
      refs: msg.refs,
    });
    useUIStore.getState().setRoute('terminal');
    store.markSent(id);
  } catch (err) {
    store.markFailed(id, err instanceof Error ? err.message : String(err));
  }
}

export function parseTerminalScheduleRequest(text: string): { command: string; runAt: number } | null {
  const trimmed = text.trim();
  const relative = /^(?:send|tell|message|write)(?:\s+(?:this|the|that)\s+terminal)?(?:\s+(.+?))?\s+in\s+([a-z0-9 -]+?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)$/i.exec(trimmed);
  if (relative) {
    const command = relative[1]?.trim() || fallbackTerminalCheckIn();
    const amount = parseScheduleAmount(relative[2] ?? '');
    const unit = (relative[3] ?? '').toLowerCase();
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const mult = unit.startsWith('hour') || unit.startsWith('hr') ? 60 * 60 * 1000 : unit.startsWith('min') ? 60 * 1000 : 1000;
    return { command, runAt: Date.now() + amount * mult };
  }
  const at = /^(?:send|tell|message|write)(?:\s+(?:this|the|that)\s+terminal)?(?:\s+(.+?))?\s+at\s+(.+)$/i.exec(trimmed);
  if (at) {
    const command = at[1]?.trim() || fallbackTerminalCheckIn();
    const when = Date.parse(at[2]?.trim() ?? '');
    if (!Number.isFinite(when)) return null;
    return { command, runAt: when };
  }
  return null;
}
