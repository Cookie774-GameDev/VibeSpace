import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reminder, Task } from '@/types/task';

const mocks = vi.hoisted(() => ({
  listOpen: vi.fn(),
  update: vi.fn(),
  notify: vi.fn(),
  toastInfo: vi.fn(),
  getState: vi.fn(),
}));

vi.mock('@/lib/db/repositories', () => ({
  taskRepo: {
    listOpen: mocks.listOpen,
    update: mocks.update,
  },
}));

vi.mock('@/stores/auth', () => ({
  useAuthStore: {
    getState: mocks.getState,
  },
}));

vi.mock('@/lib/tauri', () => ({
  notify: mocks.notify,
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    info: mocks.toastInfo,
  },
}));

import { pollOnce } from './NotificationEngine';

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 'rem_1',
    task_id: 'task_1',
    fires_at: 1000,
    channels: ['banner', 'in_app'],
    status: 'scheduled',
    snooze_history: [],
    message_override: 'Stretch and check the build',
    ...overrides,
  } as Reminder;
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_1',
    workspace_id: 'workspace_1',
    title: 'Release check',
    status: 'open',
    priority: 'normal',
    effort: 3,
    context_tags: [],
    energy_required: 'medium',
    reminders: [reminder()],
    created_by: 'user_text',
    source_refs: [],
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as Task;
}

describe('NotificationEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getState.mockReturnValue({ workspaceId: 'workspace_1' });
    mocks.listOpen.mockResolvedValue([]);
    mocks.update.mockResolvedValue(undefined);
    mocks.notify.mockResolvedValue(undefined);
  });

  it('does not poll without an active workspace', async () => {
    mocks.getState.mockReturnValue({ workspaceId: null });

    await expect(pollOnce(2000)).resolves.toBe(0);
    expect(mocks.listOpen).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('fires due reminders once through shared notification delivery', async () => {
    const firedEvents: Event[] = [];
    const listener = (event: Event) => firedEvents.push(event);
    window.addEventListener('jarvis:reminder', listener);
    mocks.listOpen.mockResolvedValue([task()]);

    try {
      await expect(pollOnce(2000)).resolves.toBe(1);
    } finally {
      window.removeEventListener('jarvis:reminder', listener);
    }

    expect(mocks.toastInfo).toHaveBeenCalledWith(
      'Release check',
      'Stretch and check the build',
      6000,
    );
    expect(mocks.notify).toHaveBeenCalledWith('Release check', 'Stretch and check the build', {
      fallbackToast: false,
    });
    expect(mocks.update).toHaveBeenCalledWith('task_1', {
      reminders: [expect.objectContaining({ id: 'rem_1', status: 'fired' })],
      updated_at: 2000,
    });
    expect(firedEvents).toHaveLength(1);
  });

  it('keeps in-app-only reminders out of OS notification delivery', async () => {
    mocks.listOpen.mockResolvedValue([task({ reminders: [reminder({ channels: ['in_app'] })] })]);

    await expect(pollOnce(2000)).resolves.toBe(1);

    expect(mocks.toastInfo).toHaveBeenCalledWith(
      'Release check',
      'Stretch and check the build',
      6000,
    );
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('keeps banner-only reminders out of in-app toast delivery', async () => {
    mocks.listOpen.mockResolvedValue([task({ reminders: [reminder({ channels: ['banner'] })] })]);

    await expect(pollOnce(2000)).resolves.toBe(1);

    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith('Release check', 'Stretch and check the build', {
      fallbackToast: false,
    });
  });

  it('leaves future reminders scheduled', async () => {
    mocks.listOpen.mockResolvedValue([task({ reminders: [reminder({ fires_at: 3000 })] })]);

    await expect(pollOnce(2000)).resolves.toBe(0);
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
