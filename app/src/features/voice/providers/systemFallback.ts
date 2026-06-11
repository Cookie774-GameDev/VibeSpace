/**
 * system_tts_fallback — wraps the browser/OS SpeechSynthesis API via the
 * existing speechSynthesis module. This is the universal safety net: it needs
 * no model download, no network, and no API key. Used when Kokoro isn't ready
 * and cloud voice is unavailable.
 */
import type { SpeakChunkOptions, VoiceProvider } from './types';
import { useAuthStore } from '@/stores/auth';
import { isSpeechSynthesisSupported, speakText } from '../speechSynthesis';
import { getVoiceProfile } from '../voiceProfiles';

class SystemFallbackProvider implements VoiceProvider {
  readonly id = 'system_tts_fallback' as const;

  async isAvailable(): Promise<boolean> {
    return isSpeechSynthesisSupported();
  }

  async speakChunk(text: string, options: SpeakChunkOptions): Promise<void> {
    if (options.signal.aborted) return;
    const auth = useAuthStore.getState();
    const voicePreset =
      options.preset === 'friday'
        ? 'aurora'
        : options.preset === 'jarvis'
          ? 'jarvis-prime'
          : auth.voicePreset;
    const profile = getVoiceProfile(voicePreset);
    const engine = auth.voiceEngine === 'local' ? 'local' : 'system';
    const onAbort = () => {
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* ignore */
      }
    };
    options.signal.addEventListener('abort', onAbort, { once: true });
    try {
      await speakText(text, {
        voicePreset,
        engine,
        rate: profile.rate,
        pitch: profile.pitch,
        volume: options.volume ?? 1,
      });
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
