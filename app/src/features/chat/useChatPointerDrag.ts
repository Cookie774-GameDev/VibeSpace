import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { Chat } from '@/types/chat';
import { writeChatDragPayload } from './chatDragPayload';

function suppressReleaseClick() {
  // A pointer drag is not a click. Windows can dispatch the compatibility click
  // to the drop target/common ancestor, outside the original sidebar row.
  const clear = () => {
    window.removeEventListener('click', suppress, true);
    window.removeEventListener('pointerdown', clear, true);
    window.clearTimeout(timer);
  };
  const suppress = (event: MouseEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    clear();
  };
  const timer = window.setTimeout(clear, 400);
  window.addEventListener('click', suppress, true);
  window.addEventListener('pointerdown', clear, true);
}

/** Keep internal chat drags in the WebView; native OS file drops remain untouched. */
export function useChatPointerDrag(chat: Chat) {
  const cleanup = useRef<() => void>(() => undefined);
  const suppressClick = useRef(false);
  useEffect(() => () => cleanup.current(), []);
  return {
    draggable: false,
    onClickCapture: (event: React.MouseEvent<HTMLElement>) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || event.pointerType === 'touch') return;
      const button = (event.target as Element).closest('button');
      // Pin/menu controls keep their ordinary pointer behavior.
      if (button?.hasAttribute('aria-label') && button !== event.currentTarget) return;
      cleanup.current();
      suppressClick.current = false;
      const origin = { x: event.clientX, y: event.clientY, id: event.pointerId };
      const source = event.currentTarget;
      let transfer: DataTransfer | null = null;
      let hovered: Element | null = null;
      const send = (target: EventTarget, type: string, point: PointerEvent) => {
        target.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
            clientX: point.clientX,
            clientY: point.clientY,
          }),
        );
      };
      const move = (point: PointerEvent) => {
        if (point.pointerId !== origin.id) return;
        if (!transfer && Math.hypot(point.clientX - origin.x, point.clientY - origin.y) < 6) return;
        if (!transfer) {
          transfer = new DataTransfer();
          writeChatDragPayload(transfer, chat);
          transfer.effectAllowed = 'link';
          suppressClick.current = true;
          try {
            source.setPointerCapture(origin.id);
          } catch {
            /* Detached/test elements may not capture. */
          }
          send(window, 'dragstart', point);
        }
        point.preventDefault();
        const next = document.elementFromPoint(point.clientX, point.clientY);
        if (hovered && hovered !== next) send(hovered, 'dragleave', point);
        hovered = next;
        if (hovered) send(hovered, 'dragover', point);
      };
      const end = (point: PointerEvent) => {
        if (point.pointerId !== origin.id) return;
        if (transfer) {
          point.preventDefault();
          suppressReleaseClick();
          const target = document.elementFromPoint(point.clientX, point.clientY);
          if (target && point.type === 'pointerup') send(target, 'drop', point);
        }
        cleanup.current();
      };
      const cancel = () => cleanup.current();
      const key = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key === 'Escape') cancel();
      };
      cleanup.current = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        window.removeEventListener('blur', cancel);
        window.removeEventListener('keydown', key);
        if (source.hasPointerCapture?.(origin.id)) source.releasePointerCapture(origin.id);
        if (transfer) window.dispatchEvent(new Event('dragend'));
        transfer = null;
        cleanup.current = () => undefined;
      };
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      window.addEventListener('blur', cancel);
      window.addEventListener('keydown', key);
    },
  };
}
