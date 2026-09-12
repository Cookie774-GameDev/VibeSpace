import {
  RELEASE_THEME_DEFINITIONS,
  normalizePersistedTheme,
  parseSelectableTheme,
  parseThemeCommandArgument,
} from './themeContract';
import type { SelectableTheme, ThemeDefinition } from './themeContract';

export type { SelectableTheme, ThemeDefinition };

export const SELECTABLE_THEMES: readonly ThemeDefinition[] = RELEASE_THEME_DEFINITIONS;

export const migrateThemePreference = normalizePersistedTheme;

export function isSelectableTheme(theme: unknown): theme is SelectableTheme {
  return parseSelectableTheme(theme) !== null;
}

export { parseThemeCommandArgument };
