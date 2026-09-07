import { describe, expect, it, vi } from 'vitest';
import { writeTerminalWithCompletion } from './terminalWriteCompletion';

describe('terminal write completion', () => {
  it('waits for the renderer acknowledgement and preserves exact data', async () => {
    let acknowledge!: () => void;
    const write = vi.fn((_data: string, done: () => void) => { acknowledge = done; });
    const afterWrite = vi.fn();
    const settled = vi.fn();
    const data = '\x1b[31m😀\r\n\x1b[0m';
    const pending = writeTerminalWithCompletion({ write }, data, afterWrite).then(settled);
    await Promise.resolve();
    expect(write).toHaveBeenCalledWith(data, expect.any(Function));
    expect(settled).not.toHaveBeenCalled();
    acknowledge();
    await pending;
    expect(afterWrite).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('settles synchronous writer failures so drain cleanup runs', async () => {
    const error = new Error('renderer disposed');
    const afterWrite = vi.fn();
    const cleanup = vi.fn();
    await expect(writeTerminalWithCompletion({ write() { throw error; } }, 'tail', afterWrite)
      .finally(cleanup)).rejects.toBe(error);
    expect(afterWrite).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('turns asynchronous completion-hook failures into settled rejections', async () => {
    let acknowledge!: () => void;
    const error = new Error('snapshot failed');
    const cleanup = vi.fn();
    const pending = writeTerminalWithCompletion({ write(_data, done) { acknowledge = done; } }, 'tail', () => { throw error; })
      .finally(cleanup);
    const assertion = expect(pending).rejects.toBe(error);
    expect(() => acknowledge()).not.toThrow();
    await assertion;
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('ignores duplicate acknowledgements', async () => {
    const afterWrite = vi.fn();
    await writeTerminalWithCompletion({ write(_data, done) { done(); done(); } }, 'tail', afterWrite);
    expect(afterWrite).toHaveBeenCalledTimes(1);
  });
});
