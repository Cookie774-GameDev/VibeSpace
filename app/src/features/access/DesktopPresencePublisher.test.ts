import { describe, expect, it, vi } from 'vitest';
import { startDesktopPresenceHeartbeat } from './DesktopPresencePublisher';

const snapshot = {
  deviceId: 'device_12345678',
  displayName: 'Main PC',
  appVersion: '1.5.0',
  terminals: [],
  chats: [],
  agentJobs: [],
  activeRuntime: null,
  providerUsage: {},
  backgroundTaskCount: 0,
  recentSyncAt: null,
};

describe('desktop presence heartbeat', () => {
  const expectedUserId = '11111111-1111-4111-8111-111111111111';

  it('publishes immediately, bounds the timer, and marks the device offline on disposal', async () => {
    let timer: (() => void) | undefined;
    const publish = vi.fn().mockResolvedValue(true);
    const markOffline = vi.fn().mockResolvedValue(true);
    const clearInterval = vi.fn();

    const dispose = startDesktopPresenceHeartbeat({
      client: { rpc: vi.fn() },
      expectedUserId,
      collect: vi.fn().mockResolvedValue(snapshot),
      publish,
      markOffline,
      setInterval: (callback, delay) => {
        expect(delay).toBe(60_000);
        timer = callback;
        return 7 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval,
    });

    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    timer?.();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));

    dispose();
    expect(clearInterval).toHaveBeenCalledWith(7);
    await vi.waitFor(() => {
      expect(markOffline).toHaveBeenCalledWith(
        expect.anything(),
        expectedUserId,
        'device_12345678',
      );
    });
    expect(publish).toHaveBeenCalledWith(expect.anything(), expectedUserId, snapshot);
  });

  it('never overlaps a slow presence collection', async () => {
    let timer: (() => void) | undefined;
    let release: ((value: typeof snapshot) => void) | undefined;
    const collect = vi.fn(
      () =>
        new Promise<typeof snapshot>((resolve) => {
          release = resolve;
        }),
    );
    const publish = vi.fn().mockResolvedValue(true);

    const dispose = startDesktopPresenceHeartbeat({
      client: { rpc: vi.fn() },
      expectedUserId,
      collect,
      publish,
      markOffline: vi.fn().mockResolvedValue(true),
      setInterval: (callback) => {
        timer = callback;
        return 9 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: vi.fn(),
    });

    timer?.();
    timer?.();
    expect(collect).toHaveBeenCalledTimes(1);

    release?.(snapshot);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    dispose();
  });

  it('does not publish or mark offline after the captured account becomes stale', async () => {
    let current = true;
    let release: ((value: typeof snapshot) => void) | undefined;
    const publish = vi.fn().mockResolvedValue(true);
    const markOffline = vi.fn().mockResolvedValue(true);
    const collect = vi.fn(
      () =>
        new Promise<typeof snapshot>((resolve) => {
          release = resolve;
        }),
    );

    const dispose = startDesktopPresenceHeartbeat({
      client: { rpc: vi.fn() },
      expectedUserId,
      collect,
      publish,
      markOffline,
      isCurrent: () => current,
      setInterval: () => 11 as unknown as ReturnType<typeof setInterval>,
      clearInterval: vi.fn(),
    });

    current = false;
    release?.(snapshot);
    await Promise.resolve();
    dispose();

    await vi.waitFor(() => {
      expect(publish).not.toHaveBeenCalled();
      expect(markOffline).not.toHaveBeenCalled();
    });
  });

  it('does not run stale offline cleanup after an in-flight publish changes account', async () => {
    let current = true;
    let timer: (() => void) | undefined;
    let releasePublish: ((value: true) => void) | undefined;
    const publish = vi.fn(
      () =>
        new Promise<true>((resolve) => {
          releasePublish = resolve;
        }),
    );
    const markOffline = vi.fn().mockResolvedValue(true);

    const dispose = startDesktopPresenceHeartbeat({
      client: { rpc: vi.fn() },
      expectedUserId,
      collect: vi.fn().mockResolvedValue(snapshot),
      publish,
      markOffline,
      isCurrent: () => current,
      setInterval: (callback) => {
        timer = callback;
        return 13 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: vi.fn(),
    });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));

    current = false;
    releasePublish?.(true);
    timer?.();
    dispose();

    await vi.waitFor(() => {
      expect(publish).toHaveBeenCalledTimes(1);
      expect(markOffline).not.toHaveBeenCalled();
    });
  });
});
