import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRightClickDrag } from './rightClickDrag';

describe('startRightClickDrag', () => {
  afterEach(() => {
    document.body.classList.remove('jarvis-terminal-right-dragging');
    delete document.body.dataset.jarvisSuppressContextMenuUntil;
    delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
    vi.restoreAllMocks();
  });

  it('keeps file/context right-drag active through left-button mouseup', () => {
    const dropTarget = document.createElement('div');
    dropTarget.dataset.terminalDrop = 'chat';
    document.body.appendChild(dropTarget);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => dropTarget),
    });
    const inserted = vi.fn();
    window.addEventListener('jarvis:composer:insert-text', inserted);

    startRightClickDrag(
      new MouseEvent('mousedown', {
        button: 2,
        buttons: 2,
        clientX: 10,
        clientY: 10,
        bubbles: true,
        cancelable: true,
      }),
      'file',
      { path: 'C:\\temp\\demo.txt' },
    );

    document.dispatchEvent(
      new MouseEvent('mousemove', {
        buttons: 2,
        clientX: 30,
        clientY: 30,
        bubbles: true,
        cancelable: true,
      }),
    );
    document.dispatchEvent(
      new MouseEvent('mouseup', {
        button: 0,
        buttons: 2,
        clientX: 31,
        clientY: 31,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(document.body.classList.contains('jarvis-terminal-right-dragging')).toBe(true);
    expect(inserted).not.toHaveBeenCalled();

    document.dispatchEvent(
      new MouseEvent('mouseup', {
        button: 2,
        buttons: 0,
        clientX: 32,
        clientY: 32,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(document.body.classList.contains('jarvis-terminal-right-dragging')).toBe(false);
    expect(inserted).toHaveBeenCalledTimes(1);

    window.removeEventListener('jarvis:composer:insert-text', inserted);
    dropTarget.remove();
  });
});
