export interface PetContextMenuDismissalOptions {
  menuElement: HTMLElement;
  close: () => void;
}

export function installPetContextMenuDismissal({
  menuElement,
  close,
}: PetContextMenuDismissalOptions): () => void {
  const isInside = (target: EventTarget | null) =>
    target instanceof Node && menuElement.contains(target);
  const onPointerDown = (event: PointerEvent) => {
    if (!isInside(event.target)) close();
  };
  const onContextMenu = (event: MouseEvent) => {
    if (!isInside(event.target)) close();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close();
  };

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('contextmenu', onContextMenu, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('popstate', close);
  window.addEventListener('hashchange', close);
  window.addEventListener('blur', close);

  return () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('contextmenu', onContextMenu, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('popstate', close);
    window.removeEventListener('hashchange', close);
    window.removeEventListener('blur', close);
  };
}
