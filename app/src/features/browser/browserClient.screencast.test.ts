import { describe, expect, it, vi } from 'vitest';
import { CdpSession } from './browserClient';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('CdpSession screencast lifecycle', () => {
  it('starts and stops the screencast idempotently without closing CDP', async () => {
    const session = new CdpSession();
    const send = vi.spyOn(session, 'send').mockResolvedValue({});
    const close = vi.spyOn(session, 'close');

    await session.startScreencast();
    await session.startScreencast();
    await session.stopScreencast();
    await session.stopScreencast();

    expect(send.mock.calls.map(([method]) => method)).toEqual([
      'Page.enable',
      'Runtime.enable',
      'Network.enable',
      'Page.startScreencast',
      'Page.stopScreencast',
    ]);
    expect(close).not.toHaveBeenCalled();
  });

  it('reconciles start-stop-start overlap to the latest enabled intent', async () => {
    const session = new CdpSession();
    const pageEnable = deferred<unknown>();
    const send = vi.spyOn(session, 'send').mockImplementation((method) => {
      if (method === 'Page.enable') return pageEnable.promise;
      return Promise.resolve({});
    });

    const starting = session.startScreencast();
    const staleHide = session.stopScreencast();
    const finalShow = session.startScreencast();
    pageEnable.resolve({});
    await Promise.all([starting, staleHide, finalShow]);

    expect(send.mock.calls.map(([method]) => method)).toEqual([
      'Page.enable',
      'Runtime.enable',
      'Network.enable',
      'Page.startScreencast',
    ]);
  });

  it('keeps actual started state after a failed stop so a later stop retries', async () => {
    const session = new CdpSession();
    let stopAttempts = 0;
    const send = vi.spyOn(session, 'send').mockImplementation((method) => {
      if (method === 'Page.stopScreencast' && stopAttempts++ === 0) {
        return Promise.reject(new Error('remote stop failed'));
      }
      return Promise.resolve({});
    });

    await session.startScreencast();
    await expect(session.stopScreencast()).rejects.toThrow('remote stop failed');
    await session.stopScreencast();

    expect(send.mock.calls.filter(([method]) => method === 'Page.stopScreencast')).toHaveLength(2);
  });

  it('rejects pending CDP requests when the session closes', async () => {
    const session = new CdpSession();
    const socket = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    };
    (session as unknown as { ws: typeof socket }).ws = socket;

    const pending = session.send('Runtime.evaluate');
    await session.close();
    const outcome = await Promise.race([
      pending.then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 10)),
    ]);

    expect(outcome).toBe('CDP session closed');
  });

  it('handles a rejected best-effort frame acknowledgement during close', async () => {
    const session = new CdpSession();
    const acknowledgement = Promise.reject(new Error('CDP session closed'));
    const catchAcknowledgement = vi.spyOn(acknowledgement, 'catch');
    vi.spyOn(session, 'send').mockReturnValue(acknowledgement);

    (
      session as unknown as {
        handleMessage(raw: string): void;
      }
    ).handleMessage(
      JSON.stringify({
        method: 'Page.screencastFrame',
        params: { data: 'frame', sessionId: 7 },
      }),
    );

    expect(catchAcknowledgement).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });
});
