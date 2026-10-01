import { describe, expect, it } from 'vitest';
import { SELECTABLE_THEMES, migrateThemePreference, parseThemeCommandArgument } from './themes';

describe('appearance theme registry', () => {
  it('exposes only the four themes shipping in this release', () => {
    expect(SELECTABLE_THEMES.map((theme) => theme.id)).toEqual([
      'jarvis',
      'default',
      'monochrome',
      'warm',
    ]);
  });

  it('uses the accepted public labels and descriptions', () => {
    expect(SELECTABLE_THEMES).toEqual([
      {
        id: 'jarvis',
        label: 'Jarvis One',
        description: 'High-contrast command center.',
      },
      {
        id: 'default',
        label: 'Default',
        description: 'Warm, focused dark workspace.',
      },
      {
        id: 'monochrome',
        label: 'MonoChrome',
        description: 'Terminal-inspired developer console.',
      },
      {
        id: 'warm',
        label: 'Warm',
        description: 'Espresso and ivory paper workspace.',
      },
    ]);
  });

  it('migrates all legacy preferences through the canonical contract', () => {
    expect(migrateThemePreference('light')).toBe('monochrome');
    expect(migrateThemePreference('dark')).toBe('default');
    expect(migrateThemePreference('system')).toBe('default');
    // The approved Warm fallback also applies to deferred/unknown saved preferences.
    expect(migrateThemePreference('vibespace')).toBe('warm');
    expect(migrateThemePreference('sakura')).toBe('warm');
    expect(migrateThemePreference('warm')).toBe('warm');
    expect(migrateThemePreference('origami')).toBe('warm');
    expect(migrateThemePreference('dusk')).toBe('warm');
    expect(migrateThemePreference('unknown')).toBe('warm');
    for (const selected of ['jarvis', 'default', 'monochrome', 'warm'] as const) {
      expect(migrateThemePreference(selected)).toBe(selected);
    }
  });

  it('parses friendly /theme arguments', () => {
    expect(parseThemeCommandArgument('VibeSpace')).toBeNull();
    expect(parseThemeCommandArgument('jarvis core')).toBe('jarvis');
    expect(parseThemeCommandArgument('jarvis one')).toBe('jarvis');
    expect(parseThemeCommandArgument('dark')).toBe('default');
    expect(parseThemeCommandArgument('light')).toBe('monochrome');
    expect(parseThemeCommandArgument('terminal')).toBe('monochrome');
    expect(parseThemeCommandArgument('sakura')).toBeNull();
    expect(parseThemeCommandArgument('  SAKURA DUSK  ')).toBeNull();
    expect(parseThemeCommandArgument('cozy')).toBe('warm');
    expect(parseThemeCommandArgument('paperfold')).toBeNull();
    expect(parseThemeCommandArgument('dusk')).toBeNull();
    expect(parseThemeCommandArgument('nope')).toBeNull();
  });
});
