import { afterEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '@/stores/ui';
import {
  applyThemeSyncToApplication,
  parseThemeSyncMessage,
  publishThemePreference,
  startThemeSync,
  type ThemeSyncChannel,
} from './themeSync';

class FakeChannel implements ThemeSyncChannel {
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
  readonly posted: unknown[] = [];
  closeCount = 0;

  postMessage(value: unknown) {
    this.posted.push(value);
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void) {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void) {
    this.listeners.delete(listener);
  }

  close() {
    this.closeCount += 1;
  }

  emit(data: unknown) {
    for (const listener of this.listeners) {
      listener({ data } as MessageEvent<unknown>);
    }
  }
}

describe('theme cross-window messages', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useUIStore.setState({ theme: 'default' });
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.setAttribute('data-theme-preference', 'default');
  });

  it('accepts release ids and legacy Light from the sync envelope', () => {
    expect(parseThemeSyncMessage({ kind: 'theme', theme: 'jarvis' })).toBe('jarvis');
    expect(parseThemeSyncMessage({ kind: 'theme', theme: 'vibespace' })).toBeNull();
    expect(parseThemeSyncMessage({ kind: 'theme', theme: 'default' })).toBe('default');
    expect(parseThemeSyncMessage({ kind: 'theme', theme: 'monochrome' })).toBe('monochrome');
    expect(parseThemeSyncMessage({ kind: 'theme', theme: 'sakura' })).toBeNull();
    expect(parseThemeSyncMessage({ kind: 'theme', theme: 'warm' })).toBe('warm');
    expect(parseThemeSyncMessage({ kind: 'theme', theme: 'origami' })).toBeNull();
    expect(parseThemeSyncMessage({ kind: 'theme', theme: 'light' })).toBe('monochrome');
  });

  it('rejects storage ids, command aliases, unknown, malformed, and unrelated messages', () => {
    expect(parseThemeSyncMessage({ kind: 'theme', theme: 'dark' })).toBeNull();
    expect(parseThemeSyncMessage({ kind: 'theme', theme: 'system' })).toBeNull();
    expect(parseThemeSyncMessage({ kind: 'theme', theme: 'core' })).toBeNull();
    expect(parseThemeSyncMessage({ kind: 'theme', theme: 'unknown' })).toBeNull();
    expect(parseThemeSyncMessage(null)).toBeNull();
    expect(parseThemeSyncMessage({ kind: 'voice', theme: 'vibespace' })).toBeNull();
    expect(parseThemeSyncMessage({ kind: 'theme' })).toBeNull();
  });

  it('uses the production application handler for one detached update without echoing', () => {
    const channel = new FakeChannel();
    const factory = vi.fn(() => channel);
    const setState = vi.spyOn(useUIStore, 'setState');
    const stop = startThemeSync(
      (theme) => applyThemeSyncToApplication(theme, document, useUIStore),
      factory,
    );

    expect(factory).toHaveBeenCalledWith('vibespace:appearance');
    channel.emit({ kind: 'theme', theme: 'monochrome' });
    channel.emit({ kind: 'theme', theme: 'dark' });

    expect(document.documentElement.dataset.theme).toBe('monochrome');
    expect(document.documentElement.dataset.themePreference).toBe('monochrome');
    expect(useUIStore.getState().theme).toBe('monochrome');
    expect(setState).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledWith({ theme: 'monochrome' });
    expect(channel.posted).toEqual([]);

    stop();
    expect(channel.listeners.size).toBe(0);
    expect(channel.closeCount).toBe(1);
    channel.emit({ kind: 'theme', theme: 'default' });
    expect(useUIStore.getState().theme).toBe('monochrome');
    expect(setState).toHaveBeenCalledTimes(1);
  });

  it('ignores a deferred Sakura detached update and releases its listener', () => {
    const channel = new FakeChannel();
    const setState = vi.spyOn(useUIStore, 'setState');
    const stop = startThemeSync(
      (theme) => applyThemeSyncToApplication(theme, document, useUIStore),
      () => channel,
    );

    channel.emit({ kind: 'theme', theme: 'sakura' });

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.themePreference).toBe('default');
    expect(useUIStore.getState().theme).toBe('default');
    expect(setState).not.toHaveBeenCalled();
    expect(channel.posted).toEqual([]);

    stop();
    expect(channel.listeners.size).toBe(0);
    expect(channel.closeCount).toBe(1);
  });

  it('applies one Warm detached update without echoing and releases its listener', () => {
    const channel = new FakeChannel();
    const setState = vi.spyOn(useUIStore, 'setState');
    const stop = startThemeSync(
      (theme) => applyThemeSyncToApplication(theme, document, useUIStore),
      () => channel,
    );

    channel.emit({ kind: 'theme', theme: 'warm' });

    expect(document.documentElement.dataset.theme).toBe('warm');
    expect(document.documentElement.dataset.themePreference).toBe('warm');
    expect(useUIStore.getState().theme).toBe('warm');
    expect(setState).toHaveBeenCalledOnce();
    expect(channel.posted).toEqual([]);

    stop();
    expect(channel.listeners.size).toBe(0);
    expect(channel.closeCount).toBe(1);
  });

  it('ignores a deferred Origami detached update and releases its listener', () => {
    const channel = new FakeChannel();
    const setState = vi.spyOn(useUIStore, 'setState');
    const stop = startThemeSync(
      (theme) => applyThemeSyncToApplication(theme, document, useUIStore),
      () => channel,
    );

    channel.emit({ kind: 'theme', theme: 'origami' });

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.themePreference).toBe('default');
    expect(useUIStore.getState().theme).toBe('default');
    expect(setState).not.toHaveBeenCalled();
    expect(channel.posted).toEqual([]);

    stop();
    expect(channel.listeners.size).toBe(0);
    expect(channel.closeCount).toBe(1);
  });

  it('publishes only canonical ids on a fresh channel and closes it', () => {
    const canonicalChannel = new FakeChannel();
    publishThemePreference('monochrome', () => canonicalChannel);
    expect(canonicalChannel.posted).toEqual([{ kind: 'theme', theme: 'monochrome' }]);
    expect(canonicalChannel.closeCount).toBe(1);

    const sakuraChannel = new FakeChannel();
    publishThemePreference('sakura', () => sakuraChannel);
    expect(sakuraChannel.posted).toEqual([]);
    expect(sakuraChannel.closeCount).toBe(0);

    const warmChannel = new FakeChannel();
    publishThemePreference('warm', () => warmChannel);
    expect(warmChannel.posted).toEqual([{ kind: 'theme', theme: 'warm' }]);
    expect(warmChannel.closeCount).toBe(1);

    const origamiChannel = new FakeChannel();
    publishThemePreference('origami', () => origamiChannel);
    expect(origamiChannel.posted).toEqual([]);
    expect(origamiChannel.closeCount).toBe(0);

    const legacyChannel = new FakeChannel();
    publishThemePreference('light' as never, () => legacyChannel);
    expect(legacyChannel.posted).toEqual([]);
    expect(legacyChannel.closeCount).toBe(0);
  });
});
