import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  getVersion: vi.fn(),
}));

vi.mock('@/lib/utils', async (original) => ({
  ...(await original<typeof import('@/lib/utils')>()),
  isTauri: true,
}));
vi.mock('@/lib/tauri', () => ({ getAppVersion: mocks.getVersion }));
vi.mock('@/lib/updates', async (original) => ({
  ...(await original<typeof import('@/lib/updates')>()),
  getAutoUpdateEnabled: () => false,
  setAutoUpdateEnabled: vi.fn(),
  checkForAppUpdate: mocks.check,
}));

import { About } from './About';

describe('About update state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVersion.mockResolvedValue('1.5.0');
  });

  it('shows the real installed version, release channel, latest version, and notes link', async () => {
    mocks.check.mockResolvedValue({
      available: true,
      installed: false,
      version: '1.6.0',
      notes: 'Security and reliability update.',
      notesUrl: 'https://github.com/Cookie774-GameDev/VibeSpace/releases/tag/v1.6.0',
      releaseChannel: 'stable',
    });
    render(<About />);
    await waitFor(() => expect(screen.getByText('1.5.0')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(screen.getByText('Jarvis 1.6.0 is available')).toBeTruthy());
    expect(screen.getByText('Security and reliability update.')).toBeTruthy();
    expect(screen.getByText('1.6.0')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Release notes/i }).getAttribute('href')).toContain(
      '/tag/v1.6.0',
    );
  });

  it('reports failure without claiming the app is current', async () => {
    mocks.check.mockRejectedValue(new Error('GitHub rate limit reached.'));
    render(<About />);
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(screen.getByText('Update check failed')).toBeTruthy());
    expect(screen.getByText('GitHub rate limit reached.')).toBeTruthy();
    expect(screen.queryByText('Jarvis is up to date')).toBeNull();
  });
});
