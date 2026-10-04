import * as React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useUIStore } from '@/stores/ui';
import { browserChatStore } from './browserChatStore';
import { browserChatProvider } from './providerRegistry';
import { BrowserProviderSurface } from './BrowserProviderSurface';

const visibleRect: DOMRect = {
  x: 20,
  y: 30,
  top: 30,
  right: 920,
  bottom: 670,
  left: 20,
  width: 900,
  height: 640,
  toJSON: () => ({}),
};

const ACCOUNT_PROFILE_A =
  'profile_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const ACCOUNT_PROFILE_B =
  'profile_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;

const hiddenRect: DOMRect = {
  x: 0,
  y: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
};

describe('BrowserProviderSurface', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    useUIStore.setState({ route: 'chat', activeChatId: 'chat-browser' });
    await browserChatStore.persist.rehydrate();
    browserChatStore.setState({
      engine: 'native',
      chatPreferences: { 'chat-browser': { engine: 'browser', providerId: 'chatgpt' } },
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(visibleRect);
  });

  it('opens the selected managed provider with an account-scoped profile and hides on unmount', async () => {
    let hostGeometryListener: (() => void) | undefined;
    const unsubscribeHostGeometry = vi.fn();
    const runtime = {
      openManaged: vi.fn(async () => ({
        kind: 'managed' as const,
        providerId: 'chatgpt' as const,
      })),
      hideAll: vi.fn(async () => undefined),
      openSystemBrowser: vi.fn(async () => undefined),
      openExternalNavigation: vi.fn(async () => undefined),
      openChatGptPlugins: vi.fn(async () => undefined),
      subscribeHostGeometry: vi.fn(async (listener: () => void) => {
        hostGeometryListener = listener;
        return unsubscribeHostGeometry;
      }),
    };
    const provider = browserChatProvider('chatgpt');
    const rendered = render(
      <BrowserProviderSurface
        provider={provider}
        accountProfileKey={ACCOUNT_PROFILE_A}
        runtime={runtime}
      />,
    );

    expect(screen.getByLabelText('ChatGPT provider surface')).toBeTruthy();
    await waitFor(() => expect(runtime.openManaged).toHaveBeenCalledOnce());
    expect(runtime.openManaged).toHaveBeenLastCalledWith(
      provider,
      { x: 20, y: 30, width: 900, height: 640 },
      undefined,
      ACCOUNT_PROFILE_A,
      'chat-browser',
    );
    await waitFor(() => expect(runtime.subscribeHostGeometry).toHaveBeenCalledOnce());

    hostGeometryListener?.();
    await waitFor(() => expect(runtime.openManaged).toHaveBeenCalledTimes(2));

    rendered.unmount();
    await waitFor(() => expect(runtime.hideAll).toHaveBeenCalledOnce());
    expect(unsubscribeHostGeometry).toHaveBeenCalledOnce();
  });

  it('uses the entire host area for the full-page provider view', async () => {
    const runtime = {
      openManaged: vi.fn(async () => ({
        kind: 'managed' as const,
        providerId: 'chatgpt' as const,
      })),
      hideAll: vi.fn(async () => undefined),
      openSystemBrowser: vi.fn(async () => undefined),
      openExternalNavigation: vi.fn(async () => undefined),
      openChatGptPlugins: vi.fn(async () => undefined),
    };

    render(
      <BrowserProviderSurface
        provider={browserChatProvider('chatgpt')}
        accountProfileKey={ACCOUNT_PROFILE_A}
        runtime={runtime}
        fullPage
      />,
    );

    const host = screen.getByLabelText('ChatGPT provider surface');
    expect(host.className).toContain('min-h-0');
    expect(host.className).not.toContain('rounded-xl');
    await waitFor(() => expect(runtime.openManaged).toHaveBeenCalledOnce());
  });

  it('parks the native page while an overlapping VibeSpace popover is open', async () => {
    const runtime = {
      openManaged: vi.fn(async () => ({
        kind: 'managed' as const,
        providerId: 'chatgpt' as const,
      })),
      hideAll: vi.fn(async () => undefined),
      openSystemBrowser: vi.fn(async () => undefined),
      openExternalNavigation: vi.fn(async () => undefined),
      openChatGptPlugins: vi.fn(async () => undefined),
    };
    render(
      <BrowserProviderSurface
        provider={browserChatProvider('chatgpt')}
        accountProfileKey={ACCOUNT_PROFILE_A}
        runtime={runtime}
      />,
    );
    await waitFor(() => expect(runtime.openManaged).toHaveBeenCalledOnce());

    const popover = document.createElement('div');
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('data-state', 'open');
    document.body.appendChild(popover);
    await waitFor(() => expect(runtime.hideAll).toHaveBeenCalledOnce());
    expect(runtime.openManaged).toHaveBeenCalledOnce();

    popover.remove();
    await waitFor(() => expect(runtime.openManaged).toHaveBeenCalledTimes(2));
  });

  it('follows an animated sidebar width change even when the host receives no resize event', async () => {
    let rect = visibleRect;
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(() => rect);
    const runtime = {
      openManaged: vi.fn(async () => ({
        kind: 'managed' as const,
        providerId: 'chatgpt' as const,
      })),
      hideAll: vi.fn(async () => undefined),
      openSystemBrowser: vi.fn(async () => undefined),
      openExternalNavigation: vi.fn(async () => undefined),
      openChatGptPlugins: vi.fn(async () => undefined),
    };
    render(
      <BrowserProviderSurface
        provider={browserChatProvider('chatgpt')}
        accountProfileKey={ACCOUNT_PROFILE_A}
        runtime={runtime}
      />,
    );
    await waitFor(() => expect(runtime.openManaged).toHaveBeenCalledOnce());

    rect = { ...visibleRect, x: 4, left: 4, width: 916, right: 920 };
    act(() => useUIStore.setState({ navOpen: !useUIStore.getState().navOpen }));
    await waitFor(() =>
      expect(runtime.openManaged).toHaveBeenLastCalledWith(
        browserChatProvider('chatgpt'),
        { x: 4, y: 30, width: 916, height: 640 },
        undefined,
        ACCOUNT_PROFILE_A,
        'chat-browser',
      ),
    );
    expect(runtime.openManaged).toHaveBeenCalledTimes(2);
  });

  it('keeps opening status until the matching native page finishes loading', async () => {
    let sendLoad:
      | ((load: {
          providerId: string;
          accountProfileKey: string;
          pageId: string;
          phase: 'started' | 'finished';
        }) => void)
      | undefined;
    const runtime = {
      openManaged: vi.fn(async () => ({
        kind: 'managed' as const,
        providerId: 'chatgpt' as const,
        loaded: false,
      })),
      hideAll: vi.fn(async () => undefined),
      openSystemBrowser: vi.fn(async () => undefined),
      openExternalNavigation: vi.fn(async () => undefined),
      openChatGptPlugins: vi.fn(async () => undefined),
      subscribeLoad: vi.fn(async (listener: typeof sendLoad) => {
        sendLoad = listener;
        return () => undefined;
      }),
    };
    render(
      <BrowserProviderSurface
        provider={browserChatProvider('chatgpt')}
        accountProfileKey={ACCOUNT_PROFILE_A}
        runtime={runtime}
      />,
    );
    await waitFor(() => expect(runtime.openManaged).toHaveBeenCalledOnce());
    expect(browserChatStore.getState().providerRuntime.chatgpt?.pageStatus).toBe('opening');

    act(() =>
      sendLoad?.({
        providerId: 'chatgpt',
        accountProfileKey: ACCOUNT_PROFILE_A,
        pageId: 'other-chat',
        phase: 'finished',
      }),
    );
    expect(browserChatStore.getState().providerRuntime.chatgpt?.pageStatus).toBe('opening');
    act(() =>
      sendLoad?.({
        providerId: 'chatgpt',
        accountProfileKey: ACCOUNT_PROFILE_A,
        pageId: 'chat-browser',
        phase: 'finished',
      }),
    );
    expect(browserChatStore.getState().providerRuntime.chatgpt?.pageStatus).toBe('ready');
  });

  it('subscribes to native page events before it starts opening a page', async () => {
    let releaseLoad: ((unsubscribe: () => void) => void) | undefined;
    let releaseNavigation: ((unsubscribe: () => void) => void) | undefined;
    const loadSubscription = new Promise<() => void>((resolve) => {
      releaseLoad = resolve;
    });
    const navigationSubscription = new Promise<() => void>((resolve) => {
      releaseNavigation = resolve;
    });
    const runtime = {
      openManaged: vi.fn(async () => ({
        kind: 'managed' as const,
        providerId: 'chatgpt' as const,
        loaded: false,
      })),
      hideAll: vi.fn(async () => undefined),
      openSystemBrowser: vi.fn(async () => undefined),
      openExternalNavigation: vi.fn(async () => undefined),
      openChatGptPlugins: vi.fn(async () => undefined),
      subscribeLoad: vi.fn(() => loadSubscription),
      subscribeNavigation: vi.fn(() => navigationSubscription),
    };
    render(
      <BrowserProviderSurface
        provider={browserChatProvider('chatgpt')}
        accountProfileKey={ACCOUNT_PROFILE_A}
        runtime={runtime}
      />,
    );

    expect(runtime.subscribeLoad).toHaveBeenCalledOnce();
    expect(runtime.subscribeNavigation).toHaveBeenCalledOnce();
    expect(runtime.openManaged).not.toHaveBeenCalled();
    releaseLoad?.(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.openManaged).not.toHaveBeenCalled();
    releaseNavigation?.(() => undefined);
    await waitFor(() => expect(runtime.openManaged).toHaveBeenCalledOnce());
  });

  it('mounts a validated provider frame in a plain browser without external actions', async () => {
    let geometryListener: (() => void) | undefined;
    const runtime = {
      openManaged: vi.fn(async () => ({
        kind: 'embedded_frame' as const,
        providerId: 'chatgpt' as const,
        url: 'https://chatgpt.com/',
      })),
      hideAll: vi.fn(async () => undefined),
      openSystemBrowser: vi.fn(async () => undefined),
      openExternalNavigation: vi.fn(async () => undefined),
      openChatGptPlugins: vi.fn(async () => undefined),
      subscribeHostGeometry: vi.fn(async (listener: () => void) => {
        geometryListener = listener;
        return () => undefined;
      }),
    };

    render(
      <BrowserProviderSurface
        provider={browserChatProvider('chatgpt')}
        accountProfileKey={ACCOUNT_PROFILE_A}
        runtime={runtime}
        fullPage
      />,
    );

    const frame = await screen.findByTitle('ChatGPT');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('src')).toBe('https://chatgpt.com/');
    expect(screen.queryByRole('button', { name: /Open ChatGPT/i })).toBeNull();
    await waitFor(() => expect(geometryListener).toBeTypeOf('function'));
    act(() => geometryListener?.());
    await waitFor(() => expect(runtime.openManaged).toHaveBeenCalledOnce());
    expect(runtime.openSystemBrowser).not.toHaveBeenCalled();
  });

  it('hides immediately when the Browser Chat host is not rendered', async () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(hiddenRect);
    const runtime = {
      openManaged: vi.fn(async () => ({
        kind: 'managed' as const,
        providerId: 'chatgpt' as const,
      })),
      hideAll: vi.fn(async () => undefined),
      openSystemBrowser: vi.fn(async () => undefined),
      openExternalNavigation: vi.fn(async () => undefined),
      openChatGptPlugins: vi.fn(async () => undefined),
    };

    render(
      <BrowserProviderSurface
        provider={browserChatProvider('chatgpt')}
        accountProfileKey={ACCOUNT_PROFILE_A}
        runtime={runtime}
      />,
    );

    await waitFor(() => expect(runtime.hideAll).toHaveBeenCalledOnce());
    expect(runtime.openManaged).not.toHaveBeenCalled();
  });

  it('hides on the immediate route change without waiting for React route teardown', async () => {
    const runtime = {
      openManaged: vi.fn(async () => ({
        kind: 'managed' as const,
        providerId: 'chatgpt' as const,
      })),
      hideAll: vi.fn(async () => undefined),
      openSystemBrowser: vi.fn(async () => undefined),
      openExternalNavigation: vi.fn(async () => undefined),
      openChatGptPlugins: vi.fn(async () => undefined),
    };

    render(
      <BrowserProviderSurface
        provider={browserChatProvider('chatgpt')}
        accountProfileKey={ACCOUNT_PROFILE_A}
        runtime={runtime}
      />,
    );
    await waitFor(() => expect(runtime.openManaged).toHaveBeenCalledOnce());

    act(() => useUIStore.setState({ route: 'files' }));
    await waitFor(() => expect(runtime.hideAll).toHaveBeenCalledOnce());
    expect(runtime.openManaged).toHaveBeenCalledOnce();
  });

  it('hides the old profile and reopens with the new VibeSpace account profile', async () => {
    const runtime = {
      openManaged: vi.fn(async () => ({
        kind: 'managed' as const,
        providerId: 'chatgpt' as const,
      })),
      hideAll: vi.fn(async () => undefined),
      openSystemBrowser: vi.fn(async () => undefined),
      openExternalNavigation: vi.fn(async () => undefined),
      openChatGptPlugins: vi.fn(async () => undefined),
    };
    const provider = browserChatProvider('chatgpt');

    const rendered = render(
      <BrowserProviderSurface
        provider={provider}
        accountProfileKey={ACCOUNT_PROFILE_A}
        runtime={runtime}
      />,
    );
    await waitFor(() => expect(runtime.openManaged).toHaveBeenCalledOnce());

    rendered.rerender(
      <BrowserProviderSurface
        provider={provider}
        accountProfileKey={ACCOUNT_PROFILE_B}
        runtime={runtime}
      />,
    );

    await waitFor(() => expect(runtime.hideAll).toHaveBeenCalled());
    await waitFor(() => expect(runtime.openManaged).toHaveBeenCalledTimes(2));
    expect(runtime.openManaged).toHaveBeenLastCalledWith(
      provider,
      { x: 20, y: 30, width: 900, height: 640 },
      undefined,
      ACCOUNT_PROFILE_B,
      'chat-browser',
    );
  });

  it('opens a separate managed page when the active Browser Chat tab changes', async () => {
    browserChatStore.setState({
      chatPreferences: {
        'chat-browser': { engine: 'browser', providerId: 'chatgpt' },
        'chat-second': { engine: 'browser', providerId: 'chatgpt' },
      },
    });
    const runtime = {
      openManaged: vi.fn(async () => ({
        kind: 'managed' as const,
        providerId: 'chatgpt' as const,
        loaded: true,
      })),
      hideAll: vi.fn(async () => undefined),
      openSystemBrowser: vi.fn(async () => undefined),
      openExternalNavigation: vi.fn(async () => undefined),
      openChatGptPlugins: vi.fn(async () => undefined),
    };
    const provider = browserChatProvider('chatgpt');
    render(
      <BrowserProviderSurface
        provider={provider}
        accountProfileKey={ACCOUNT_PROFILE_A}
        runtime={runtime}
      />,
    );
    await waitFor(() => expect(runtime.openManaged).toHaveBeenCalledOnce());

    act(() => useUIStore.setState({ activeChatId: 'chat-second' }));
    await waitFor(() => expect(runtime.openManaged).toHaveBeenCalledTimes(2));
    expect(runtime.openManaged).toHaveBeenLastCalledWith(
      provider,
      { x: 20, y: 30, width: 900, height: 640 },
      undefined,
      ACCOUNT_PROFILE_A,
      'chat-second',
    );
    expect(runtime.hideAll).toHaveBeenCalledOnce();
  });

  it('parks the native child when closing Browser Chat selects a normal chat', async () => {
    const runtime = {
      openManaged: vi.fn(async () => ({
        kind: 'managed' as const,
        providerId: 'chatgpt' as const,
      })),
      hideAll: vi.fn(async () => undefined),
      openSystemBrowser: vi.fn(async () => undefined),
      openExternalNavigation: vi.fn(async () => undefined),
      openChatGptPlugins: vi.fn(async () => undefined),
    };
    render(
      <BrowserProviderSurface
        provider={browserChatProvider('chatgpt')}
        accountProfileKey={ACCOUNT_PROFILE_A}
        runtime={runtime}
      />,
    );
    await waitFor(() => expect(runtime.openManaged).toHaveBeenCalledOnce());

    act(() => useUIStore.setState({ activeChatId: 'chat-native' }));
    await waitFor(() => expect(runtime.hideAll).toHaveBeenCalledOnce());
    expect(runtime.openManaged).toHaveBeenCalledOnce();
  });

  it('re-hides a stale native open that resolves after route teardown', async () => {
    let releaseOpen: (() => void) | undefined;
    const pendingOpen = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const runtime = {
      openManaged: vi.fn(async () => {
        await pendingOpen;
        return { kind: 'managed' as const, providerId: 'chatgpt' as const };
      }),
      hideAll: vi.fn(async () => undefined),
      openSystemBrowser: vi.fn(async () => undefined),
      openExternalNavigation: vi.fn(async () => undefined),
      openChatGptPlugins: vi.fn(async () => undefined),
    };

    render(
      <BrowserProviderSurface
        provider={browserChatProvider('chatgpt')}
        accountProfileKey={ACCOUNT_PROFILE_A}
        runtime={runtime}
      />,
    );
    await waitFor(() => expect(runtime.openManaged).toHaveBeenCalledOnce());

    act(() => useUIStore.setState({ route: 'terminal' }));
    await waitFor(() => expect(runtime.hideAll).toHaveBeenCalledOnce());
    releaseOpen?.();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.hideAll).toHaveBeenCalledOnce();
  });

  it('coalesces geometry bursts while one native surface update is in flight', async () => {
    let hostGeometryListener: (() => void) | undefined;
    let releaseFirstOpen: (() => void) | undefined;
    const firstOpen = new Promise<void>((resolve) => {
      releaseFirstOpen = resolve;
    });
    const runtime = {
      openManaged: vi
        .fn()
        .mockImplementationOnce(async () => {
          await firstOpen;
          return { kind: 'managed' as const, providerId: 'chatgpt' as const };
        })
        .mockResolvedValue({
          kind: 'managed' as const,
          providerId: 'chatgpt' as const,
        }),
      hideAll: vi.fn(async () => undefined),
      openSystemBrowser: vi.fn(async () => undefined),
      openExternalNavigation: vi.fn(async () => undefined),
      openChatGptPlugins: vi.fn(async () => undefined),
      subscribeHostGeometry: vi.fn(async (listener: () => void) => {
        hostGeometryListener = listener;
        return () => undefined;
      }),
    };

    render(
      <BrowserProviderSurface
        provider={browserChatProvider('chatgpt')}
        accountProfileKey={ACCOUNT_PROFILE_A}
        runtime={runtime}
      />,
    );
    await waitFor(() => expect(runtime.openManaged).toHaveBeenCalledOnce());

    hostGeometryListener?.();
    hostGeometryListener?.();
    hostGeometryListener?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runtime.openManaged).toHaveBeenCalledOnce();

    releaseFirstOpen?.();
    await waitFor(() => expect(runtime.openManaged).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.openManaged).toHaveBeenCalledTimes(2);
  });

  it('shows an in-app error without launching an external browser when opening fails', async () => {
    const runtime = {
      openManaged: vi.fn(async () => {
        throw new Error('managed unavailable');
      }),
      hideAll: vi.fn(async () => undefined),
      openSystemBrowser: vi.fn(async () => undefined),
      openExternalNavigation: vi.fn(async () => undefined),
      openChatGptPlugins: vi.fn(async () => undefined),
    };
    render(
      <BrowserProviderSurface
        provider={browserChatProvider('claude')}
        accountProfileKey={ACCOUNT_PROFILE_A}
        runtime={runtime}
      />,
    );

    expect(await screen.findByText(/provider surface is unavailable/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /open claude in system browser/i })).toBeNull();
    expect(runtime.openSystemBrowser).not.toHaveBeenCalled();
  });
});
