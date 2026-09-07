import { describe, expect, it, vi } from 'vitest';
import { createPetPositionQueue } from './petPositionQueue';

describe('native pet move queue', () => {
  it('bounds IPC to one move and applies only the latest queued position before settling', async () => {
    let release!: () => void;
    const move = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const queue = createPetPositionQueue(move);
    queue.push(10, 20);
    queue.push(30, 40);
    queue.push(50, 60);
    expect(move.mock.calls).toEqual([[10, 20]]);
    let settled = false;
    const flush = queue.flush().then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    release();
    await flush;
    expect(move.mock.calls).toEqual([
      [10, 20],
      [50, 60],
    ]);
    expect(settled).toBe(true);
  });
  it('discards queued movement on unmount and recovers after a rejected native move', async () => {
    let reject!: (reason: Error) => void;
    const move = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValue(undefined);
    const queue = createPetPositionQueue(move);
    queue.push(1, 2);
    queue.push(3, 4);
    queue.clear();
    reject(new Error('window closed'));
    await queue.flush();
    expect(move).toHaveBeenCalledTimes(1);
    queue.push(5, 6);
    await queue.flush();
    expect(move).toHaveBeenLastCalledWith(5, 6);
  });
});
