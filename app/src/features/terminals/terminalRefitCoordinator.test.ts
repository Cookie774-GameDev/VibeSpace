import { describe, expect, it, vi } from 'vitest';
import {
  createTerminalRefitCoordinator,
  type TerminalRefitFrameScheduler,
} from './terminalRefitCoordinator';

function createFrameScheduler() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();

  const scheduler: TerminalRefitFrameScheduler = {
    requestFrame: vi.fn((callback: FrameRequestCallback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    }),
    cancelFrame: vi.fn((id: number) => {
      callbacks.delete(id);
    }),
  };

  const flushNext = (time = 0) => {
    const entry = callbacks.entries().next().value as
      | [number, FrameRequestCallback]
      | undefined;
    if (!entry) throw new Error('No animation frame is pending');
    callbacks.delete(entry[0]);
    entry[1](time);
  };

  return { scheduler, callbacks, flushNext };
}

describe('terminal refit coordinator', () => {
  it('waits for two stable usable frames before applying a refit', () => {
    const frames = createFrameScheduler();
    const geometries = [
      { width: 0, height: 0 },
      { width: 640, height: 0 },
      { width: 640, height: 360 },
      { width: 641, height: 360 },
      { width: 641, height: 360 },
    ];
    const onStableGeometry = vi.fn();
    const coordinator = createTerminalRefitCoordinator({
      ...frames.scheduler,
      readGeometry: () => geometries.shift() ?? { width: 641, height: 360 },
      onStableGeometry,
      stableFrameCount: 2,
      maxFrames: 8,
    });

    coordinator.request();
    for (let index = 0; index < 5; index += 1) frames.flushNext(index);

    expect(onStableGeometry).toHaveBeenCalledTimes(1);
    expect(onStableGeometry).toHaveBeenCalledWith({ width: 641, height: 360 });
    expect(frames.callbacks.size).toBe(0);
  });

  it('stops after the strict frame cap when geometry never becomes usable', () => {
    const frames = createFrameScheduler();
    const onStableGeometry = vi.fn();
    const coordinator = createTerminalRefitCoordinator({
      ...frames.scheduler,
      readGeometry: () => ({ width: 0, height: 0 }),
      onStableGeometry,
      maxFrames: 3,
    });

    coordinator.request();
    frames.flushNext();
    frames.flushNext();
    frames.flushNext();

    expect(onStableGeometry).not.toHaveBeenCalled();
    expect(frames.callbacks.size).toBe(0);
  });

  it('supersedes an outstanding request and keeps only one frame pending', () => {
    const frames = createFrameScheduler();
    const coordinator = createTerminalRefitCoordinator({
      ...frames.scheduler,
      readGeometry: () => ({ width: 640, height: 360 }),
      onStableGeometry: vi.fn(),
    });

    coordinator.request();
    coordinator.request();

    expect(frames.scheduler.cancelFrame).toHaveBeenCalledTimes(1);
    expect(frames.callbacks.size).toBe(1);
  });

  it('cancels pending work and ignores requests after disposal', () => {
    const frames = createFrameScheduler();
    const onStableGeometry = vi.fn();
    const coordinator = createTerminalRefitCoordinator({
      ...frames.scheduler,
      readGeometry: () => ({ width: 640, height: 360 }),
      onStableGeometry,
    });

    coordinator.request();
    coordinator.dispose();
    coordinator.request();

    expect(frames.scheduler.cancelFrame).toHaveBeenCalledTimes(1);
    expect(frames.callbacks.size).toBe(0);
    expect(onStableGeometry).not.toHaveBeenCalled();
  });
});
