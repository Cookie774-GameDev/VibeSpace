import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { nanoid } from 'nanoid';
import { safeLocalStorage } from '@/lib/persistence/safeLocalStorage';

export const CLOCK_SOUNDS = ['chime', 'pulse', 'soft'] as const;
export type ClockSound = (typeof CLOCK_SOUNDS)[number];

export type ClockEntryKind = 'timer' | 'alarm';
export type ClockEntryStatus = 'scheduled' | 'fired' | 'cancelled';

export interface ClockEntry {
  id: string;
  kind: ClockEntryKind;
  label: string;
  dueAt: number;
  createdAt: number;
  status: ClockEntryStatus;
  sound: ClockSound;
  durationMs?: number;
  firedAt?: number;
}

interface ClockStoreState {
  entries: ClockEntry[];
  createTimer: (input: { durationMs: number; label?: string; sound?: ClockSound; now?: number }) => ClockEntry;
  createAlarm: (input: { dueAt: number; label?: string; sound?: ClockSound; now?: number }) => ClockEntry;
  cancel: (id: string) => boolean;
  cancelAllScheduled: () => number;
  clearCompleted: () => number;
  markFired: (id: string, firedAt?: number) => ClockEntry | null;
  scheduled: () => ClockEntry[];
  completed: () => ClockEntry[];
}

const MIN_DURATION_MS = 1_000;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeLabel(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function normalizeSound(value: ClockSound | undefined): ClockSound {
  return value && CLOCK_SOUNDS.includes(value) ? value : 'chime';
}

export function clampTimerDurationMs(durationMs: number): number {
  if (!Number.isFinite(durationMs)) return MIN_DURATION_MS;
  return Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, Math.round(durationMs)));
}

export function parseAlarmTime(input: string, now = Date.now()): number | null {
  const raw = input.trim();
  if (!raw) return null;

  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > now) return numeric;

  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed) && parsed > now) return parsed;

  const match = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const period = match[3]?.toLowerCase();
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (period) {
    if (hour < 1 || hour > 12) return null;
    if (period === 'pm' && hour !== 12) hour += 12;
    if (period === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }

  const date = new Date(now);
  date.setHours(hour, minute, 0, 0);
  if (date.getTime() <= now) date.setDate(date.getDate() + 1);
  return date.getTime();
}

export function formatClockRemaining(dueAt: number, now = Date.now()): string {
  const remaining = Math.max(0, dueAt - now);
  const totalSeconds = Math.ceil(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  return `${seconds}s`;
}

export const useClockStore = create<ClockStoreState>()(
  persist(
    (set, get) => ({
      entries: [],

      createTimer: ({ durationMs, label, sound, now = Date.now() }) => {
        const safeDuration = clampTimerDurationMs(durationMs);
        const entry: ClockEntry = {
          id: `clock_${nanoid(10)}`,
          kind: 'timer',
          label: normalizeLabel(label, 'Timer'),
          dueAt: now + safeDuration,
          createdAt: now,
          status: 'scheduled',
          sound: normalizeSound(sound),
          durationMs: safeDuration,
        };
        set((state) => ({ entries: [entry, ...state.entries].slice(0, 100) }));
        return entry;
      },

      createAlarm: ({ dueAt, label, sound, now = Date.now() }) => {
        if (!Number.isFinite(dueAt) || dueAt <= now) {
          throw new Error('Alarm time must be in the future.');
        }
        const entry: ClockEntry = {
          id: `clock_${nanoid(10)}`,
          kind: 'alarm',
          label: normalizeLabel(label, 'Alarm'),
          dueAt: Math.round(dueAt),
          createdAt: now,
          status: 'scheduled',
          sound: normalizeSound(sound),
        };
        set((state) => ({ entries: [entry, ...state.entries].slice(0, 100) }));
        return entry;
      },

      cancel: (id) => {
        let changed = false;
        set((state) => ({
          entries: state.entries.map((entry) => {
            if (entry.id !== id || entry.status !== 'scheduled') return entry;
            changed = true;
            return { ...entry, status: 'cancelled' };
          }),
        }));
        return changed;
      },

      cancelAllScheduled: () => {
        let count = 0;
        set((state) => ({
          entries: state.entries.map((entry) => {
            if (entry.status !== 'scheduled') return entry;
            count += 1;
            return { ...entry, status: 'cancelled' };
          }),
        }));
        return count;
      },

      clearCompleted: () => {
        const before = get().entries.length;
        set((state) => ({ entries: state.entries.filter((entry) => entry.status === 'scheduled') }));
        return before - get().entries.length;
      },

      markFired: (id, firedAt = Date.now()) => {
        let fired: ClockEntry | null = null;
        set((state) => ({
          entries: state.entries.map((entry) => {
            if (entry.id !== id || entry.status !== 'scheduled') return entry;
            fired = { ...entry, status: 'fired', firedAt };
            return fired;
          }),
        }));
        return fired;
      },

      scheduled: () =>
        get()
          .entries.filter((entry) => entry.status === 'scheduled')
          .sort((a, b) => a.dueAt - b.dueAt),

      completed: () =>
        get()
          .entries.filter((entry) => entry.status !== 'scheduled')
          .sort((a, b) => (b.firedAt ?? b.createdAt) - (a.firedAt ?? a.createdAt)),
    }),
    {
      name: 'jarvis-clock',
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (state) => ({ entries: state.entries }),
      version: 1,
    },
  ),
);
