import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  SELECTABLE_THEME_IDS,
  THEME_COMMAND_ALIASES,
  THEME_DEFINITIONS,
  normalizePersistedTheme,
  parseSelectableTheme,
  parseThemeCommandArgument,
  parseThemeSyncMessage,
  resolveDocumentTheme,
} from './themeContract';
import type { ResolvedDocumentTheme, SelectableTheme } from './themeContract';

describe('canonical theme contract', () => {
  it('preserves the complete theme catalog for future releases', () => {
    expect(SELECTABLE_THEME_IDS).toEqual([
      'jarvis',
      'vibespace',
      'default',
      'monochrome',
      'sakura',
      'warm',
      'origami',
    ]);
    expectTypeOf<Parameters<typeof resolveDocumentTheme>[0]>().toEqualTypeOf<SelectableTheme>();
    expectTypeOf<ReturnType<typeof resolveDocumentTheme>>().toEqualTypeOf<ResolvedDocumentTheme>();
  });

  it('preserves VibeSpace metadata while deferring it from this release', () => {
    expect(THEME_DEFINITIONS.at(1)).toEqual({
      id: 'vibespace',
      label: 'VibeSpace',
      description: 'Pastel origami workspace.',
    });
    expect(parseSelectableTheme('vibespace')).toBeNull();
    expect(normalizePersistedTheme('vibespace')).toBe('default');
  });

  it('preserves Sakura metadata while deferring it from this release', () => {
    expect(THEME_DEFINITIONS.at(4)).toEqual({
      id: 'sakura',
      label: 'Sakura',
      description: 'Cel-painted dusk workspace.',
    });
    expect(parseSelectableTheme('sakura')).toBeNull();
    expect(normalizePersistedTheme('sakura')).toBe('default');
    expect(normalizePersistedTheme('dusk')).toBe('default');
  });

  it('publishes Warm as the owner-approved paper workspace theme', () => {
    expect(THEME_DEFINITIONS.at(-2)).toEqual({
      id: 'warm',
      label: 'Warm',
      description: 'Espresso and ivory paper workspace.',
    });
    expect(normalizePersistedTheme('warm')).toBe('warm');
  });

  it('preserves Origami metadata while deferring it from this release', () => {
    expect(THEME_DEFINITIONS.at(-1)).toEqual({
      id: 'origami',
      label: 'Origami',
      description: 'Sculpted paper workspace in motion.',
    });
    expect(parseSelectableTheme('origami')).toBeNull();
    expect(normalizePersistedTheme('origami')).toBe('default');
  });

  it('parses only themes enabled for the current release', () => {
    for (const theme of ['jarvis', 'default', 'monochrome', 'warm'] as const) {
      expect(parseSelectableTheme(theme)).toBe(theme);
    }

    for (const value of [
      'sakura',
      'origami',
      'vibespace',
      'light',
      'dark',
      'system',
      'mono',
      'MONOCHROME',
      '',
      null,
      {},
    ]) {
      expect(parseSelectableTheme(value)).toBeNull();
    }
  });

  it('normalizes every persisted value to a canonical theme', () => {
    expect(normalizePersistedTheme('light')).toBe('monochrome');
    expect(normalizePersistedTheme('dark')).toBe('default');
    expect(normalizePersistedTheme('system')).toBe('default');
    expect(normalizePersistedTheme('monochrome')).toBe('monochrome');
    expect(normalizePersistedTheme('jarvis')).toBe('jarvis');

    for (const value of ['mono', 'unknown', '', null, undefined, {}, 42]) {
      expect(normalizePersistedTheme(value)).toBe('default');
    }
  });

  it('resolves canonical preferences to document themes', () => {
    expect(resolveDocumentTheme('jarvis')).toBe('jarvis');
    expect(resolveDocumentTheme('vibespace')).toBe('vibespace');
    expect(resolveDocumentTheme('default')).toBe('dark');
    expect(resolveDocumentTheme('monochrome')).toBe('monochrome');
    expect(resolveDocumentTheme('sakura')).toBe('sakura');
    expect(resolveDocumentTheme('warm')).toBe('warm');
    expect(resolveDocumentTheme('origami')).toBe('origami');
  });

  it('parses command aliases case-insensitively after trimming', () => {
    const aliases = {
      jarvis: 'jarvis',
      'jarvis core': 'jarvis',
      'jarvis one': 'jarvis',
      core: 'jarvis',
      default: 'default',
      dark: 'default',
      monochrome: 'monochrome',
      mono: 'monochrome',
      terminal: 'monochrome',
      light: 'monochrome',
      warm: 'warm',
      cozy: 'warm',
    } as const;

    expect(THEME_COMMAND_ALIASES).toEqual(aliases);

    for (const [alias, theme] of Object.entries(aliases)) {
      expect(parseThemeCommandArgument(`  ${alias.toUpperCase()}  `)).toBe(theme);
    }

    for (const value of ['dusk', 'blossom', 'system', 'unknown', '']) {
      expect(parseThemeCommandArgument(value)).toBeNull();
    }
  });

  it('accepts release-enabled sync messages plus the exact legacy light value', () => {
    for (const theme of ['jarvis', 'default', 'monochrome', 'warm'] as const) {
      expect(parseThemeSyncMessage(theme)).toBe(theme);
    }

    expect(parseThemeSyncMessage('light')).toBe('monochrome');

    for (const value of [
      'sakura',
      'origami',
      'vibespace',
      'dark',
      'system',
      'mono',
      'terminal',
      'MONOCHROME',
      '',
      null,
      {},
    ]) {
      expect(parseThemeSyncMessage(value)).toBeNull();
    }
  });
});
