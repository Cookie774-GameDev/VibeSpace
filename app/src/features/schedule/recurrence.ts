/**
 * Recurrence helpers for the V2 Schedule feature.
 *
 * We encode recurrence as a tiny string code (`daily`, `weekdays`, `weekly`,
 * `biweekly`, `monthly`) stored in the existing `recurrence_rule` column on
 * `EventRow`. The column was originally meant to carry RFC5545 RRULE text;
 * V2 overloads it with these short codes. `parseRecurrence` is tolerant of
 * a few RRULE shapes so existing rows (if any) round-trip into a sensible
 * kind.
 *
 * `expandRecurrence` materialises a single event into its visible instances
 * for a `[fromMs, toMs)` window. It always anchors arithmetic at the
 * original `start_at` so monthly events with day-of-month 31 don't drift
 * forward (Jan 31 → Feb 28 → Mar 31, not Mar 28).
 */
import { addDays, addMonths, differenceInCalendarDays, differenceInCalendarMonths } from 'date-fns';
import type { EventRow } from '@/types/event';

export type RecurrenceKind = 'none' | 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly';

/** Stable list used to render the chip row. Keep in display order. */
export const RECURRENCE_KINDS: RecurrenceKind[] = [
  'none',
  'daily',
  'weekdays',
  'weekly',
  'biweekly',
  'monthly',
];

/**
 * One materialised occurrence of an event. The `event` reference is shared
 * across all instances of the same row (so React keys should combine it
 * with `instanceStartMs`). `isRecurrence` is true for every occurrence
 * other than the original anchor.
 */
export interface RecurrenceInstance {
  event: EventRow;
  /** Unix ms for this occurrence's start. */
  instanceStartMs: number;
  /** Unix ms for this occurrence's end. */
  instanceEndMs: number;
  /** True if this is a generated repeat, not the original anchor row. */
  isRecurrence: boolean;
}

/**
 * Coerce the stored recurrence string into a known kind. Empty / undefined
 * / unrecognised strings collapse to `'none'`.
 */
export function parseRecurrence(s?: string): RecurrenceKind {
  if (!s) return 'none';
  const v = s.trim().toLowerCase();
  switch (v) {
    case '':
    case 'none':
      return 'none';
    case 'daily':
      return 'daily';
    case 'weekdays':
      return 'weekdays';
    case 'weekly':
      return 'weekly';
    case 'biweekly':
    case 'fortnightly':
      return 'biweekly';
    case 'monthly':
      return 'monthly';
    default:
      // Tolerate simple RRULE-shaped strings in case existing rows used them.
      if (v.includes('byday=mo,tu,we,th,fr')) return 'weekdays';
      if (v.includes('freq=daily')) return 'daily';
      if (v.includes('freq=weekly') && v.includes('interval=2')) return 'biweekly';
      if (v.includes('freq=weekly')) return 'weekly';
      if (v.includes('freq=monthly')) return 'monthly';
      return 'none';
  }
}

/** Inverse of parseRecurrence — returns the value to persist (or undefined for 'none'). */
export function serializeRecurrence(k: RecurrenceKind): string | undefined {
  return k === 'none' ? undefined : k;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Hard cap to keep expansion bounded for misbehaving inputs (~1 year of daily). */
const MAX_INSTANCES = 366;

/**
 * Expand `event` into its instances inside `[fromMs, toMs)`. Non-recurring
 * events return at most one (themselves) when their window overlaps;
 * recurring events emit one per occurrence. The returned array is *not*
 * sorted across multiple events — callers that mix series should sort by
 * `instanceStartMs` afterwards.
 */
export function expandRecurrence(
  event: EventRow,
  fromMs: number,
  toMs: number,
): RecurrenceInstance[] {
  if (toMs <= fromMs) return [];

  const kind = parseRecurrence(event.recurrence_rule);
  const duration = Math.max(0, event.end_at - event.start_at);

  if (kind === 'none') {
    if (event.start_at < toMs && event.end_at > fromMs) {
      return [
        {
          event,
          instanceStartMs: event.start_at,
          instanceEndMs: event.end_at,
          isRecurrence: false,
        },
      ];
    }
    return [];
  }

  const out: RecurrenceInstance[] = [];
  const anchor = new Date(event.start_at);

  // Monthly walks index-by-index off the anchor so day-of-month is
  // preserved (Jan 31 → Mar 31 instead of Jan 31 → Feb 28 → Mar 28).
  if (kind === 'monthly') {
    let i = 0;
    if (anchor.getTime() < fromMs) {
      const months = differenceInCalendarMonths(new Date(fromMs), anchor);
      i = Math.max(0, months - 1);
    }
    let count = 0;
    while (count < MAX_INSTANCES) {
      const occur = addMonths(anchor, i);
      const startMs = occur.getTime();
      if (startMs >= toMs) break;
      const endMs = startMs + duration;
      if (endMs > fromMs) {
        out.push({
          event,
          instanceStartMs: startMs,
          instanceEndMs: endMs,
          isRecurrence: startMs !== event.start_at,
        });
      }
      i++;
      count++;
    }
    return out;
  }

  // Daily / weekdays / weekly / biweekly: walk a cursor in calendar units.
  let cursor = new Date(anchor);
  if (cursor.getTime() < fromMs) {
    const daysDiff = differenceInCalendarDays(new Date(fromMs), cursor);
    if (kind === 'daily' || kind === 'weekdays') {
      if (daysDiff > 0) cursor = addDays(cursor, daysDiff);
    } else if (kind === 'weekly') {
      const weeks = Math.floor(daysDiff / 7);
      if (weeks > 0) cursor = addDays(cursor, weeks * 7);
    } else if (kind === 'biweekly') {
      const periods = Math.floor(daysDiff / 14);
      if (periods > 0) cursor = addDays(cursor, periods * 14);
    }
  }

  let count = 0;
  while (cursor.getTime() < toMs && count < MAX_INSTANCES) {
    const startMs = cursor.getTime();
    const endMs = startMs + duration;
    let include = endMs > fromMs;
    if (kind === 'weekdays') {
      const dow = cursor.getDay();
      if (dow === 0 || dow === 6) include = false;
    }
    if (include) {
      out.push({
        event,
        instanceStartMs: startMs,
        instanceEndMs: endMs,
        isRecurrence: startMs !== event.start_at,
      });
    }
    switch (kind) {
      case 'daily':
      case 'weekdays':
        cursor = addDays(cursor, 1);
        break;
      case 'weekly':
        cursor = addDays(cursor, 7);
        break;
      case 'biweekly':
        cursor = addDays(cursor, 14);
        break;
    }
    count++;
  }

  return out;
}

/** Friendly label for a kind — used by the chip row in the modal. */
export function recurrenceLabel(k: RecurrenceKind): string {
  switch (k) {
    case 'none':
      return 'No repeat';
    case 'daily':
      return 'Daily';
    case 'weekdays':
      return 'Weekdays';
    case 'weekly':
      return 'Weekly';
    case 'biweekly':
      return 'Every 2 weeks';
    case 'monthly':
      return 'Monthly';
  }
}
