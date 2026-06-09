/**
 * Minimal base64 → HTMLAudioElement playback with abort + cleanup.
 * Returns a stop() function. Resolves when playback ends (or is aborted).
 *
 * Used by Kokoro and cloud providers. Guards against duplicate playback and
 * leaked object URLs / audio elements.
 */

export interface PlaybackOptions {
  volume?: number;
  signal?: AbortSignal;
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

  let settled = false;
  const cleanup = () => {
    try {
      audio.pause();
      audio.src = '';
    } catch {
      /* ignore */
    }
    URL.revokeObjectURL(url);
  };
  const stop = () => {
    if (settled) return;
    settled = true;
    cleanup();
  };

  if (options.signal?.aborted) {
    stop();
    return stop;
  }

  await new Promise<void>((resolve) => {
    const done = () => {
      if (settled) {
        resolve();
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    audio.addEventListener('ended', done, { once: true });
    audio.addEventListener('error', done, { once: true });
    options.signal?.addEventListener(
      'abort',
      () => {
        stop();
        resolve();
      },
      { once: true },
    );
    audio.play().catch(() => done());
  });

  return stop;
}
