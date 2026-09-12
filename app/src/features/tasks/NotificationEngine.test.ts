import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reminder, Task } from '@/types/task';

const mocks = vi.hoisted(() => ({
  listOpen: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  claim: vi.fn(),
  finalize: vi.fn(),
  release: vi.fn(),
  notifyDone: vi.fn(),
  toastInfo: vi.fn(),
  getAuthState: vi.fn(),
  getUiState: vi.fn(),
}));

vi.mock('@/lib/db/repositories', () => ({
  taskRepo: {
    listOpen: mocks.listOpen,
    getById: mocks.getById,
    update: mocks.update,
  },
  reminderClaimRepo: {
    claim: mocks.claim,
    finalize: mocks.finalize,
    release: mocks.release,
  },
}));

vi.mock('@/stores/auth', () => ({
  useAuthStore: {
    getState: mocks.getAuthState,
  },
}));

vi.mock('@/stores/ui', () => ({
  useUIStore: {
    getState: mocks.getUiState,
  },
}));

vi.mock('@/lib/notifications', () => ({
  notifyDone: mocks.notifyDone,
}));

vi.mock('@/lib/tauri', () => ({
  requestNotificationPermission: vi.fn(),
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    info: mocks.toastInfo,
  },
}));

import { pollOnce } from './NotificationEngine';

function pollWithClaim(now: number, claimId: string): Promise<number> {
  return (
    pollOnce as unknown as (currentTime: number, createClaimId: () => string) => Promise<number>
  )(now, () => claimId);
}

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

function claimedReminder(claim: { id: string; claimed_at: number; expires_at: number }): Reminder {
  return reminder({ delivery_claim: claim } as Partial<Reminder>);
}

function usePersistedTask(initial: Task) {
  let persisted = structuredClone(initial);
  mocks.listOpen.mockImplementation(async () => [structuredClone(persisted)]);
  mocks.getById.mockImplementation(async () => structuredClone(persisted));
  mocks.update.mockImplementation(async (_id: string, patch: Partial<Task>) => {
    persisted = { ...persisted, ...structuredClone(patch) };
    return structuredClone(persisted);
  });
  mocks.claim.mockImplementation(async (input) => {
    const current = persisted.reminders.find((candidate) => candidate.id === input.reminderId);
    if (
      persisted.workspace_id !== input.expectedWorkspaceId ||
      input.getActiveWorkspaceId() !== input.expectedWorkspaceId ||
      !current ||
      current.status !== 'scheduled' ||
      current.fires_at > input.now ||
      (current.delivery_claim && current.delivery_claim.expires_at > input.now)
    ) {
      return undefined;
    }
    return mocks.update(input.taskId, {
      reminders: persisted.reminders.map((candidate) =>
        candidate.id === input.reminderId
          ? {
              ...candidate,
              delivery_claim: {
                id: input.claimId,
                claimed_at: input.now,
                expires_at: input.expiresAt,
              },
            }
          : candidate,
      ),
      updated_at: input.now,
    });
  });
  mocks.finalize.mockImplementation(async (input) => {
    const current = persisted.reminders.find((candidate) => candidate.id === input.reminderId);
    if (
      persisted.workspace_id !== input.expectedWorkspaceId ||
      input.getActiveWorkspaceId() !== input.expectedWorkspaceId ||
      current?.delivery_claim?.id !== input.claimId
    ) {
      return undefined;
    }
    return mocks.update(input.taskId, {
      reminders: persisted.reminders.map((candidate) => {
        if (candidate.id !== input.reminderId) return candidate;
        const { delivery_claim: _claim, ...rest } = candidate;
        return { ...rest, status: 'fired' };
      }),
      updated_at: input.now,
    });
  });
  mocks.release.mockImplementation(async (input) => {
    const current = persisted.reminders.find((candidate) => candidate.id === input.reminderId);
    if (
      persisted.workspace_id !== input.expectedWorkspaceId ||
      input.getActiveWorkspaceId() !== input.expectedWorkspaceId ||
      current?.delivery_claim?.id !== input.claimId
    ) {
      return undefined;
    }
    return mocks.update(input.taskId, {
      reminders: persisted.reminders.map((candidate) => {
        if (candidate.id !== input.reminderId) return candidate;
        const { delivery_claim: _claim, ...rest } = candidate;
        return rest;
      }),
      updated_at: input.now,
    });
  });
  return () => structuredClone(persisted);
}

describe('NotificationEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthState.mockReturnValue({ workspaceId: 'workspace_1' });
    mocks.getUiState.mockReturnValue({
      notificationMaster: true,
      doneNotifications: { reminders: true },
    });
    mocks.listOpen.mockResolvedValue([]);
    mocks.getById.mockResolvedValue(undefined);
    mocks.update.mockResolvedValue(undefined);
    mocks.claim.mockResolvedValue(undefined);
    mocks.finalize.mockResolvedValue(undefined);
    mocks.release.mockResolvedValue(undefined);
    mocks.notifyDone.mockResolvedValue({
      channel: 'browser',
      permission: 'granted',
      message: 'ok',
    });
  });

  it('does not poll without an active workspace', async () => {
    mocks.getAuthState.mockReturnValue({ workspaceId: null });

    await expect(pollOnce(2000)).resolves.toBe(0);
    expect(mocks.listOpen).not.toHaveBeenCalled();
    expect(mocks.notifyDone).not.toHaveBeenCalled();
  });

  it('fires due reminders once through settings-gated notification delivery', async () => {
    const firedEvents: Event[] = [];
    const listener = (event: Event) => firedEvents.push(event);
    window.addEventListener('jarvis:reminder', listener);
    usePersistedTask(task());

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
    expect(mocks.notifyDone).toHaveBeenCalledWith(
      'reminders',
      'Release check',
      'Stretch and check the build',
    );
    expect(mocks.update).toHaveBeenCalledWith('task_1', {
      reminders: [expect.objectContaining({ id: 'rem_1', status: 'fired' })],
      updated_at: 2000,
    });
    expect(firedEvents).toHaveLength(1);
  });

  it('skips OS banner when reminder category is disabled', async () => {
    mocks.getUiState.mockReturnValue({
      notificationMaster: true,
      doneNotifications: { reminders: false },
    });
    usePersistedTask(task());

    await expect(pollOnce(2000)).resolves.toBe(1);
    expect(mocks.toastInfo).toHaveBeenCalled();
    expect(mocks.notifyDone).not.toHaveBeenCalled();
  });

  it('keeps in-app-only reminders out of OS notification delivery', async () => {
    usePersistedTask(task({ reminders: [reminder({ channels: ['in_app'] })] }));

    await expect(pollOnce(2000)).resolves.toBe(1);

    expect(mocks.toastInfo).toHaveBeenCalledWith(
      'Release check',
      'Stretch and check the build',
      6000,
    );
    expect(mocks.notifyDone).not.toHaveBeenCalled();
  });

  it('does not deliver a reminder until its fired state is durably claimed', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const firedEvents: Event[] = [];
    const listener = (event: Event) => firedEvents.push(event);
    window.addEventListener('jarvis:reminder', listener);
    usePersistedTask(task());
    mocks.update.mockRejectedValueOnce(new Error('local database unavailable'));

    try {
      await expect(pollOnce(2000)).resolves.toBe(0);
    } finally {
      window.removeEventListener('jarvis:reminder', listener);
    }

    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.notifyDone).not.toHaveBeenCalled();
    expect(firedEvents).toHaveLength(0);
    expect(warning).toHaveBeenCalledOnce();
  });

  it('does not redeliver a reminder while another delivery claim is active', async () => {
    const getPersisted = usePersistedTask(
      task({
        reminders: [
          claimedReminder({
            id: 'claim_active',
            claimed_at: 1900,
            expires_at: 5000,
          }),
        ],
      }),
    );

    await expect(pollWithClaim(2000, 'claim_other')).resolves.toBe(0);

    expect(mocks.notifyDone).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(getPersisted().reminders[0]).toMatchObject({
      status: 'scheduled',
      delivery_claim: { id: 'claim_active' },
    });
  });

  it('claims, verifies, delivers, and then finalizes a due reminder', async () => {
    const getPersisted = usePersistedTask(task());

    await expect(pollWithClaim(2000, 'claim_success')).resolves.toBe(1);

    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(mocks.update.mock.calls[0]?.[1]).toMatchObject({
      reminders: [
        expect.objectContaining({
          id: 'rem_1',
          status: 'scheduled',
          delivery_claim: {
            id: 'claim_success',
            claimed_at: 2000,
            expires_at: 122000,
          },
        }),
      ],
    });
    expect(mocks.notifyDone).toHaveBeenCalledTimes(1);
    expect(getPersisted().reminders[0]).toMatchObject({
      id: 'rem_1',
      status: 'fired',
    });
    expect(getPersisted().reminders[0]).not.toHaveProperty('delivery_claim');
  });

  it('releases a failed delivery claim so a later poll can retry without a hot loop', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const getPersisted = usePersistedTask(task());
    mocks.notifyDone.mockRejectedValueOnce(new Error('notification transport unavailable'));

    await expect(pollWithClaim(2000, 'claim_failed')).resolves.toBe(0);

    expect(mocks.notifyDone).toHaveBeenCalledTimes(1);
    expect(getPersisted().reminders[0]).toMatchObject({
      id: 'rem_1',
      status: 'scheduled',
    });
    expect(getPersisted().reminders[0]).not.toHaveProperty('delivery_claim');
    expect(warning).toHaveBeenCalledOnce();

    await expect(pollWithClaim(2030, 'claim_retry')).resolves.toBe(1);
    expect(mocks.notifyDone).toHaveBeenCalledTimes(2);
    expect(getPersisted().reminders[0].status).toBe('fired');
  });

  it('reclaims a stale delivery claim after a crashed poll', async () => {
    const getPersisted = usePersistedTask(
      task({
        reminders: [
          claimedReminder({
            id: 'claim_crashed',
            claimed_at: 1000,
            expires_at: 1500,
          }),
        ],
      }),
    );

    await expect(pollWithClaim(2000, 'claim_recovery')).resolves.toBe(1);

    expect(mocks.update.mock.calls[0]?.[1].reminders?.[0]).toMatchObject({
      status: 'scheduled',
      delivery_claim: { id: 'claim_recovery' },
    });
    expect(mocks.notifyDone).toHaveBeenCalledTimes(1);
    expect(getPersisted().reminders[0].status).toBe('fired');
  });

  it('keeps a successful delivery claimed when fired finalization fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const getPersisted = usePersistedTask(task());
    const persistUpdate = mocks.update.getMockImplementation();
    let updateCount = 0;
    mocks.update.mockImplementation(async (...args: unknown[]) => {
      updateCount += 1;
      if (updateCount === 2) throw new Error('final fired write unavailable');
      return persistUpdate?.(...args);
    });

    await expect(pollWithClaim(2000, 'claim_delivered')).resolves.toBe(0);
    expect(mocks.notifyDone).toHaveBeenCalledTimes(1);
    expect(getPersisted().reminders[0]).toMatchObject({
      status: 'scheduled',
      delivery_claim: {
        id: 'claim_delivered',
        expires_at: 122000,
      },
    });

    await expect(pollWithClaim(2030, 'claim_too_soon')).resolves.toBe(0);
    expect(mocks.notifyDone).toHaveBeenCalledTimes(1);

    await expect(pollWithClaim(122001, 'claim_after_expiry')).resolves.toBe(1);
    expect(mocks.notifyDone).toHaveBeenCalledTimes(2);
    expect(getPersisted().reminders[0].status).toBe('fired');
    expect(warning).toHaveBeenCalledOnce();
  });

  it('serializes concurrent polls so one due reminder has one active delivery', async () => {
    usePersistedTask(task());

    const [first, second] = await Promise.all([
      pollWithClaim(2000, 'claim_first'),
      pollWithClaim(2000, 'claim_second'),
    ]);

    expect(first + second).toBe(1);
    expect(mocks.notifyDone).toHaveBeenCalledTimes(1);
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1);
  });

  it('stops a claimed reminder when the active workspace changes before delivery', async () => {
    const getPersisted = usePersistedTask(task());
    const persistUpdate = mocks.update.getMockImplementation();
    mocks.update.mockImplementationOnce(async (...args: unknown[]) => {
      const updated = await persistUpdate?.(...args);
      mocks.getAuthState.mockReturnValue({ workspaceId: 'workspace_2' });
      return updated;
    });

    await expect(pollWithClaim(2000, 'claim_workspace_switch')).resolves.toBe(0);

    expect(mocks.notifyDone).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(getPersisted().reminders[0]).toMatchObject({
      status: 'scheduled',
      delivery_claim: { id: 'claim_workspace_switch' },
    });
  });
});
