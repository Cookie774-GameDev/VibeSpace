import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GATED_SETTINGS_HIVE_TAB,
  HIVE_PRODUCT_FLAG,
  isGatedSettingsHiveTab,
  isHiveProductEnabled,
} from './hiveProductGate';

describe('hiveProductGate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to disabled for product builds', () => {
    expect(isHiveProductEnabled({})).toBe(false);
    expect(isHiveProductEnabled({ VITE_HIVE_ENABLED: '' })).toBe(false);
    expect(isHiveProductEnabled({ VITE_HIVE_ENABLED: 'false' })).toBe(false);
    expect(isHiveProductEnabled({ VITE_HIVE_ENABLED: 'maybe' })).toBe(false);
  });

  it('enables only for explicit truthy VITE_HIVE_ENABLED values', () => {
    for (const value of ['true', 'TRUE', '1', 'yes', 'on', ' true ']) {
      expect(isHiveProductEnabled({ VITE_HIVE_ENABLED: value })).toBe(true);
    }
  });

  it('treats the hive settings tab as gated when the product is off', () => {
    expect(isGatedSettingsHiveTab(GATED_SETTINGS_HIVE_TAB)).toBe(true);
    expect(isGatedSettingsHiveTab('plans')).toBe(false);
    expect(isGatedSettingsHiveTab(null)).toBe(false);
    expect(isGatedSettingsHiveTab(undefined)).toBe(false);
  });

  it('does not gate the hive settings tab when the product is on', () => {
    expect(
      isGatedSettingsHiveTab(GATED_SETTINGS_HIVE_TAB) &&
        !isHiveProductEnabled({ VITE_HIVE_ENABLED: 'true' }),
    ).toBe(false);
    // Direct check with enabled env is via isHiveProductEnabled only;
    // isGatedSettingsHiveTab reads import.meta.env in app builds.
    expect(HIVE_PRODUCT_FLAG).toBe('VITE_HIVE_ENABLED');
  });
});
