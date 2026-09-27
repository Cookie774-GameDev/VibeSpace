import { describe, expect, it, vi } from 'vitest';
import { captureVoiceScreenAttachment, type VoiceScreenCaptureOptions } from './voiceScreenCapture';

function createCaptureHarness({
  width = 1920,
  height = 1080,
  blob = new Blob(['screen-bytes'], { type: 'image/jpeg' }),
  hasContext = true,
}: {
  width?: number;
  height?: number;
  blob?: Blob;
  hasContext?: boolean;
} = {}) {
  const videoTrackStop = vi.fn();
  const audioTrackStop = vi.fn();
  const videoTrack = { stop: videoTrackStop } as unknown as MediaStreamTrack;
  const audioTrack = { stop: audioTrackStop } as unknown as MediaStreamTrack;
  const tracks = [videoTrack, audioTrack];
  const stream = {
    getVideoTracks: () => [videoTrack],
    getTracks: () => tracks,
  } as unknown as MediaStream;
  const getDisplayMedia = vi.fn().mockResolvedValue(stream);
  const drawImage = vi.fn();
  const context = hasContext ? { drawImage } : null;
  const toBlob = vi.fn((callback: BlobCallback) => callback(blob));
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toBlob,
  } as unknown as HTMLCanvasElement;
  const video = {
    videoWidth: width,
    videoHeight: height,
    readyState: 2,
    muted: false,
    playsInline: false,
    srcObject: null,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
  } as unknown as HTMLVideoElement;
  const options: VoiceScreenCaptureOptions = {
    mediaDevices: { getDisplayMedia } as unknown as Pick<MediaDevices, 'getDisplayMedia'>,
    createVideoElement: () => video,
    createCanvasElement: () => canvas,
    createId: () => 'voice-screen-test-id',
  };

  return {
    options,
    stream,
    video,
    canvas,
    getDisplayMedia,
    drawImage,
    toBlob,
    tracks,
    trackStops: [videoTrackStop, audioTrackStop],
  };
}

describe('voice screen capture', () => {
  it('does not request a screen unless the transcript says “on my screen”', async () => {
    const harness = createCaptureHarness();

    const result = await captureVoiceScreenAttachment(
      'Please check the current page.',
      harness.options,
    );

    expect(result).toMatchObject({ ok: false, code: 'phrase-required' });
    expect(harness.getDisplayMedia).not.toHaveBeenCalled();
  });

  it('captures one bounded frame into a Composer ChatImageAttachment and stops every track', async () => {
    const harness = createCaptureHarness();

    const result = await captureVoiceScreenAttachment('Please tell me what is on my screen.', {
      ...harness.options,
      maxDimension: 1000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachment).toMatchObject({
      id: 'voice-screen-test-id',
      name: 'screen-capture.jpg',
      mimeType: 'image/jpeg',
      data: btoa('screen-bytes'),
      size: new Blob(['screen-bytes']).size,
    });
    expect(harness.getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(harness.getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
    expect(harness.drawImage).toHaveBeenCalledTimes(1);
    expect(harness.canvas.width).toBe(1000);
    expect(harness.canvas.height).toBe(562);
    expect(harness.trackStops.map((stop) => stop.mock.calls.length)).toEqual([1, 1]);
    expect((harness.video as HTMLVideoElement).pause).toHaveBeenCalledTimes(1);
  });

  it('returns a brief permission failure and does not claim a capture when the chooser is denied', async () => {
    const harness = createCaptureHarness();
    harness.getDisplayMedia.mockRejectedValue(
      Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
    );

    const result = await captureVoiceScreenAttachment('Look on my screen.', harness.options);

    expect(result).toMatchObject({
      ok: false,
      code: 'permission-denied',
      message: expect.stringMatching(/text without an image/i),
    });
    expect(harness.drawImage).not.toHaveBeenCalled();
  });

  it('stops all tracks when a frame cannot be rendered', async () => {
    const harness = createCaptureHarness({ hasContext: false });

    const result = await captureVoiceScreenAttachment('Look on my screen.', harness.options);

    expect(result).toMatchObject({ ok: false, code: 'capture-failed' });
    expect(harness.trackStops.map((stop) => stop.mock.calls.length)).toEqual([1, 1]);
    expect(harness.toBlob).not.toHaveBeenCalled();
  });

  it('rejects encoded images over the capture byte limit and still stops every track', async () => {
    const harness = createCaptureHarness({
      blob: new Blob(['too many bytes'], { type: 'image/jpeg' }),
    });

    const result = await captureVoiceScreenAttachment('Look on my screen.', {
      ...harness.options,
      maxBytes: 4,
    });

    expect(result).toMatchObject({ ok: false, code: 'image-too-large' });
    expect(harness.trackStops.map((stop) => stop.mock.calls.length)).toEqual([1, 1]);
  });
});
