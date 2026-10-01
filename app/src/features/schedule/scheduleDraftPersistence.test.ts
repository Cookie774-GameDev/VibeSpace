import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearScheduleDraft,
  readScheduleDraft,
  scheduleDraftStorageKey,
  writeScheduleDraft,
  type ScheduleDraft,
} from './scheduleDraftPersistence';

const draft: ScheduleDraft = {
  schemaVersion: 1,
  quick: 'Plan the release tomorrow at 9',
  title: 'Release planning',
  startInput: '2026-08-10T09:00',
  endInput: '2026-08-10T10:00',
  allDay: false,
  description: 'Prepare the release checklist.',
  reminderOffsets: [15, 60],
  scheduleMode: 'event',
  jarvisRecurrence: 'once',
  intervalAmount: 2,
  intervalUnit: 'hours',
  jarvisModelOptionId: '',
};

describe('Schedule draft persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('round-trips a versioned workspace-scoped draft synchronously', () => {
    writeScheduleDraft('workspace_1', draft);

    expect(window.localStorage.getItem(scheduleDraftStorageKey('workspace_1'))).toBeTruthy();
    expect(readScheduleDraft('workspace_1')).toEqual(draft);
  });

  it('isolates workspaces and clears only the saved workspace draft', () => {
    writeScheduleDraft('workspace_1', draft);
    writeScheduleDraft('workspace_2', { ...draft, title: 'Other workspace' });

    clearScheduleDraft('workspace_1');

    expect(readScheduleDraft('workspace_1')).toBeNull();
    expect(readScheduleDraft('workspace_2')?.title).toBe('Other workspace');
  });

  it('fails closed for malformed, unsupported, or unsafe persisted values', () => {
    window.localStorage.setItem(scheduleDraftStorageKey('workspace_1'), '{broken');
    expect(readScheduleDraft('workspace_1')).toBeNull();

    window.localStorage.setItem(
      scheduleDraftStorageKey('workspace_1'),
      JSON.stringify({ ...draft, schemaVersion: 2 }),
    );
    expect(readScheduleDraft('workspace_1')).toBeNull();

    window.localStorage.setItem(
      scheduleDraftStorageKey('workspace_1'),
      JSON.stringify({ ...draft, intervalAmount: 10_000 }),
    );
    expect(readScheduleDraft('workspace_1')).toBeNull();
  });
});
