export type SettingsTab =
  | 'account'
  | 'plans'
  | 'providers'
  | 'hive'
  | 'plugins'
  | 'localmodels'
  | 'appearance'
  | 'voice'
  | 'composerstt'
  | 'phone'
  | 'ambient'
  | 'notifications'
  | 'accessibility'
  | 'hotkeys'
  | 'jarvisactions'
  | 'admin'
  | 'about';

const TAB_IMPORTS: Record<SettingsTab, () => Promise<unknown>> = {
  account: () => import('./sections/Account'),
  plans: () => import('./sections/Plans'),
  providers: () => import('./sections/Providers'),
  hive: () => import('./sections/Hive'),
  plugins: () => import('@/features/plugins/Plugins'),
  localmodels: () => import('./sections/LocalModels'),
  appearance: () => import('./sections/Appearance'),
  voice: () => import('./sections/Voice'),
  composerstt: () => import('./sections/ComposerStt'),
  phone: () => import('./sections/PhoneVoice'),
  ambient: () => import('./sections/Ambient'),
  notifications: () => import('./sections/Notifications'),
  accessibility: () => import('./sections/Accessibility'),
  hotkeys: () => import('./sections/Hotkeys'),
  jarvisactions: () => import('./sections/JarvisActions').then((m) => ({ default: m.JarvisActions })),
  admin: () => import('./sections/Admin'),
  about: () => import('./sections/About'),
};

const prefetched = new Set<SettingsTab>();

/** Warm the JS chunk for a settings tab (no-op after first load). */
export function prefetchSettingsTab(tab: SettingsTab): void {
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
      if (tab !== exclude) prefetchSettingsTab(tab);
    }
  };
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout: 2500 });
  } else {
    window.setTimeout(run, 0);
  }
}
