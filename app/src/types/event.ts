import type {
  ContextRef,
  EventId,
  ProjectId,
  Timestamped,
  WorkspaceId,
} from './common';

/**
 * Schedule events.
 *
 * One row in the `events` table. An event has a definite time window
 * (start/end) and lives inside a workspace. Reminders fire via the
 * existing NotificationEngine; the `voice` channel uses Web Speech to
 * speak the reminder out loud.
 *
 * `source_ref` carries provider-specific identifiers when the event
 * mirrors a Google Calendar / extracted-from-chat / voice-dictated
 * origin. Conflict resolution (Plan B2 §4.7) compares Google `etag`.
 */

/** Lifecycle status. */
export type EventStatus = 'scheduled' | 'tentative' | 'cancelled' | 'done';

/** Where the event was created from. */
export type EventSource = 'manual' | 'voice' | 'ai' | 'google' | 'extracted';

/** Reminder delivery channel. Mirrors NotificationChannel for consistency. */
export type EventChannel = 'desktop' | 'in_app' | 'voice';

export interface EventAttendee {
  name: string;
  email?: string;
  status?: 'pending' | 'accepted' | 'declined';
}

export interface EventReminder {
  /** Minutes before start_at to fire. */
  offset_min: number;
  /** Channels to deliver on. */
  channels: EventChannel[];
}

export interface EventSourceRef {
  /** Google Calendar event id (if source='google'). */
  google_event_id?: string;
  /** Google etag for conflict detection. */
  etag?: string;
  /** Google calendar id (default: 'primary'). */
  calendar_id?: string;
  /** Generic provenance (chat, voice, etc) when source != 'google'. */
  context?: ContextRef;
}

export type EventRow = {
  id: EventId;
  workspace_id: WorkspaceId;
  project_id?: ProjectId;
  title: string;
  description?: string;
  /** Unix ms. */
  start_at: number;
  /** Unix ms. */
  end_at: number;
  all_day: boolean;
  /** IANA tz, e.g. 'America/New_York'. */
  timezone: string;
  location?: string;
  attendees: EventAttendee[];
  source: EventSource;
  source_ref?: EventSourceRef;
  /** RFC5545 RRULE; V2 only renders next instance. */
  recurrence_rule?: string;
  reminders: EventReminder[];
  status: EventStatus;
  /** HSL hue 0..359 for UI tinting. */
  color_hue?: number;
  /** `usr_*` or `agt_*` who created this row. */
  created_by: string;
} & Timestamped;

/**
 * Helper - inputs for creating an event. Fills in sensible defaults at the
 * repo layer (status='scheduled', all_day=false, timezone=local, source='manual').
 */
export type EventInput = Pick<EventRow, 'workspace_id' | 'title' | 'start_at' | 'end_at'> &
  Partial<Omit<EventRow, 'id' | 'created_at' | 'updated_at' | 'reminders' | 'attendees'>> & {
    reminders?: EventReminder[];
    attendees?: EventAttendee[];
  };
