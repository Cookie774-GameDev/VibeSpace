import type {
  Reminder,
  Task,
  TaskPriority,
  QuietHours,
  NotificationChannel,
} from '@/types/task';
import { newReminderId } from '@/lib/ids';

/**
 * Inputs the smart scheduler reads from. All fields except `now` and
 * `quietHours` are optional - the calendar/reminder typing exists for
 * Phase 2 wiring without touching the engine signature.
 */
export interface SchedulerContext {
  /** Wall clock in unix ms - injected for determinism in tests. */
  now: number;
  /** Quiet hours config (read by caller from settingsRepo with fallback). */
  quietHours: QuietHours;
  /**
   * Calendar busy windows (unix-ms ranges). Stubbed at V1; the avoidance
   * heuristic below is wired and ready for the calendar reader to populate.
   */
  calendarBusy?: Array<{ start: number; end: number; label?: string }>;
  /**
   * Reminders already scheduled across other tasks - used to avoid clustering
   * three buzzes inside a 15-minute window.
   */
  existingReminders?: Reminder[];
}

/** Minimum spacing between fired reminders to dodge cluster fatigue. */
const CLUSTER_WINDOW_MS = 15 * 60 * 1000;
/** Step we walk forward when shifting out of a quiet/busy window. */
const SHIFT_STEP_MS = 30 * 60 * 1000;

/**
 * The smart scheduler.
 *
 * Picks 1-3 reminder times for a task based on priority, deadline pressure,
 * quiet hours, and (when populated) calendar / cluster avoidance.
 *
 * Hard rules from the spec:
 *   - Always at least 1 reminder.
 *   - Max 3 for urgent, 2 for high, 1 for normal/low.
 *   - Never inside quiet hours unless task is urgent.
 *   - Every reminder gets a smart_reason string.
 */
export function pickReminderTimes(task: Task, ctx: SchedulerContext): Reminder[] {
  const anchor = task.due_at ?? task.scheduled_for;
  const limit = reminderLimitFor(task.priority);

  // Channel set by priority (default channels per spec section 7).
  const channels = defaultChannelsFor(task.priority);

  // No anchor time -> single soft "today" reminder.
  if (!anchor) {
    const ts = chooseSoftSlot(ctx.now, ctx.quietHours, task.priority);
    return [
      buildReminder(
        task.id,
        ts,
        channels,
        smartReasonForSoft(ts, task.priority),
      ),
    ];
  }

  if (anchor <= ctx.now) {
    // Already due - fire one immediate-ish reminder right now (or next
    // non-quiet moment for non-urgent).
    const ts = task.priority === 'urgent' ? ctx.now : nextNonQuietTime(ctx.now, ctx.quietHours);
    return [
      buildReminder(
        task.id,
        ts,
        channels,
        task.priority === 'urgent'
          ? 'Past due - flagging now because this is urgent.'
          : 'Past due - first window I can reach you.',
      ),
    ];
  }

  // Build candidate offsets (minutes-before-anchor) by priority.
  const offsetsMin = candidateOffsetsMin(task.priority, anchor - ctx.now);

  // Evaluate each candidate, with quiet/calendar/cluster shifts.
  const placed: Reminder[] = [];
  const taken: number[] = [];

  for (const offMin of offsetsMin) {
    const raw = anchor - offMin * 60 * 1000;
    if (raw <= ctx.now) continue;

    const adjusted = adjustSlot(raw, anchor, task.priority, ctx, taken);
    if (adjusted === null) continue;

    placed.push(
      buildReminder(
        task.id,
        adjusted,
        channels,
        smartReasonForOffset(adjusted, anchor, task.priority),
      ),
    );
    taken.push(adjusted);
    if (placed.length >= limit) break;
  }

  // Floor: if nothing made it past the filters, schedule one fallback.
  if (placed.length === 0) {
    const fallback = task.priority === 'urgent'
      ? Math.max(ctx.now + 60_000, anchor - 30 * 60 * 1000)
      : nextNonQuietTime(Math.max(ctx.now + 60_000, anchor - 60 * 60 * 1000), ctx.quietHours);
    if (fallback < anchor) {
      placed.push(
        buildReminder(
          task.id,
          fallback,
          channels,
          'Backup reminder - quiet hours pushed all earlier slots.',
        ),
      );
    } else {
      // Last resort: 1 minute before deadline.
      placed.push(
        buildReminder(
          task.id,
          Math.max(ctx.now + 60_000, anchor - 60_000),
          channels,
          'Last-minute reminder.',
        ),
      );
    }
  }

  // Ascending fires_at for nicer DB shape.
  placed.sort((a, b) => a.fires_at - b.fires_at);
  return placed;
}

// ============================================================
// Helpers
// ============================================================

function reminderLimitFor(p: TaskPriority): number {
  if (p === 'urgent') return 3;
  if (p === 'high') return 2;
  return 1;
}

function defaultChannelsFor(p: TaskPriority): NotificationChannel[] {
  if (p === 'urgent') return ['banner', 'in_app', 'voice'];
  if (p === 'high') return ['banner', 'in_app'];
  if (p === 'normal') return ['banner', 'in_app'];
  return ['in_app'];
}

/**
 * Deadline pressure curve - returns offset minutes-before-anchor.
 *
 * urgent:  24h, 4h, 30min before (3 reminders)
 * high:    24h, 1h before (2 reminders)
 * normal:  1h before (1 reminder)
 * low:     30min before (1 reminder)
 *
 * Filtered by available time so we never schedule "24h before" if the
 * task was added 2 hours before deadline.
 */
function candidateOffsetsMin(p: TaskPriority, msUntilAnchor: number): number[] {
  const minUntil = msUntilAnchor / 60_000;
  let offs: number[];
  if (p === 'urgent') offs = [24 * 60, 4 * 60, 30];
  else if (p === 'high') offs = [24 * 60, 60];
  else if (p === 'normal') offs = [60];
  else offs = [30];
  return offs.filter((m) => m < minUntil);
}

/**
 * Slot adjustment pipeline:
 *   1. Out-of-quiet-hours (skip filter for urgent).
 *   2. Out-of-calendar-busy.
 *   3. Cluster avoidance vs already-taken slots.
 *
 * Returns adjusted ts or null if the slot can't be honored before deadline.
 */
function adjustSlot(
  raw: number,
  anchor: number,
  priority: TaskPriority,
  ctx: SchedulerContext,
  taken: number[],
): number | null {
  let ts = raw;

  if (priority !== 'urgent' && isQuietHour(ts, ctx.quietHours)) {
    ts = nextNonQuietTime(ts, ctx.quietHours);
  }

  if (ctx.calendarBusy && ctx.calendarBusy.length > 0) {
    const busy = ctx.calendarBusy.find((b) => ts >= b.start && ts < b.end);
    if (busy) {
      // Try 5 minutes before busy starts.
      const before = busy.start - 5 * 60 * 1000;
      ts = before > Date.now() ? before : busy.end + 60_000;
    }
  }

  // Cluster: if within 15 min of another taken slot, push earlier 30 min.
  let guard = 0;
  while (taken.some((t) => Math.abs(t - ts) < CLUSTER_WINDOW_MS) && guard < 8) {
    ts -= SHIFT_STEP_MS;
    guard++;
  }

  if (ts >= anchor) return null;
  if (ts <= ctx.now) return null;
  return ts;
}

/**
 * Quiet-hours predicate. Honors:
 *   - Disabled → never quiet
 *   - full_day_quiet[dow]  → all 24h quiet for that day
 *   - start_hour/end_hour windows including those crossing midnight
 */
export function isQuietHour(ts: number, q: QuietHours): boolean {
  if (!q.enabled) return false;
  const d = new Date(ts);
  const dow = d.getDay();
  if (q.full_day_quiet?.[dow]) return true;
  const h = d.getHours();
  if (q.start_hour <= q.end_hour) {
    return h >= q.start_hour && h < q.end_hour;
  }
  // Crosses midnight (e.g. 22 -> 8)
  return h >= q.start_hour || h < q.end_hour;
}

/**
 * Step forward in 30-minute increments until we exit quiet hours.
 * Capped at 48h of stepping so a misconfigured all-quiet schedule
 * can never infinite-loop.
 */
export function nextNonQuietTime(ts: number, q: QuietHours): number {
  if (!q.enabled || !isQuietHour(ts, q)) return ts;
  let cur = ts;
  for (let i = 0; i < 96; i++) {
    cur += SHIFT_STEP_MS;
    if (!isQuietHour(cur, q)) return cur;
  }
  return ts;
}

/**
 * For tasks without a hard anchor, pick a sensible "soft" reminder time:
 *   - urgent: 30 minutes from now
 *   - high:   2 hours from now (or next non-quiet)
 *   - else:   tomorrow at 9am, snapped past quiet hours
 */
function chooseSoftSlot(now: number, q: QuietHours, p: TaskPriority): number {
  if (p === 'urgent') return now + 30 * 60 * 1000;
  const candidate = p === 'high' ? now + 2 * 60 * 60 * 1000 : nextMorning9am(now);
  return nextNonQuietTime(candidate, q);
}

function nextMorning9am(ts: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

// ============================================================
// Smart-reason templating
// ============================================================

function smartReasonForOffset(fires: number, anchor: number, priority: TaskPriority): string {
  const offsetMs = anchor - fires;
  const offsetMin = Math.round(offsetMs / 60_000);
  const offsetHr = offsetMs / 3_600_000;

  if (offsetHr >= 23.5) {
    const days = Math.round(offsetHr / 24);
    return days === 1
      ? 'A day ahead of your deadline so you can plan it in.'
      : `${days} days ahead of your deadline so you can plan it in.`;
  }
  if (offsetHr >= 3.5) {
    return `${Math.round(offsetHr)}h before deadline so there's room to actually do it.`;
  }
  if (offsetHr >= 1.5) {
    return `${Math.round(offsetHr)}h before deadline.`;
  }
  if (offsetMin >= 45) {
    return priority === 'urgent' ? 'One hour out - sprint window.' : '1 hour before deadline.';
  }
  if (offsetMin >= 25) {
    return `${offsetMin} min before deadline.`;
  }
  return 'Quick heads up just before deadline.';
}

function smartReasonForSoft(ts: number, priority: TaskPriority): string {
  const d = new Date(ts);
  const clock = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (priority === 'urgent') return `Pinging you at ${clock} - flagged urgent without a hard deadline.`;
  if (priority === 'high') return `Coming back to this around ${clock} since it's high priority.`;
  return `Setting this for ${clock} - no hard deadline so picking a calm window.`;
}

function buildReminder(
  taskId: Task['id'],
  fires_at: number,
  channels: NotificationChannel[],
  smart_reason: string,
): Reminder {
  return {
    id: newReminderId(),
    task_id: taskId,
    fires_at,
    channels,
    status: 'scheduled',
    snooze_history: [],
    smart_reason,
  };
}
