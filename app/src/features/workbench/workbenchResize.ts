export type ResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
export const RESIZE_DIRECTIONS: ResizeDirection[] = ['se', 'n', 'ne', 'e', 's', 'sw', 'w', 'nw'];
type Bounds = { x: number; y: number; width: number; height: number };

export function resizeWorkbenchBounds(
  start: Bounds,
  direction: ResizeDirection,
  dx: number,
  dy: number,
  zoom: number,
): Bounds {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const width = Math.max(
    240,
    Math.round(
      start.width + (direction.includes('w') ? -dx : direction.includes('e') ? dx : 0) / scale,
    ),
  );
  const height = Math.max(
    160,
    Math.round(
      start.height + (direction.includes('n') ? -dy : direction.includes('s') ? dy : 0) / scale,
    ),
  );
  return {
    x: start.x + (direction.includes('w') ? start.width - width : 0),
    y: start.y + (direction.includes('n') ? start.height - height : 0),
    width,
    height,
  };
}
