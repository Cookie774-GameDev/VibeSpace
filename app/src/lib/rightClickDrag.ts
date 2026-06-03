import { contextMapFilePath, contextNodeFilePath } from '@/features/context/tree';

export function startRightClickDrag(
  e: React.MouseEvent | MouseEvent,
  type: 'file' | 'context',
  data: { path: string } | { node: any; tree: any }
) {
  if (e.button !== 2) return;
  e.preventDefault();
  e.stopPropagation();

  const startX = e.clientX;
  const startY = e.clientY;
  let latestX = startX;
  let latestY = startY;
  let dragging = false;
  let preview: HTMLDivElement | null = null;
  let hoverTarget: HTMLElement | null = null;
  let suppressNativeMenuUntil = 0;

  // Determine path to paste
  let path = '';
  let label = '';
  if (type === 'file') {
    path = (data as { path: string }).path;
    label = path.split(/[\\/]/).pop() || path;
  } else {
    const { node, tree } = data as { node: any; tree: any };
    const filePath = contextNodeFilePath(tree, node);
    path = filePath || (node.kind === 'root' && tree?.rootDir ? contextMapFilePath(tree.rootDir) : node.path) || node.title;
    label = node.title;
  }

  const clearHoverTarget = () => {
    hoverTarget?.classList.remove('jarvis-terminal-drop-hover');
    hoverTarget = null;
  };

  const findDropTarget = () => {
    const el = document.elementFromPoint(latestX, latestY) as HTMLElement | null;
    return el?.closest('[data-terminal-drop]') as HTMLElement | null;
  };

  const ensurePreview = () => {
    if (preview) return;
    preview = document.createElement('div');
    preview.className = 'jarvis-terminal-drag-preview';
    preview.textContent = `Paste path · ${label}`;
    document.body.appendChild(preview);
    document.body.classList.add('jarvis-terminal-right-dragging');
  };

  const updatePreview = () => {
    if (!preview) return;
    preview.style.transform = `translate3d(${latestX + 14}px, ${latestY + 14}px, 0)`;
  };

  const cleanup = () => {
    clearHoverTarget();
    preview?.remove();
    preview = null;
    document.body.classList.remove('jarvis-terminal-right-dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    const delay = Math.max(0, suppressNativeMenuUntil - Date.now()) + 50;
    window.setTimeout(() => {
      document.removeEventListener('contextmenu', onContextMenu, true);
    }, delay);
  };

  const onContextMenu = (ev: MouseEvent) => {
    if (dragging || Date.now() < suppressNativeMenuUntil) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  };

  function onMove(ev: MouseEvent) {
    latestX = ev.clientX;
    latestY = ev.clientY;
    const moved = Math.hypot(latestX - startX, latestY - startY);
    if (!dragging && moved < 6) return;
    dragging = true;
    ev.preventDefault();
    ensurePreview();
    updatePreview();

    const target = findDropTarget();
    if (target !== hoverTarget) {
      clearHoverTarget();
      hoverTarget = target;
      if (hoverTarget) {
        hoverTarget.classList.add('jarvis-terminal-drop-hover');
      }
    }
  }

  function onUp(ev: MouseEvent) {
    if (dragging) {
      suppressNativeMenuUntil = Date.now() + 700;
      ev.preventDefault();
      ev.stopPropagation();
      const dropTarget = findDropTarget();
      if (dropTarget) {
        const kind = dropTarget.dataset.terminalDrop;
        if (kind === 'chat') {
          const targetChatId = dropTarget.dataset.terminalDropChatId;
          window.dispatchEvent(
            new CustomEvent('jarvis:composer:insert-text', {
              detail: { text: path, chatId: targetChatId },
            })
          );
        } else if (kind === 'pane') {
          const targetPaneId = dropTarget.dataset.terminalDropPaneId;
          if (targetPaneId) {
            window.dispatchEvent(
              new CustomEvent('jarvis:terminal:write-text', {
                detail: { paneId: targetPaneId, text: path },
              })
            );
          }
        }
      }
    }
    cleanup();
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  document.addEventListener('contextmenu', onContextMenu, true);
}
