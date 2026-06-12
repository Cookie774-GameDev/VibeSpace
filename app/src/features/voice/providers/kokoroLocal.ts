/**
 * kokoro_local — local Kokoro-82M TTS via a Tauri command.
 *
 * The Rust side (kokoro.rs, added separately to avoid clobbering another
 * agent's in-flight src-tauri changes) exposes:
 *   - kokoro_status() -> { installed, ready }
 *   - kokoro_warmup()
 *   - kokoro_speak({ text, voice, speed }) -> base64 wav/mp3
 *
 * Until the Rust command exists, isAvailable() returns false and the
 * TtsService transparently uses system_tts_fallback. No throw, no UI freeze.
 */
import type { SpeakChunkOptions, VoiceProvider } from './types';
import { VOICE_PRESETS } from '../voicePlans';
import { resolveKokoroSpeed } from '../speechRate';
import { playBase64Audio } from '../audioPlayback';

const LOCAL_GEN_TIMEOUT_MS = 15_000;
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

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('kokoro_timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

class KokoroLocalProvider implements VoiceProvider {
  readonly id = 'kokoro_local' as const;
  private stopFn: (() => void) | null = null;

  async isAvailable(): Promise<boolean> {
    const invoke = await getInvoke();
    if (!invoke) return false;
    try {
      const status = await invoke<{ installed: boolean; ready: boolean }>('kokoro_status');
      return Boolean(status?.ready);
    } catch {
      return false;
    }
  }

  async warmup(): Promise<void> {
    const invoke = await getInvoke();
    if (!invoke) return;
    try {
      await withTimeout(invoke<void>('kokoro_warmup'), WARMUP_TIMEOUT_MS);
    } catch {
      /* warmup best-effort */
    }
  }

  async speakChunk(text: string, options: SpeakChunkOptions): Promise<void> {
    if (options.signal.aborted) return;
    const invoke = await getInvoke();
    if (!invoke) throw new Error('kokoro_unavailable');
    const preset = VOICE_PRESETS[options.preset];
    const result = await withTimeout(
      invoke<{ audio: string; mime: string }>('kokoro_speak', {
        text,
        voice: preset.kokoroVoice,
        speed: resolveKokoroSpeed(preset.speed),
      }),
      LOCAL_GEN_TIMEOUT_MS,
    );
    if (options.signal.aborted) return;
    const stop = await playBase64Audio(result.audio, result.mime || 'audio/wav', {
      volume: options.volume ?? 1,
      signal: options.signal,
    });
    this.stopFn = stop;
  }

  stop(): void {
    this.stopFn?.();
    this.stopFn = null;
  }
}

export const kokoroLocalProvider = new KokoroLocalProvider();
