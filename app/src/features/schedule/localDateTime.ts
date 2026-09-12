/**
 * Local OS clock helpers for schedule date/time fields.
 * Uses the device timezone (Windows / macOS / Linux) — never UTC offsets in UI.
 * Display hour cycle follows Settings → Ambient → Time format (presentation only).
 */
import { formatUserDateTime, formatUserTime } from '@/lib/timeFormat';

/** IANA timezone from the OS, e.g. `America/New_York`. */
export function getLocalTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local time';
  } catch {
    return 'Local time';
  }
}

/** `datetime-local` value from epoch ms in local time. */
export function toLocalDateTimeInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parse `datetime-local` as local wall-clock (not UTC). */
export function fromLocalDateTimeInput(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return Number.NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  if ([year, month, day, hours, minutes].some((n) => Number.isNaN(n))) return Number.NaN;
  return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime();
}

/** Local calendar day key `YYYY-MM-DD`. */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Start of local day for epoch ms. */
export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Human label for a local day: Today, Tomorrow, or weekday date. */
export function formatLocalDayHeading(ms: number, now = Date.now()): string {
  const dayStart = startOfLocalDay(ms);
  const todayStart = startOfLocalDay(now);
  const diffDays = Math.round((dayStart - todayStart) / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays === -1) return 'Yesterday';
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

export function formatLocalDateTime(ms: number): string {
  return formatUserDateTime(ms, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function formatLocalTime(ms: number): string {
  return formatUserTime(ms);
}

export function formatLocalEventRange(
  startMs: number,
  endMs: number,
  allDay: boolean,
): string {
  if (allDay) {
    return `${new Date(startMs).toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })} · All day`;
  }
  const sameDay = localDayKey(startMs) === localDayKey(endMs);
  if (sameDay) {
    return `${formatLocalDateTime(startMs)} – ${formatLocalTime(endMs)}`;
  }
  return `${formatLocalDateTime(startMs)} – ${formatLocalDateTime(endMs)}`;
}

/** Default event start: next whole local hour from now. */
export function defaultEventStartMs(now = Date.now()): number {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d.getTime();
}

export function defaultEventEndMs(startMs: number): number {
  return startMs + 60 * 60 * 1000;
}
