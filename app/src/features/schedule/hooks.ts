/**
 * Live event subscriptions backed by Dexie. Re-renders whenever the events
 * table changes thanks to `dexie-react-hooks`.
 *
 * V2 adds recurrence-aware feeds (`useUpcomingEvents`, `useTodayEvents`)
 * that materialise repeating series via `expandRecurrence`. Both feeds
 * fetch all events for the workspace and let the helper filter the visible
 * window — recurring anchors can predate the window so a `start_at` index
 * range query alone would miss them.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { endOfDay, startOfDay } from 'date-fns';
import { db } from '@/lib/db';
import type { EventRow } from '@/types/event';
import type { WorkspaceId } from '@/types/common';
import { expandRecurrence, type RecurrenceInstance } from './recurrence';

export interface UseEventsOptions {
  workspaceId: WorkspaceId | null;
  fromMs?: number;
  toMs?: number;
  /** Cap returned rows. Default: no cap. */
  limit?: number;
}

/**
 * Subscribe to raw events in a workspace, optionally bounded by [fromMs, toMs).
 * Always sorted ascending by start_at. This hook does NOT expand recurring
 * series — use `useUpcomingEvents` / `useTodayEvents` for that.
 */
export function useEvents(opts: UseEventsOptions): EventRow[] {
  const { workspaceId, fromMs, toMs, limit } = opts;
  return (
    useLiveQuery(async () => {
      if (!workspaceId) return [] as EventRow[];
      let rows: EventRow[];
      if (fromMs !== undefined && toMs !== undefined) {
        rows = await db.events
          .where('[workspace_id+start_at]')
          .between([workspaceId, fromMs], [workspaceId, toMs], true, false)
          .toArray();
      } else {
        rows = await db.events.where('workspace_id').equals(workspaceId).toArray();
      }
      rows.sort((a, b) => a.start_at - b.start_at);
      return limit ? rows.slice(0, limit) : rows;
    }, [workspaceId, fromMs, toMs, limit]) ?? []
  );
}

/**
 * Upcoming feed — every materialised occurrence in the next `windowMs`.
 * A daily-recurring event therefore lights up `windowMs / 1 day` rows
 * instead of one. Default window is 14 days for a real two-week glance.
 */
export function useUpcomingEvents(
  workspaceId: WorkspaceId | null,
  windowMs = 14 * 24 * 60 * 60 * 1000,
  limit = 50,
): RecurrenceInstance[] {
  return (
    useLiveQuery(async () => {
      if (!workspaceId) return [] as RecurrenceInstance[];
      const fromMs = Date.now();
      const toMs = fromMs + windowMs;
      // Recurring anchors might predate fromMs so we scan the whole
      // workspace. V2 events tables are small (manual entry); revisit if
      // workloads ever push this above a few thousand rows.
      const rows = await db.events.where('workspace_id').equals(workspaceId).toArray();
      const out: RecurrenceInstance[] = [];
      for (const ev of rows) {
        out.push(...expandRecurrence(ev, fromMs, toMs));
      }
      out.sort((a, b) => a.instanceStartMs - b.instanceStartMs);
      return limit ? out.slice(0, limit) : out;
    }, [workspaceId, windowMs, limit]) ?? []
  );
}

/**
 * Events that land inside today's local-time window — including recurrence
 * expansions. The `[start, end]` bounds are computed once when the hook
 * first runs; consumers that stay open across midnight will see stale data
 * until the next render.
 */
export function useTodayEvents(workspaceId: WorkspaceId | null): RecurrenceInstance[] {
  return (
    useLiveQuery(async () => {
      if (!workspaceId) return [] as RecurrenceInstance[];
      const now = new Date();
      const fromMs = startOfDay(now).getTime();
      const toMs = endOfDay(now).getTime();
      const rows = await db.events.where('workspace_id').equals(workspaceId).toArray();
      const out: RecurrenceInstance[] = [];
      for (const ev of rows) {
        out.push(...expandRecurrence(ev, fromMs, toMs));
      }
      out.sort((a, b) => a.instanceStartMs - b.instanceStartMs);
      return out;
    }, [workspaceId]) ?? []
  );
}
