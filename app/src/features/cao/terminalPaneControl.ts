import { flattenLeaves, fromLeaves, newLeaf, type PaneNode } from '@/features/terminals/paneTree';

/** Mounted, account/project-bound pane authority. No persisted commands are replayed. */
export function createCaoTerminalPaneRegistry() {
  type Port = { current(): boolean; read(): PaneNode; replace(tree: PaneNode): void };
  const ports = new Map<string, Port>();
  const key = (accountId: string, projectId: string) => JSON.stringify([accountId, projectId]);
  return {
    register(
      accountId: string,
      projectId: string,
      current: Port['current'],
      read: Port['read'],
      replace: Port['replace'],
    ) {
      const id = key(accountId, projectId),
        port = { current, read, replace };
      ports.set(id, port);
      return () => {
        if (ports.get(id) === port) ports.delete(id);
      };
    },
    capture(accountId: string, projectId: string, paneId: string, sessionId: string) {
      const id = key(accountId, projectId),
        port = ports.get(id);
      const read = () => {
        if (!port || ports.get(id) !== port || !port.current())
          throw Error('cao_terminal_pane_unavailable');
        const leaf = flattenLeaves(port.read()).find(
          (row) => row.id === paneId && row.sessionId === sessionId,
        );
        if (
          !leaf ||
          leaf.executionId ||
          leaf.pendingCommand ||
          leaf.startupCommand ||
          leaf.startupCommands?.length
        )
          throw Error('cao_terminal_manual_pane_required');
        return leaf;
      };
      const original = read(),
        revision = JSON.stringify(original);
      const assert = () => {
        if (JSON.stringify(read()) !== revision) throw Error('cao_terminal_pane_changed');
      };
      return {
        assert,
        replace(nextSessionId: string) {
          assert();
          const leaf = newLeaf({
            sessionId: nextSessionId,
            projectId,
            command: original.command,
            cwd: original.cwd,
            name: original.name,
            fontSize: original.fontSize,
            agentSlug: original.agentSlug,
            agentMode: original.agentMode,
            connectedFiles: original.connectedFiles,
            preserveExisting: true,
          });
          if (leaf.kind !== 'leaf') throw Error('cao_terminal_pane_invalid');
          leaf.sessionId = nextSessionId;
          port!.replace(
            fromLeaves(flattenLeaves(port!.read()).map((row) => (row.id === paneId ? leaf : row))),
          );
        },
      };
    },
  };
}
export const caoTerminalPaneRegistry = createCaoTerminalPaneRegistry();
