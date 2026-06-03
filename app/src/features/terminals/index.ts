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
