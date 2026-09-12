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
    const rendered = render(<BrowserProviderSurface provider={provider} accountProfileKey={ACCOUNT_PROFILE_A} runtime={runtime} />);

    expect(screen.getByLabelText('ChatGPT provider surface')).toBeTruthy();
    await waitFor(() => expect(runtime.openManaged).toHaveBeenCalledOnce());
    expect(runtime.openManaged).toHaveBeenLastCalledWith(
      provider,
      { x: 20, y: 30, width: 900, height: 640 },
      undefined,
      ACCOUNT_PROFILE_A,
    );
    await waitFor(() => expect(runtime.subscribeHostGeometry).toHaveBeenCalledOnce());

    hostGeometryListener?.();
    await waitFor(() => expect(runtime.openManaged).toHaveBeenCalledTimes(2));

    rendered.unmount();
    await waitFor(() => expect(runtime.hideAll).toHaveBeenCalledOnce());
    expect(unsubscribeHostGeometry).toHaveBeenCalledOnce();
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

    render(<BrowserProviderSurface provider={browserChatProvider('chatgpt')} accountProfileKey={ACCOUNT_PROFILE_A} runtime={runtime} />);

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

    render(<BrowserProviderSurface provider={browserChatProvider('chatgpt')} accountProfileKey={ACCOUNT_PROFILE_A} runtime={runtime} />);
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
    );
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

    render(<BrowserProviderSurface provider={browserChatProvider('chatgpt')} accountProfileKey={ACCOUNT_PROFILE_A} runtime={runtime} />);
    await waitFor(() => expect(runtime.openManaged).toHaveBeenCalledOnce());

    act(() => useUIStore.setState({ route: 'terminal' }));
    await waitFor(() => expect(runtime.hideAll).toHaveBeenCalledOnce());
    releaseOpen?.();

    await waitFor(() => expect(runtime.hideAll).toHaveBeenCalledTimes(2));
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

    render(<BrowserProviderSurface provider={browserChatProvider('chatgpt')} accountProfileKey={ACCOUNT_PROFILE_A} runtime={runtime} />);
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

  it('shows a truthful fallback action when managed opening fails', async () => {
    const runtime = {
      openManaged: vi.fn(async () => {
        throw new Error('managed unavailable');
      }),
      hideAll: vi.fn(async () => undefined),
      openSystemBrowser: vi.fn(async () => undefined),
      openExternalNavigation: vi.fn(async () => undefined),
      openChatGptPlugins: vi.fn(async () => undefined),
    };
    render(<BrowserProviderSurface provider={browserChatProvider('claude')} accountProfileKey={ACCOUNT_PROFILE_A} runtime={runtime} />);

    expect(await screen.findByText(/managed provider surface is unavailable/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /open claude in system browser/i })).toBeTruthy();
  });
});
