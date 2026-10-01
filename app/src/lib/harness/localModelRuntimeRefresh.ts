import { isTauri } from '@/lib/utils';

interface LocalModelRuntimeDependencies {
  available(): boolean;
  stop(): Promise<boolean>;
  refresh(): Promise<void>;
}

async function invoke<T>(command: string): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke<T>(command);
}

/**
 * Regenerate the dynamic Ollama model map only when VibeSpace already owns a
 * running private OpenCode server. A model download must never start OpenCode
 * as an unrelated side effect.
 */
export async function refreshOpenCodeLocalModelRuntime(
  dependencies: LocalModelRuntimeDependencies = {
    available: () => isTauri,
    stop: () => invoke<boolean>('opencode_server_stop'),
    refresh: async () => {
      const { harnessRuntimeManager } = await import('./runtimeManager');
      await harnessRuntimeManager.refresh();
    },
  },
): Promise<void> {
  if (!dependencies.available()) return;
  if (await dependencies.stop()) await dependencies.refresh();
}
