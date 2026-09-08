import { sanitizePersistedDraft } from './terminalContentSanitizer';

export type TerminalRestartDecision =
  | { kind: 'safe-shell'; spawnCommand: string | undefined }
  | {
      kind: 'confirm';
      spawnCommand: string | undefined;
      deferredCommand: string;
      deferredCommands?: readonly string[];
    };

const SAFE_SHELLS = new Set([
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'cmd',
  'cmd.exe',
  'bash',
  'bash.exe',
  'sh',
  'sh.exe',
  'zsh',
  'zsh.exe',
  'fish',
  'fish.exe',
  'nu',
  'nu.exe',
]);

function firstPrintableLine(command: string | null | undefined): string {
  if (!command) return '';
  const [firstLine = ''] = command.split(/[\r\n]/, 1);
  return sanitizePersistedDraft(firstLine).trim();
}

function shellCommand(command: string | null | undefined): string | undefined {
  const printable = firstPrintableLine(command);
  if (!printable || /[\r\n]/.test(command ?? '') || printable !== command?.trim()) return undefined;
  const unquoted = printable.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  const basename = unquoted.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
  return SAFE_SHELLS.has(basename) ? printable : undefined;
}

export function terminalRestartDecision(
  command?: string | null,
  startupCommand?: string | null,
  startupCommands?: readonly string[],
): TerminalRestartDecision {
  const safeShell = shellCommand(command);
  if (startupCommands?.length) {
    const deferredCommands = startupCommands.map(firstPrintableLine).filter(Boolean);
    return {
      kind: 'confirm',
      spawnCommand: safeShell,
      deferredCommand: deferredCommands.join('\n'),
      deferredCommands,
    };
  }
  const deferredStartup = firstPrintableLine(startupCommand);
  if (startupCommand) {
    return {
      kind: 'confirm',
      spawnCommand: safeShell,
      deferredCommand: deferredStartup,
    };
  }

  if (command == null || command.trim() === '') {
    return { kind: 'safe-shell', spawnCommand: undefined };
  }
  if (safeShell) {
    return { kind: 'safe-shell', spawnCommand: command };
  }

  return {
    kind: 'confirm',
    spawnCommand: undefined,
    deferredCommand: firstPrintableLine(command),
  };
}

export async function confirmTerminalRestart(
  commands: readonly string[],
  controls: {
    confirm: (commands: readonly string[]) => boolean;
    isCurrent: () => boolean;
    write: (command: string) => Promise<unknown>;
  },
): Promise<void> {
  const printableCommands = commands.filter(Boolean);
  if (!printableCommands.length || !controls.isCurrent() || !controls.confirm(printableCommands))
    return;
  for (const command of printableCommands) {
    if (!controls.isCurrent()) return;
    await controls.write(command);
  }
}
