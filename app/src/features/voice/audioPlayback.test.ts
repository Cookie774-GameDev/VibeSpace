import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { playBase64Audio } from './audioPlayback';

let instances: SyntheticAudio[];
let playAction: (audio: SyntheticAudio) => Promise<void>;
class SyntheticAudio extends EventTarget {
  src: string;
  volume = 1;
  pause = vi.fn();
  play = vi.fn(() => playAction(this));
  constructor(src: string) {
    super();
    this.src = src;
    instances.push(this);
  }
}
beforeEach(() => {
  instances = [];
  playAction = async () => undefined;
  vi.stubGlobal('Audio', SyntheticAudio);
  vi.stubGlobal('AudioContext', undefined);
  URL.createObjectURL = vi.fn(() => `blob:synthetic-${instances.length}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function audio() {
  const item = instances.at(-1);
  if (!item) throw new Error('Expected admitted synthetic audio');
  return item;
}
function expectClean(item: SyntheticAudio, count = 1) {
  expect(item.pause).toHaveBeenCalledTimes(1);
  expect(item.src).toBe('');
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(count);
}

describe('base64 playback outcome and exactly-once cleanup', () => {
  it('resolves natural ended with the existing stop callback', async () => {
    const pending = playBase64Audio('AA==', 'audio/wav', { volume: 0.4 });
    const item = audio();
    expect(item.volume).toBe(0.4);
    item.dispatchEvent(new Event('ended'));
    const stop = await pending;
    expect(typeof stop).toBe('function');
    stop();
    stop();
    expectClean(item);
  });
  it('rejects a media error with a stable typed failure', async () => {
    const pending = playBase64Audio('AA==', 'audio/wav');
    const item = audio();
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'AudioPlaybackError',
      code: 'media_error',
    });
    item.dispatchEvent(new Event('error'));
    await assertion;
    expectClean(item);
  });
  it('rejects asynchronous play failure with a stable typed failure', async () => {
    playAction = () => Promise.reject(new Error('Synthetic playback blocked'));
    await expect(playBase64Audio('AA==', 'audio/wav')).rejects.toMatchObject({
      name: 'AudioPlaybackError',
      code: 'play_rejected',
    });
    expectClean(audio());
  });
  it('cleans up and classifies synchronous play failure', async () => {
    playAction = () => {
      throw new Error('Synthetic synchronous failure');
    };
    await expect(playBase64Audio('AA==', 'audio/wav')).rejects.toMatchObject({
      name: 'AudioPlaybackError',
      code: 'play_rejected',
    });
    expectClean(audio());
  });
  it('preserves pre-abort without starting playback', async () => {
    const scope = new AbortController();
    scope.abort();
    const stop = await playBase64Audio('AA==', 'audio/wav', { signal: scope.signal });
    expect(audio().play).not.toHaveBeenCalled();
    stop();
    expectClean(audio());
  });
  it('resolves an active abort once and ignores late media signals', async () => {
    const scope = new AbortController();
    const pending = playBase64Audio('AA==', 'audio/wav', { signal: scope.signal });
    const item = audio();
    scope.abort();
    item.dispatchEvent(new Event('error'));
    item.dispatchEvent(new Event('ended'));
    const stop = await pending;
    stop();
    expectClean(item);
  });
  it('does not turn an abort into failure when the play promise rejects later', async () => {
    let rejectPlay!: (error: Error) => void;
    playAction = () =>
      new Promise<void>((_resolve, reject) => {
        rejectPlay = reject;
      });
    const scope = new AbortController();
    const pending = playBase64Audio('AA==', 'audio/wav', { signal: scope.signal });
    const item = audio();
    scope.abort();
    rejectPlay(new Error('Late rejection after stop'));
    await expect(pending).resolves.toBeTypeOf('function');
    expectClean(item);
  });
  it('keeps a settled media failure failed despite later ended and abort', async () => {
    const scope = new AbortController();
    const pending = playBase64Audio('AA==', 'audio/wav', { signal: scope.signal });
    const item = audio();
    const assertion = expect(pending).rejects.toMatchObject({ code: 'media_error' });
    item.dispatchEvent(new Event('error'));
    item.dispatchEvent(new Event('ended'));
    scope.abort();
    await assertion;
    expectClean(item);
  });
  it('keeps a natural end successful despite duplicate and late errors', async () => {
    const pending = playBase64Audio('AA==', 'audio/wav');
    const item = audio();
    item.dispatchEvent(new Event('ended'));
    item.dispatchEvent(new Event('error'));
    item.dispatchEvent(new Event('ended'));
    await expect(pending).resolves.toBeTypeOf('function');
    expectClean(item);
  });
  it('removes both media and abort listeners after settlement', async () => {
    const scope = new AbortController();
    const removeAbort = vi.spyOn(scope.signal, 'removeEventListener');
    const pending = playBase64Audio('AA==', 'audio/wav', { signal: scope.signal });
    const item = audio();
    const removeMedia = vi.spyOn(item, 'removeEventListener');
    item.dispatchEvent(new Event('ended'));
    await pending;
    expect(removeAbort).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(removeMedia).toHaveBeenCalledWith('ended', expect.any(Function));
    expect(removeMedia).toHaveBeenCalledWith('error', expect.any(Function));
  });
  it('a failed old element cannot finish or clean a newer playback', async () => {
    const first = playBase64Audio('AA==', 'audio/wav');
    const old = audio();
    const rejected = expect(first).rejects.toMatchObject({ code: 'media_error' });
    old.dispatchEvent(new Event('error'));
    await rejected;
    const second = playBase64Audio('AA==', 'audio/wav');
    const fresh = audio();
    let settled = false;
    void second.then(() => {
      settled = true;
    });
    old.dispatchEvent(new Event('ended'));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fresh.pause).not.toHaveBeenCalled();
    fresh.dispatchEvent(new Event('ended'));
    await second;
    expectClean(old, 2);
    expectClean(fresh, 2);
  });
});
