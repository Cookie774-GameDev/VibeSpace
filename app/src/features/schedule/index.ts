/**
 * V2 — Schedule.
 *
 * Lightweight schedule view: an upcoming feed for the next 7 days, plus an
 * "Add event" dialog. Events live in the V2 events table (see B2 §4 plan)
 * and surface in the AmbientHome glance card and (later) Google Calendar
 * sync.
 *
 * V2 keeps it minimal:
 *   - No drag-to-reschedule (planned for V3 with DayGrid)
 *   - No recurrence rule editor (just a toggle for daily / weekly)
 *   - Reminder list is editable but uses preset offsets (none/5/15/60 min)
 *
 * Render path: mounted as a Dialog from anywhere via
 * `useUIStore.scheduleOpen`. Two tabs inside: "Upcoming" and "Add event".
 */

export { ScheduleModal } from './ScheduleModal';
export { useEvents, useUpcomingEvents } from './hooks';
export { parseEventInput } from './parseEventInput';
