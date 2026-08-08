import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { browserChatStore } from './browserChatStore';
import { BrowserChatHub } from './BrowserChatHub';
import { browserChatSurface } from './providerSurface';
import { useAuthStore } from '@/stores/auth';
import { getBridgeWorkspaceGrant, setBridgeWorkspaceGrant } from '@/lib/bridge';
import { projectStorageKey, ROOT_PREFIX } from '@/features/files/projectFiles';
import type { ProjectId } from '@/types/common';
import { browserChatWorkspaceGrantStore, revokeBrowserChatWorkspace } from './workspaceGrant';

vi.mock('./BrowserProviderSurface', () => ({
  BrowserProviderSurface: ({ provider }: { provider: { label: string } }) => (
    <div aria-label={`${provider.label} provider surface`}>{provider.label} real provider page</div>
  ),
}));

describe('BrowserChatHub', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv('VITE_PHONE_JARVIS_CLOUD_URL', 'https://vibespace-mcp.fly.dev');
    localStorage.clear();
    revokeBrowserChatWorkspace();
    setBridgeWorkspaceGrant();
    useAuthStore.setState({
      projectId: 'project-1' as ProjectId,
      localUserId: 'account-1',
    });
    browserChatStore.setState({
      engine: 'browser',
      providerId: 'chatgpt',
      chatPreferences: {},
      preferManagedSurface: true,
      providerRuntime: {},
    });
  });
  afterEach(cleanup);

  it('shows the three provider-owned surfaces with separate page and bridge status', () => {
    render(<BrowserChatHub />);

    expect(screen.getByRole('tab', { name: 'ChatGPT' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /Claude/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Gemini/i })).toBeTruthy();
    expect(screen.getByText(/page status/i)).toBeTruthy();
    expect(screen.getByText(/tool bridge/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /sign in or sign up/i })).toBeTruthy();
    expect(screen.getByText(/not auto-connected/i)).toBeTruthy();
    expect(screen.getByText(/provider subscription and limits still apply/i)).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('keeps Claude and Gemini gated as future providers without scraping remote history', () => {
    render(<BrowserChatHub />);

    const claude = screen.getByRole('tab', { name: /Claude/i });
    const gemini = screen.getByRole('tab', { name: /Gemini/i });
    expect(claude).toHaveProperty('disabled', true);
    expect(gemini).toHaveProperty('disabled', true);
    fireEvent.click(claude);
    expect(browserChatStore.getState().providerId).toBe('chatgpt');
    expect(screen.getByLabelText('ChatGPT provider surface')).toBeTruthy();
    expect(document.body.textContent).toMatch(/does not.*read provider messages/i);
    expect(document.body.textContent).not.toMatch(/sync remote history/i);
  });

  it('requires an explicit read-only project grant before arming the local relay', () => {
    localStorage.setItem(
      projectStorageKey(ROOT_PREFIX, 'project-1'),
      'C:\\Users\\viper\\Projects\\Safe',
    );
    render(<BrowserChatHub chatId="chat-1" />);

    expect(browserChatWorkspaceGrantStore.getSnapshot()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /approve current project read-only/i }));

    expect(browserChatWorkspaceGrantStore.getSnapshot()).toMatchObject({
      accountId: 'account-1',
      projectId: 'project-1',
      canonicalRoot: 'C:\\Users\\viper\\Projects\\Safe',
      readAllowed: true,
      modifyAllowed: false,
      terminalAllowed: false,
    });
    expect(getBridgeWorkspaceGrant()).toMatchObject({
      root: 'C:\\Users\\viper\\Projects\\Safe',
      displayName: 'Safe',
    });
    expect(screen.getByText(/local relay armed/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /revoke project access/i }));
    expect(browserChatWorkspaceGrantStore.getSnapshot()).toBeNull();
    expect(getBridgeWorkspaceGrant()).toBeUndefined();
  });

  it('presents one branded VibeSpace MCP connection with honest approval boundaries', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    vi.spyOn(browserChatSurface, 'openSystemBrowser').mockResolvedValue();

    render(<BrowserChatHub chatId="chat-1" />);

    expect(screen.getByText('VibeSpace MCP')).toBeTruthy();
    expect(screen.getByText(/file reads/i)).toBeTruthy();
    expect(screen.getByText(/file writes/i)).toBeTruthy();
    expect(screen.getByText(/playwright browser/i)).toBeTruthy();
    expect(screen.getByText(/installed mcp tools/i)).toBeTruthy();
    expect(screen.getAllByText(/approval required/i).length).toBeGreaterThanOrEqual(3);

    fireEvent.click(screen.getByRole('button', { name: /connect vibespace mcp/i }));
    expect(writeText).toHaveBeenCalledWith('https://vibespace-mcp.fly.dev/mcp');
    await waitFor(() => expect(browserChatSurface.openSystemBrowser).toHaveBeenCalled());
    expect(screen.getByText(/one-time oauth approval/i)).toBeTruthy();
  });
});
