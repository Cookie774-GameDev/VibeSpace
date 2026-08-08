/**
 * Terminals feature barrel.
 *
 * Tile-grid only as of the Projects update — `TerminalGrid` (the
 * legacy splits renderer) was retired. The pane tree shape itself is
 * still public so other features can read pane metadata.
 */

export { TerminalView } from './TerminalView';
export { TileGrid } from './TileGrid';
export { TerminalsPage } from './TerminalsPage';
export { AgentRolePicker } from './AgentRolePicker';
export type { TerminalViewProps } from './types';
export * from './terminalCommandFoundation';
export * from './terminalPromptProtocol';
export * from './terminalSlashIntegration';
export { TerminalCommandPalette } from './TerminalCommandPalette';
export {
  runTerminalPromptUpgrade,
  terminalPromptUpgradeChatId,
  canInsertUpgradedPromptIntoTerminal,
  buildTerminalPromptUpgradeSources,
  buildTerminalRelatedSources,
  collectTerminalRelatedSources,
  prepareUpgradedPromptInsert,
} from './terminalPromptUpgrade';
export {
  installTerminalCli,
  readTerminalCliInstallStatus,
  uninstallTerminalCli,
} from './terminalCliInstall';
export type { TerminalCliInstallStatus } from './terminalCliInstall';
export { TerminalCliRuntimeHost } from './TerminalCliRuntimeHost';
export {
  type PaneNode,
  type LeafBase,
  newLeaf,
  closePane,
  countLeaves,
  findPane,
  updateLeaf,
  flattenLeaves,
  fromLeaves,
  appendLeaf,
  gridDimensions,
  MAX_PANES,
} from './paneTree';
