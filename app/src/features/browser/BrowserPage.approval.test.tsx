import * as React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserReviewedAction } from './browserTypes';
import { useBrowserStore } from './browserStore';

const { approveReviewed, denyReviewed, executeLegacy } = vi.hoisted(() => ({
  approveReviewed: vi.fn(),
  denyReviewed: vi.fn(),
  executeLegacy: vi.fn(),
}));

vi.mock('./browserCanonicalApprovalRuntime', () => ({
  approveBrowserCanonicalReviewedAction: approveReviewed,
  denyBrowserCanonicalReviewedAction: denyReviewed,
}));

vi.mock('./browserActions', async (importOriginal) => {
  const original = await importOriginal<typeof import('./browserActions')>();
  return {
    ...original,
    executeBrowserTool: executeLegacy,
  };
});

vi.mock('@/lib/tauri', () => ({ openExternal: vi.fn(async () => undefined) }));

vi.mock('./browserClient', () => ({
  browserStart: vi.fn(async () => ({ ok: false, error: { message: 'not available' } })),
  browserStatus: vi.fn(async () => ({ running: false })),
  browserStop: vi.fn(async () => undefined),
  isTauriRuntime: vi.fn(() => false),
  resolvePageWsUrl: vi.fn(async (url: string) => url),
  CdpSession: class {},
}));

import { BrowserPage } from './BrowserPage';

function pendingAction(): BrowserReviewedAction {
  return {
    id: 'action-1',
    accountId: 'account-a',
    requester: {
      kind: 'agent',
      agent: { id: 'agent-1' as never, slug: 'jarvis', builtin: true },
      runId: 'run-1',
    },
    kind: 'browser.click',
    actionVersion: 1,
    origin: 'https://example.test',
    tabId: 'tab-1',
    target: { currentUrl: 'https://example.test/start', selector: '#continue' },
    parameters: { selector: '#continue' },
    parametersHash: 'a'.repeat(64),
    reviewedHash: 'b'.repeat(64),
    expectedEffect: 'Interact with the selected page control.',
    risk: 'confirm',
    safeSummary: 'Browser click requires review.',
    status: 'pending',
    requestedAt: 100,
    expiresAt: 200,
  };
}

function resetBrowser(action: BrowserReviewedAction = pendingAction()) {
  useBrowserStore.setState({
    tabs: [
      {
        id: 'tab-1',
        url: 'https://example.test/start',
        title: 'Start',
        loading: false,
        pinned: false,
        muted: false,
        controlMode: 'ask_every_action',
      },
    ],
    activeTabId: 'tab-1',
    runtime: null,
    frameDataUrl: null,
    consoleEntries: [],
    agentActions: [action],
    agentArmed: true,
    sidebarOpen: false,
    consoleOpen: true,
    draftUrl: 'https://example.test/start',
    closedStack: [],
  });
}

describe('BrowserPage approval interlock', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    resetBrowser();
    approveReviewed.mockReset();
    denyReviewed.mockReset();
    executeLegacy.mockReset();
    approveReviewed.mockImplementation(async (actionId: string) => {
      useBrowserStore
        .getState()
        .resolveAgentAction(
          actionId,
          'completed',
          'Approved browser operation completed and was observed.',
        );
      return {
        ok: true,
        actionId,
        status: 'completed',
        message: 'Approved browser operation completed and was observed.',
      };
    });
    denyReviewed.mockImplementation((actionId: string) => {
      useBrowserStore.getState().resolveAgentAction(actionId, 'denied', 'Denied by user.');
      return { ok: false, actionId, status: 'denied', message: 'Denied by user.' };
    });
  });

  it('removes the viewport background image only under MonoChrome', async () => {
    render(<BrowserPage />);

    const viewportClasses = screen.getByTestId('browser-viewport').className.split(/\s+/);
    await waitFor(() =>
      expect(viewportClasses).toContain('[html[data-theme=monochrome]_&]:bg-none'),
    );
    expect(viewportClasses).not.toContain('bg-none');
  });

  it('keeps tab activation semantics separate from close and new-tab actions', async () => {
    render(<BrowserPage />);
    await waitFor(() => expect(useBrowserStore.getState().runtime).toEqual({ running: false }));

    const tablist = screen.getByRole('tablist', { name: 'Browser tabs' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.getAttribute('aria-keyshortcuts')).toBe('Delete');
    expect(within(tablist).queryAllByRole('button', { name: /close|new tab/i })).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Close Start' })).toBeNull();
    expect(screen.getByRole('button', { name: 'New tab' })).toBeTruthy();
  });

  it('approves by exact action ID through the canonical runtime without direct CDP', async () => {
    render(<BrowserPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(approveReviewed).toHaveBeenCalledWith('action-1'));
    expect(approveReviewed).toHaveBeenCalledTimes(1);
    expect(executeLegacy).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().agentActions[0]).toMatchObject({
      id: 'action-1',
      status: 'completed',
    });
    expect(
      await screen.findByText('Approved browser operation completed and was observed.'),
    ).toBeTruthy();
  });

  it('denies the exact pending record through the canonical runtime', async () => {
    render(<BrowserPage />);
    await waitFor(() => expect(useBrowserStore.getState().runtime).toEqual({ running: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));

    expect(denyReviewed).toHaveBeenCalledWith('action-1');
    expect(useBrowserStore.getState().agentActions[0]).toMatchObject({
      id: 'action-1',
      status: 'denied',
    });
    expect(approveReviewed).not.toHaveBeenCalled();
    expect(executeLegacy).not.toHaveBeenCalled();
  });

  it('keeps ordinary manual address-bar navigation enabled', async () => {
    resetBrowser({ ...pendingAction(), status: 'denied' });
    render(<BrowserPage />);

    const address = screen.getByRole('textbox', { name: 'Address bar' });
    fireEvent.change(address, { target: { value: 'https://example.org/manual' } });
    fireEvent.submit(address.closest('form')!);

    await waitFor(() => {
      expect(useBrowserStore.getState().tabs[0]?.url).toBe('https://example.org/manual');
    });
    expect(approveReviewed).not.toHaveBeenCalled();
    expect(executeLegacy).not.toHaveBeenCalled();
  });
});
