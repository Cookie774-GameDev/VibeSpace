export type FullscreenLayer = 'focus' | 'system';

export type SystemFullscreenBehavior = 'always-hidden' | 'reveal-on-edge-hover';

export type FullscreenAvailability = 'available' | 'web-preview' | 'unavailable';

export interface FullscreenPreferences {
  rememberFocusMode: boolean;
  rememberSystemFullscreen: boolean;
  restoreFullscreenOnRestart: boolean;
  systemFullscreenBehavior: SystemFullscreenBehavior;
}

export interface FullscreenRestoreRecord {
  focusActive: boolean;
  systemActive: boolean;
  cleanShutdown: boolean;
  appVersion: string | null;
  recoveryLaunch: boolean;
}

export const DEFAULT_FULLSCREEN_PREFERENCES: Readonly<FullscreenPreferences> = Object.freeze({
  rememberFocusMode: false,
  rememberSystemFullscreen: false,
  restoreFullscreenOnRestart: false,
  systemFullscreenBehavior: 'always-hidden',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeFullscreenPreferences(value: unknown): FullscreenPreferences {
  if (!isRecord(value)) return { ...DEFAULT_FULLSCREEN_PREFERENCES };

  return {
    rememberFocusMode:
      typeof value.rememberFocusMode === 'boolean'
        ? value.rememberFocusMode
        : DEFAULT_FULLSCREEN_PREFERENCES.rememberFocusMode,
    rememberSystemFullscreen:
      typeof value.rememberSystemFullscreen === 'boolean'
        ? value.rememberSystemFullscreen
        : DEFAULT_FULLSCREEN_PREFERENCES.rememberSystemFullscreen,
    restoreFullscreenOnRestart:
      typeof value.restoreFullscreenOnRestart === 'boolean'
        ? value.restoreFullscreenOnRestart
        : DEFAULT_FULLSCREEN_PREFERENCES.restoreFullscreenOnRestart,
    systemFullscreenBehavior:
      value.systemFullscreenBehavior === 'always-hidden' ||
      value.systemFullscreenBehavior === 'reveal-on-edge-hover'
        ? value.systemFullscreenBehavior
        : DEFAULT_FULLSCREEN_PREFERENCES.systemFullscreenBehavior,
  };
}

export function activateLayer(
  order: readonly FullscreenLayer[],
  layer: FullscreenLayer,
): FullscreenLayer[] {
  return [...order.filter((item) => item !== layer), layer];
}

export function deactivateLayer(
  order: readonly FullscreenLayer[],
  layer: FullscreenLayer,
): FullscreenLayer[] {
  return order.filter((item) => item !== layer);
}

export function lastActiveLayer(order: readonly FullscreenLayer[]): FullscreenLayer | null {
  return order.at(-1) ?? null;
}

export function resolveRestorableLayers(input: {
  preferences: FullscreenPreferences;
  record: FullscreenRestoreRecord;
  currentVersion: string;
}): FullscreenLayer[] {
  const { preferences, record, currentVersion } = input;
  if (
    !preferences.restoreFullscreenOnRestart ||
    !record.cleanShutdown ||
    record.appVersion !== currentVersion ||
    record.recoveryLaunch
  ) {
    return [];
  }

  const layers: FullscreenLayer[] = [];
  if (preferences.rememberFocusMode && record.focusActive) layers.push('focus');
  if (preferences.rememberSystemFullscreen && record.systemActive) layers.push('system');
  return layers;
}
