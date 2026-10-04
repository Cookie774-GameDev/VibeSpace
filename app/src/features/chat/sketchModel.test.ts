import { beforeEach, describe, expect, it } from 'vitest';
import {
  readSketchDraft,
  resizeSketchItem,
  sketchBounds,
  sketchSvg,
  writeSketchDraft,
  type SketchItem,
} from './sketchModel';

const triangle: SketchItem = {
  id: 'triangle-1',
  kind: 'shape',
  shape: 'triangle',
  x: 20,
  y: 30,
  width: 120,
  height: 80,
  color: '#a34c2c',
  size: 7,
};

describe('sketch draft and export', () => {
  beforeEach(() => localStorage.clear());

  it('preserves separate chat drafts and clears only the saved chat', () => {
    expect(writeSketchDraft('chat-a', [triangle])).toBe(true);
    expect(writeSketchDraft('chat-b', [{ ...triangle, id: 'other' }])).toBe(true);
    expect(readSketchDraft('chat-a')).toEqual([triangle]);
    expect(writeSketchDraft('chat-a', [])).toBe(true);
    expect(readSketchDraft('chat-a')).toEqual([]);
    expect(readSketchDraft('chat-b')).toHaveLength(1);
  });

  it('rejects malformed persisted strokes and escapes exported text', () => {
    localStorage.setItem(
      'vibespace:chat-sketch:v1:bad',
      JSON.stringify([
        { id: 'bad', kind: 'stroke', points: [], color: '#000000', size: 4 },
        triangle,
      ]),
    );
    expect(readSketchDraft('bad')).toEqual([triangle]);
    const svg = sketchSvg([
      {
        id: 'text',
        kind: 'text',
        x: 2,
        y: 30,
        text: '<hello & "world">',
        color: '#000000',
        size: 20,
      },
    ]);
    expect(svg).toContain('&lt;hello &amp; &quot;world&quot;&gt;');
    expect(svg).not.toContain('<hello');
  });

  it('resizes a selected shape to the requested bounds', () => {
    const resized = resizeSketchItem(triangle, { x: 45, y: 60, width: 200, height: 150 });
    expect(sketchBounds(resized)).toEqual({ x: 45, y: 60, width: 200, height: 150 });
  });
});
