import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { SettingsModal } from './SettingsModal';
import { useUIStore } from '@/stores/ui';
import { resolveSettingsTab, DEFAULT_SETTINGS_TAB } from './settingsPrefetch';

vi.mock('@/lib/admin', () => ({
  useAppAdmin: () => false,
}));

describe('SettingsModal Hive product gate', () => {
  it('hides the Hive nav tab while the product is gated', async () => {
    useUIStore.setState({ settingsOpen: true, route: 'chat' });
    render(<SettingsModal />);

    await waitFor(() => {
      expect(document.querySelector('#settings-tab-plans')).toBeTruthy();
    });
    expect(document.querySelector('#settings-tab-hive')).toBeNull();
    expect(document.querySelector('#settings-panel-hive')).toBeNull();
  });

  it('falls back gated hive deep links to the settings root', () => {
    expect(resolveSettingsTab('hive')).toBe(DEFAULT_SETTINGS_TAB);
    useUIStore.setState({ settingsOpen: true, route: 'chat' });
    render(<SettingsModal initialTab="hive" />);
    expect(document.querySelector('#settings-tab-hive')).toBeNull();
    expect(document.querySelector('#settings-tab-plans')).toBeTruthy();
  });
});
