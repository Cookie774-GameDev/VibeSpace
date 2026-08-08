import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeFullscreenAdapter } from './nativeFullscreen';
import { useFullscreenStore } from './fullscreenStore';
import { FullscreenHost } from './FullscreenHost';

function createAdapter(initial = false) {
  let active = initial;
  let listener: ((enabled: boolean) => void) | null = null;
  const unsubscribe = vi.fn();
  const adapter: NativeFullscreenAdapter = {
    availability: () => 'available',
    read: async () => active,
    write: async (enabled) => {
      active = enabled;
      return active;
    },
    subscribe: async (next) => {
      listener = next;
      return unsubscribe;
    },
  };
  return {
    adapter,
    publish: (enabled: boolean) => {
      active = enabled;
      listener?.(enabled);
    },
    unsubscribe,
  };
}

describe('FullscreenHost', () => {
  beforeEach(() => {
    localStorage.clear();
    useFullscreenStore.setState({
      focusActive: false,
      systemActive: false,
      activationOrder: [],
      preferences: {
        rememberFocusMode: false,
        rememberSystemFullscreen: false,
        restoreFullscreenOnRestart: false,
        systemFullscreenBehavior: 'always-hidden',
      },
      rememberedFocusActive: false,
      rememberedSystemActive: false,
      cleanShutdown: false,
      storedAppVersion: null,
      recoveryLaunch: false,
      nativeAvailability: 'web-preview',
      nativePending: false,
      error: null,
    });
  });

  it('toggles Focus Mode with Mod+Shift+F and System Fullscreen with F11', async () => {
    const fake = createAdapter();
    render(<FullscreenHost adapter={fake.adapter} getVersion={async () => '1.5.0'} search="" />);
    await waitFor(() => expect(useFullscreenStore.getState().storedAppVersion).toBe('1.5.0'));

    fireEvent.keyDown(window, { key: 'F', ctrlKey: true, shiftKey: true });
    expect(useFullscreenStore.getState().focusActive).toBe(true);

    fireEvent.keyDown(window, { key: 'F11' });
    await waitFor(() => expect(useFullscreenStore.getState().systemActive).toBe(true));
  });

  it('exits only the most recently activated fullscreen layer with Escape', async () => {
    const fake = createAdapter();
    render(<FullscreenHost adapter={fake.adapter} getVersion={async () => '1.5.0'} search="" />);
    await waitFor(() => expect(useFullscreenStore.getState().storedAppVersion).toBe('1.5.0'));
    act(() => useFullscreenStore.getState().setFocusActive(true));
    await act(async () => {
      await useFullscreenStore.getState().requestSystemActive(true);
    });
    act(() => useFullscreenStore.getState().setFocusActive(true));

    expect(fireEvent.keyDown(window, { key: 'Escape' })).toBe(false);

    await waitFor(() => expect(useFullscreenStore.getState().focusActive).toBe(false));
    expect(useFullscreenStore.getState().systemActive).toBe(true);
  });

  it('restores remembered Focus Mode before requesting native fullscreen', async () => {
    const fake = createAdapter();
    useFullscreenStore.setState({
      preferences: {
        rememberFocusMode: true,
        rememberSystemFullscreen: true,
        restoreFullscreenOnRestart: true,
        systemFullscreenBehavior: 'always-hidden',
      },
      rememberedFocusActive: true,
      rememberedSystemActive: true,
      cleanShutdown: true,
      storedAppVersion: '1.5.0',
    });

    render(<FullscreenHost adapter={fake.adapter} getVersion={async () => '1.5.0'} search="" />);

    await waitFor(() => expect(useFullscreenStore.getState().systemActive).toBe(true));
    expect(useFullscreenStore.getState().focusActive).toBe(true);
  });

  it('synchronizes an external native exit without changing Focus Mode', async () => {
    const fake = createAdapter(true);
    render(<FullscreenHost adapter={fake.adapter} getVersion={async () => '1.5.0'} search="" />);
    await waitFor(() => expect(useFullscreenStore.getState().storedAppVersion).toBe('1.5.0'));
    act(() => {
      useFullscreenStore.getState().setFocusActive(true);
      useFullscreenStore.getState().syncNativeState(true);
    });

    act(() => fake.publish(false));

    expect(useFullscreenStore.getState().systemActive).toBe(false);
    expect(useFullscreenStore.getState().focusActive).toBe(true);
  });

  it('records clean shutdown and releases the native subscription', async () => {
    const fake = createAdapter();
    const rendered = render(
      <FullscreenHost adapter={fake.adapter} getVersion={async () => '1.5.0'} search="" />,
    );
    await waitFor(() => expect(useFullscreenStore.getState().storedAppVersion).toBe('1.5.0'));
    act(() => {
      useFullscreenStore.getState().setFocusActive(true);
      useFullscreenStore.getState().setPreferences({ rememberFocusMode: true });
    });

    fireEvent(window, new Event('pagehide'));
    expect(useFullscreenStore.getState().cleanShutdown).toBe(true);
    expect(useFullscreenStore.getState().rememberedFocusActive).toBe(true);

    rendered.unmount();
    expect(fake.unsubscribe).toHaveBeenCalledOnce();
  });
});
