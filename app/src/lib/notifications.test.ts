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
  notifyApiKeyExpired,
  notifyApiKeyRejected,
  notifyConnectorAuthExpired,
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

  it.each(['denied', 'unavailable'] as const)('S61B2 retries an unaccepted %s identity immediately after recovery', async permission => {
    mocks.notify.mockResolvedValueOnce({ channel: 'none', permission, message: 'No native send' });
    const identity = { completionIdentity: `S61B2-event-${permission}` };
    expect((await notifyDone('reminders', 'S61B2 event', 'Due', identity))?.channel).toBe('none');
    mocks.notify.mockResolvedValueOnce({ channel: 'native', permission: 'granted', message: 'Accepted' });
    expect((await notifyDone('reminders', 'S61B2 event', 'Due', identity))?.channel).toBe('native');
    expect(await notifyDone('reminders', 'S61B2 event', 'Due', identity)).toBeNull();
    expect(mocks.notify).toHaveBeenCalledTimes(2);
  });

  it('S61B2 retains suppression for a granted but uncertain native outcome', async () => {
    mocks.notify.mockResolvedValueOnce({ channel: 'none', permission: 'granted', message: 'Unconfirmed' });
    const identity = { completionIdentity: 'S61B2-uncertain' };
    await notifyDone('reminders', 'S61B2 event', 'Due', identity);
    expect(await notifyDone('reminders', 'S61B2 event', 'Due', identity)).toBeNull();
    expect(mocks.notify).toHaveBeenCalledOnce();
  });

  it('S61B2 does not repeat a rejected adapter call with an ambiguous acceptance', async () => {
    mocks.notify.mockRejectedValueOnce(new Error('adapter outcome unknown'));
    const identity = { completionIdentity: 'S61B2-throw' };
    await expect(notifyDone('reminders', 'S61B2 event', 'Due', identity)).rejects.toThrow('adapter outcome unknown');
    expect(await notifyDone('reminders', 'S61B2 event', 'Due', identity)).toBeNull();
    expect(mocks.notify).toHaveBeenCalledOnce();
  });

  it('S61B2 suppresses concurrent duplicate while native acknowledgement is pending', async () => {
    let complete!: (result: { channel: 'native'; permission: 'granted'; message: string }) => void;
    mocks.notify.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const identity = { completionIdentity: 'S61B2-flight' };
    const first = notifyDone('reminders', 'S61B2 event', 'Due', identity);
    expect(await notifyDone('reminders', 'S61B2 event', 'Due', identity)).toBeNull();
    complete({ channel: 'native', permission: 'granted', message: 'Accepted' });
    await expect(first).resolves.toMatchObject({ channel: 'native' });
    expect(mocks.notify).toHaveBeenCalledOnce();
  });
  it('S61B2 does not clear a newer accepted reservation when an old attempt fails late', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let finishOld!: (result: { channel: 'none'; permission: 'denied'; message: string }) => void;
    mocks.notify.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const identity = { completionIdentity: 'S61B2-late-old' };
    const old = notifyDone('reminders', 'S61B2 event', 'Due', identity);
    now += 10 * 60_000 + 1;
    await notifyDone('reminders', 'S61B2 event', 'Due', identity);
    finishOld({ channel: 'none', permission: 'denied', message: 'Old attempt denied' });
    await old;
    expect(await notifyDone('reminders', 'S61B2 event', 'Due', identity)).toBeNull();
    expect(mocks.notify).toHaveBeenCalledTimes(2);
  });

  it('S61B2 failed explicit skipDedupe test cannot remove an accepted identity', async () => {
    const identity = { completionIdentity: 'S61B2-test-override' };
    await notifyDone('reminders', 'S61B2 event', 'Due', identity);
    mocks.notify.mockResolvedValueOnce({ channel: 'none', permission: 'denied', message: 'Test denied' });
    await notifyDone('reminders', 'S61B2 event', 'Due', { ...identity, skipDedupe: true });
    expect(await notifyDone('reminders', 'S61B2 event', 'Due', identity)).toBeNull();
    expect(mocks.notify).toHaveBeenCalledTimes(2);
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
    expect(mocks.notify.mock.calls[0][2]).toEqual(
      expect.objectContaining({ variant: 'credential_expired', fallbackToast: true }),
    );
  });

  it('bounds a connector label and detail in the native notification', async () => {
    notifyConnectorAuthExpired(`Codex ${'very-long-name-'.repeat(8)}`, 'Reconnect. '.repeat(30));
    await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalledTimes(1));
    const [title, body] = mocks.notify.mock.calls[0];
    expect(title.length).toBeLessThanOrEqual(58);
    expect(body.length).toBeLessThan(110);
    expect(body).toContain('Detected ');
  });

  it('shows the Codex name for an expired OpenAI Codex connector', async () => {
    notifyConnectorAuthExpired('openai-codex');
    await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalledTimes(1));
    expect(mocks.notify.mock.calls[0][0]).toBe('Codex authorization expired');
  });

  it('uses distinct context-map artwork and completed-task artwork for terminal success', async () => {
    mocks.getState.mockReturnValue(
      enabledNotificationState({
        doneNotifications: {
          ...enabledNotificationState().doneNotifications,
          contextMaps: true,
          terminal: true,
        },
      }),
    );
    await notifyDone('contextMaps', 'Context map ready', '2,500 files indexed with SiYuan.');
    await notifyDone('terminal', 'Terminal done', 'Command finished successfully.');
    expect(mocks.notify.mock.calls[0]).toEqual([
      'Context map ready',
      '2,500 files indexed with SiYuan.',
      expect.objectContaining({ variant: 'context_map_completed', fallbackToast: true }),
    ]);
    expect(mocks.notify.mock.calls[1][2]).toEqual(
      expect.objectContaining({ variant: 'task_completed', fallbackToast: true }),
    );
  });

  it('fills a bounded Deepgram expiry notice with observed time and repair path', async () => {
    await notifyApiKeyExpired('Deepgram', new Date('2026-09-27T14:35:00'));
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    const [title, body, options] = mocks.notify.mock.calls[0];
    expect(title).toBe('Deepgram API key expired');
    expect(body).toMatch(/Detected .*2:35|Detected .*14:35/);
    expect(body).toContain('Settings → Speech to Text');
    expect(title.length).toBeLessThan(60);
    expect(body.length).toBeLessThan(120);
    expect(options).toEqual(
      expect.objectContaining({
        variant: 'credential_expired',
        fallbackToast: true,
      }),
    );
    expect(`${title} ${body}`).not.toContain('sk-');
  });

  it('honors connector notification settings for expired API keys', async () => {
    mocks.getState.mockReturnValue(
      enabledNotificationState({
        doneNotifications: { ...enabledNotificationState().doneNotifications, connectors: false },
      }),
    );
    expect(await notifyApiKeyExpired('Deepgram')).toBeNull();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('reports a rejected Deepgram key without asserting expiration', async () => {
    await notifyApiKeyRejected('Deepgram', new Date('2026-09-27T14:35:00'));
    const [title, body, options] = mocks.notify.mock.calls[0];
    expect(title).toBe('Deepgram authorization failed');
    expect(body).toContain('Settings → Speech to Text');
    expect(body).toContain('35');
    expect(`${title} ${body}`).not.toMatch(/expired|private-key/i);
    expect(options.variant).toBe('credential_expired');
    await notifyApiKeyRejected('Deepgram', new Date('2026-09-27T14:36:00'));
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });
});
