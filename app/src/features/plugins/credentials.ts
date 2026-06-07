import { isTauri } from '@/lib/utils';

const browserSessionVault = new Map<string, string>();

function credentialKey(pluginId: string, fieldId: string): string {
  const clean = `${pluginId}-${fieldId}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return `plugin-${clean}`;
}

async function invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke<T>(command, args);
}

export async function setPluginCredential(
  pluginId: string,
  fieldId: string,
  value: string,
): Promise<void> {
  const key = credentialKey(pluginId, fieldId);
  const trimmed = value.trim();
  if (isTauri) {
    await invoke('credential_set', { provider: key, key: trimmed });
  } else if (trimmed) {
    browserSessionVault.set(key, trimmed);
  } else {
    browserSessionVault.delete(key);
  }
}

export async function getPluginCredential(
  pluginId: string,
  fieldId: string,
): Promise<string | undefined> {
  const key = credentialKey(pluginId, fieldId);
  if (isTauri) {
    const value = await invoke<string | null>('credential_get', { provider: key });
    return value?.trim() || undefined;
  }
  return browserSessionVault.get(key);
}

export async function deletePluginCredential(pluginId: string, fieldId: string): Promise<void> {
  const key = credentialKey(pluginId, fieldId);
  if (isTauri) {
    await invoke('credential_delete', { provider: key });
  } else {
    browserSessionVault.delete(key);
  }
}
