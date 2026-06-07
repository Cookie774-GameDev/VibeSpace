import { taskRepo, settingsRepo } from '@/lib/db/repositories';
import { newTaskId, newReminderId } from '@/lib/ids';
import { useAuthStore } from '@/stores/auth';
import { notifyDone } from '@/lib/notifications';
import type { Reminder, Task, TaskInput, QuietHours } from '@/types/task';
import type { ContextRef, TaskId, ReminderId } from '@/types/common';
import { pickReminderTimes, type SchedulerContext } from './Scheduler';

/**
 * Pure service layer for task CRUD + scheduling.
 *
 * No React. Every UI surface (schedule, voice service, command palette,
 * extractor agent) goes through this object. It owns the rules of "what
 * happens when a task is created/updated/completed/snoozed".
 *
 * Backed by the dexie-backed `taskRepo` from `@/lib/db/repositories`.
 */

const DEFAULT_QUIET_HOURS: QuietHours = {
  enabled: true,
  start_hour: 22,
  end_hour: 8,
  // Sun=0, Mon=1, ... Sat=6.  Sunday quiet by default per spec section 5.
  full_day_quiet: [true, false, false, false, false, false, false],
};

async function loadQuietHours(): Promise<QuietHours> {
  try {
    const v = await settingsRepo.get<QuietHours>('quiet_hours');
    if (v && typeof v === 'object') {
      return {
        enabled: v.enabled ?? DEFAULT_QUIET_HOURS.enabled,
        start_hour: v.start_hour ?? DEFAULT_QUIET_HOURS.start_hour,
        end_hour: v.end_hour ?? DEFAULT_QUIET_HOURS.end_hour,
        full_day_quiet: v.full_day_quiet ?? DEFAULT_QUIET_HOURS.full_day_quiet,
      };
    }
  } catch {
    /* fall through to default */
  }
  return DEFAULT_QUIET_HOURS;
}

async function loadSchedulerContext(now: number): Promise<SchedulerContext> {
  return {
    now,
    quietHours: await loadQuietHours(),
    calendarBusy: [], // wired but stubbed at V1
    existingReminders: [],
  };
}

/**
 * Create a task. Defaults are filled in for required fields. The
 * scheduler is run automatically and reminders are attached.
 */
export async function createTask(input: TaskInput): Promise<Task> {
  const now = Date.now();
  const workspaceId = input.workspace_id ?? useAuthStore.getState().workspaceId;
  if (!workspaceId) {
    throw new Error('createTask: no active workspace');
  }

  const id = newTaskId() as TaskId;

  // Compose the task with defaults pulled from spec.
  const draft: Task = {
    id,
    workspace_id: workspaceId,
    project_id: input.project_id,
    title: (input.title ?? '').trim() || 'Untitled task',
    notes: input.notes,
    status: input.status ?? 'open',
    priority: input.priority ?? 'normal',
    due_at: input.due_at,
    scheduled_for: input.scheduled_for,
    estimated_duration_min: input.estimated_duration_min,
    effort: input.effort ?? 3,
    context_tags: input.context_tags ?? [],
    location: input.location,
    energy_required: input.energy_required ?? 'medium',
    blocked_by_task_ids: input.blocked_by_task_ids,
    reminders: [],
    created_by: input.created_by ?? 'user_text',
    source_refs: input.source_refs ?? [],
    agent_owner: input.agent_owner,
    external_ids: input.external_ids,
    done_at: input.done_at,
    completion_evidence: input.completion_evidence,
    created_at: now,
    updated_at: now,
  };

  // Run the smart scheduler unless explicit reminders were provided.
  if (input.reminders && input.reminders.length > 0) {
    draft.reminders = input.reminders.map((r) => ({
      ...r,
      id: newReminderId(),
      task_id: id,
      status: 'scheduled' as const,
      snooze_history: [],
    }));
  } else {
    const ctx = await loadSchedulerContext(now);
    draft.reminders = pickReminderTimes(draft, ctx);
  }

  await taskRepo.create(draft);
  return draft;
}

/**
 * Update a task. If `due_at`, `scheduled_for`, or `priority` changes
 * AND the task still has scheduled reminders that haven't fired, we
 * re-run the scheduler to keep reminders consistent with the new shape.
 */
export async function updateTask(id: TaskId, patch: Partial<Task>): Promise<Task> {
  const existing = await taskRepo.getById(id);
  if (!existing) throw new Error(`updateTask: task ${id} not found`);

  const now = Date.now();
  const next: Task = { ...existing, ...patch, updated_at: now };

  const timingChanged = 'due_at' in patch || 'scheduled_for' in patch || 'priority' in patch;

  if (timingChanged) {
    // Drop only `scheduled` reminders so any already-fired/snoozed/dismissed
    // entries keep their audit history.
    const keep = next.reminders.filter((r) => r.status !== 'scheduled');
    const ctx = await loadSchedulerContext(now);
    const fresh = pickReminderTimes(next, ctx);
    next.reminders = [...keep, ...fresh];
  }

  await taskRepo.update(id, next);
  return next;
}

/**
 * Mark a task done. Records optional completion evidence (e.g., the
 * git commit, the email, the chat message that proves it was done).
 *
 * Also marks any pending scheduled reminders as `completed` so the
 * notification engine doesn't fire them.
 */
export async function completeTask(id: TaskId, evidence?: ContextRef): Promise<Task> {
  const existing = await taskRepo.getById(id);
  if (!existing) throw new Error(`completeTask: task ${id} not found`);

  const now = Date.now();
  const reminders: Reminder[] = existing.reminders.map((r) =>
    r.status === 'scheduled' ? { ...r, status: 'completed' as const } : r,
  );

  const next: Task = {
    ...existing,
    status: 'done',
    done_at: now,
    completion_evidence: evidence ?? existing.completion_evidence,
    reminders,
    updated_at: now,
  };

  await taskRepo.update(id, next);
  void notifyDone('tasks', 'Task done', next.title);
  return next;
}

/**
 * Move a task back to open (undo a completion).
 */
export async function reopenTask(id: TaskId): Promise<Task> {
  const existing = await taskRepo.getById(id);
  if (!existing) throw new Error(`reopenTask: task ${id} not found`);
  const now = Date.now();
  const next: Task = {
    ...existing,
    status: 'open',
    done_at: undefined,
    completion_evidence: undefined,
    updated_at: now,
  };
  await taskRepo.update(id, next);
  return next;
}

/**
 * Delete a task.
 */
export async function deleteTask(id: TaskId): Promise<void> {
  await taskRepo.delete(id);
}

/**
 * Snooze a single reminder until `until`. Records the snooze in
 * `snooze_history` and resets status back to 'scheduled' so it'll fire
 * again at the new time.
 */
export async function snoozeReminder(
  reminderId: ReminderId,
  until: number,
  reason?: string,
): Promise<Task | null> {
  const all = await findTaskByReminderId(reminderId);
  if (!all) return null;

  const now = Date.now();
  const reminders: Reminder[] = all.reminders.map((r) => {
    if (r.id !== reminderId) return r;
    return {
      ...r,
      fires_at: until,
      status: 'scheduled' as const,
      snooze_history: [...r.snooze_history, { snoozed_at: now, until, reason }],
    };
  });

  const next: Task = { ...all, reminders, updated_at: now };
  await taskRepo.update(all.id, next);
  return next;
}

/**
 * Mark a reminder dismissed (user said "not relevant", neither done
 * nor snoozed).
 */
export async function dismissReminder(reminderId: ReminderId): Promise<Task | null> {
  const all = await findTaskByReminderId(reminderId);
  if (!all) return null;
  const now = Date.now();
  const reminders: Reminder[] = all.reminders.map((r) =>
    r.id === reminderId ? { ...r, status: 'dismissed' as const } : r,
  );
  const next: Task = { ...all, reminders, updated_at: now };
  await taskRepo.update(all.id, next);
  return next;
}

/**
 * Find the task that owns a given reminder. The repo doesn't expose a
 * direct index on reminder IDs (reminders are nested), so we scan open
 * tasks. Cheap at V1 list sizes.
 */
async function findTaskByReminderId(reminderId: ReminderId): Promise<Task | null> {
  const workspaceId = useAuthStore.getState().workspaceId;
  if (!workspaceId) return null;
  const tasks = await taskRepo.listOpen(workspaceId);
  for (const t of tasks) {
    if (t.reminders?.some((r) => r.id === reminderId)) return t;
  }
  return null;
}

/**
 * Convenience namespace export for callers that prefer a service object.
 */
export const TaskService = {
  createTask,
  updateTask,
  completeTask,
  reopenTask,
  deleteTask,
  snoozeReminder,
  dismissReminder,
};
