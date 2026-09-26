import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RELAY_SETTINGS,
  normalizeRelaySettings,
  readRelaySettings,
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
});
