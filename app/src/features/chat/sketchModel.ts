export const SKETCH_WIDTH = 960;
export const SKETCH_HEIGHT = 600;
export const SKETCH_DRAFT_PREFIX = 'vibespace:chat-sketch:v1:';
export const MAX_SKETCH_ITEMS = 500;

export type SketchPoint = { x: number; y: number };
export type SketchShape = 'line' | 'rectangle' | 'ellipse' | 'triangle' | 'arrow';
export type SketchItem =
  | { id: string; kind: 'stroke'; points: SketchPoint[]; color: string; size: number }
  | {
      id: string;
      kind: 'shape';
      shape: SketchShape;
      x: number;
      y: number;
      width: number;
      height: number;
      color: string;
      size: number;
    }
  | { id: string; kind: 'text'; x: number; y: number; text: string; color: string; size: number };

export type SketchBounds = { x: number; y: number; width: number; height: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const safeColor = (value: string) => (/^#[\da-f]{6}$/i.test(value) ? value : '#17212b');
const safeNumber = (value: number) => (Number.isFinite(value) ? value : 0);
const fmt = (value: number) => Math.round(safeNumber(value) * 100) / 100;
const xml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[char]!,
  );

export function sketchBounds(item: SketchItem): SketchBounds {
  if (item.kind === 'shape') {
    return {
      x: Math.min(item.x, item.x + item.width),
      y: Math.min(item.y, item.y + item.height),
      width: Math.abs(item.width),
      height: Math.abs(item.height),
    };
  }
  if (item.kind === 'text') {
    return {
      x: item.x,
      y: item.y - item.size,
      width: Math.max(12, item.text.length * item.size * 0.62),
      height: item.size * 1.25,
    };
  }
  const xs = item.points.map((point) => point.x);
  const ys = item.points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(1, Math.max(...xs) - x),
    height: Math.max(1, Math.max(...ys) - y),
  };
}

export function moveSketchItem(item: SketchItem, dx: number, dy: number): SketchItem {
  if (item.kind === 'stroke')
    return { ...item, points: item.points.map((point) => ({ x: point.x + dx, y: point.y + dy })) };
  return { ...item, x: item.x + dx, y: item.y + dy };
}

export function resizeSketchItem(item: SketchItem, next: SketchBounds): SketchItem {
  const previous = sketchBounds(item);
  const width = Math.max(8, next.width);
  const height = Math.max(8, next.height);
  if (item.kind === 'shape') return { ...item, x: next.x, y: next.y, width, height };
  if (item.kind === 'text')
    return {
      ...item,
      x: next.x,
      y: next.y + height * 0.8,
      size: clamp(item.size * Math.min(width / previous.width, height / previous.height), 10, 160),
    };
  return {
    ...item,
    points: item.points.map((point) => ({
      x: next.x + ((point.x - previous.x) / previous.width) * width,
      y: next.y + ((point.y - previous.y) / previous.height) * height,
    })),
  };
}

export function sketchPath(points: readonly SketchPoint[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${fmt(points[0]!.x)} ${fmt(points[0]!.y)} l 0.01 0`;
  return points
    .map((point, index) => `${index ? 'L' : 'M'} ${fmt(point.x)} ${fmt(point.y)}`)
    .join(' ');
}

export function sketchItemMarkup(item: SketchItem): string {
  const color = safeColor(item.color);
  const size = clamp(safeNumber(item.size), 1, 160);
  if (item.kind === 'stroke')
    return `<path d="${sketchPath(item.points)}" fill="none" stroke="${color}" stroke-width="${fmt(size)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (item.kind === 'text')
    return `<text x="${fmt(item.x)}" y="${fmt(item.y)}" fill="${color}" font-family="Georgia,serif" font-size="${fmt(size)}" font-weight="600">${xml(item.text)}</text>`;
  const bounds = sketchBounds(item);
  const x = fmt(bounds.x),
    y = fmt(bounds.y),
    w = fmt(bounds.width),
    h = fmt(bounds.height);
  const common = `fill="none" stroke="${color}" stroke-width="${fmt(size)}" stroke-linecap="round" stroke-linejoin="round"`;
  switch (item.shape) {
    case 'rectangle':
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" ${common}/>`;
    case 'ellipse':
      return `<ellipse cx="${fmt(x + w / 2)}" cy="${fmt(y + h / 2)}" rx="${fmt(w / 2)}" ry="${fmt(h / 2)}" ${common}/>`;
    case 'triangle':
      return `<path d="M ${fmt(x + w / 2)} ${y} L ${fmt(x + w)} ${fmt(y + h)} L ${x} ${fmt(y + h)} Z" ${common}/>`;
    case 'arrow':
      return `<path d="M ${x} ${fmt(y + h)} L ${fmt(x + w)} ${y} M ${fmt(x + w)} ${y} L ${fmt(x + w * 0.56)} ${fmt(y + h * 0.1)} M ${fmt(x + w)} ${y} L ${fmt(x + w * 0.88)} ${fmt(y + h * 0.45)}" ${common}/>`;
    case 'line':
      return `<path d="M ${x} ${y} L ${fmt(x + w)} ${fmt(y + h)}" ${common}/>`;
  }
}

export function sketchSvg(items: readonly SketchItem[], background = '#fffaf2'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SKETCH_WIDTH}" height="${SKETCH_HEIGHT}" viewBox="0 0 ${SKETCH_WIDTH} ${SKETCH_HEIGHT}"><rect width="100%" height="100%" fill="${safeColor(background)}"/>${items.slice(0, MAX_SKETCH_ITEMS).map(sketchItemMarkup).join('')}</svg>`;
}

function validItem(value: unknown): value is SketchItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<SketchItem> & { x?: number; y?: number; text?: string };
  if (
    typeof item.id !== 'string' ||
    item.id.length > 100 ||
    !['stroke', 'shape', 'text'].includes(String(item.kind))
  )
    return false;
  if (
    typeof item.color !== 'string' ||
    !/^#[\da-f]{6}$/i.test(item.color) ||
    typeof item.size !== 'number' ||
    !Number.isFinite(item.size)
  )
    return false;
  if (item.kind === 'stroke')
    return (
      Array.isArray(item.points) &&
      item.points.length > 0 &&
      item.points.length <= 10000 &&
      item.points.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
    );
  if (item.kind === 'shape')
    return (
      ['line', 'rectangle', 'ellipse', 'triangle', 'arrow'].includes(String(item.shape)) &&
      [item.x, item.y, item.width, item.height].every(
        (number) => typeof number === 'number' && Number.isFinite(number),
      )
    );
  return (
    typeof item.text === 'string' &&
    item.text.length <= 500 &&
    Number.isFinite(item.x) &&
    Number.isFinite(item.y)
  );
}

export function readSketchDraft(scope: string): SketchItem[] {
  try {
    const raw = localStorage.getItem(SKETCH_DRAFT_PREFIX + scope);
    if (!raw || raw.length > 2_000_000) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_SKETCH_ITEMS).filter(validItem) : [];
  } catch {
    return [];
  }
}

export function writeSketchDraft(scope: string, items: readonly SketchItem[]): boolean {
  try {
    const key = SKETCH_DRAFT_PREFIX + scope;
    if (items.length) localStorage.setItem(key, JSON.stringify(items.slice(0, MAX_SKETCH_ITEMS)));
    else localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
