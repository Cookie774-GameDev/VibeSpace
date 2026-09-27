import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorPanel } from './EditorPanel';
import { useWorkbenchStore } from './store';
import type { WorkbenchPanel } from './types';

afterEach(() => vi.restoreAllMocks());

describe('Workbench editor device preview', () => {
  it('opens a laptop in landscape with the current edited source', async () => {
    const openDevicePreview = vi.fn(() => 'preview-1');
    const previous = useWorkbenchStore.getState().openDevicePreview;
    act(() => useWorkbenchStore.setState({ openDevicePreview }));
    const panel: WorkbenchPanel = {
      id: 'editor-preview-test',
      kind: 'editor',
      title: 'Draft',
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      z: 1,
      minimized: false,
      status: 'ready',
      settings: { language: 'html', previewDeviceId: 'macbook-air-13', note: '<p>First</p>' },
    };
    try {
      const view = render(<EditorPanel panel={panel} onUpdate={vi.fn()} />);
      fireEvent.change(screen.getByRole('textbox', { name: 'Editor content' }), {
        target: { value: '<p>Updated</p>' },
      });
      fireEvent.click(
        screen.getByRole('button', { name: /Open 13-inch Retina laptop layout preview/ }),
      );
      expect(openDevicePreview).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceId: 'macbook-air-13',
          orientation: 'landscape',
          content: '<p>Updated</p>',
        }),
      );
      await act(async () => Promise.resolve());
      view.unmount();
    } finally {
      useWorkbenchStore.setState({ openDevicePreview: previous });
    }
  });
});
