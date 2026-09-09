/** Keep the menu inside the detached pet WebView, not just inside the desktop. */
export function petContextMenuPosition(
  point: { x: number; y: number },
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const inset = 4;
  return {
    x: Math.max(inset, Math.min(point.x, viewport.width - menu.width - inset)),
    y: Math.max(inset, Math.min(point.y, viewport.height - menu.height - inset)),
  };
}
