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
  'qwen',
  'cohere',
  'perplexity',
  'fireworks',
  'replicate',
  'hyperbolic',
  'novita',
  'lambda',
];

const browserSessionVault = new Map<ProviderId, string>();

export type ApiKeySaveErrorCode =
  | 'credential-write-failed'
  | 'credential-read-failed'
  | 'credential-verification-failed'
  | 'harness-refresh-failed';

export type ApiKeySaveResult = { ok: true } | { ok: false; code: ApiKeySaveErrorCode };

export interface SecureApiKeyHydrationResult {
  keys: Partial<Record<ProviderId, string>>;
  status: 'ready' | 'degraded';
  failedProviders: ProviderId[];
}

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

async function deleteApiKeyFromVault(provider: ProviderId): Promise<void> {
  if (!isSecretApiKeyProvider(provider)) return;
  if (isTauri) {
    await invoke('credential_delete', { provider });
    return;
  }
  browserSessionVault.delete(provider);
}

interface CredentialRuntimeDependencies {
  available(): boolean;
  stop(): Promise<boolean>;
  refresh(): Promise<void>;
}

export async function refreshOpenCodeCredentialRuntime(
  dependencies: CredentialRuntimeDependencies = {
    available: () => isTauri,
    stop: () => invoke<boolean>('opencode_server_stop'),
    refresh: async () => {
      const { harnessRuntimeManager } = await import('@/lib/harness/runtimeManager');
      await harnessRuntimeManager.refresh();
    },
  },
): Promise<void> {
  if (!dependencies.available()) return;
  const stopped = await dependencies.stop();
  if (stopped) await dependencies.refresh();
}

interface DeleteApiKeyDependencies {
  delete: typeof deleteApiKeyFromVault;
  refresh: typeof refreshOpenCodeCredentialRuntime;
}

export async function deleteApiKeySecurely(
  provider: ProviderId,
  dependencies: DeleteApiKeyDependencies = {
    delete: deleteApiKeyFromVault,
    refresh: refreshOpenCodeCredentialRuntime,
  },
): Promise<void> {
  if (!isSecretApiKeyProvider(provider)) return;
  await dependencies.delete(provider);
  await dependencies.refresh();
}

export async function secureDeleteApiKey(provider: ProviderId): Promise<void> {
  await deleteApiKeySecurely(provider);
}

function sameSecret(left: string | undefined, right: string): boolean {
  if (!left || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < right.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

interface VerifiedSaveDependencies {
  set: typeof secureSetApiKey;
  get: typeof secureGetApiKey;
  refresh?: typeof refreshOpenCodeCredentialRuntime;
}

export async function saveApiKeySecurely(
  provider: ProviderId,
  key: string,
  dependencies: VerifiedSaveDependencies = {
    set: secureSetApiKey,
    get: secureGetApiKey,
  },
): Promise<ApiKeySaveResult> {
  const trimmed = key.trim();
  try {
    await dependencies.set(provider, trimmed);
  } catch {
    return { ok: false, code: 'credential-write-failed' };
  }

  let stored: string | undefined;
  try {
    stored = await dependencies.get(provider);
  } catch {
    return { ok: false, code: 'credential-read-failed' };
  }
  if (!sameSecret(stored, trimmed)) {
    return { ok: false, code: 'credential-verification-failed' };
  }
  try {
    await (dependencies.refresh ?? refreshOpenCodeCredentialRuntime)();
  } catch {
    return { ok: false, code: 'harness-refresh-failed' };
  }
  return { ok: true };
}

export async function loadSecureApiKeysDetailed(): Promise<SecureApiKeyHydrationResult> {
  const failedProviders: ProviderId[] = [];
  const entries = await Promise.all(
    SECRET_API_KEY_PROVIDERS.map(async (provider) => {
      try {
        const value = await secureGetApiKey(provider);
        return value ? ([provider, value] as const) : null;
      } catch {
        failedProviders.push(provider);
        console.warn(`[credentials] credential-read-failed:${provider}`);
        return null;
      }
    }),
  );
  return {
    keys: Object.fromEntries(entries.filter(Boolean) as Array<readonly [ProviderId, string]>),
    status: failedProviders.length > 0 ? 'degraded' : 'ready',
    failedProviders,
  };
}

export async function loadSecureApiKeys(): Promise<Partial<Record<ProviderId, string>>> {
  return (await loadSecureApiKeysDetailed()).keys;
}
