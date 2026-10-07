import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMRequest } from '../types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@/lib/utils', () => ({ isTauri: true }));

import { foundryProvider } from './foundry';

type NativeRequest = { requestId: string; artifactId: string };
let cancelResult: () => Promise<boolean>;
const outcomes: Promise<unknown>[] = [];
const pending = new Map<string, { input: NativeRequest; complete: () => void; fail: (error: Error) => void }>();
const job = {
  id: 'job_cancel_fixture',
  name: 'Synthetic cancellation fixture',
  version: 1,
  method: 'full',
  status: 'completed',
  artifactVerified: true,
  artifactSha256: 'a'.repeat(64),
};

function start(signal: AbortSignal, onChunk = vi.fn()) {
  const req: LLMRequest = {
    agent: {
      model: { provider: 'foundry', model: `artifact--${job.id}` },
      system_prompt: '',
    } as LLMRequest['agent'],
    messages: [{ role: 'user', content: 'Return a synthetic local response.' }],
    signal,
    onChunk,
  };
  const outcome = foundryProvider.run(req).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  outcomes.push(outcome);
  return outcome;
}

function cancelCalls() {
  return invoke.mock.calls.filter(([command]) => command === 'model_foundry_cancel_chat');
}

beforeEach(() => {
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  pending.clear();
  outcomes.length = 0;
  cancelResult = async () => true;
  invoke.mockReset();
  invoke.mockImplementation((command: string, input?: NativeRequest) => {
    if (command === 'model_foundry_chat') {
      return new Promise((resolve, reject) => {
        pending.set(input!.requestId, {
          input: input!,
          fail: reject,
          complete: () => resolve({
            artifactId: job.id, modelName: job.name, version: job.version,
            method: job.method, text: 'Synthetic response.', inputTokens: 2, outputTokens: 2,
          }),
        });
      });
    }
    if (command === 'model_foundry_list_jobs') return Promise.resolve([job]);
    if (command === 'model_foundry_cancel_chat') return cancelResult();
    throw new Error(`Unexpected fixture native command: ${command}`);
  });
});

afterEach(async () => {
  for (const request of pending.values()) request.complete();
  await Promise.all(outcomes);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Foundry cancellation boundary (injected native IO, no actual worker)', () => {
  it('does not start native inference when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await start(controller.signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ name: 'AbortError' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not dispatch after abort while the native module is still loading', async () => {
    const controller = new AbortController();
    let finished = false;
    const resultPromise = start(controller.signal).then((result) => {
      finished = true;
      return result;
    });
    controller.abort();
    await vi.waitFor(() => expect(finished).toBe(true));
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('requests cancellation of the same native request when aborted in flight', async () => {
    const controller = new AbortController();
    const onChunk = vi.fn();
    const resultPromise = start(controller.signal, onChunk);
    await vi.waitFor(() => expect(pending.size).toBe(1));
    const request = [...pending.values()][0]!;
    expect(request.input.requestId).toMatch(/^foundry-bridge-/);
    controller.abort();
    await Promise.resolve();
    // Always settle the injected response before asserting; no unresolved work is retained.
    request.complete();
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ name: 'AbortError' });
    expect(onChunk).not.toHaveBeenCalled();
    expect(cancelCalls()).toEqual([
      ['model_foundry_cancel_chat', { requestId: request.input.requestId }],
    ]);
  });

  it('cancels only the aborted request when two inferences share an artifact', async () => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstChunks = vi.fn();
    const secondChunks = vi.fn();
    const first = start(firstController.signal, firstChunks);
    const second = start(secondController.signal, secondChunks);
    await vi.waitFor(() => expect([...pending.keys()], JSON.stringify(invoke.mock.calls)).toHaveLength(2));
    const [firstRequest, secondRequest] = [...pending.values()];
    expect(firstRequest!.input.requestId).not.toBe(secondRequest!.input.requestId);
    firstController.abort();
    await Promise.resolve();
    firstRequest!.complete();
    secondRequest!.complete();
    expect((await first).ok).toBe(false);
    expect((await second).ok).toBe(true);
    expect(firstChunks).not.toHaveBeenCalled();
    expect(secondChunks).toHaveBeenCalledTimes(2);
    expect(cancelCalls()).toEqual([
      ['model_foundry_cancel_chat', { requestId: firstRequest!.input.requestId }],
    ]);
  });

  it('does not cancel a completed request when its signal aborts later', async () => {
    const controller = new AbortController();
    const resultPromise = start(controller.signal);
    await vi.waitFor(() => expect(pending.size).toBe(1));
    [...pending.values()][0]!.complete();
    expect((await resultPromise).ok).toBe(true);
    controller.abort();
    await Promise.resolve();
    expect(cancelCalls()).toEqual([]);
  });

  it('does not treat a native cancellation acknowledgment as terminal completion', async () => {
    const controller = new AbortController();
    let finished = false;
    const resultPromise = start(controller.signal).then((result) => {
      finished = true;
      return result;
    });
    await vi.waitFor(() => expect(pending.size).toBe(1));
    controller.abort();
    await vi.waitFor(() => expect(cancelCalls()).toHaveLength(1));
    expect(finished).toBe(false);
    [...pending.values()][0]!.complete();
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ name: 'AbortError' });
  });

  it('retries the same request after cancellation arrives before native worker registration', async () => {
    let attempts = 0;
    cancelResult = async () => ++attempts >= 3;
    const controller = new AbortController();
    const resultPromise = start(controller.signal);
    await vi.waitFor(() => expect(pending.size).toBe(1));
    const request = [...pending.values()][0]!;
    controller.abort();
    await vi.waitFor(() => expect(attempts).toBe(3), { timeout: 1_500 });
    expect(cancelCalls().map(([, args]) => args)).toEqual([
      { requestId: request.input.requestId },
      { requestId: request.input.requestId },
      { requestId: request.input.requestId },
    ]);
    request.complete();
    expect((await resultPromise).ok).toBe(false);
  });

  it('keeps cancellation failure observed and retries only while its native request is pending', async () => {
    let attempts = 0;
    cancelResult = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Synthetic temporary cancellation failure');
      return true;
    };
    const controller = new AbortController();
    const resultPromise = start(controller.signal);
    await vi.waitFor(() => expect(pending.size).toBe(1));
    controller.abort();
    await vi.waitFor(() => expect(attempts).toBe(2));
    [...pending.values()][0]!.complete();
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ name: 'AbortError' });
  });

  it('removes its abort listener and pending early-registration retry after native completion', async () => {
    cancelResult = async () => false;
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const resultPromise = start(controller.signal);
    await vi.waitFor(() => expect(pending.size).toBe(1));
    controller.abort();
    await vi.waitFor(() => expect(cancelCalls()).toHaveLength(1));
    [...pending.values()][0]!.complete();
    expect((await resultPromise).ok).toBe(false);
    const handler = add.mock.calls.find(([event]) => event === 'abort')?.[1];
    expect(handler).toBeTypeOf('function');
    expect(remove).toHaveBeenCalledWith('abort', handler);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(cancelCalls()).toHaveLength(1);
  });


  it('preserves a native cleanup failure instead of relabeling it as confirmed cancellation', async () => {
    const controller = new AbortController();
    const onChunk = vi.fn();
    const resultPromise = start(controller.signal, onChunk);
    await vi.waitFor(() => expect(pending.size).toBe(1));
    controller.abort();
    await vi.waitFor(() => expect(cancelCalls()).toHaveLength(1));
    const error = new Error('Synthetic native cleanup failed; worker closure is unconfirmed');
    [...pending.values()][0]!.fail(error);
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(error);
    expect(onChunk).not.toHaveBeenCalled();
  });

});
