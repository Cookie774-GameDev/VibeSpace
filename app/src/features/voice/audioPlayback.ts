/**
 * Minimal base64 → HTMLAudioElement playback with abort + cleanup.
 * Returns a stop() function. Resolves when playback ends (or is aborted),
 * and rejects when media playback fails so callers can use their fallback.
 *
 * Used by Jarvis High and cloud providers. Guards against duplicate playback and
 * leaked object URLs / audio elements.
 */

import { tapJarvisPlaybackElement } from './jarvisPlaybackEnergy';

export interface PlaybackOptions {
  volume?: number;
  signal?: AbortSignal;
}

export class AudioPlaybackError extends Error {
  constructor(readonly code: 'media_error' | 'play_rejected') {
    super(`audio_playback_${code}`);
    this.name = 'AudioPlaybackError';
  }
}

function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function playBase64Audio(
  b64: string,
  mime: string,
  options: PlaybackOptions = {},
): Promise<() => void> {
  if (typeof window === 'undefined' || typeof Audio === 'undefined') {
    return () => {};
  }
  const url = URL.createObjectURL(base64ToBlob(b64, mime));
  const audio = new Audio(url);
  audio.volume = Math.min(1, Math.max(0, options.volume ?? 1));
  const releaseTap = tapJarvisPlaybackElement(audio);

  let stop = () => {};
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: AudioPlaybackError) => {
      if (settled) return;
      settled = true;
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      options.signal?.removeEventListener('abort', onAbort);
      releaseTap();
      try {
        audio.pause();
        audio.src = '';
      } catch {
        /* ignore */
      }
      URL.revokeObjectURL(url);
      if (error && !options.signal?.aborted) reject(error);
      else resolve();
    };
    const onEnded = () => finish();
    const onError = () => finish(new AudioPlaybackError('media_error'));
    const onAbort = () => finish();
    stop = onAbort;

    if (options.signal?.aborted) {
      stop();
      return;
    }

    audio.addEventListener('ended', onEnded, { once: true });
    audio.addEventListener('error', onError, { once: true });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      audio.play().catch(() => finish(new AudioPlaybackError('play_rejected')));
    } catch {
      finish(new AudioPlaybackError('play_rejected'));
    }
  });

  return stop;
}
