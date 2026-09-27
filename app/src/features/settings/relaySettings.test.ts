import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canAutomaticallyParticipateInRelay,
  canParticipateInRelay,
  DEFAULT_RELAY_SETTINGS,
  normalizeRelaySettings,
  readRelaySettings,
  subscribeRelaySettings,
  writeRelaySettings,
} from './relaySettings';

describe('Agent Relay settings persistence', () => {
  beforeEach(() => localStorage.clear());

  it('defaults safely to Off with automatic participation disabled', () => {
    expect(readRelaySettings()).toEqual(DEFAULT_RELAY_SETTINGS);
  });

  it('persists scope, automatic participation, and normalized exclusions', () => {
    writeRelaySettings({
      scope: 'project',
      automaticParticipation: true,
      excludedParticipants: [' project-a ', 'session-b', 'project-a', ''],
    });

    expect(readRelaySettings()).toEqual({
      scope: 'project',
      automaticParticipation: true,
      excludedParticipants: ['project-a', 'session-b'],
    });
  });

  it('fails closed on corrupt or invalid stored values', () => {
    localStorage.setItem('vibespace:agent-relay:settings:v1', '{not json');
    expect(readRelaySettings()).toEqual(DEFAULT_RELAY_SETTINGS);
    expect(
      normalizeRelaySettings({
        scope: 'invalid',
        automaticParticipation: 'yes',
        excludedParticipants: ['ok', 3, 'ok'],
      }),
    ).toEqual({ scope: 'off', automaticParticipation: false, excludedParticipants: ['ok'] });
  });

  it('normalizes and returns a safe snapshot when storage throws', () => {
    const storage = {
      setItem: () => {
        throw new Error('storage disabled');
      },
    };
    expect(
      writeRelaySettings(
        { scope: 'entire-app', automaticParticipation: true, excludedParticipants: [] },
        storage,
      ),
    ).toEqual({ scope: 'entire-app', automaticParticipation: true, excludedParticipants: [] });
  });

  it('fails closed for disabled, out-of-project, excluded, and incomplete participants', () => {
    const projectSettings = {
      scope: 'project' as const,
      automaticParticipation: true,
      excludedParticipants: ['private-project', 'private-session'],
    };
    expect(
      canParticipateInRelay(
        projectSettings,
        { projectId: 'project-a', sessionId: 'session-a' },
        'project-a',
      ),
    ).toBe(true);
    expect(
      canParticipateInRelay(
        projectSettings,
        { projectId: 'project-b', sessionId: 'session-a' },
        'project-a',
      ),
    ).toBe(false);
    expect(
      canParticipateInRelay(
        projectSettings,
        { projectId: 'private-project', sessionId: 'session-a' },
        'private-project',
      ),
    ).toBe(false);
    expect(
      canParticipateInRelay(
        projectSettings,
        { projectId: 'project-a', sessionId: 'private-session' },
        'project-a',
      ),
    ).toBe(false);
    expect(canParticipateInRelay(projectSettings, { projectId: 'project-a' }, 'project-a')).toBe(
      false,
    );
    expect(
      canParticipateInRelay(
        DEFAULT_RELAY_SETTINGS,
        { projectId: 'project-a', sessionId: 'session-a' },
        'project-a',
      ),
    ).toBe(false);
    expect(
      canParticipateInRelay(
        { ...projectSettings, scope: 'entire-app' },
        { projectId: 'project-b', sessionId: 'session-b' },
        'project-a',
      ),
    ).toBe(true);
    expect(
      canAutomaticallyParticipateInRelay(
        projectSettings,
        { projectId: 'project-a', sessionId: 'session-a' },
        'project-a',
      ),
    ).toBe(true);
    expect(
      canAutomaticallyParticipateInRelay(
        { ...projectSettings, automaticParticipation: false },
        { projectId: 'project-a', sessionId: 'session-a' },
        'project-a',
      ),
    ).toBe(false);
  });

  it('notifies host subscribers after writes and stops notifying after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeRelaySettings(listener);

    writeRelaySettings({ ...DEFAULT_RELAY_SETTINGS, scope: 'project' });

    expect(listener).toHaveBeenCalledWith({
      scope: 'project',
      automaticParticipation: false,
      excludedParticipants: [],
    });
    unsubscribe();
    listener.mockClear();
    writeRelaySettings({ ...DEFAULT_RELAY_SETTINGS, scope: 'entire-app' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies multiple host subscribers once for a cross-window settings change', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeRelaySettings(first);
    const unsubscribeSecond = subscribeRelaySettings(second);

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'vibespace:agent-relay:settings:v1',
        newValue: JSON.stringify({ scope: 'entire-app', automaticParticipation: true }),
      }),
    );

    const nextSettings = {
      scope: 'entire-app',
      automaticParticipation: true,
      excludedParticipants: [],
    };
    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith(nextSettings);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(nextSettings);
    unsubscribeFirst();
    unsubscribeSecond();
  });

  it('fails closed when another app window clears local storage', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeRelaySettings(listener);

    window.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null }));

    expect(listener).toHaveBeenCalledWith(DEFAULT_RELAY_SETTINGS);
    unsubscribe();
  });
});
