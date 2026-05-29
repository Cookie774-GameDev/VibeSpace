/**
 * Terminals feature barrel.
 */

export { TerminalView } from './TerminalView';
export { TerminalGrid } from './TerminalGrid';
export { TerminalsPage } from './TerminalsPage';
export type { TerminalViewProps } from './types';
export {
  type PaneNode,
  newLeaf,
  splitPane,
  closePane,
  setRatio,
  countLeaves,
  findPane,
  updateLeaf,
  firstLeafId,
  MAX_PANES,
} from './paneTree';
