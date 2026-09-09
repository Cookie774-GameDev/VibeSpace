import type { TerminalRef } from '@/features/terminals/terminalRefs';

export type WorkbenchTerminalCommand = { command: string; id: number; target: TerminalRef };
const listeners = new Set<{
  readRef: () => TerminalRef;
  receive: (command: WorkbenchTerminalCommand) => void;
}>();
let sequence = 0;

export function subscribeWorkbenchTerminalCommands(
  readRef: () => TerminalRef,
  receive: (command: WorkbenchTerminalCommand) => void,
) {
  const listener = { readRef, receive };
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function deliverWorkbenchTerminalCommand(
  command: string,
  refs: readonly TerminalRef[],
): number {
  let delivered = 0;
  const seen = new Set<string>();
  if (!command.trim()) return 0;
  for (const ref of refs) {
    if (!ref.paneId || !ref.sessionId || seen.has(ref.paneId)) continue;
    seen.add(ref.paneId);
    const matches = [...listeners].filter(({ readRef }) => {
      const live = readRef();
      return (
        live.paneId === ref.paneId &&
        live.sessionId === ref.sessionId &&
        live.projectId === ref.projectId
      );
    });
    if (matches.length !== 1) continue;
    matches[0].receive({ command, id: ++sequence, target: { ...ref } });
    delivered++;
  }
  return delivered;
}
