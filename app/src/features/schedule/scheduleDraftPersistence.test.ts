import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearScheduleDraft,
  readScheduleDraft,
  scheduleDraftsEqual,
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
  eventRecurrenceRule: 'weekly',
  description: 'Prepare the release checklist.',
  reminderOffsets: [15, 60],
  scheduleMode: 'event',
  jarvisRecurrence: 'once',
  intervalAmount: 2,
  intervalUnit: 'hours',
  jarvisModelOptionId: '',
};

describe('Schedule draft persistence', () => {
  it('preserves delayed routing and detects unsaved timing or destination changes', () => {
    const delayed: ScheduleDraft = {
      ...draft,
      scheduleMode: 'jarvis',
      timingMode: 'delay',
      delayMinutes: 3,
      targetChatId: 'chat_current',
    };
    expect(writeScheduleDraft('workspace_1', delayed)).toBe(true);
    expect(readScheduleDraft('workspace_1')).toEqual(delayed);
    expect(scheduleDraftsEqual(delayed, { ...delayed, delayMinutes: 4 })).toBe(false);
    expect(scheduleDraftsEqual(delayed, { ...delayed, targetChatId: undefined })).toBe(false);
    expect(writeScheduleDraft('workspace_1', { ...delayed, delayMinutes: 0 })).toBe(false);
    expect(writeScheduleDraft('workspace_1', { ...delayed, delayMinutes: 1.5 })).toBe(false);
  });
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

  it('round-trips a revision-bound CAO edit and compares its mutable policy', () => {
    const caoDraft = {
      ...draft,
      scheduleMode: 'jarvis' as const,
      editing: {
        eventId: 'event_cao_1',
        updatedAt: 1_750_000_000_000,
        caoSupervision: {
          schemaVersion: 1 as const,
          mode: 'cao_supervision' as const,
          scheduleId: 'schedule-cao',
          policyId: 'policy-strict',
          targetId: 'learning-md',
          projectId: 'project-a',
        },
      },
    };

    expect(writeScheduleDraft('workspace_1', caoDraft)).toBe(true);
    expect(readScheduleDraft('workspace_1')).toEqual(caoDraft);
    expect(
      scheduleDraftsEqual(caoDraft, {
        ...caoDraft,
        editing: {
          ...caoDraft.editing,
          caoSupervision: { ...caoDraft.editing.caoSupervision, policyId: 'policy-balanced' },
        },
      }),
    ).toBe(false);
  });

  it('fails closed when a persisted CAO edit token is malformed', () => {
    window.localStorage.setItem(
      scheduleDraftStorageKey('workspace_1'),
      JSON.stringify({
        ...draft,
        scheduleMode: 'jarvis',
        editing: {
          eventId: 'event_cao_1',
          updatedAt: 1_750_000_000_000,
          caoSupervision: {
            schemaVersion: 1,
            mode: 'cao_supervision',
            scheduleId: 'schedule-cao',
            policyId: 'unsafe policy value',
            targetId: 'learning-md',
            projectId: 'project-a',
          },
        },
      }),
    );

    expect(readScheduleDraft('workspace_1')).toBeNull();
  });
});
