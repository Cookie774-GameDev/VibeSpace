import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CanvasPage } from './CanvasPage';
import { useUIStore } from '@/stores/ui';

afterEach(() => vi.unstubAllGlobals());

it('uses the actual infinite viewport for zoom and exposes the full Notes route', () => {
  let resize: ResizeObserverCallback = () => {};
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  useUIStore.setState({ route: 'canvas' });
  render(<CanvasPage persistence={{ scope: null, repository: {} as never }} />);
  const workspace = screen.getByRole('region', { name: 'Canvas workspace' });
  expect(workspace.dataset.layout).toBe('edgeless');
  act(() =>
    resize(
      [{ contentRect: { width: 800, height: 600 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    ),
  );
  fireEvent.wheel(workspace, { deltaY: -100, clientX: 400, clientY: 300 });
  expect(Number(workspace.dataset.cameraX)).toBeCloseTo(0);
  expect(Number(workspace.dataset.cameraY)).toBeCloseTo(0);
  expect(Number(workspace.dataset.cameraZoom)).toBeGreaterThan(1);
  expect(workspace.style.overflow).toBe('hidden');
  fireEvent.click(screen.getByRole('button', { name: 'Open Notes' }));
  expect(useUIStore.getState().route).toBe('notes');
});
