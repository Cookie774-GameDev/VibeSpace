import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearScheduleDraft, readScheduleDraft, scheduleDraftStorageKey, writeScheduleDraft, type ScheduleDraft } from '@/features/schedule/scheduleDraftPersistence';
const ownedStorage = vi.hoisted(() => {
  const entries = new Map<string, string>();
  return { entries, api: { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } } };
});
// Only the storage boundary is injected. Actual Zustand persist/merge/setters run.
vi.mock('@/lib/persistence/safeLocalStorage', () => ({ safeLocalStorage: ownedStorage.api }));
const workspaces = ['S61B4D-workspace-a', 'S61B4D-workspace-b'];
const eventDraft: ScheduleDraft = { schemaVersion: 1, quick: 'S61B4D disposable event', title: 'S61B4D event', startInput: '2026-11-10T09:00', endInput: '2026-11-10T09:15', allDay: false, eventRecurrenceRule: 'weekly', description: 'Synthetic non-agent schedule persistence only.', reminderOffsets: [15], scheduleMode: 'event', jarvisRecurrence: 'once', intervalAmount: 1, intervalUnit: 'hours', jarvisModelOptionId: '' };
beforeEach(() => { ownedStorage.entries.clear(); vi.resetModules(); });
afterEach(() => { for (const id of workspaces) clearScheduleDraft(id); ownedStorage.entries.clear(); });
describe('S61B4D nonchat clean-state settings contracts', () => {
  it('rehydrates actual pet settings in a fresh module and retains neighboring settings on one edit', async () => {
    const first = (await import('@/features/pets/petSettingsStore')).usePetSettingsStore;
    first.getState().setPanelMode('always-on-top');
    first.getState().setReducedMotion(true);
    first.getState().setAnimationLevel('reduced');
    first.getState().setSoundEnabled(false);
    first.getState().setSleepTimeoutMs(123_000);
    expect(ownedStorage.entries.has('vibespace-pet-settings')).toBe(true);
    vi.resetModules();
    const reopened = (await import('@/features/pets/petSettingsStore')).usePetSettingsStore;
    await reopened.persist.rehydrate();
    expect(reopened.getState()).toMatchObject({ panelMode: 'always-on-top', reducedMotion: true, animationLevel: 'reduced', soundEnabled: false, sleepTimeoutMs: 123_000 });
    reopened.getState().setPositionLocked(true);
    vi.resetModules();
    const edited = (await import('@/features/pets/petSettingsStore')).usePetSettingsStore;
    await edited.persist.rehydrate();
    expect(edited.getState()).toMatchObject({ positionLocked: true, panelMode: 'always-on-top', reducedMotion: true, animationLevel: 'reduced', soundEnabled: false, sleepTimeoutMs: 123_000 });
  });
  it('reloads exact event drafts from persisted bytes and recovers one corrupted workspace without touching another', () => {
    const other = { ...eventDraft, title: 'S61B4D other event', description: 'Separate workspace marker' };
    expect(writeScheduleDraft(workspaces[0], eventDraft)).toBe(true);
    expect(writeScheduleDraft(workspaces[1], other)).toBe(true);
    const preserved = window.localStorage.getItem(scheduleDraftStorageKey(workspaces[1]));
    expect(readScheduleDraft(workspaces[0])).toEqual(eventDraft);
    window.localStorage.setItem(scheduleDraftStorageKey(workspaces[0]), '{invalid S61B4D');
    expect(readScheduleDraft(workspaces[0])).toBeNull();
    expect(readScheduleDraft(workspaces[1])).toEqual(other);
    expect(writeScheduleDraft(workspaces[0], { ...eventDraft, title: 'S61B4D recovered' })).toBe(true);
    expect(readScheduleDraft(workspaces[0])?.title).toBe('S61B4D recovered');
    expect(window.localStorage.getItem(scheduleDraftStorageKey(workspaces[1]))).toBe(preserved);
  });
});
