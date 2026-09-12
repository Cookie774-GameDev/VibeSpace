import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from './browserStore';

const browserHarness = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  close: vi.fn(),
  connect: vi.fn(),
  navigate: vi.fn(),
  browserStop: vi.fn(),
  frameListener: null as null | ((frame: string) => void),
}));

vi.mock('@/lib/tauri', () => ({ openExternal: vi.fn(async () => undefined) }));

vi.mock('./browserClient', () => ({
  browserStart: vi.fn(async () => ({
    ok: true,
    status: {
      running: true,
      cdp_ws_url: 'ws://127.0.0.1/devtools/page/test',
      session_id: 'browser-session-test',
    },
  })),
  browserStatus: vi.fn(async () => ({ running: false })),
  browserStop: browserHarness.browserStop,
  isTauriRuntime: vi.fn(() => true),
  resolvePageWsUrl: vi.fn(async (url: string) => url),
  CdpSession: class {
    connect = browserHarness.connect;
    startScreencast = browserHarness.start;
    stopScreencast = browserHarness.stop;
    close = browserHarness.close;
    navigate = browserHarness.navigate;
    reload = vi.fn();
    onCdpEvent = vi.fn();
    onScreencast(callback: (frame: string) => void) {
      browserHarness.frameListener = callback;
    }
  },
}));

vi.mock('./browserCanonicalApprovalRuntime', () => ({
  approveBrowserCanonicalReviewedAction: vi.fn(),
  denyBrowserCanonicalReviewedAction: vi.fn(),
}));

import { BrowserPage } from './BrowserPage';

describe('BrowserPage cached-route visibility', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    for (const value of Object.values(browserHarness)) {
      if (typeof value === 'function' && 'mockReset' in value) value.mockReset();
    }
    browserHarness.start.mockResolvedValue(undefined);
    browserHarness.stop.mockResolvedValue(undefined);
    browserHarness.close.mockResolvedValue(undefined);
    browserHarness.connect.mockResolvedValue(undefined);
    browserHarness.navigate.mockResolvedValue(undefined);
    browserHarness.browserStop.mockResolvedValue(false);
    browserHarness.frameListener = null;
    useBrowserStore.setState({
      tabs: [
        {
          id: 'tab-visibility',
          url: 'about:blank',
          title: 'New Tab',
          loading: false,
          pinned: false,
          muted: false,
          controlMode: 'ask_every_action',
        },
      ],
      activeTabId: 'tab-visibility',
      runtime: null,
      frameDataUrl: null,
      consoleEntries: [],
      agentActions: [],
      agentArmed: false,
      sidebarOpen: false,
      consoleOpen: false,
      draftUrl: 'about:blank',
      closedStack: [],
    });
  });

  it('suspends only the screencast while hidden and rejects late frames', async () => {
    const view = render(<BrowserPage routeVisible />);
    fireEvent.click(screen.getByRole('button', { name: 'Agent runtime' }));

    await waitFor(() => expect(browserHarness.start).toHaveBeenCalledTimes(1));
    act(() => browserHarness.frameListener?.('visible-frame'));
    expect(useBrowserStore.getState().frameDataUrl).toContain('visible-frame');

    view.rerender(<BrowserPage routeVisible={false} />);
    await waitFor(() => expect(browserHarness.stop).toHaveBeenCalledTimes(1));
    expect(useBrowserStore.getState().frameDataUrl).toBeNull();

    act(() => browserHarness.frameListener?.('late-hidden-frame'));
    expect(useBrowserStore.getState().frameDataUrl).toBeNull();
    expect(browserHarness.close).not.toHaveBeenCalled();
    expect(browserHarness.browserStop).not.toHaveBeenCalled();

    view.rerender(<BrowserPage routeVisible />);
    await waitFor(() => expect(browserHarness.start).toHaveBeenCalledTimes(2));
  });

  it('reconciles a hidden connection to visibility before a pending stop finishes', async () => {
    let releaseStop!: () => void;
    browserHarness.stop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseStop = resolve;
        }),
    );
    const view = render(<BrowserPage routeVisible={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Agent runtime' }));

    await waitFor(() => expect(browserHarness.stop).toHaveBeenCalledTimes(1));
    view.rerender(<BrowserPage routeVisible />);
    await waitFor(() => expect(browserHarness.start).toHaveBeenCalledTimes(1));

    expect(browserHarness.stop.mock.invocationCallOrder[0]).toBeLessThan(
      browserHarness.start.mock.invocationCallOrder[0],
    );
    await act(async () => releaseStop());
  });
});
