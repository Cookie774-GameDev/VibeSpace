import { afterEach, describe, expect, it } from 'vitest';
import { parseThemeCommandArgument } from '@/features/appearance/themes';
import { useUIStore } from '@/stores/ui';
import { getAppearanceCommandHelp, getThemeCommandHelp } from './Composer';

describe('Composer theme command boundary', () => {
  afterEach(() => {
    useUIStore.getState().setTheme('default');
  });

  it.each([
    ['warm', 'warm'],
    ['  MONO  ', 'monochrome'],
  ] as const)(
    'resolves %s and applies the release appearance through the real setter',
    (argument, expectedTheme) => {
      const theme = parseThemeCommandArgument(argument);

      expect(theme).toBe(expectedTheme);
      if (!theme) throw new Error('Expected a current release theme.');

      useUIStore.getState().setTheme(theme);

      expect(useUIStore.getState().theme).toBe(expectedTheme);
      expect(document.documentElement.dataset.themePreference).toBe(expectedTheme);
    },
  );

  it('separates scoped console themes from official global appearance themes', () => {
    expect(getThemeCommandHelp()).toBe(
      'Chat console themes: Paper White, Solar Sand, Sakura Mist, Icebound, VibeSpace Amber, Graphite, Midnight Blue, Monokai Ember, Matrix Moss, OLED Void. Use /theme <name>.',
    );
    expect(getAppearanceCommandHelp()).toBe(
      'Available appearances: Jarvis One, Default, MonoChrome, Warm. Use /themes or /appearance to choose.',
    );
    expect(parseThemeCommandArgument('vibespace')).toBeNull();
    expect(parseThemeCommandArgument('sakura')).toBeNull();
    expect(parseThemeCommandArgument('origami')).toBeNull();
    expect(parseThemeCommandArgument('dusk')).toBeNull();
    expect(parseThemeCommandArgument('blossom')).toBeNull();
  });
});
