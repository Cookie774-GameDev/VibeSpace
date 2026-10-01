export interface SlashCommandProgress {
  command: string;
  phase: 'running' | 'succeeded' | 'failed' | 'cancelled';
  detail: string;
}

export async function runSlashCommandWithProgress(
  command: string,
  execute: () => Promise<boolean | string>,
  update: (state: SlashCommandProgress | null) => void,
  outcome?: () => Pick<SlashCommandProgress, 'phase' | 'detail'> | undefined,
): Promise<boolean | string> {
  update({ command, phase: 'running', detail: 'Working…' });
  try {
    const result = await execute();
    update(result === true
      ? { command, ...(outcome?.() ?? { phase: 'succeeded', detail: 'Completed.' }) }
      : null);
    return result;
  } catch (error) {
    const cancelled = error instanceof Error && error.name === 'AbortError';
    update({
      command,
      phase: cancelled ? 'cancelled' : 'failed',
      detail: cancelled ? 'Cancelled.' : 'Could not finish. Retry the command; check diagnostics if it persists.',
    });
    return true;
  }
}
