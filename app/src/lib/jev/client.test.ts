import { describe, expect, it, vi } from 'vitest';
import { createJevClient, createJevTransportFromNative, parseJevResponse } from './client';

const question = {
  type: 'choice' as const,
  instructions: 'Choose the next action.',
  criteria: { noop: 'No action', wake_main_cao: 'Wake CAO' },
};

describe('Jev client contract', () => {
  it('sends typed state/questions through the injected native transport and parses usage', async () => {
    const transport = vi.fn().mockResolvedValue({
      model: 'jev-1.13.0',
      answers: {
        action: {
          type: 'choice',
          choice: 'wake_main_cao',
          probabilities: { noop: 0.1, wake_main_cao: 0.9 },
          confidence: 0.9,
        },
      },
      usage: { input_tokens: 32, output_tokens: 7 },
    });
    const client = createJevClient({ transport });

    await expect(
      client.evaluate({
        state: { bounded: 'snapshot' },
        questions: { action: question },
      }),
    ).resolves.toMatchObject({
      model: 'jev-1.13.0',
      usage: { inputTokens: 32, outputTokens: 7 },
      answers: { action: { type: 'choice', choice: 'wake_main_cao' } },
    });
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ model: 'jev-latest', state: { bounded: 'snapshot' } }),
      }),
    );
  });

  it('rejects malformed answer shapes and unknown choice probabilities', () => {
    expect(() =>
      parseJevResponse(
        {
          model: 'jev-1.13.0',
          answers: {
            action: {
              type: 'choice',
              choice: 'other',
              probabilities: { noop: 0.5, wake_main_cao: 0.5 },
              confidence: 0.5,
            },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        { action: question },
      ),
    ).toThrow('jev_response_invalid');
  });

  it('propagates cancellation without retrying or exposing request content', async () => {
    const controller = new AbortController();
    const transport = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      throw new DOMException('aborted', 'AbortError');
    });
    const client = createJevClient({ transport });
    const pending = client.evaluate({
      state: 'private',
      questions: { action: question },
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('bounds a non-cooperative native transport and ignores its late result', async () => {
    let resolveLate!: (value: unknown) => void;
    const transport = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveLate = resolve;
        }),
    );
    const onUsage = vi.fn();
    const client = createJevClient({ transport, timeoutMs: 5, onUsage });
    const pending = client.evaluate({ state: { bounded: true }, questions: { action: question } });
    await expect(pending).rejects.toMatchObject({ code: 'transport_timeout' });
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    onUsage.mockClear();
    resolveLate({
      model: 'jev-late',
      answers: {
        action: {
          type: 'choice',
          choice: 'noop',
          probabilities: { noop: 1, wake_main_cao: 0 },
          confidence: 1,
        },
      },
    });
    await Promise.resolve();
    expect(onUsage).not.toHaveBeenCalled();
  });

  it('preserves native provider-reported usage and cost in the typed response', async () => {
    const transport = createJevTransportFromNative({
      jev_http_models: vi.fn(async () => ({ kind: 'connected' as const, models: [], status: 200 })),
      jev_http_systemone: vi.fn(async () => ({
        kind: 'ok' as const,
        status: 200,
        body: {
          model: 'jev-1.13.0',
          answers: {
            action: {
              type: 'choice',
              choice: 'noop',
              probabilities: { noop: 1, wake_main_cao: 0 },
              confidence: 1,
            },
          },
        },
        usage: { inputTokens: 11, outputTokens: 4, costUsd: 0.002 },
      })),
    });
    const client = createJevClient({ transport });
    await expect(
      client.evaluate({ state: { bounded: true }, questions: { action: question } }),
    ).resolves.toMatchObject({
      usage: { inputTokens: 11, outputTokens: 4, costUsd: 0.002 },
    });
  });
});
