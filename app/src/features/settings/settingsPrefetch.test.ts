import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS_TAB,
  isGatedHiveSettingsTab,
  isLegacySettingsAccountTab,
  isSettingsTab,
  resolveSettingsTab,
} from './settingsPrefetch';
import { getLastSettingsTab, rememberSettingsTab } from './settingsTabMemory';

describe('settingsPrefetch Account removal', () => {
  it('no longer treats account as a Settings tab', () => {
    expect(isSettingsTab('account')).toBe(false);
    expect(isSettingsTab('plans')).toBe(true);
    expect(isLegacySettingsAccountTab('account')).toBe(true);
    expect(isLegacySettingsAccountTab('plans')).toBe(false);
    expect(isSettingsTab('browseragent')).toBe(true);
  });

  it('maps legacy account onto the settings root', () => {
    expect(resolveSettingsTab('account')).toBe(DEFAULT_SETTINGS_TAB);
    expect(resolveSettingsTab('voice')).toBe('voice');
    expect(resolveSettingsTab('browseragent')).toBe('browseragent');
    expect(resolveSettingsTab('not-a-tab')).toBe(DEFAULT_SETTINGS_TAB);
    expect(DEFAULT_SETTINGS_TAB).toBe('plans');
  });

  it('remembers only real settings tabs', () => {
    rememberSettingsTab('account');
    expect(getLastSettingsTab()).toBe('plans');
    rememberSettingsTab('appearance');
    expect(getLastSettingsTab()).toBe('appearance');
  });
});

describe('settingsPrefetch Hive product gate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps hive in the SettingsTab type union for recovery', () => {
    expect(isSettingsTab('hive')).toBe(true);
  });

  it('redirects gated hive deep links to the settings root by default', () => {
    expect(isGatedHiveSettingsTab('hive')).toBe(true);
    expect(resolveSettingsTab('hive')).toBe(DEFAULT_SETTINGS_TAB);
    rememberSettingsTab('hive');
    expect(getLastSettingsTab()).toBe(DEFAULT_SETTINGS_TAB);
  });
});
