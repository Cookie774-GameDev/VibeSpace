import type { SettingsTab } from './settingsPrefetch';

let lastTab: SettingsTab = 'account';

export function getLastSettingsTab(): SettingsTab {
  return lastTab;
}

export function rememberSettingsTab(tab: SettingsTab): void {
  lastTab = tab;
}
