import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const notificationState = vi.hoisted(() => ({
  notificationMaster: true,
  setNotificationMaster: vi.fn(),
  doneNotifications: {
    jarvis: true,
    terminal: true,
    tasks: true,
    contextMaps: true,
    skills: true,
    connectors: true,
    reminders: true,
  },
  setDoneNotification: vi.fn(),
  aiCompletionCue: true,
  setAiCompletionCue: vi.fn(),
  notificationSound: true,
  setNotificationSound: vi.fn(),
  notificationBadge: false,
  setNotificationBadge: vi.fn(),
}));

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (state: typeof notificationState) => unknown) =>
    selector(notificationState),
}));

vi.mock('@/lib/assistantPersona', () => ({
  useAssistantPersonaName: () => 'Jarvis',
  assistantPersonaDisplayName: () => 'Jarvis',
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
    jarvis: 'Jarvis done',
    terminal: 'Terminal done',
    tasks: 'Task done',
    contextMaps: 'Context map done',
    skills: 'Skill done',
    connectors: 'Connector / auth expired',
    reminders: 'Task reminders',
  }),
  readNotificationPermission: vi.fn(async () => 'granted'),
  ensureOsNotificationPermission: vi.fn(async () => 'granted'),
  sendTestNotification: vi.fn(async () => ({
    channel: 'toast',
    permission: 'granted',
    delivered: true,
    message: 'ok',
  })),
  notifyDone: vi.fn(),
}));

import { Notifications } from './Notifications';

describe('Notifications MonoChrome appearance', () => {
  afterEach(cleanup);

  it('flattens every visible Switch thumb and disables track/thumb motion only in MonoChrome or reduced motion', () => {
    render(<Notifications />);

    // master + sound + badge + 7 categories + ai completion cue = 11
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(11);

    for (const control of switches) {
      expect(control.firstElementChild?.className).toContain('shadow-lg');
      expect(control.className).toContain('[html[data-theme=monochrome]_&_span]:shadow-none');
      expect(control.className).toContain('[html[data-theme=monochrome]_&]:transition-none');
      expect(control.className).toContain('[html[data-theme=monochrome]_&_span]:transition-none');
      expect(control.className).toContain('motion-reduce:transition-none');
      expect(control.className).toContain('motion-reduce:[&_span]:transition-none');
    }
  });

  it('keeps Send test enabled even when categories are on (always clickable control)', () => {
    render(<Notifications />);
    const sendTest = screen.getByRole('button', { name: /send test/i });
    expect(sendTest.hasAttribute('disabled')).toBe(false);
  });
});
