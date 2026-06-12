import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
  getState: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  notify: mocks.notify,
}));

vi.mock('@/stores/ui', () => ({
  useUIStore: {
    getState: mocks.getState,
  },
}));

import {
  getAiCompletionInstruction,
  notifyDone,
  resetDoneNotificationDedupeForTests,
} from './notifications';

function enabledNotificationState(overrides: Record<string, unknown> = {}) {
  return {
    notificationMaster: true,
    doneNotifications: {
      jarvis: true,
      terminal: false,
      tasks: false,
      contextMaps: false,
      skills: false,
    },
    aiCompletionCue: false,
    ...overrides,
  };
}

describe('notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDoneNotificationDedupeForTests();
    mocks.getState.mockReturnValue(enabledNotificationState());
  });

  afterEach(() => {
    resetDoneNotificationDedupeForTests();
  });

  it('returns empty completion instruction when the cue is disabled', () => {
    mocks.getState.mockReturnValue(enabledNotificationState({ aiCompletionCue: false }));
    expect(getAiCompletionInstruction()).toBe('');
  });

  it('returns completion instruction when the cue is enabled', () => {
    mocks.getState.mockReturnValue(enabledNotificationState({ aiCompletionCue: true }));
    expect(getAiCompletionInstruction()).toContain('Completion behavior');
  });

  it('skips notifyDone when the master switch is off', async () => {
    mocks.getState.mockReturnValue(enabledNotificationState({ notificationMaster: false }));
    await notifyDone('jarvis', 'Jarvis done', 'Finished');
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('skips notifyDone when the event type is disabled', async () => {
    mocks.getState.mockReturnValue(
      enabledNotificationState({
        doneNotifications: {
          jarvis: false,
          terminal: false,
          tasks: false,
          contextMaps: false,
          skills: false,
        },
      }),
    );
    await notifyDone('jarvis', 'Jarvis done', 'Finished');
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('does not fall back to in-app toast for ordinary done notifications', async () => {
    await notifyDone('jarvis', 'Jarvis done', 'Finished');
    expect(mocks.notify).toHaveBeenCalledWith('Jarvis done', 'Finished', {
      fallbackToast: false,
    });
  });

  it('allows fallback toast only for explicit test notifications', async () => {
    await notifyDone('jarvis', 'Jarvis done', 'Finished', { allowFallbackToast: true });
    expect(mocks.notify).toHaveBeenCalledWith('Jarvis done', 'Finished', {
      fallbackToast: true,
    });
  });

  it('dedupes identical done notifications fired in quick succession', async () => {
    await notifyDone('jarvis', 'Jarvis done', 'Finished');
    await notifyDone('jarvis', 'Jarvis done', 'Finished');
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });
});
