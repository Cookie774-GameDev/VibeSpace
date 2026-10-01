import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
  getState: vi.fn(),
  getNotificationPermission: vi.fn(),
  requestNotificationPermission: vi.fn(),
  setTrayBadge: vi.fn(),
  personaPreset: 'jarvis' as string,
}));

vi.mock('@/lib/tauri', () => ({
  notify: mocks.notify,
  getNotificationPermission: mocks.getNotificationPermission,
  requestNotificationPermission: mocks.requestNotificationPermission,
  setTrayBadge: mocks.setTrayBadge,
}));

vi.mock('@/stores/ui', async () => {
  const actual = await vi.importActual<typeof import('@/stores/ui')>('@/stores/ui');
  return {
    ...actual,
    useUIStore: {
      getState: mocks.getState,
    },
  };
});

vi.mock('@/stores/auth', () => ({
  useAuthStore: {
    getState: () => ({ personaPreset: mocks.personaPreset }),
  },
}));

import {
  detectAndNotifyConnectorAuthLoss,
  getAiCompletionInstruction,
  getDoneNotificationLabels,
  notifyDone,
  resetDoneNotificationDedupeForTests,
  sendTestNotification,
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
      connectors: true,
      reminders: true,
    },
    aiCompletionCue: false,
    notificationSound: true,
    notificationBadge: false,
    ...overrides,
  };
}

describe('notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDoneNotificationDedupeForTests();
    mocks.personaPreset = 'jarvis';
    mocks.getState.mockReturnValue(enabledNotificationState());
    mocks.notify.mockResolvedValue({
      channel: 'browser',
      permission: 'granted',
      message: 'Delivered as a browser notification.',
    });
    mocks.getNotificationPermission.mockResolvedValue('granted');
    mocks.requestNotificationPermission.mockResolvedValue('granted');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDoneNotificationDedupeForTests();
  });

  it('returns empty completion instruction when the cue is disabled', () => {
    mocks.getState.mockReturnValue(enabledNotificationState({ aiCompletionCue: false }));
    expect(getAiCompletionInstruction()).toBe('');
  });

  it('returns a plain DONE/BLOCKED completion instruction with assistant name', () => {
    mocks.getState.mockReturnValue(enabledNotificationState({ aiCompletionCue: true }));
    mocks.personaPreset = 'friday';
    const text = getAiCompletionInstruction();
    expect(text).toContain('Friday');
    expect(text).toContain('DONE:');
    expect(text).toContain('BLOCKED:');
    expect(text).toMatch(/user-visible|user reads/i);
    expect(text).not.toMatch(/chain.of.thought|hidden reasoning only/i);
  });

  it('labels assistant-done with Jarvis or Friday', () => {
    expect(getDoneNotificationLabels('jarvis').jarvis).toBe('Jarvis done');
    expect(getDoneNotificationLabels('friday').jarvis).toBe('Friday done');
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
          connectors: false,
          reminders: false,
        },
      }),
    );
    await notifyDone('jarvis', 'Jarvis done', 'Finished');
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('does not fall back to in-app toast for ordinary done notifications', async () => {
    await notifyDone('jarvis', 'Jarvis done', 'Finished');
    expect(mocks.notify).toHaveBeenCalledWith('Jarvis done', 'Finished', {
      silent: false,
      fallbackToast: false,
      onClick: expect.any(Function),
    });
  });

  it('allows fallback toast only for explicit test notifications', async () => {
    await notifyDone('jarvis', 'Jarvis done', 'Finished', { allowFallbackToast: true });
    expect(mocks.notify).toHaveBeenCalledWith('Jarvis done', 'Finished', {
      silent: false,
      fallbackToast: true,
      onClick: expect.any(Function),
    });
  });

  it('dedupes identical done notifications fired in quick succession', async () => {
    await notifyDone('jarvis', 'Jarvis done', 'Finished');
    await notifyDone('jarvis', 'Jarvis done', 'Finished');
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['terminal-first', ['terminal', 'tasks']],
    ['task-first', ['tasks', 'terminal']],
  ] as const)(
    'dedupes one canonical run across terminal and task categories in %s order',
    async (_name, order) => {
      mocks.getState.mockReturnValue(
        enabledNotificationState({
          doneNotifications: {
            jarvis: false,
            terminal: true,
            tasks: true,
            contextMaps: false,
            skills: false,
            connectors: false,
            reminders: false,
          },
        }),
      );
      for (const kind of order) {
        await notifyDone(kind, `${kind} title`, `${kind} body`, {
          completionIdentity: 'jarvis-run:jrun-shared',
        });
      }
      expect(mocks.notify).toHaveBeenCalledTimes(1);
    },
  );

  it('isolates shared completion identities and preserves category behavior without one', async () => {
    mocks.getState.mockReturnValue(
      enabledNotificationState({
        doneNotifications: {
          jarvis: false,
          terminal: true,
          tasks: true,
          contextMaps: false,
          skills: false,
          connectors: false,
          reminders: false,
        },
      }),
    );
    await notifyDone('terminal', 'Terminal one', 'Finished', {
      completionIdentity: 'jarvis-run:jrun-one',
    });
    await notifyDone('tasks', 'Task two', 'Finished', {
      completionIdentity: 'jarvis-run:jrun-two',
    });
    await notifyDone('terminal', 'Ordinary terminal', 'Finished');
    await notifyDone('tasks', 'Ordinary task', 'Finished');
    expect(mocks.notify).toHaveBeenCalledTimes(4);
  });

  it('retains shared completion identity longer than ordinary presentation dedupe', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await notifyDone('jarvis', 'First title', 'First body', {
      completionIdentity: 'jarvis-run:jrun-delayed',
    });
    now += 5_000;
    await notifyDone('jarvis', 'Later title', 'Later body', {
      completionIdentity: 'jarvis-run:jrun-delayed',
    });
    await notifyDone('jarvis', 'Ordinary title', 'Ordinary body');
    expect(mocks.notify).toHaveBeenCalledTimes(2);
  });

  it('keeps the shared completion dedupe hard bounded and test-resettable', async () => {
    for (let index = 0; index < 65; index += 1) {
      await notifyDone('jarvis', `Run ${index}`, 'Finished', {
        completionIdentity: `jarvis-run:jrun-${index}`,
      });
    }
    await notifyDone('jarvis', 'Run zero replay', 'Finished', {
      completionIdentity: 'jarvis-run:jrun-0',
    });
    expect(mocks.notify).toHaveBeenCalledTimes(66);

    resetDoneNotificationDedupeForTests();
    await notifyDone('jarvis', 'Run latest replay', 'Finished', {
      completionIdentity: 'jarvis-run:jrun-64',
    });
    expect(mocks.notify).toHaveBeenCalledTimes(67);
  });

  it('honors silent mode when notification sound is off', async () => {
    mocks.getState.mockReturnValue(enabledNotificationState({ notificationSound: false }));
    await notifyDone('jarvis', 'Jarvis done', 'Finished');
    expect(mocks.notify).toHaveBeenCalledWith(
      'Jarvis done',
      'Finished',
      expect.objectContaining({ silent: true }),
    );
  });

  it('sendTestNotification forces delivery even when master is off', async () => {
    mocks.getState.mockReturnValue(enabledNotificationState({ notificationMaster: false }));
    mocks.getNotificationPermission.mockResolvedValue('default');
    mocks.requestNotificationPermission.mockResolvedValue('granted');

    const result = await sendTestNotification();
    expect(mocks.requestNotificationPermission).toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(result.delivered).toBe(true);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('detects connector auth loss authenticated → unauthenticated only', () => {
    const fired = detectAndNotifyConnectorAuthLoss(
      {
        'openai-codex': { auth: 'authenticated' },
        'anthropic-claude-code': { auth: 'unauthenticated' },
      },
      {
        'openai-codex': { auth: 'unauthenticated' },
        'anthropic-claude-code': { auth: 'unauthenticated' },
        'new-one': { auth: 'unauthenticated' },
      },
      { 'openai-codex': 'Codex CLI' },
    );
    expect(fired).toEqual(['openai-codex']);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0][0]).toMatch(/expired|sign-in/i);
  });
});
