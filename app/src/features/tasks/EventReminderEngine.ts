import { eventRepo } from '@/lib/db/repositories';
import { notifyDone } from '@/lib/notifications';
import { expandRecurrence } from '@/features/schedule/recurrence';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { toast } from '@/components/ui/toast';
import type { EventReminder, EventRow } from '@/types/event';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const MAX_OFFSET_MIN = 7 * 24 * 60;
const CLAIM_MS = 2 * MINUTE_MS;
const activeDeliveries = new Set<string>();

type DueReminder = Readonly<{
  event: EventRow;
  index: number;
  occurrenceStartAt: number;
}>;

function validOffset(reminder: EventReminder): boolean {
  return (
    Number.isSafeInteger(reminder.offset_min) &&
    reminder.offset_min >= 0 &&
    reminder.offset_min <= MAX_OFFSET_MIN
  );
}

function dueReminders(event: EventRow, now: number): DueReminder[] {
  if (event.status !== 'scheduled' || !event.reminders?.length) return [];
  const maxOffset = Math.max(0, ...event.reminders.filter(validOffset).map((r) => r.offset_min));
  const result: DueReminder[] = [];
  for (const occurrence of expandRecurrence(
    event,
    now - DAY_MS,
    now + maxOffset * MINUTE_MS + 1,
  )) {
    event.reminders.forEach((reminder, index) => {
      if (!validOffset(reminder)) return;
      const dueAt = occurrence.instanceStartMs - reminder.offset_min * MINUTE_MS;
      if (
        dueAt <= now &&
        dueAt >= now - DAY_MS &&
        (reminder.last_fired_start_at === undefined ||
          reminder.last_fired_start_at < occurrence.instanceStartMs)
      ) {
        result.push({ event, index, occurrenceStartAt: occurrence.instanceStartMs });
      }
    });
  }
  return result.sort(
    (left, right) =>
      left.occurrenceStartAt - right.occurrenceStartAt || left.index - right.index,
  );
}

function sameReminderScope(
  current: EventRow,
  due: DueReminder,
  expectedWorkspaceId: EventRow['workspace_id'],
): boolean {
  const original = due.event.reminders[due.index];
  const reminder = current.reminders[due.index];
  return (
    current.workspace_id === expectedWorkspaceId &&
    current.status === 'scheduled' &&
    current.start_at === due.event.start_at &&
    current.end_at === due.event.end_at &&
    current.recurrence_rule === due.event.recurrence_rule &&
    !!original &&
    !!reminder &&
    validOffset(reminder) &&
    reminder.offset_min === original.offset_min &&
    JSON.stringify(reminder.channels) === JSON.stringify(original.channels) &&
    (reminder.last_fired_start_at === undefined ||
      reminder.last_fired_start_at < due.occurrenceStartAt)
  );
}

function ownsClaim(reminder: EventReminder | undefined, claimId: string, due: DueReminder): boolean {
  return (
    reminder?.delivery_claim?.id === claimId &&
    reminder.delivery_claim.occurrence_start_at === due.occurrenceStartAt
  );
}

async function claimReminder(
  due: DueReminder,
  workspaceId: EventRow['workspace_id'],
  now: number,
  claimId: string,
): Promise<boolean> {
  const current = await eventRepo.getById(due.event.id);
  if (
    !current ||
    !sameReminderScope(current, due, workspaceId) ||
    useAuthStore.getState().workspaceId !== workspaceId ||
    (current.reminders[due.index]?.delivery_claim?.expires_at ?? 0) > now
  ) {
    return false;
  }
  const claimed = await eventRepo.updateIfUpdatedAt(due.event.id, current.updated_at, (fresh) => {
    if (
      !sameReminderScope(fresh, due, workspaceId) ||
      (fresh.reminders[due.index]?.delivery_claim?.expires_at ?? 0) > now ||
      useAuthStore.getState().workspaceId !== workspaceId
    ) {
      return undefined;
    }
    return {
      reminders: fresh.reminders.map((reminder, index) =>
        index === due.index
          ? {
              ...reminder,
              delivery_claim: {
                id: claimId,
                occurrence_start_at: due.occurrenceStartAt,
                claimed_at: now,
                expires_at: now + CLAIM_MS,
              },
            }
          : reminder,
      ),
    };
  });
  return !!claimed;
}

async function readClaim(
  due: DueReminder,
  workspaceId: EventRow['workspace_id'],
  claimId: string,
): Promise<{ event: EventRow; reminder: EventReminder }> {
  const event = await eventRepo.getById(due.event.id);
  const reminder = event?.reminders[due.index];
  if (
    !event ||
    !reminder ||
    !sameReminderScope(event, due, workspaceId) ||
    !ownsClaim(reminder, claimId, due) ||
    useAuthStore.getState().workspaceId !== workspaceId
  ) {
    throw new Error('Event reminder delivery scope changed');
  }
  return { event, reminder };
}

async function releaseClaim(
  due: DueReminder,
  workspaceId: EventRow['workspace_id'],
  claimId: string,
): Promise<void> {
  try {
    const current = await eventRepo.getById(due.event.id);
    if (!current || !ownsClaim(current.reminders[due.index], claimId, due)) return;
    await eventRepo.updateIfUpdatedAt(due.event.id, current.updated_at, (fresh) => {
      if (
        fresh.workspace_id !== workspaceId ||
        !ownsClaim(fresh.reminders[due.index], claimId, due)
      ) {
        return undefined;
      }
      return {
        reminders: fresh.reminders.map((reminder, index) => {
          if (index !== due.index) return reminder;
          const { delivery_claim: _claim, ...released } = reminder;
          return released;
        }),
      };
    });
  } catch {
    // An expired persisted claim is retryable after a transient write failure.
  }
}

async function finalizeClaim(
  due: DueReminder,
  workspaceId: EventRow['workspace_id'],
  claimId: string,
): Promise<boolean> {
  const current = await eventRepo.getById(due.event.id);
  if (!current || !ownsClaim(current.reminders[due.index], claimId, due)) return false;
  const finalized = await eventRepo.updateIfUpdatedAt(due.event.id, current.updated_at, (fresh) => {
    if (
      fresh.workspace_id !== workspaceId ||
      !ownsClaim(fresh.reminders[due.index], claimId, due)
    ) {
      return undefined;
    }
    return {
      reminders: fresh.reminders.map((reminder, index) => {
        if (index !== due.index) return reminder;
        const { delivery_claim: _claim, ...rest } = reminder;
        return { ...rest, last_fired_start_at: due.occurrenceStartAt };
      }),
    };
  });
  return !!finalized;
}

async function deliver(
  due: DueReminder,
  workspaceId: EventRow['workspace_id'],
  claimId: string,
): Promise<void> {
  const { event, reminder } = await readClaim(due, workspaceId, claimId);
  const body =
    reminder.offset_min === 0
      ? 'Event starts now'
      : `Event starts in ${reminder.offset_min} minute${reminder.offset_min === 1 ? '' : 's'}`;
  const channels = new Set(reminder.channels);
  if (channels.has('desktop')) {
    const ui = useUIStore.getState();
    if (ui.notificationMaster && ui.doneNotifications.reminders) {
      const result = await notifyDone('reminders', event.title, body, {
        completionIdentity: `event-reminder:${event.id}:${due.occurrenceStartAt}:${due.index}`,
      });
      // A desktop-only attempt with no delivery must remain retryable.
      // Combined reminders may still complete through their in-app channel.
      if (result?.channel === 'none' && result.permission !== 'granted' && !channels.has('in_app')) {
        throw new Error('event_reminder_delivery_unavailable');
      }
    }
  }
  if (channels.has('in_app')) {
    const current = await readClaim(due, workspaceId, claimId);
    toast.info(current.event.title, body, 6000);
  }
}

function defaultClaimId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `event-reminder-${Date.now()}-${Math.random()}`;
}

/** Polls manual calendar event reminders, including concrete recurring occurrences. */
export async function pollEventReminders(
  now: number = Date.now(),
  createClaimId: () => string = defaultClaimId,
): Promise<number> {
  const workspaceId = useAuthStore.getState().workspaceId;
  if (!workspaceId) return 0;
  const events = await eventRepo.listByWorkspace(workspaceId);
  let fired = 0;
  for (const event of events) {
    for (const due of dueReminders(event, now)) {
      const activeKey = `${event.id}:${due.index}:${due.occurrenceStartAt}`;
      if (activeDeliveries.has(activeKey)) continue;
      activeDeliveries.add(activeKey);
      const claimId = createClaimId();
      let delivered = false;
      try {
        if (!(await claimReminder(due, workspaceId, now, claimId))) continue;
        await deliver(due, workspaceId, claimId);
        delivered = true;
        if (await finalizeClaim(due, workspaceId, claimId)) fired += 1;
      } catch {
        if (!delivered) await releaseClaim(due, workspaceId, claimId);
        console.warn('[EventReminderEngine] delivery attempt failed');
      } finally {
        activeDeliveries.delete(activeKey);
      }
    }
  }
  return fired;
}
