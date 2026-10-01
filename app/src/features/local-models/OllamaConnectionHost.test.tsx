import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapOllamaConnection } from '@/lib/ai/ollamaBootstrap';
import { OllamaConnectionHost } from './OllamaConnectionHost';

vi.mock('@/lib/ai/ollamaBootstrap', () => ({
  bootstrapOllamaConnection: vi.fn(),
}));

describe('OllamaConnectionHost lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(bootstrapOllamaConnection).mockImplementation(() => new Promise(() => undefined));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('aborts an in-flight bootstrap when the host unmounts', async () => {
    const view = render(<OllamaConnectionHost />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(bootstrapOllamaConnection).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(bootstrapOllamaConnection).mock.calls[0]?.[0]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);

    view.unmount();

    expect(signal?.aborted).toBe(true);
  });

  it('does not report an expected unmount abort as a background failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(bootstrapOllamaConnection)
      .mockResolvedValueOnce({
        ready: true,
        status: {
          ready: true,
          apiReachable: true,
          installed: true,
          phase: 'ready',
          detail: 'Ollama API is reachable.',
          statusMsg: 'Ollama ready',
        },
        modelCount: 1,
      })
      .mockImplementationOnce(
        ({ signal } = {}) =>
          new Promise((_, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted by user', 'AbortError')),
              { once: true },
            );
          }),
      );
    const view = render(<OllamaConnectionHost />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(bootstrapOllamaConnection).toHaveBeenCalledTimes(2);

    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(warn).not.toHaveBeenCalled();
  });
});
