import { invoke } from '@tauri-apps/api/core';
import { resolveRuntimePlan } from '@/lib/runtimeProfile';

type Input = {
  accountId: string;
  projectId?: string | null;
  paneId?: string | null;
  cwd?: string | null;
  restore: boolean;
  command?: string;
  startupCommand?: string;
  startupCommands?: readonly string[];
};
type ManagedLaunch = { state: 'new' | 'resume'; startupCommand: string };

/** Only the explicit Claude preset is managed. Arbitrary shell text stays user-controlled. */
export async function prepareManagedClaudeContinuity(
  input: Input,
  prepare: (command: string, args: Record<string, unknown>) => Promise<unknown> = invoke,
): Promise<ManagedLaunch | null> {
  const { accountId, projectId, paneId, cwd, restore } = input;
  const startup =
    input.startupCommands?.length === 1 ? input.startupCommands[0] : input.startupCommand;
  if (
    !resolveRuntimePlan().terminalCliEnabled ||
    !accountId ||
    !paneId ||
    (input.startupCommands?.length ?? 0) > 1 ||
    (startup?.trim() ?? input.command?.trim()) !== 'claude'
  )
    return null;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const shell = input.command?.trim() === 'claude' ? undefined : input.command;
    if (shell && !/(^|[\\/])(powershell|pwsh|bash|zsh|sh|fish)(\.exe)?$/i.test(shell)) return null;
    const value = (await Promise.race([
      prepare('terminal_claude_continuity_prepare', {
        accountId,
        projectId: projectId || '__default__',
        paneId,
        cwd: cwd ?? null,
        restore,
        shell,
      }),
      new Promise<null>((resolve) => {
        deadline = setTimeout(() => resolve(null), 3000);
      }),
    ])) as Partial<ManagedLaunch> | null;
    if (
      !value ||
      value.state !== (restore ? 'resume' : 'new') ||
      typeof value.startupCommand !== 'string' ||
      !value.startupCommand
    )
      return null;
    return value as ManagedLaunch;
  } catch {
    return null;
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}
