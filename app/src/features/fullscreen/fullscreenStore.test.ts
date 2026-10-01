import { beforeEach, describe, expect, it } from 'vitest';
import type { NativeFullscreenAdapter } from './nativeFullscreen';
import {
  configureFullscreenAdapter,
  useFullscreenStore,
  type FullscreenState,
} from './fullscreenStore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function adapterWithWrites(writes: Array<Promise<boolean> | boolean>): NativeFullscreenAdapter {
  return {
    availability: () => 'available',
    read: async () => false,
    write: async () => {
      const next = writes.shift();
      if (next === undefined) throw new Error('Unexpected native write');
      return next;
    },
    subscribe: async () => () => undefined,
  };
}

const RESET_STATE: Partial<FullscreenState> = {
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
};

describe('fullscreen store', () => {
  beforeEach(() => {
    localStorage.clear();
    useFullscreenStore.setState(RESET_STATE);
    configureFullscreenAdapter(adapterWithWrites([]));
  });

  it('clears remembered state when its remember preference is disabled', () => {
    useFullscreenStore.setState({
      rememberedFocusActive: true,
      rememberedSystemActive: true,
    });

    useFullscreenStore.getState().setPreferences({
      rememberFocusMode: false,
      rememberSystemFullscreen: false,
    });

    expect(useFullscreenStore.getState().rememberedFocusActive).toBe(false);
    expect(useFullscreenStore.getState().rememberedSystemActive).toBe(false);
  });

  it('restores a remembered layer only after a clean same-version launch', () => {
    useFullscreenStore.setState({
      preferences: {
        rememberFocusMode: true,
        rememberSystemFullscreen: true,
        restoreFullscreenOnRestart: true,
        systemFullscreenBehavior: 'always-hidden',
      },
      rememberedFocusActive: true,
      rememberedSystemActive: false,
      cleanShutdown: true,
      storedAppVersion: '1.5.0',
    });

    expect(
      useFullscreenStore.getState().beginSession({
        appVersion: '1.5.0',
        recoveryLaunch: false,
      }),
    ).toEqual(['focus']);
    expect(useFullscreenStore.getState().cleanShutdown).toBe(false);
  });

  it.each([
    { appVersion: '1.5.1', recoveryLaunch: false, cleanShutdown: true },
    { appVersion: '1.5.0', recoveryLaunch: true, cleanShutdown: true },
    { appVersion: '1.5.0', recoveryLaunch: false, cleanShutdown: false },
  ])('suppresses and clears unsafe remembered state for %o', (launch) => {
    useFullscreenStore.setState({
      preferences: {
        rememberFocusMode: true,
        rememberSystemFullscreen: true,
        restoreFullscreenOnRestart: true,
        systemFullscreenBehavior: 'reveal-on-edge-hover',
      },
      rememberedFocusActive: true,
      rememberedSystemActive: true,
      cleanShutdown: launch.cleanShutdown,
      storedAppVersion: '1.5.0',
    });

    expect(useFullscreenStore.getState().beginSession(launch)).toEqual([]);
    expect(useFullscreenStore.getState().rememberedFocusActive).toBe(false);
    expect(useFullscreenStore.getState().rememberedSystemActive).toBe(false);
  });

  it('serializes contradictory native targets and ignores the stale completion', async () => {
    const enter = deferred<boolean>();
    const exit = deferred<boolean>();
    configureFullscreenAdapter(adapterWithWrites([enter.promise, exit.promise]));

    const entering = useFullscreenStore.getState().requestSystemActive(true);
    const exiting = useFullscreenStore.getState().requestSystemActive(false);
    enter.resolve(true);
    await entering;
    expect(useFullscreenStore.getState().systemActive).toBe(false);
    expect(useFullscreenStore.getState().nativePending).toBe(true);

    exit.resolve(false);
    await exiting;
    expect(useFullscreenStore.getState().systemActive).toBe(false);
    expect(useFullscreenStore.getState().nativePending).toBe(false);
  });

  it('preserves observed native truth and exposes a bounded error after failure', async () => {
    configureFullscreenAdapter({
      ...adapterWithWrites([]),
      write: async () => {
        throw new Error('secret native details');
      },
    });
    useFullscreenStore.setState({ systemActive: true, activationOrder: ['system'] });

    await expect(useFullscreenStore.getState().requestSystemActive(false)).resolves.toBe(true);
    expect(useFullscreenStore.getState().systemActive).toBe(true);
    expect(useFullscreenStore.getState().error).toBe(
      'VibeSpace could not change fullscreen. Try again or use the window controls.',
    );
  });

  it('exits only the most recently activated layer', async () => {
    configureFullscreenAdapter(adapterWithWrites([true]));
    useFullscreenStore.getState().setFocusActive(true);
    await useFullscreenStore.getState().requestSystemActive(true);
    useFullscreenStore.getState().setFocusActive(true);

    await expect(useFullscreenStore.getState().exitMostRecentLayer()).resolves.toBe('focus');
    expect(useFullscreenStore.getState().focusActive).toBe(false);
    expect(useFullscreenStore.getState().systemActive).toBe(true);
  });

  it('records only explicitly remembered active layers at clean shutdown', () => {
    useFullscreenStore.setState({
      focusActive: true,
      systemActive: true,
      preferences: {
        rememberFocusMode: true,
        rememberSystemFullscreen: false,
        restoreFullscreenOnRestart: true,
        systemFullscreenBehavior: 'always-hidden',
      },
    });

    useFullscreenStore.getState().markCleanShutdown('1.5.0');

    expect(useFullscreenStore.getState()).toMatchObject({
      rememberedFocusActive: true,
      rememberedSystemActive: false,
      cleanShutdown: true,
      storedAppVersion: '1.5.0',
    });
  });
});
