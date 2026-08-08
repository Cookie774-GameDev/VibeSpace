import { DEFAULT_SETTINGS_TAB, resolveSettingsTab, type SettingsTab } from './settingsPrefetch';

let lastTab: SettingsTab = DEFAULT_SETTINGS_TAB;

export function getLastSettingsTab(): SettingsTab {
  return lastTab;
}

export function rememberSettingsTab(tab: SettingsTab | string): void {
  lastTab = resolveSettingsTab(tab);
}
