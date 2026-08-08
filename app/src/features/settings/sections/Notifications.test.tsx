import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendTestNotification: vi.fn(),
  readNotificationPermission: vi.fn(),
  ensureOsNotificationPermission: vi.fn(),
  setNotificationMaster: vi.fn(),
  setDoneNotification: vi.fn(),
  setAiCompletionCue: vi.fn(),
  setNotificationSound: vi.fn(),
  setNotificationBadge: vi.fn(),
  state: {
    notificationMaster: false,
    doneNotifications: {
      jarvis: false,
      terminal: false,
      tasks: false,
      contextMaps: false,
      skills: false,
      connectors: false,
      reminders: false,
    },
    aiCompletionCue: false,
    notificationSound: true,
    notificationBadge: false,
  },
}));

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      ...mocks.state,
      setNotificationMaster: mocks.setNotificationMaster,
      setDoneNotification: mocks.setDoneNotification,
      setAiCompletionCue: mocks.setAiCompletionCue,
      setNotificationSound: mocks.setNotificationSound,
      setNotificationBadge: mocks.setNotificationBadge,
    }),
}));

vi.mock('@/lib/assistantPersona', () => ({
  useAssistantPersonaName: () => 'Friday',
  assistantPersonaDisplayName: () => 'Friday',
}));

vi.mock('@/lib/notifications', () => ({
  DONE_NOTIFICATION_KEYS: [
    'jarvis',
    'terminal',
    'tasks',
    'contextMaps',
    'skills',
    'connectors',
    'reminders',
  ],
  DONE_NOTIFICATION_DESCRIPTIONS: {
    jarvis: 'When an AI chat response finishes.',
    terminal: 'When a terminal command exits.',
    tasks: 'When a task is marked done.',
    contextMaps: 'When a Context map finishes generating.',
    skills: 'When a skill is enabled or disabled.',
    connectors: 'When a connector loses authorization.',
    reminders: 'When a task reminder is due.',
  },
  getDoneNotificationLabels: () => ({
    jarvis: 'Friday done',
    terminal: 'Terminal done',
    tasks: 'Task done',
    contextMaps: 'Context map done',
    skills: 'Skill done',
    connectors: 'Connector / auth expired',
    reminders: 'Task reminders',
  }),
  readNotificationPermission: mocks.readNotificationPermission,
  ensureOsNotificationPermission: mocks.ensureOsNotificationPermission,
  sendTestNotification: mocks.sendTestNotification,
}));

import { Notifications } from './Notifications';

describe('Notifications settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.notificationMaster = false;
    mocks.readNotificationPermission.mockResolvedValue('default');
    mocks.ensureOsNotificationPermission.mockResolvedValue('granted');
    mocks.sendTestNotification.mockResolvedValue({
      channel: 'toast',
      permission: 'denied',
      delivered: true,
      message:
        'Browser notifications are blocked. Showing an in-app toast instead. Allow notifications for this site in the browser address bar.',
    });
  });

  afterEach(cleanup);

  it('shows Friday in AI completion cue copy and keeps Send test clickable with master off', async () => {
    render(<Notifications />);

    expect(screen.getByText(/Ask Friday to say when work is done/i)).toBeTruthy();
    expect(screen.getByText(/DONE:/i)).toBeTruthy();
    expect(screen.getByText(/BLOCKED:/i)).toBeTruthy();
    expect(screen.getByText('Friday done')).toBeTruthy();
    expect(screen.getByText('Connector / auth expired')).toBeTruthy();
    expect(screen.getByText('Task reminders')).toBeTruthy();

    const sendTest = screen.getByRole('button', { name: /send test/i });
    expect(sendTest.hasAttribute('disabled')).toBe(false);

    fireEvent.click(sendTest);
    await waitFor(() => {
      expect(mocks.sendTestNotification).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId('notification-test-feedback').textContent).toMatch(
        /blocked|toast/i,
      );
    });
  });

  it('requests permission and surfaces status', async () => {
    render(<Notifications />);
    await waitFor(() => {
      expect(mocks.readNotificationPermission).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole('button', { name: /request permission/i }));
    await waitFor(() => {
      expect(mocks.ensureOsNotificationPermission).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByTestId('notification-test-feedback').textContent).toMatch(
        /granted|permission/i,
      );
    });
  });
});
