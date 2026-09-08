import { invoke } from '@tauri-apps/api/core';
import { useAgentStore } from '@/stores/agents';

/** Unknown native state is busy: never interrupt a recovered terminal or agent. */
export async function canInstallStartupUpdate(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sessions = await Promise.race([
      invoke<unknown>('terminal_list'),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 3000);
      }),
    ]);
    return (
      Array.isArray(sessions) &&
      sessions.length === 0 &&
      Object.values(useAgentStore.getState().runStates).every(
        (state) => !state || ['idle', 'done', 'error'].includes(state),
      )
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
