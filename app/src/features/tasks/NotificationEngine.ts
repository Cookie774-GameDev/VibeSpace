import { taskRepo } from '@/lib/db/repositories';
import { useAuthStore } from '@/stores/auth';
import { isTauri } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import type { Reminder, Task } from '@/types/task';

/**
 * The notification engine.
 *
 * - Polls scheduled reminders every 30 seconds.
 * - When a reminder's fires_at <= now, dispatches via:
 *     (1) browser/Tauri notification banner
 *     (2) in-app toast (always, as a soft fallback / always-visible cue)
 *     (3) the `jarvis:reminder` custom event (for the rest of the app
 *         to react - e.g., voice service speaks the reminder).
 *
 * Permission flow is non-blocking: we ask only when the first reminder
 * is being delivered, never at boot.
 *
 * Tauri detection is graceful - if the runtime isn't Tauri or the optional
 * notification module isn't available, we silently fall through to the
 * browser path.
 */

const POLL_INTERVAL_MS = 30 * 1000;
let runningInstanceId = 0;

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
 * `fires_at` has passed.  Exported for tests.
 */
export async function pollOnce(now: number = Date.now()): Promise<number> {
  const workspaceId = useAuthStore.getState().workspaceId;
  if (!workspaceId) return 0;

  const tasks = await taskRepo.listOpen(workspaceId);
  let fired = 0;

  for (const task of tasks) {
    if (!task.reminders || task.reminders.length === 0) continue;
    let mutated = false;
    const nextReminders: Reminder[] = [];

    for (const r of task.reminders) {
      if (r.status === 'scheduled' && r.fires_at <= now) {
        await deliverReminder(task, r);
        nextReminders.push({ ...r, status: 'fired' });
        mutated = true;
        fired += 1;
      } else {
        nextReminders.push(r);
      }
    }

    if (mutated) {
      try {
        await taskRepo.update(task.id, { reminders: nextReminders, updated_at: now });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[NotificationEngine] failed to mark reminder fired', err);
      }
    }
  }

  return fired;
}

/**
 * Deliver one reminder across the appropriate channels.
 */
async function deliverReminder(task: Task, reminder: Reminder): Promise<void> {
  const title = task.title;
  const body = reminder.message_override || reminder.smart_reason || 'Reminder';

  // Always emit the in-app event so other features can react.
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(
        new CustomEvent('jarvis:reminder', {
          detail: { task, reminder },
        }),
      );
    } catch {
      /* dispatch should never throw */
    }
  }

  // Always show an in-app toast - it's the always-visible surface.
  try {
    toast.info(title, body, 6000);
  } catch {
    /* toast is best-effort */
  }

  // Native banner (priority order: Tauri > browser).
  let delivered = false;
  if (isTauri) {
    delivered = await deliverTauri(title, body);
  }
  if (!delivered) {
    delivered = await deliverBrowser(title, body);
  }

  // If neither native channel delivered, the in-app toast is sufficient.
  void delivered;
}

// ============================================================
// Tauri delivery (optional / graceful)
// ============================================================

async function deliverTauri(title: string, body: string): Promise<boolean> {
  // We don't statically import the Tauri notification module because it
  // may not be present in the bundle (browser dev) and we don't want to
  // pull it into the chunk graph eagerly. Vite's @vite-ignore tells the
  // bundler to skip resolution; the @ts-ignore covers strict TS in case
  // the package isn't installed.
  try {
    const path = '@tauri-apps/api/notification';
    // @ts-ignore - dynamic import for optional Tauri runtime
    const mod: any = await import(/* @vite-ignore */ path).catch(() => null);
    if (!mod || typeof mod.sendNotification !== 'function') return false;

    if (typeof mod.isPermissionGranted === 'function') {
      let granted: boolean = await mod.isPermissionGranted();
      if (!granted && typeof mod.requestPermission === 'function') {
        const status = await mod.requestPermission();
        granted = status === 'granted';
      }
      if (!granted) return false;
    }
    mod.sendNotification({ title, body });
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// Browser delivery
// ============================================================

let permissionAsked = false;

async function deliverBrowser(title: string, body: string): Promise<boolean> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return false;

  try {
    if (Notification.permission === 'default' && !permissionAsked) {
      permissionAsked = true;
      // Async permission request - first reminder doubles as the prompt.
      try {
        await Notification.requestPermission();
      } catch {
        return false;
      }
    }

    if (Notification.permission !== 'granted') return false;

    // eslint-disable-next-line no-new
    new Notification(title, { body });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask for browser notification permission ahead of time.
 * Optional - the engine will request lazily on first delivery if you
 * don't call this. Useful from a settings page or onboarding step.
 */
export async function ensureNotificationPermission(): Promise<NotificationPermission | 'unavailable'> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return 'unavailable';
  if (Notification.permission !== 'default') return Notification.permission;
  permissionAsked = true;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}
