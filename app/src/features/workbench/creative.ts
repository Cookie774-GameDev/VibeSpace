export const CREATIVE_KINDS = [
  'text',
  'title',
  'frame',
  'rectangle',
  'ellipse',
  'diamond',
  'line',
  'arrow',
  'draw',
] as const;
export type CreativeKind = (typeof CREATIVE_KINDS)[number];
export interface CreativeStyle {
  kind: CreativeKind;
  color: string;
  fill: string;
  stroke: number;
  dash: 'solid' | 'dashed' | 'dotted';
  opacity: number;
  fontSize: number;
  font: 'sans' | 'serif' | 'hand';
  rotate: number;
  points: number[][];
}
export function creativeStyle(value: unknown): CreativeStyle {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const number = (key: string, fallback: number, min: number, max: number) =>
    typeof v[key] === 'number' && Number.isFinite(v[key])
      ? Math.max(min, Math.min(max, v[key] as number))
      : fallback;
  const color = (value: unknown, fallback: string) =>
    typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value) ? value : fallback;
  return {
    kind: CREATIVE_KINDS.includes(v.kind as CreativeKind) ? (v.kind as CreativeKind) : 'text',
    color: color(v.color, '#e8c99b'),
    fill: v.fill === 'none' ? 'none' : color(v.fill, 'none'),
    stroke: number('stroke', 2, 1, 12),
    opacity: number('opacity', 1, 0.1, 1),
    fontSize: number('fontSize', v.kind === 'title' ? 48 : 24, 12, 160),
    rotate: number('rotate', 0, -360, 360),
    dash: v.dash === 'dashed' || v.dash === 'dotted' ? v.dash : 'solid',
    font: v.font === 'serif' || v.font === 'hand' ? v.font : 'sans',
    points: Array.isArray(v.points)
      ? v.points
          .slice(0, 2000)
          .filter(
            (p) =>
              Array.isArray(p) &&
              p.length === 2 &&
              p.every((n) => typeof n === 'number' && Number.isFinite(n)),
          )
          .map((p) => p.map((n: number) => Math.max(0, Math.min(1000, n))))
      : [],
  };
}
