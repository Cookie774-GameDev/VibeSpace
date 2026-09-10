import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CREATIVE_KINDS, creativeStyle } from './creative';
import { CreativeTools } from './CreativeTools';
import { CreativeItem } from './CreativeItem';
import { useWorkbenchStore } from './store';
import { sanitizeWorkbenchDocument, documentToTemplatePanels } from './persistence';

describe('Workbench Creative', () => {
  beforeEach(() => {
    useWorkbenchStore.setState({
      panels: [],
      history: [],
      future: [],
      selectedIds: [],
      view: { x: 0, y: 0, zoom: 1 },
      canvasSize: { width: 1000, height: 700 },
    });
  });
  afterEach(cleanup);
  it('creates every tool from the hover menu without replacing existing panels', () => {
    useWorkbenchStore.getState().addPanel('terminal');
    render(<CreativeTools />);
    for (const label of [
      'Text',
      'Title',
      'Border / frame',
      'Rectangle',
      'Ellipse',
      'Diamond',
      'Line',
      'Arrow',
      'Freehand',
    ]) {
      fireEvent.mouseEnter(screen.getByRole('button', { name: 'Creative' }));
      fireEvent.click(screen.getByRole('menuitem', { name: label }));
    }
    expect(
      useWorkbenchStore
        .getState()
        .panels.map((p) => p.settings.creative?.kind)
        .filter(Boolean),
    ).toEqual(CREATIVE_KINDS);
    expect(useWorkbenchStore.getState().panels[0].kind).toBe('terminal');
  });
  it('persists styles, small geometry, back ordering, text and drawing in documents/templates', () => {
    const s = useWorkbenchStore.getState();
    const id = s.addPanel('creative', undefined, {
      creative: creativeStyle({
        kind: 'draw',
        points: [
          [1, 2],
          [500, 900],
        ],
        dash: 'dotted',
        font: 'hand',
        fill: '#123456',
      }),
      note: 'My title',
    })!;
    s.updatePanel(id, { width: 65, height: 45, z: -5 });
    const doc = useWorkbenchStore.getState().toDocument();
    const saved = sanitizeWorkbenchDocument(JSON.parse(JSON.stringify(doc)), () => doc);
    expect(saved.panels).toEqual(doc.panels);
    expect(documentToTemplatePanels(saved.panels)[0].settings.creative).toEqual(
      doc.panels[0].settings.creative,
    );
  });
  it('undoes/redoes creative edits and duplication without changing originals', () => {
    const s = useWorkbenchStore.getState();
    const id = s.addPanel('creative', undefined, {
      creative: creativeStyle({ kind: 'title' }),
      note: 'First',
    })!;
    s.updatePanel(id, { settings: { note: 'Second' } });
    s.undo();
    expect(useWorkbenchStore.getState().panels[0].settings.note).toBe('First');
    s.redo();
    s.duplicatePanel(id);
    expect(useWorkbenchStore.getState().panels.map((p) => p.settings.note)).toEqual([
      'Second',
      'Second',
    ]);
    s.undo();
    expect(useWorkbenchStore.getState().panels).toHaveLength(1);
  });
  it('clamps malformed imported styles and rejects executable color/path payloads', () => {
    const s = creativeStyle({
      kind: 'script',
      color: 'url(https://example.com)',
      fill: '<script>',
      fontSize: Infinity,
      stroke: -8,
      opacity: 8,
      points: [
        [NaN, 0],
        [Infinity, 2],
        [9999, -20],
      ],
      font: 'url(unsafe)',
    });
    expect(s).toMatchObject({
      kind: 'text',
      color: '#e8c99b',
      fill: 'none',
      stroke: 1,
      opacity: 1,
      fontSize: 24,
      font: 'sans',
      points: [[1000, 0]],
    });
  });
  it('edits literal text, cancels drafts and supports keyboard resizing', () => {
    const id = useWorkbenchStore.getState().addPanel('creative', undefined, {
      creative: creativeStyle({ kind: 'text' }),
      note: 'Initial',
    })!;
    const onUpdate = vi.fn();
    render(
      <CreativeItem
        panel={useWorkbenchStore.getState().panels.find((p) => p.id === id)!}
        selected
        zoom={1}
        onUpdate={onUpdate}
        onSelect={vi.fn()}
        onDuplicate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit text' }));
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '<img src=x onerror=alert(1)>' },
    });
    fireEvent.blur(screen.getByRole('textbox'));
    expect(onUpdate).toHaveBeenCalledWith({ settings: { note: '<img src=x onerror=alert(1)>' } });
    expect(document.querySelector('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit text' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Discard' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(screen.getByText('Initial')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Resize creative item' }), {
      key: 'ArrowRight',
    });
    expect(onUpdate).toHaveBeenCalledWith({ width: 370, height: 180 });
  });
});
