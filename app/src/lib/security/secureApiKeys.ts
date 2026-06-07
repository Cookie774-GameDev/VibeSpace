import type { ProviderId } from '@/types/common';
import { isTauri } from '@/lib/utils';

export const SECRET_API_KEY_PROVIDERS: readonly ProviderId[] = [
  'anthropic',
  'openai',
  'google',
  'xai',
  'openrouter',
  'groq',
  'deepseek',
  'mistral',
  'together',
  'cohere',
  'perplexity',
  'fireworks',
  'replicate',
  'hyperbolic',
  'novita',
  'lambda',
];

const browserSessionVault = new Map<ProviderId, string>();

export function isSecretApiKeyProvider(provider: ProviderId): boolean {
  return SECRET_API_KEY_PROVIDERS.includes(provider);
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke<T>(cmd, args);
}

export async function secureSetApiKey(provider: ProviderId, key: string): Promise<void> {
  if (!isSecretApiKeyProvider(provider)) return;
  const trimmed = key.trim();
  if (isTauri) {
    await invoke('credential_set', { provider, key: trimmed });
    return;
  }
  if (trimmed) browserSessionVault.set(provider, trimmed);
  else browserSessionVault.delete(provider);
}

export async function secureGetApiKey(provider: ProviderId): Promise<string | undefined> {
  if (!isSecretApiKeyProvider(provider)) return undefined;
  if (isTauri) {
    const value = await invoke<string | null>('credential_get', { provider });
    return typeof value === 'string' && value.trim() ? value : undefined;
  }
  return browserSessionVault.get(provider);
}

export async function secureDeleteApiKey(provider: ProviderId): Promise<void> {
  if (!isSecretApiKeyProvider(provider)) return;
  if (isTauri) {
    await invoke('credential_delete', { provider });
    return;
  }
  browserSessionVault.delete(provider);
}

export async function loadSecureApiKeys(): Promise<Partial<Record<ProviderId, string>>> {
  const entries = await Promise.all(
    SECRET_API_KEY_PROVIDERS.map(async (provider) => {
      try {
        const value = await secureGetApiKey(provider);
        return value ? ([provider, value] as const) : null;
      } catch (err) {
        console.warn(`[credentials] Could not load ${provider} API key from secure storage`, err);
        return null;
      }
    }),
  );
  return Object.fromEntries(entries.filter(Boolean) as Array<readonly [ProviderId, string]>);
}
