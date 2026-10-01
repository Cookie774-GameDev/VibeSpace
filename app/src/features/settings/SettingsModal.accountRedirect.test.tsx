import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '@/stores/ui';
import { SettingsModal } from './SettingsModal';

vi.mock('@/lib/admin', () => ({
  useAppAdmin: () => false,
}));

// Avoid loading every settings section in this navigation contract test.
vi.mock('./sections/Plans', () => ({
  Plans: () => <div data-testid="settings-plans-panel">Plans</div>,
}));
vi.mock('./sections/Providers', () => ({ Providers: () => null }));
vi.mock('./sections/SubscriptionCliBridge', () => ({ SubscriptionCliBridge: () => null }));
vi.mock('./sections/Hive', () => ({ Hive: () => null }));
vi.mock('./sections/AllAboutMe', () => ({ AllAboutMe: () => null }));
vi.mock('@/features/plugins/Plugins', () => ({ Plugins: () => null }));
vi.mock('./sections/LocalModels', () => ({ LocalModels: () => null }));
vi.mock('./sections/Appearance', () => ({ Appearance: () => null }));
vi.mock('./sections/Voice', () => ({ Voice: () => null }));
vi.mock('./sections/ComposerStt', () => ({ ComposerStt: () => null }));
vi.mock('./sections/PhoneVoice', () => ({ PhoneVoice: () => null }));
vi.mock('./sections/Ambient', () => ({ Ambient: () => null }));
vi.mock('./sections/Notifications', () => ({ Notifications: () => null }));
vi.mock('./sections/Accessibility', () => ({ Accessibility: () => null }));
vi.mock('./sections/Hotkeys', () => ({ Hotkeys: () => null }));
vi.mock('./sections/JarvisActions', () => ({ JarvisActions: () => null }));
vi.mock('./sections/Admin', () => ({ Admin: () => null }));
vi.mock('./sections/About', () => ({ About: () => null }));

describe('SettingsModal Account removal', () => {
  beforeEach(() => {
    useUIStore.setState({ settingsOpen: true, route: 'chat' });
  });

  afterEach(() => {
    cleanup();
    useUIStore.setState({ settingsOpen: false, route: 'chat' });
  });

  it('does not render a Settings Account nav item', async () => {
    render(<SettingsModal />);
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Plans' })).toBeTruthy();
    });
    expect(document.querySelector('#settings-tab-account')).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Account' })).toBeNull();
  });

  it('redirects legacy jarvis:settings:tab account events to Account Center', async () => {
    render(<SettingsModal />);
    await waitFor(() => {
      expect(document.querySelector('#settings-tab-plans')).not.toBeNull();
    });

    act(() => {
      window.dispatchEvent(new CustomEvent('jarvis:settings:tab', { detail: { tab: 'account' } }));
    });

    await waitFor(() => {
      expect(useUIStore.getState().route).toBe('account');
      expect(useUIStore.getState().settingsOpen).toBe(false);
    });
  });

  it('maps an obsolete initial Account tab to the Settings root', async () => {
    render(<SettingsModal initialTab={'account'} />);

    await waitFor(() => {
      expect(document.querySelector('#settings-tab-plans')?.getAttribute('aria-selected')).toBe(
        'true',
      );
    });
    expect(screen.queryByRole('tab', { name: 'Account' })).toBeNull();
  });
});
