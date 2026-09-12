import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CreativeItem } from './CreativeItem';
import { creativeStyle } from './creative';
import { useWorkbenchStore } from './store';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('moves freehand at canvas zoom without rewriting its drawing, and supports keyboard nudging', () => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  useWorkbenchStore.setState({ panels: [], history: [], future: [], selectedIds: [] });
  const id = useWorkbenchStore.getState().addPanel('creative', undefined, {
    creative: creativeStyle({ kind: 'draw', points: [[10, 20], [800, 900]] }),
  })!;
  const panel = useWorkbenchStore.getState().panels.find(p => p.id === id)!;
  const update = vi.fn();
  render(<CreativeItem panel={panel} selected zoom={0.5} onUpdate={update}
    onSelect={vi.fn()} onDuplicate={vi.fn()} onClose={vi.fn()} />);
  const handle = screen.getByRole('button', { name: 'Move creative item' });
  handle.setPointerCapture = vi.fn();
  fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(handle, { clientX: 120, clientY: 115 });
  fireEvent.pointerUp(handle, { clientX: 120, clientY: 115 });
  expect(update).toHaveBeenCalledWith({ x: panel.x + 40, y: panel.y + 30, width: panel.width, height: panel.height });
  expect(update.mock.calls.every(([patch]) => !patch.settings)).toBe(true);
  update.mockClear();
  fireEvent.pointerDown(handle, { button: 0, clientX: 50, clientY: 50 });
  fireEvent.pointerMove(handle, { clientX: 70, clientY: 80 });
  fireEvent.pointerCancel(handle);
  fireEvent.pointerUp(handle, { clientX: 70, clientY: 80 });
  expect(update).not.toHaveBeenCalled();
  fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
  expect(update).toHaveBeenCalledWith({ x: panel.x - 10, y: panel.y });
});

it('keeps the edge grip mounted while selecting, so the initial drag completes', () => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  const id = useWorkbenchStore.getState().addPanel('creative', undefined, { creative: creativeStyle({ kind: 'rectangle' }) })!;
  const panel = useWorkbenchStore.getState().panels.find(p => p.id === id)!;
  const update = vi.fn(), select = vi.fn();
  const props = { panel, zoom: 0.5, onUpdate: update, onSelect: select, onDuplicate: vi.fn(), onClose: vi.fn() };
  const { rerender } = render(<CreativeItem {...props} selected={false} />);
  const grip = screen.getByRole('button', { name: 'Select and move creative item' });
  expect(grip.style.getPropertyValue('--grip-width')).toBe('24px');
  grip.setPointerCapture = vi.fn();
  fireEvent.pointerDown(grip, { button: 0, clientX: 100, clientY: 100 });
  expect(select).toHaveBeenCalledOnce();
  rerender(<CreativeItem {...props} selected />);
  expect(screen.getByRole('button', { name: 'Select and move creative item' })).toBe(grip);
  expect(screen.getByRole('button', { name: 'Move creative item' })).toBeTruthy();
  fireEvent.pointerUp(grip, { clientX: 120, clientY: 130 });
  expect(update).toHaveBeenCalledWith({ x: panel.x + 40, y: panel.y + 60, width: panel.width, height: panel.height });
});
