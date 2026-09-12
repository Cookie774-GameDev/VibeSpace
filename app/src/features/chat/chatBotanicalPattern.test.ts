import { describe, expect, it } from 'vitest';
import { botanicalRandom, botanicalSections, paintBotanicalBackground } from './chatBotanicalPattern';

describe('procedural chat foliage', () => {
  const sample = (chat: string, section: number, side = 0) => {
    const random = botanicalRandom(chat, section, side);
    return Array.from({ length: 20 }, random);
  };
  it('recreates the same artwork when revisiting history', () => {
    expect(sample('chat-a', 5)).toEqual(sample('chat-a', 5));
  });
  it('varies across sections, chats, and edges', () => {
    expect(sample('chat-a', 5)).not.toEqual(sample('chat-a', 6));
    expect(sample('chat-a', 5)).not.toEqual(sample('chat-b', 5));
    expect(sample('chat-a', 5)).not.toEqual(sample('chat-a', 5, 1));
    expect(sample('chat-a', 5).every(n => n >= 0 && n < 1)).toBe(true);
  });
  it('draws only the viewport sections regardless of history length', () => {
    expect(botanicalSections(0, 900)).toEqual([0, 1]);
    expect(botanicalSections(48000000, 900)).toEqual([100000, 100001]);
    expect(botanicalSections(-20, 480)).toEqual([0, 1]);
  });

  it('keeps painted leaf outlines apart across sizes, seeds and section boundaries', () => {
    for (const width of [320, 520, 1200, 1920]) {
      for (let seed = 0; seed < 40; seed++) {
        let matrix = [1, 0, 0, 1, 0, 0];
        const stack: number[][] = [];
        let points: number[][] = [];
        const leaves: { left: number; right: number; top: number; bottom: number }[] = [];
        const point = (x: number, y: number) => points.push([
          matrix[0] * x + matrix[2] * y + matrix[4],
          matrix[1] * x + matrix[3] * y + matrix[5],
        ]);
        const context = {
          clearRect() {}, stroke() {},
          save() { stack.push([...matrix]); },
          restore() { matrix = stack.pop()!; },
          translate(x: number, y: number) {
            matrix[4] += matrix[0] * x + matrix[2] * y;
            matrix[5] += matrix[1] * x + matrix[3] * y;
          },
          scale(x: number, y: number) {
            matrix[0] *= x; matrix[1] *= x; matrix[2] *= y; matrix[3] *= y;
          },
          rotate(angle: number) {
            const [a, b, c, d] = matrix;
            const cos = Math.cos(angle), sin = Math.sin(angle);
            matrix[0] = a * cos + c * sin; matrix[1] = b * cos + d * sin;
            matrix[2] = c * cos - a * sin; matrix[3] = d * cos - b * sin;
          },
          beginPath() { points = []; }, moveTo: point, lineTo: point,
          quadraticCurveTo(a: number, b: number, c: number, d: number) { point(a, b); point(c, d); },
          bezierCurveTo(a: number, b: number, c: number, d: number, e: number, f: number) {
            point(a, b); point(c, d); point(e, f);
          },
          fill() {
            leaves.push({ left: Math.min(...points.map(p => p[0])), right: Math.max(...points.map(p => p[0])),
              top: Math.min(...points.map(p => p[1])), bottom: Math.max(...points.map(p => p[1])) });
          },
        };
        paintBotanicalBackground(context as unknown as CanvasRenderingContext2D,
          `layout-${seed}`, width, 1440, 120, '#775f4c');
        expect(leaves.length).toBeGreaterThan(4);
        for (let i = 0; i < leaves.length; i++) {
          const a = leaves[i];
          expect(a.left).toBeGreaterThanOrEqual(4);
          expect(a.right).toBeLessThanOrEqual(width - 4);
          for (const b of leaves.slice(i + 1)) {
            expect(a.right + 11.9 <= b.left || b.right + 11.9 <= a.left ||
              a.bottom + 11.9 <= b.top || b.bottom + 11.9 <= a.top).toBe(true);
          }
        }
      }
    }
  });
});
