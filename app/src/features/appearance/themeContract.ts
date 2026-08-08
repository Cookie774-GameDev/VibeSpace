import {
  DOCUMENT_THEME_BY_ID,
  PERSISTED_LEGACY_THEME_MAP,
  RELEASE_THEME_IDS,
  SYNC_LEGACY_THEME_MAP,
  THEME_COMMAND_ALIASES,
  THEME_FALLBACK_ID,
} from './themeContract.generated';
import type { ResolvedDocumentTheme, SelectableTheme } from './themeContract.generated';

export * from './themeContract.generated';

const selectableThemeIds: ReadonlySet<string> = new Set(RELEASE_THEME_IDS);

export function parseSelectableTheme(value: unknown): SelectableTheme | null {
  return typeof value === 'string' && selectableThemeIds.has(value)
    ? (value as SelectableTheme)
    : null;
}

export function normalizePersistedTheme(value: unknown): SelectableTheme {
  const canonical = parseSelectableTheme(value);
  if (canonical) return canonical;

  if (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(PERSISTED_LEGACY_THEME_MAP, value)
  ) {
    return PERSISTED_LEGACY_THEME_MAP[value as keyof typeof PERSISTED_LEGACY_THEME_MAP];
  }

  return THEME_FALLBACK_ID;
}

export function resolveDocumentTheme(theme: SelectableTheme): ResolvedDocumentTheme {
  return DOCUMENT_THEME_BY_ID[theme];
}

export function parseThemeCommandArgument(value: string): SelectableTheme | null {
  const alias = value.trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(THEME_COMMAND_ALIASES, alias)) {
    return null;
  }
  return THEME_COMMAND_ALIASES[alias as keyof typeof THEME_COMMAND_ALIASES];
}

export function parseThemeSyncMessage(value: unknown): SelectableTheme | null {
  const canonical = parseSelectableTheme(value);
  if (canonical) return canonical;

  if (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(SYNC_LEGACY_THEME_MAP, value)
  ) {
    return SYNC_LEGACY_THEME_MAP[value as keyof typeof SYNC_LEGACY_THEME_MAP];
  }

  return null;
}
