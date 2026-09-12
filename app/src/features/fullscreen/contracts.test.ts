import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FULLSCREEN_PREFERENCES,
  activateLayer,
  deactivateLayer,
  lastActiveLayer,
  normalizeFullscreenPreferences,
  resolveRestorableLayers,
} from './contracts';

describe('fullscreen contracts', () => {
  it('keeps layers unique and moves a reactivated layer to the most-recent position', () => {
    expect(activateLayer([], 'focus')).toEqual(['focus']);
    expect(activateLayer(['focus'], 'system')).toEqual(['focus', 'system']);
    expect(activateLayer(['focus', 'system'], 'focus')).toEqual(['system', 'focus']);
    expect(lastActiveLayer(['system', 'focus'])).toBe('focus');
    expect(deactivateLayer(['system', 'focus'], 'focus')).toEqual(['system']);
    expect(deactivateLayer(['system'], 'focus')).toEqual(['system']);
  });

  it('normalizes malformed preferences to safe defaults', () => {
    expect(
      normalizeFullscreenPreferences({
        rememberFocusMode: true,
        rememberSystemFullscreen: 'yes',
        restoreFullscreenOnRestart: 1,
        systemFullscreenBehavior: 'unsupported',
      }),
    ).toEqual({
      rememberFocusMode: true,
      rememberSystemFullscreen: false,
      restoreFullscreenOnRestart: false,
      systemFullscreenBehavior: 'always-hidden',
    });
    expect(normalizeFullscreenPreferences(null)).toEqual(DEFAULT_FULLSCREEN_PREFERENCES);
  });

  it('restores only remembered active layers after a clean same-version launch', () => {
    expect(
      resolveRestorableLayers({
        preferences: {
          rememberFocusMode: true,
          rememberSystemFullscreen: false,
          restoreFullscreenOnRestart: true,
          systemFullscreenBehavior: 'reveal-on-edge-hover',
        },
        record: {
          focusActive: true,
          systemActive: true,
          cleanShutdown: true,
          appVersion: '1.5.0',
          recoveryLaunch: false,
        },
        currentVersion: '1.5.0',
      }),
    ).toEqual(['focus']);
  });

  it.each([
    {
      name: 'master restore disabled',
      restoreFullscreenOnRestart: false,
      cleanShutdown: true,
      appVersion: '1.5.0',
      recoveryLaunch: false,
    },
    {
      name: 'unclean shutdown',
      restoreFullscreenOnRestart: true,
      cleanShutdown: false,
      appVersion: '1.5.0',
      recoveryLaunch: false,
    },
    {
      name: 'application version changed',
      restoreFullscreenOnRestart: true,
      cleanShutdown: true,
      appVersion: '1.4.9',
      recoveryLaunch: false,
    },
    {
      name: 'recovery launch',
      restoreFullscreenOnRestart: true,
      cleanShutdown: true,
      appVersion: '1.5.0',
      recoveryLaunch: true,
    },
  ])('suppresses restoration after $name', (scenario) => {
    expect(
      resolveRestorableLayers({
        preferences: {
          rememberFocusMode: true,
          rememberSystemFullscreen: true,
          restoreFullscreenOnRestart: scenario.restoreFullscreenOnRestart,
          systemFullscreenBehavior: 'always-hidden',
        },
        record: {
          focusActive: true,
          systemActive: true,
          cleanShutdown: scenario.cleanShutdown,
          appVersion: scenario.appVersion,
          recoveryLaunch: scenario.recoveryLaunch,
        },
        currentVersion: '1.5.0',
      }),
    ).toEqual([]);
  });
});
