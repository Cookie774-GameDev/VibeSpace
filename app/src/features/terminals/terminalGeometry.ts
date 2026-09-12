export interface TerminalGridSize {
  rows: number;
  cols: number;
}

export interface TerminalContainerGeometry {
  width: number;
  height: number;
}

export interface TerminalContainerGeometrySource {
  clientWidth: number;
  clientHeight: number;
}

export const MIN_TERMINAL_CONTAINER_WIDTH = 40;
export const MIN_TERMINAL_CONTAINER_HEIGHT = 40;

export function readTerminalContainerGeometry(
  source: TerminalContainerGeometrySource,
): TerminalContainerGeometry {
  return {
    width: source.clientWidth,
    height: source.clientHeight,
  };
}

export function isUsableTerminalGeometry(
  geometry: TerminalContainerGeometry,
  minWidth = MIN_TERMINAL_CONTAINER_WIDTH,
  minHeight = MIN_TERMINAL_CONTAINER_HEIGHT,
): boolean {
  return geometry.width > minWidth && geometry.height > minHeight;
}

export function sameTerminalGeometry(
  left: TerminalContainerGeometry,
  right: TerminalContainerGeometry,
): boolean {
  return left.width === right.width && left.height === right.height;
}

export function shouldSendTerminalResize(
  previous: TerminalGridSize | null,
  next: TerminalGridSize,
): boolean {
  return previous == null || previous.rows !== next.rows || previous.cols !== next.cols;
}
