import type { ChatImageAttachment } from '@/lib/ai/vision';
import { isSupportedVideoMime, isSupportedVideoPath } from './imageAttachments';

const MAX_VIDEO_BYTES = 40 * 1024 * 1024;
const MAX_FRAMES = 4;

function imageId(seed: string): string {
  return `vidframe_${Date.now().toString(36)}_${Math.abs(hash(seed)).toString(36)}`;
}

function hash(value: string): number {
  let out = 0;
  for (let i = 0; i < value.length; i += 1) {
    out = Math.imul(31, out) + value.charCodeAt(i);
  }
  return out;
}

/**
 * Sample a few representative frames from a browser video File for vision models.
 * Honest fallback when the provider has no native video input API.
 */
export async function extractVideoFramesAsImages(
  file: File,
  options: { maxFrames?: number } = {},
): Promise<ChatImageAttachment[]> {
  const mimeType = file.type || (isSupportedVideoPath(file.name) ? 'video/mp4' : '');
  if (!isSupportedVideoMime(mimeType) && !isSupportedVideoPath(file.name)) {
    throw new Error('Only MP4, WEBM, and MOV videos are supported.');
  }
  if (file.size > MAX_VIDEO_BYTES) {
    throw new Error('Video is too large. Use a clip under 40 MB.');
  }

  const maxFrames = Math.min(options.maxFrames ?? MAX_FRAMES, MAX_FRAMES);
  const objectUrl = URL.createObjectURL(file);

  try {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = objectUrl;

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Could not read video metadata.'));
    });

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
    const timestamps: number[] = [];
    for (let i = 0; i < maxFrames; i += 1) {
      timestamps.push(Math.min(duration * ((i + 0.5) / maxFrames), Math.max(duration - 0.05, 0)));
    }

    const canvas = document.createElement('canvas');
    const width = Math.min(video.videoWidth || 640, 1280);
    const height = Math.min(video.videoHeight || 360, 720);
    canvas.width = width || 640;
    canvas.height = height || 360;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not prepare video frame canvas.');

    const frames: ChatImageAttachment[] = [];
    for (const time of timestamps) {
      await new Promise<void>((resolve, reject) => {
        video.onseeked = () => resolve();
        video.onerror = () => reject(new Error('Could not seek video for frame extraction.'));
        try {
          video.currentTime = time;
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      const comma = dataUrl.indexOf(',');
      const data = comma === -1 ? '' : dataUrl.slice(comma + 1);
      if (!data) continue;
      const stamp = time.toFixed(1);
      frames.push({
        id: imageId(`${file.name}:${stamp}`),
        name: `${file.name || 'video'}@${stamp}s.jpg`,
        mimeType: 'image/jpeg',
        data,
        size: Math.ceil((data.length * 3) / 4),
      });
    }
    if (frames.length === 0) {
      throw new Error('Could not extract frames from this video.');
    }
    return frames;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function videoCapabilityMessage(modelSupportsVision: boolean): string {
  if (modelSupportsVision) {
    return 'Video will be sent as representative frames to the vision model.';
  }
  return 'This model cannot process video. Choose a vision-capable model, or attach a text description instead.';
}
