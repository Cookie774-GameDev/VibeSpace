import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventRow } from '@/types/event';

const mocks = vi.hoisted(() => ({
  listByWorkspace: vi.fn(),
  getById: vi.fn(),
  updateIfUpdatedAt: vi.fn(),
  getAuthState: vi.fn(),
  getUiState: vi.fn(),
  notifyDone: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock('@/lib/db/repositories', () => ({
  eventRepo: {
    listByWorkspace: mocks.listByWorkspace,
    getById: mocks.getById,
    updateIfUpdatedAt: mocks.updateIfUpdatedAt,
  },
}));
vi.mock('@/stores/auth', () => ({ useAuthStore: { getState: mocks.getAuthState } }));
vi.mock('@/stores/ui', () => ({ useUIStore: { getState: mocks.getUiState } }));
vi.mock('@/lib/notifications', () => ({ notifyDone: mocks.notifyDone }));
vi.mock('@/components/ui/toast', () => ({ toast: { info: mocks.toastInfo } }));

import { pollEventReminders } from './EventReminderEngine';

const DAY_MS = 24 * 60 * 60 * 1000;
const ANCHOR = new Date(2026, 8, 28, 10, 0).getTime();

function event(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: 'evt_test' as EventRow['id'],
    workspace_id: 'workspace_1' as EventRow['workspace_id'],
    title: 'A4 reminder fixture',
    start_at: ANCHOR,
    end_at: ANCHOR + 30 * 60 * 1000,
    all_day: false,
    timezone: 'America/Chicago',
    attendees: [],
    source: 'manual',
    reminders: [
      { offset_min: 15, channels: ['in_app'] },
      { offset_min: 0, channels: ['desktop', 'in_app'] },
    ],
    status: 'scheduled',
    created_by: 'usr_test',
    created_at: ANCHOR - DAY_MS,
    updated_at: 1,
    ...overrides,
  };
}

function persist(initial: EventRow) {
  let stored = structuredClone(initial);
  mocks.listByWorkspace.mockImplementation(async () => [structuredClone(stored)]);
  mocks.getById.mockImplementation(async () => structuredClone(stored));
  mocks.updateIfUpdatedAt.mockImplementation(async (_id, expected, buildPatch) => {
    if (stored.updated_at !== expected) return undefined;
    const patch = buildPatch(structuredClone(stored));
    if (!patch) return undefined;
    stored = { ...stored, ...structuredClone(patch), updated_at: stored.updated_at + 1 };
    return structuredClone(stored);
  });
  return () => structuredClone(stored);
}

describe('pollEventReminders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthState.mockReturnValue({ workspaceId: 'workspace_1' });
    mocks.getUiState.mockReturnValue({
      notificationMaster: true,
      doneNotifications: { reminders: true },
    });
    mocks.listByWorkspace.mockResolvedValue([]);
    mocks.getById.mockResolvedValue(undefined);
    mocks.updateIfUpdatedAt.mockResolvedValue(undefined);
    mocks.notifyDone.mockResolvedValue({ channel: 'none', permission: 'denied' });
  });

  it('delivers 15-minute and at-time event reminders once despite denied OS permission', async () => {
    const read = persist(event());
    await expect(pollEventReminders(ANCHOR - 15 * 60 * 1000, () => 'claim_before')).resolves.toBe(1);
    await expect(pollEventReminders(ANCHOR, () => 'claim_at')).resolves.toBe(1);
    await expect(pollEventReminders(ANCHOR + 30 * 1000, () => 'claim_retry')).resolves.toBe(0);
    expect(mocks.toastInfo).toHaveBeenCalledTimes(2);
    expect(mocks.notifyDone).toHaveBeenCalledTimes(1);
    expect(read().reminders.map((reminder) => reminder.last_fired_start_at)).toEqual([
      ANCHOR,
      ANCHOR,
    ]);
  });

  it('fires each daily occurrence once after restart without replaying older occurrences', async () => {
    const read = persist(event({ recurrence_rule: 'daily', reminders: [{ offset_min: 0, channels: ['in_app'] }] }));
    await expect(pollEventReminders(ANCHOR, () => 'claim_first')).resolves.toBe(1);
    await expect(pollEventReminders(ANCHOR + DAY_MS, () => 'claim_second')).resolves.toBe(1);
    await expect(pollEventReminders(ANCHOR + DAY_MS + 30_000, () => 'claim_duplicate')).resolves.toBe(0);
    expect(read().reminders[0]?.last_fired_start_at).toBe(ANCHOR + DAY_MS);
    expect(mocks.toastInfo).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['weekly', 'weekly', new Date(2026, 9, 5, 10, 0).getTime()],
    ['monthly', 'monthly', new Date(2026, 9, 28, 10, 0).getTime()],
    ['custom weekdays', 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE', new Date(2026, 8, 30, 10, 0).getTime()],
  ])('fires the next %s occurrence once', async (_label, recurrence_rule, nextStart) => {
    const read = persist(event({ recurrence_rule, reminders: [{ offset_min: 0, channels: ['in_app'] }] }));
    await expect(pollEventReminders(ANCHOR, () => 'claim_anchor')).resolves.toBe(1);
    await expect(pollEventReminders(nextStart, () => 'claim_next')).resolves.toBe(1);
    await expect(pollEventReminders(nextStart + 30_000, () => 'claim_duplicate')).resolves.toBe(0);
    expect(read().reminders[0]?.last_fired_start_at).toBe(nextStart);
    expect(mocks.toastInfo).toHaveBeenCalledTimes(2);
  });

  it('keeps competing polls from delivering the same occurrence twice', async () => {
    persist(event({ reminders: [{ offset_min: 0, channels: ['in_app'] }] }));
    const results = await Promise.all([
      pollEventReminders(ANCHOR, () => 'claim_one'),
      pollEventReminders(ANCHOR, () => 'claim_two'),
    ]);
    expect(results.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1);
  });
});
