/**
 * Local Jarvis High TTS backed by the native Piper runtime.
 */
import type { SpeakChunkOptions, VoiceProvider } from './types';
import { playBase64Audio } from '../audioPlayback';

const LOCAL_GENERATION_TIMEOUT_MS = 30_000;
const WARMUP_TIMEOUT_MS = 20_000;

type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

async function getInvoke(): Promise<TauriInvoke | null> {
  try {
    const mod = await import('@tauri-apps/api/core');
    return mod.invoke as TauriInvoke;
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('jarvis_voice_timeout')), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

class JarvisHighLocalProvider implements VoiceProvider {
  readonly id = 'jarvis_local' as const;
  private stopPlayback: (() => void) | null = null;

  async isAvailable(): Promise<boolean> {
    const invoke = await getInvoke();
    if (!invoke) return false;
    try {
      const status = await invoke<{ installed: boolean; ready: boolean }>('jarvis_voice_status');
      return Boolean(status?.ready);
    } catch {
      return false;
    }
  }

  async warmup(): Promise<void> {
    const invoke = await getInvoke();
    if (!invoke) return;
    try {
      await withTimeout(invoke<void>('jarvis_voice_warmup'), WARMUP_TIMEOUT_MS);
    } catch {
      // Warmup is best-effort; normal synthesis retains the OS fallback.
    }
  }

  async speakChunk(text: string, options: SpeakChunkOptions): Promise<void> {
    if (options.signal.aborted) return;
    const invoke = await getInvoke();
    if (!invoke) throw new Error('jarvis_voice_unavailable');
    const result = await withTimeout(
      invoke<{ audio: string; mime: string }>('jarvis_voice_speak', {
        text,
        speed: options.preset === 'friday' ? 1.02 : 1,
      }),
      LOCAL_GENERATION_TIMEOUT_MS,
    );
    if (options.signal.aborted) return;
    this.stopPlayback = await playBase64Audio(result.audio, result.mime || 'audio/wav', {
      volume: options.volume ?? 1,
      signal: options.signal,
    });
  }

  stop(): void {
    this.stopPlayback?.();
    this.stopPlayback = null;
  }
}

export const jarvisHighLocalProvider = new JarvisHighLocalProvider();
