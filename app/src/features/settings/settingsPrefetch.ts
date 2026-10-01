import { isHiveProductEnabled } from '@/lib/features/hiveProductGate';

export type SettingsTab =
  | 'general'
  | 'plans'
  | 'providers'
  | 'connections'
  | 'hive'
  | 'allaboutme'
  | 'plugins'
  | 'localmodels'
  | 'browseragent'
  | 'appearance'
  | 'voice'
  | 'composerstt'
  | 'phone'
  | 'ambient'
  | 'notifications'
  | 'telemetry'
  | 'accessibility'
  | 'hotkeys'
  | 'jarvisactions'
  | 'admin'
  | 'about';

/** First-class settings root after the Settings Account tab was removed. */
export const DEFAULT_SETTINGS_TAB: SettingsTab = 'plans';

/**
 * Legacy settings tab id that previously opened a duplicate Account panel.
 * Callers must redirect this to the Account Center route (or settings root).
 */
export const LEGACY_SETTINGS_ACCOUNT_TAB = 'account' as const;

/** Scrapped Hive settings tab — retained for deep-link fallback + recovery. */
export const GATED_SETTINGS_HIVE_TAB = 'hive' as const;

const TAB_IMPORTS: Record<SettingsTab, () => Promise<unknown>> = {
  general: () => import('./sections/General'),
  plans: () => import('./sections/Plans'),
  providers: () => import('./sections/Providers'),
  connections: () => import('./sections/SubscriptionCliBridge'),
  hive: () => import('./sections/Hive'),
  allaboutme: () => import('./sections/AllAboutMe').then((m) => ({ default: m.AllAboutMe })),
  plugins: () => import('@/features/plugins/Plugins'),
  localmodels: () => import('./sections/LocalModels'),
  browseragent: () =>
    import('./sections/BrowserAgentSettings').then((m) => ({ default: m.BrowserAgentSettings })),
  appearance: () => import('./sections/Appearance'),
  voice: () => import('./sections/Voice'),
  composerstt: () => import('./sections/ComposerStt'),
  phone: () => import('./sections/PhoneVoice'),
  ambient: () => import('./sections/Ambient'),
  notifications: () => import('./sections/Notifications'),
  telemetry: () => import('./sections/Telemetry'),
  accessibility: () => import('./sections/Accessibility'),
  hotkeys: () => import('./sections/Hotkeys'),
  jarvisactions: () =>
    import('./sections/JarvisActions').then((m) => ({ default: m.JarvisActions })),
  admin: () => import('./sections/Admin'),
  about: () => import('./sections/About'),
};

const SETTINGS_TAB_SET = new Set<string>(Object.keys(TAB_IMPORTS));

const prefetched = new Set<SettingsTab>();

export function isSettingsTab(value: string | null | undefined): value is SettingsTab {
  return typeof value === 'string' && SETTINGS_TAB_SET.has(value);
}

/**
 * True when the request targets Hive while the product surface is gated off.
 * Stale deep links and memory should fall back to the settings root.
 */
export function isGatedHiveSettingsTab(value: string | null | undefined): boolean {
  return value === GATED_SETTINGS_HIVE_TAB && !isHiveProductEnabled();
}

/**
 * Map a requested settings tab (including the removed Account tab and gated
 * Hive tab) onto a real Settings modal tab. Legacy `account` and gated `hive`
 * become the settings root.
 */
export function resolveSettingsTab(value: string | null | undefined): SettingsTab {
  if (value === LEGACY_SETTINGS_ACCOUNT_TAB) return DEFAULT_SETTINGS_TAB;
  if (isGatedHiveSettingsTab(value)) return DEFAULT_SETTINGS_TAB;
  return isSettingsTab(value) ? value : DEFAULT_SETTINGS_TAB;
}

/** True when the request targets the retired Settings → Account surface. */
export function isLegacySettingsAccountTab(value: string | null | undefined): boolean {
  return value === LEGACY_SETTINGS_ACCOUNT_TAB;
}

/** Warm the JS chunk for a settings tab (no-op after first load). */
export function prefetchSettingsTab(tab: SettingsTab): void {
  // Do not pull the Hive chunk while the product surface is gated off.
  if (tab === GATED_SETTINGS_HIVE_TAB && !isHiveProductEnabled()) return;
  if (prefetched.has(tab)) return;
  prefetched.add(tab);
  void TAB_IMPORTS[tab]().catch(() => {
    prefetched.delete(tab);
  });
}

/** Idle-prefetch every settings section so tab clicks feel instant. */
export function prefetchAllSettingsTabs(exclude?: SettingsTab): void {
  const run = () => {
    for (const tab of Object.keys(TAB_IMPORTS) as SettingsTab[]) {
      if (tab === exclude) continue;
      if (tab === GATED_SETTINGS_HIVE_TAB && !isHiveProductEnabled()) continue;
      prefetchSettingsTab(tab);
    }
  };
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout: 2500 });
  } else {
    window.setTimeout(run, 0);
  }
}
