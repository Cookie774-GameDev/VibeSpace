import { IMAGE_ATTACHMENT_MAX_BYTES, type ChatImageAttachment } from '@/lib/ai/vision';

export const VOICE_SCREEN_CAPTURE_MAX_BYTES = 2 * 1024 * 1024;
export const VOICE_SCREEN_CAPTURE_MAX_DIMENSION = 1600;

const SCREEN_CAPTURE_REQUEST = /\bon\s+my\s+screen\b/i;
const VIDEO_FRAME_TIMEOUT_MS = 5000;

export type VoiceScreenCaptureFailureCode =
  | 'phrase-required'
  | 'capture-unavailable'
  | 'permission-denied'
  | 'capture-failed'
  | 'image-too-large';

export type VoiceScreenCaptureResult =
  | { ok: true; attachment: ChatImageAttachment }
  | { ok: false; code: VoiceScreenCaptureFailureCode; message: string };

export interface VoiceScreenCaptureOptions {
  /** Injected for regression checks; omitted in the app to use the WebView API. */
  mediaDevices?: Pick<MediaDevices, 'getDisplayMedia'> | null;
  createVideoElement?: () => HTMLVideoElement;
  createCanvasElement?: () => HTMLCanvasElement;
  maxBytes?: number;
  maxDimension?: number;
  createId?: () => string;
}

const FAILURE_MESSAGES: Record<VoiceScreenCaptureFailureCode, string> = {
  'phrase-required': 'I skipped screen capture because you did not ask for “on my screen.”',
  'capture-unavailable':
    'Screen capture is unavailable here; I will send the text without an image.',
  'permission-denied':
    'Screen capture was canceled or denied; I will send the text without an image.',
  'capture-failed': 'I could not capture the screen; I will send the text without an image.',
  'image-too-large':
    'The screenshot was too large to attach; I will send the text without an image.',
};

function failure(code: VoiceScreenCaptureFailureCode): VoiceScreenCaptureResult {
  return { ok: false, code, message: FAILURE_MESSAGES[code] };
}

function positiveIntegerLimit(
  value: number | undefined,
  fallback: number,
  ceiling: number,
): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(value), ceiling));
}

function hasFrame(video: HTMLVideoElement): boolean {
  return video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
}

function waitForVideoFrame(video: HTMLVideoElement): Promise<void> {
  if (hasFrame(video)) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      video.removeEventListener('loadeddata', onLoadedData);
      video.removeEventListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onLoadedData = () => {
      if (hasFrame(video)) finish();
      else finish(new Error('A display frame was unavailable.'));
    };
    const onError = () => finish(new Error('The display stream could not be decoded.'));
    const timeout = setTimeout(
      () => finish(new Error('Timed out waiting for a display frame.')),
      VIDEO_FRAME_TIMEOUT_MS,
    );

    video.addEventListener('loadeddata', onLoadedData, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

function canvasJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('The screenshot could not be encoded.'));
      },
      'image/jpeg',
      0.78,
    );
  });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function createAttachmentId(): string {
  return `voice-screen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isPermissionError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('name' in error)) return false;
  const name = String(error.name);
  return name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'AbortError';
}

/**
 * Ask the WebView's display picker for one frame only when the transcript
 * explicitly contains “on my screen”. The frame is returned in the same
 * base64 attachment shape used by the existing Composer and agent runtime.
 */
export async function captureVoiceScreenAttachment(
  utterance: string,
  options: VoiceScreenCaptureOptions = {},
): Promise<VoiceScreenCaptureResult> {
  if (!SCREEN_CAPTURE_REQUEST.test(utterance)) return failure('phrase-required');

  const mediaDevices =
    options.mediaDevices === undefined
      ? typeof navigator === 'undefined'
        ? undefined
        : navigator.mediaDevices
      : options.mediaDevices;
  if (!mediaDevices || typeof mediaDevices.getDisplayMedia !== 'function') {
    return failure('capture-unavailable');
  }

  const maxBytes = positiveIntegerLimit(
    options.maxBytes,
    VOICE_SCREEN_CAPTURE_MAX_BYTES,
    Math.min(VOICE_SCREEN_CAPTURE_MAX_BYTES, IMAGE_ATTACHMENT_MAX_BYTES),
  );
  const maxDimension = positiveIntegerLimit(
    options.maxDimension,
    VOICE_SCREEN_CAPTURE_MAX_DIMENSION,
    VOICE_SCREEN_CAPTURE_MAX_DIMENSION,
  );

  let stream: MediaStream | undefined;
  let video: HTMLVideoElement | undefined;
  try {
    stream = await mediaDevices.getDisplayMedia({ video: true, audio: false });
    if (!stream?.getVideoTracks()[0]) return failure('capture-failed');

    video = (options.createVideoElement ?? (() => document.createElement('video')))();
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    await waitForVideoFrame(video);

    const scale = Math.min(1, maxDimension / Math.max(video.videoWidth, video.videoHeight));
    const canvas = (options.createCanvasElement ?? (() => document.createElement('canvas')))();
    canvas.width = Math.max(1, Math.floor(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.floor(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return failure('capture-failed');

    // Draw once: this is a single permitted snapshot, not a recording stream.
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = await canvasJpeg(canvas);
    if (image.size <= 0) return failure('capture-failed');
    if (image.size > maxBytes) return failure('image-too-large');

    const mimeType = image.type === 'image/png' ? 'image/png' : 'image/jpeg';
    return {
      ok: true,
      attachment: {
        id: options.createId?.() ?? createAttachmentId(),
        name: mimeType === 'image/png' ? 'screen-capture.png' : 'screen-capture.jpg',
        mimeType,
        data: await blobToBase64(image),
        size: image.size,
      },
    };
  } catch (error) {
    return failure(isPermissionError(error) ? 'permission-denied' : 'capture-failed');
  } finally {
    try {
      video?.pause();
      if (video) video.srcObject = null;
    } catch {
      // Cleanup is best-effort; every display track is still stopped below.
    }
    try {
      for (const track of stream?.getTracks() ?? []) {
        try {
          track.stop();
        } catch {
          // Stop remaining tracks even if one browser track rejects cleanup.
        }
      }
    } catch {
      // A malformed stream should not hide the capture result from its caller.
    }
  }
}
