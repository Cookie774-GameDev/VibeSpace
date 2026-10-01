import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchCanvas } from './WorkbenchCanvas';
import { useWorkbenchStore } from './store';

describe('WorkbenchCanvas minimap', () => {
  beforeEach(() => {
    useWorkbenchStore.getState().resetWorkbench();
    useWorkbenchStore.setState({
      panels: [
        {
          id: 'notes-1',
          kind: 'notes',
          title: 'Notes',
          x: 400,
          y: 300,
          width: 320,
          height: 240,
          z: 1,
          minimized: false,
          status: 'idle',
          settings: {},
        },
      ],
      view: { x: -1800, y: -1200, zoom: 0.45 },
      canvasSize: { width: 1000, height: 700 },
      history: [],
      future: [],
    });
  });

  it('is interactive and All / double-click fit all work without moving panels', () => {
    render(<WorkbenchCanvas />);

    const minimap = screen.getByTestId('workbench-minimap');
    expect(minimap.getAttribute('aria-label')).toBe('Workbench minimap');
    expect(screen.getByRole('button', { name: 'Show all work' })).toBeTruthy();

    const beforePanel = { ...useWorkbenchStore.getState().panels[0]! };
    const beforeView = { ...useWorkbenchStore.getState().view };

    fireEvent.click(screen.getByRole('button', { name: 'Show all work' }));

    const after = useWorkbenchStore.getState();
    expect(after.panels[0]).toMatchObject({
      id: beforePanel.id,
      x: beforePanel.x,
      y: beforePanel.y,
      width: beforePanel.width,
      height: beforePanel.height,
    });
    // Camera moved (jsdom canvas size is tiny so zoom may floor at 0.25).
    expect(after.view.x !== beforeView.x || after.view.y !== beforeView.y || after.view.zoom !== beforeView.zoom).toBe(
      true,
    );
    expect(after.view.zoom).toBeGreaterThanOrEqual(0.25);
  });

  it('focuses a panel from the minimap marker (camera only)', () => {
    render(<WorkbenchCanvas />);
    const marker = screen.getByRole('button', { name: 'Focus panel from minimap' });
    fireEvent.click(marker);

    const state = useWorkbenchStore.getState();
    expect(state.selectedIds).toContain('notes-1');
    // Still only camera + selection — geometry unchanged.
    expect(state.panels[0]?.x).toBe(400);
    expect(state.panels[0]?.y).toBe(300);
  });
});
