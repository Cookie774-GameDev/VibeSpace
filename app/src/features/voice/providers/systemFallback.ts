/**
 * system_tts_fallback — wraps the browser/OS SpeechSynthesis API via the
 * existing speechSynthesis module. This is the universal safety net: it needs
 * no model download, no network, and no API key. Used when Kokoro isn't ready
 * and cloud voice is unavailable.
 */
import type { SpeakChunkOptions, VoiceProvider } from './types';
import { isSpeechSynthesisSupported, speakText } from '../speechSynthesis';

class SystemFallbackProvider implements VoiceProvider {
  readonly id = 'system_tts_fallback' as const;

  async isAvailable(): Promise<boolean> {
    return isSpeechSynthesisSupported();
  }

  async speakChunk(text: string, options: SpeakChunkOptions): Promise<void> {
    if (options.signal.aborted) return;
    // Map our TTS preset onto a persona the speechSynthesis voice picker knows.
    const persona = options.preset === 'friday' ? 'athena' : 'jarvis';
    const rate = options.preset === 'friday' ? 1.05 : 0.96;
    const onAbort = () => {
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* ignore */
      }
    };
    options.signal.addEventListener('abort', onAbort, { once: true });
    try {
      await speakText(text, { persona, rate, volume: options.volume ?? 1 });
    } finally {
      options.signal.removeEventListener('abort', onAbort);
    }
  }

  stop(): void {
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* ignore */
    }
  }
}

export const systemFallbackProvider = new SystemFallbackProvider();
