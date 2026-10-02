import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventRow } from '@/types/event';

const mocks = vi.hoisted(() => ({
  list: vi.fn(), get: vi.fn(), update: vi.fn(), nativeNotify: vi.fn(), toast: vi.fn(),
}));
vi.mock('@/lib/db/repositories', () => ({ eventRepo: {
  listByWorkspace: mocks.list, getById: mocks.get, updateIfUpdatedAt: mocks.update,
} }));
vi.mock('@/stores/auth', () => ({ useAuthStore: { getState: () => ({
  workspaceId: 'S61B2-workspace', personaPreset: 'jarvis',
}) } }));
vi.mock('@/stores/ui', async () => {
  const actual = await vi.importActual<typeof import('@/stores/ui')>('@/stores/ui');
  return { ...actual, useUIStore: { getState: () => ({
    notificationMaster: true, doneNotifications: { reminders: true },
    notificationSound: false, notificationBadge: false,
  }) } };
});
vi.mock('@/lib/tauri', () => ({
  notify: mocks.nativeNotify, getNotificationPermission: vi.fn(),
  requestNotificationPermission: vi.fn(), setTrayBadge: vi.fn(),
}));
vi.mock('@/lib/sfx', () => ({ playUiSound: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast: { info: mocks.toast } }));

// Real production reminder + real completion identity gate; only OS adapter is controlled.
import { pollEventReminders } from '@/features/tasks/EventReminderEngine';
import { resetDoneNotificationDedupeForTests } from '@/lib/notifications';

const START = new Date(2026, 9, 2, 12, 0).getTime();
function persist() {
  let row: EventRow = {
    id: 'S61B2-event' as EventRow['id'], workspace_id: 'S61B2-workspace' as EventRow['workspace_id'],
    title: 'S61B2 controlled reminder', start_at: START, end_at: START + 60_000,
    all_day: false, timezone: 'America/Chicago', attendees: [], source: 'manual',
    reminders: [{ offset_min: 0, channels: ['desktop'] }], status: 'scheduled',
    created_by: 'S61B2-user', created_at: START - 60_000, updated_at: 1,
  };
  mocks.list.mockImplementation(async () => [structuredClone(row)]);
  mocks.get.mockImplementation(async () => structuredClone(row));
  mocks.update.mockImplementation(async (_id: string, updatedAt: number,
    build: (fresh: EventRow) => Partial<EventRow> | undefined) => {
    if (updatedAt !== row.updated_at) return undefined;
    const patch = build(structuredClone(row));
    if (!patch) return undefined;
    row = { ...row, ...structuredClone(patch), updated_at: row.updated_at + 1 };
    return structuredClone(row);
  });
  return () => structuredClone(row);
}

describe('S61B2 production reminder/completion gate recovery', () => {
  beforeEach(() => { vi.clearAllMocks(); resetDoneNotificationDedupeForTests(); });

  it('retries immediately after confirmed no native send, then records only one accepted dispatch', async () => {
    const read = persist();
    mocks.nativeNotify.mockResolvedValueOnce({ channel: 'none', permission: 'denied', message: 'Denied before send' });
    await expect(pollEventReminders(START, () => 'S61B2-denied')).resolves.toBe(0);
    expect(read().reminders[0]?.last_fired_start_at).toBeUndefined();
    expect(read().reminders[0]?.delivery_claim).toBeUndefined();
    mocks.nativeNotify.mockResolvedValueOnce({ channel: 'native', permission: 'granted', message: 'Accepted' });
    await expect(pollEventReminders(START + 30_000, () => 'S61B2-recovery')).resolves.toBe(1);
    await expect(pollEventReminders(START + 60_000, () => 'S61B2-duplicate')).resolves.toBe(0);
    expect(read().reminders[0]?.last_fired_start_at).toBe(START);
    expect(mocks.nativeNotify).toHaveBeenCalledTimes(2);
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('does not automatically resend when native acceptance is uncertain', async () => {
    persist();
    mocks.nativeNotify.mockResolvedValueOnce({ channel: 'none', permission: 'granted', message: 'Acceptance uncertain' });
    await expect(pollEventReminders(START, () => 'S61B2-uncertain')).resolves.toBe(1);
    await expect(pollEventReminders(START + 30_000, () => 'S61B2-no-replay')).resolves.toBe(0);
    expect(mocks.nativeNotify).toHaveBeenCalledOnce();
    // Retiring an uncertain attempt is deliberately NOT an OS delivery PASS.
  });
});
