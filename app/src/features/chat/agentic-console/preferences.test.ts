import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONSOLE_PROFILES,
  DEFAULT_CONSOLE_PREFERENCES,
  loadConsolePreferences,
  parseChatPresentationCommand,
  saveConsolePreferences,
} from './preferences';

describe('agentic console preferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('exposes the ten approved scoped console profiles', () => {
    expect(CONSOLE_PROFILES.map((profile) => profile.label)).toEqual([
      'Paper White',
      'Solar Sand',
      'Sakura Mist',
      'Icebound',
      'VibeSpace Amber',
      'Graphite',
      'Midnight Blue',
      'Monokai Ember',
      'Matrix Moss',
      'OLED Void',
    ]);
  });

  it('fails safely to defaults for corrupt or unsupported stored data', () => {
    localStorage.setItem('vibespace.agentic-console.preferences', '{bad');
    expect(loadConsolePreferences()).toEqual(DEFAULT_CONSOLE_PREFERENCES);

    localStorage.setItem(
      'vibespace.agentic-console.preferences',
      JSON.stringify({ version: 99, view: 'made-up', profile: 'neon' }),
    );
    expect(loadConsolePreferences()).toEqual(DEFAULT_CONSOLE_PREFERENCES);
  });

  it('migrates the retired classic view to the current agentic surface', () => {
    saveConsolePreferences({
      version: 1,
      view: 'classic',
      profile: 'oled-void',
      density: 'compact',
      caret: 'block',
    });

    expect(loadConsolePreferences()).toEqual({
      version: 1,
      view: 'agentic',
      profile: 'oled-void',
      density: 'compact',
      caret: 'block',
    });
    expect(
      JSON.parse(localStorage.getItem('vibespace.agentic-console.preferences') ?? '{}'),
    ).toMatchObject({
      view: 'agentic',
    });
  });
});

describe('chat presentation command routing', () => {
  it('routes /theme to scoped console profiles', () => {
    expect(parseChatPresentationCommand('/theme Sakura Mist')).toEqual({
      kind: 'console-theme',
      profile: 'sakura-mist',
      notice: 'Chat console theme set to Sakura Mist.',
    });
  });

  it('routes /appearance to official global appearance without changing it itself', () => {
    expect(parseChatPresentationCommand('/appearance monochrome')).toEqual({
      kind: 'appearance',
      argument: 'monochrome',
    });
  });

  it('migrates legacy global /theme aliases to appearance with a notice', () => {
    expect(parseChatPresentationCommand('/theme jarvis')).toEqual({
      kind: 'appearance',
      argument: 'jarvis',
      notice: 'Global themes moved to /appearance. Applying Jarvis Core.',
    });
  });

  it('returns bounded help for unknown or missing values', () => {
    expect(parseChatPresentationCommand('/theme')).toMatchObject({ kind: 'console-theme-help' });
    expect(parseChatPresentationCommand('/appearance unknown')).toEqual({
      kind: 'appearance',
      argument: 'unknown',
    });
    expect(parseChatPresentationCommand('/not-a-theme anything')).toBeNull();
  });
});
