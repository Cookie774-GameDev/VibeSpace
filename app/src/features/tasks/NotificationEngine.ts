import { reminderClaimRepo, taskRepo } from '@/lib/db/repositories';
import { useAuthStore } from '@/stores/auth';
import { requestNotificationPermission } from '@/lib/tauri';
import { toast } from '@/components/ui/toast';
import { notifyDone } from '@/lib/notifications';
import { useUIStore } from '@/stores/ui';
import type { Reminder, Task } from '@/types/task';

/**
 * The notification engine.
 *
 * - Polls scheduled reminders every 30 seconds.
 * - When a reminder's fires_at <= now, dispatches via:
 *     (1) native/browser notification banner
 *     (2) in-app toast when the reminder includes the in_app channel
 *     (3) the `jarvis:reminder` custom event (for the rest of the app
 *         to react - e.g., voice service speaks the reminder).
 *
 * Permission flow is non-blocking: we ask only when the first reminder
 * is being delivered, never at boot.
 *
 * Native/browser delivery is centralized through `lib/tauri.notify` so tasks,
 * clock alerts, and future update reminders use the same Tauri v2 command path.
 */

const POLL_INTERVAL_MS = 30 * 1000;
const REMINDER_DELIVERY_CLAIM_MS = 2 * 60 * 1000;
let runningInstanceId = 0;
const activeReminderDeliveries = new Set<string>();

/** Detail payload for the `jarvis:reminder` window event. */
export interface JarvisReminderEventDetail {
  task: Task;
  reminder: Reminder;
}

declare global {
  interface WindowEventMap {
    'jarvis:reminder': CustomEvent<JarvisReminderEventDetail>;
  }
}

/**
 * Start the polling loop. Returns a `stop()` function that halts it
 * and is safe to call multiple times.
 */
export function startNotificationLoop(): () => void {
  const myInstance = ++runningInstanceId;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = async () => {
    if (stopped || myInstance !== runningInstanceId) return;
    try {
      await pollOnce();
    } catch (err) {
      // Never crash the loop on transient repo failures.
      // eslint-disable-next-line no-console
      console.warn('[NotificationEngine] tick failed', err);
    }
  };

  // Fire immediately on start, then on the interval.
  void tick();
  timer = setInterval(tick, POLL_INTERVAL_MS);

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
}

/**
 * Run one pass over open tasks and deliver any reminders whose
 * `fires_at` has passed. Exported for tests.
 */
export async function pollOnce(
  now: number = Date.now(),
  createClaimId: () => string = defaultClaimId,
): Promise<number> {
  const workspaceId = useAuthStore.getState().workspaceId;
  if (!workspaceId) return 0;

  const tasks = await taskRepo.listOpen(workspaceId);
  let fired = 0;

  for (const task of tasks) {
    if (!task.reminders || task.reminders.length === 0) continue;
    const due = task.reminders.filter(
      (r) =>
        r.status === 'scheduled' &&
        r.fires_at <= now &&
        (!r.delivery_claim || r.delivery_claim.expires_at <= now),
    );
    if (due.length === 0) continue;

    for (const reminder of due) {
      const activeKey = `${task.id}:${reminder.id}`;
      if (activeReminderDeliveries.has(activeKey)) continue;
      activeReminderDeliveries.add(activeKey);
      try {
        fired += await claimAndDeliverReminder(
          task.id,
          reminder.id,
          workspaceId,
          now,
          createClaimId(),
        );
      } finally {
        activeReminderDeliveries.delete(activeKey);
      }
    }
  }

  return fired;
}

function defaultClaimId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `reminder-${Date.now()}-${Math.random()}`;
}

function ownsClaim(reminder: Reminder | undefined, claimId: string): reminder is Reminder {
  return reminder?.status === 'scheduled' && reminder.delivery_claim?.id === claimId;
}

async function releaseOwnClaim(
  taskId: Task['id'],
  reminderId: Reminder['id'],
  expectedWorkspaceId: Task['workspace_id'],
  claimId: string,
  now: number,
) {
  try {
    await reminderClaimRepo.release({
      taskId,
      reminderId,
      expectedWorkspaceId,
      getActiveWorkspaceId: () => useAuthStore.getState().workspaceId,
      claimId,
      now,
    });
  } catch {
    // The bounded persisted lease makes a failed release retryable after expiry.
  }
}

async function claimAndDeliverReminder(
  taskId: Task['id'],
  reminderId: Reminder['id'],
  expectedWorkspaceId: Task['workspace_id'],
  now: number,
  claimId: string,
): Promise<number> {
  let deliverySucceeded = false;
  try {
    const claimedTask = await reminderClaimRepo.claim({
      taskId,
      reminderId,
      expectedWorkspaceId,
      getActiveWorkspaceId: () => useAuthStore.getState().workspaceId,
      claimId,
      now,
      expiresAt: now + REMINDER_DELIVERY_CLAIM_MS,
    });
    if (!claimedTask) return 0;

    await deliverReminder(taskId, reminderId, expectedWorkspaceId, claimId);
    deliverySucceeded = true;

    const finalized = await reminderClaimRepo.finalize({
      taskId,
      reminderId,
      expectedWorkspaceId,
      getActiveWorkspaceId: () => useAuthStore.getState().workspaceId,
      claimId,
      now,
    });
    return finalized ? 1 : 0;
  } catch {
    if (!deliverySucceeded) {
      await releaseOwnClaim(taskId, reminderId, expectedWorkspaceId, claimId, now);
    }
    // eslint-disable-next-line no-console
    console.warn('[NotificationEngine] reminder delivery attempt failed');
    return 0;
  }
}

/**
 * Deliver one reminder across the appropriate channels.
 */
async function readDeliverableReminder(
  taskId: Task['id'],
  reminderId: Reminder['id'],
  expectedWorkspaceId: Task['workspace_id'],
  claimId: string,
): Promise<{ task: Task; reminder: Reminder }> {
  const task = await taskRepo.getById(taskId);
  const reminder = task?.reminders.find((candidate) => candidate.id === reminderId);
  if (
    !task ||
    task.workspace_id !== expectedWorkspaceId ||
    useAuthStore.getState().workspaceId !== expectedWorkspaceId ||
    !ownsClaim(reminder, claimId)
  ) {
    throw new Error('Reminder delivery scope changed');
  }
  return { task, reminder };
}

async function deliverReminder(
  taskId: Task['id'],
  reminderId: Reminder['id'],
  expectedWorkspaceId: Task['workspace_id'],
  claimId: string,
): Promise<void> {
  const initial = await readDeliverableReminder(taskId, reminderId, expectedWorkspaceId, claimId);
  const channels = new Set(initial.reminder.channels);

  // Attempt the only rejecting channel before best-effort local effects so a
  // transport failure can retry without duplicating the local event/toast.
  if (channels.has('banner')) {
    const { task, reminder } = await readDeliverableReminder(
      taskId,
      reminderId,
      expectedWorkspaceId,
      claimId,
    );
    const ui = useUIStore.getState();
    if (ui.notificationMaster && ui.doneNotifications.reminders) {
      await notifyDone(
        'reminders',
        task.title,
        reminder.message_override || reminder.smart_reason || 'Reminder',
      );
    }
  }

  // Always emit the in-app event so other features can react.
  if (typeof window !== 'undefined') {
    try {
      const { task, reminder } = await readDeliverableReminder(
        taskId,
        reminderId,
        expectedWorkspaceId,
        claimId,
      );
      window.dispatchEvent(
        new CustomEvent('jarvis:reminder', {
          detail: { task, reminder },
        }),
      );
    } catch {
      /* dispatch should never throw */
    }
  }

  if (channels.has('in_app')) {
    try {
      const { task, reminder } = await readDeliverableReminder(
        taskId,
        reminderId,
        expectedWorkspaceId,
        claimId,
      );
      toast.info(
        task.title,
        reminder.message_override || reminder.smart_reason || 'Reminder',
        6000,
      );
    } catch {
      /* toast is best-effort */
    }
  }
}

/**
 * Ask for native/browser notification permission ahead of time.
 * Optional - the engine will request lazily on first delivery if you
 * don't call this. Useful from a settings page or onboarding step.
 */
export async function ensureNotificationPermission(): Promise<
  NotificationPermission | 'unavailable'
> {
  return requestNotificationPermission();
}
