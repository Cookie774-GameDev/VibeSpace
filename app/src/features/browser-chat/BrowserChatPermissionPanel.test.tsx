import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserChatPermissionProfile } from './permissionRegistry';
import { BrowserChatPermissionPanel } from './BrowserChatPermissionPanel';

function profile(plan: BrowserChatPermissionProfile['plan']): BrowserChatPermissionProfile {
  return {
    version: 1,
    accountId: 'account-a',
    workspaceId: 'project-a',
    plan,
    overrides: {},
    updatedAt: 1,
  };
}

describe('BrowserChatPermissionPanel', () => {
  afterEach(cleanup);

  it('shows all five plans and reports executable capabilities truthfully', () => {
    render(
      <BrowserChatPermissionPanel
        profile={profile('read')}
        workspaceGranted
        providerBridgeAvailable
        availableCapabilities={new Set(['files.list', 'files.read'])}
        onProfileChange={vi.fn()}
      />,
    );

    const selector = screen.getByLabelText('VibeSpace permission plan');
    expect([...selector.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'Off',
      'Read',
      'Project Developer',
      'Full Local Developer',
      'Custom',
    ]);
    expect(screen.getByText(/2 executable now/i)).toBeTruthy();
    expect(screen.getByText(/8 unavailable locally/i)).toBeTruthy();
    expect(screen.getByText(/write support not verified/i)).toBeTruthy();
  });

  it('emits a scoped preset profile without carrying stale custom overrides', () => {
    const onProfileChange = vi.fn();
    render(
      <BrowserChatPermissionPanel
        profile={{ ...profile('custom'), overrides: { 'files.read': 'auto' } }}
        workspaceGranted
        providerBridgeAvailable
        availableCapabilities={new Set(['files.list', 'files.read'])}
        onProfileChange={onProfileChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('VibeSpace permission plan'), {
      target: { value: 'project_developer' },
    });

    expect(onProfileChange).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'account-a',
        workspaceId: 'project-a',
        plan: 'project_developer',
        overrides: {},
      }),
    );
  });

  it('offers granular custom modes while keeping destructive actions always-confirmed', () => {
    const onProfileChange = vi.fn();
    render(
      <BrowserChatPermissionPanel
        profile={profile('custom')}
        workspaceGranted
        providerBridgeAvailable
        availableCapabilities={new Set(['files.list', 'files.read'])}
        onProfileChange={onProfileChange}
      />,
    );

    const readMode = screen.getByLabelText('Read project files approval');
    expect([...readMode.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'Always block',
      'Allow automatically',
      'Ask once this session',
      'Ask every time',
    ]);
    const deleteMode = screen.getByLabelText('Delete project paths approval');
    expect([...deleteMode.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'Always block',
      'Ask every time',
    ]);

    fireEvent.change(readMode, { target: { value: 'ask' } });
    expect(onProfileChange).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: 'custom',
        overrides: { 'files.read': 'ask' },
      }),
    );
  });
});
