import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reminder, Task } from '@/types/task';
import type { ReminderId, TaskId } from '@/types/common';

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  settingsGet: vi.fn(),
  getState: vi.fn(),
  notifyDone: vi.fn(),
}));

vi.mock('@/lib/db/repositories', () => ({
  taskRepo: {
    getById: mocks.getById,
    update: mocks.update,
  },
  settingsRepo: {
    get: mocks.settingsGet,
  },
}));

vi.mock('@/stores/auth', () => ({
  useAuthStore: {
    getState: mocks.getState,
  },
}));

vi.mock('@/lib/notifications', () => ({
  notifyDone: mocks.notifyDone,
}));

import { completeTask, updateTask } from './TaskService';

const TASK_ID = 'task_1' as TaskId;
const REMINDER_ID = 'rem_1' as ReminderId;
const FIRED_REMINDER_ID = 'rem_2' as ReminderId;

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: REMINDER_ID,
    task_id: TASK_ID,
    fires_at: 1000,
    channels: ['banner', 'in_app'],
    status: 'scheduled',
    snooze_history: [],
    ...overrides,
  } as Reminder;
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    workspace_id: 'workspace_1',
    title: 'Release check',
    status: 'open',
    priority: 'normal',
    effort: 3,
    context_tags: [],
    energy_required: 'medium',
    reminders: [reminder(), reminder({ id: FIRED_REMINDER_ID, status: 'fired' })],
    created_by: 'user_text',
    source_refs: [],
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as Task;
}

describe('TaskService notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(2000);
    mocks.getState.mockReturnValue({ workspaceId: 'workspace_1' });
    mocks.settingsGet.mockResolvedValue(undefined);
    mocks.update.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not report ordinary task edits as completed', async () => {
    mocks.getById.mockResolvedValue(task());

    await expect(updateTask(TASK_ID, { title: 'Renamed release check' })).resolves.toEqual(
      expect.objectContaining({
        title: 'Renamed release check',
        status: 'open',
      }),
    );

    expect(mocks.notifyDone).not.toHaveBeenCalled();
  });

  it('reports actual completion and closes scheduled reminders', async () => {
    mocks.getById.mockResolvedValue(task());

    await expect(completeTask(TASK_ID)).resolves.toEqual(
      expect.objectContaining({
        status: 'done',
        done_at: 2000,
        reminders: [
          expect.objectContaining({ id: 'rem_1', status: 'completed' }),
          expect.objectContaining({ id: 'rem_2', status: 'fired' }),
        ],
      }),
    );

    expect(mocks.update).toHaveBeenCalledWith(
      'task_1',
      expect.objectContaining({
        status: 'done',
        reminders: [
          expect.objectContaining({ id: 'rem_1', status: 'completed' }),
          expect.objectContaining({ id: 'rem_2', status: 'fired' }),
        ],
      }),
    );
    expect(mocks.notifyDone).toHaveBeenCalledWith('tasks', 'Task done', 'Release check');
  });
});
