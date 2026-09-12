/**
 * Voice-provider API keys (Deepgram TTS, etc.) stored in the OS keychain via
 * Tauri credentials — never in localStorage or Supabase sync payloads.
 */
import { isTauri } from '@/lib/utils';
import {
  getDeepgramApiKey,
  loadDeepgramCredential,
  removeDeepgramCredential,
  saveDeepgramCredential,
} from '@/lib/deepgram';

const VOICE_KEY_PROVIDERS = ['deepgram_voice', 'openai_voice'] as const;
export type VoiceKeyProvider = (typeof VOICE_KEY_PROVIDERS)[number];

const browserVault = new Map<VoiceKeyProvider, string>();

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke<T>(cmd, args);
}

export async function setVoiceApiKey(provider: VoiceKeyProvider, key: string): Promise<void> {
  const trimmed = key.trim();
  if (provider === 'deepgram_voice') {
    if (!trimmed) {
      const removed = await removeDeepgramCredential();
      if (removed.health !== 'missing') throw new Error('deepgram_secure_storage_unavailable');
      return;
    }
    const saved = await saveDeepgramCredential(trimmed);
    if (saved.health !== 'connected') throw new Error(`deepgram_${saved.errorCode ?? saved.health}`);
    return;
  }
  if (isTauri) {
    if (!trimmed) {
      await invoke('credential_delete', { provider });
      return;
    }
    await invoke('credential_set', { provider, key: trimmed });
    return;
  }
  if (trimmed) browserVault.set(provider, trimmed);
  else browserVault.delete(provider);
}

export async function getVoiceApiKey(provider: VoiceKeyProvider): Promise<string | undefined> {
  if (provider === 'deepgram_voice') {
    await loadDeepgramCredential();
    return getDeepgramApiKey();
  }
  if (isTauri) {
    const value = await invoke<string | null>('credential_get', { provider });
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }
  return browserVault.get(provider);
}

export async function getDeepgramVoiceKey(): Promise<string | undefined> {
  return getVoiceApiKey('deepgram_voice');
}

export async function getOpenAIVoiceKey(): Promise<string | undefined> {
  return getVoiceApiKey('openai_voice');
}
