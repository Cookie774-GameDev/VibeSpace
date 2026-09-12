export const BOTANICAL_SECTION_HEIGHT = 480;
// Warm-theme copper, deep sage and muted ink; softened by the leaf wash opacity.
const LEAF_COLORS = ['#d66f49', '#647c5a', '#775f4c'] as const;

type LeafBounds = { left: number; right: number; top: number; bottom: number };

// A Bezier curve stays inside the convex hull of its control points.
// Rotating that hull gives a conservative bound for the entire painted leaf.
function leafBounds(x: number, y: number, size: number, angle: number, fullness: number): LeafBounds {
  const points = [[0, 0], [0.2, -fullness], [0.72, -fullness * 1.15],
    [1, 0], [0.65, fullness * 0.85], [0.24, fullness]];
  const rotated = points.map(([px, py]) => [
    x + size * (px * Math.cos(angle) - py * Math.sin(angle)),
    y + size * (px * Math.sin(angle) + py * Math.cos(angle)),
  ]);
  return {
    left: Math.min(...rotated.map(p => p[0])), right: Math.max(...rotated.map(p => p[0])),
    top: Math.min(...rotated.map(p => p[1])), bottom: Math.max(...rotated.map(p => p[1])),
  };
}

/** Coordinate-derived randomness: revisiting history never changes its artwork. */
export function botanicalRandom(chatId: string, section: number, side: number) {
  let seed = 2166136261;
  for (const character of `${chatId}:${section}:${side}`) {
    seed = Math.imul(seed ^ character.charCodeAt(0), 16777619);
  }
  return () => {
    seed += 0x6d2b79f5;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function botanicalSections(scrollTop: number, height: number) {
  const first = Math.floor(Math.max(0, scrollTop) / BOTANICAL_SECTION_HEIGHT);
  const last = Math.floor((Math.max(0, scrollTop) + Math.max(0, height)) / BOTANICAL_SECTION_HEIGHT);
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

export function paintBotanicalBackground(
  ctx: CanvasRenderingContext2D, chatId: string, width: number, height: number,
  scrollTop: number, color: string,
) {
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  const reach = Math.min(240, width * 0.28);
  for (const section of botanicalSections(scrollTop, height)) {
    const occupied: LeafBounds[] = [];
    for (const side of [0, 1]) {
      const random = botanicalRandom(chatId, section, side);
      // Separate stream keeps existing leaf geometry unchanged when coloring it.
      const colorRandom = botanicalRandom(chatId, section, side + 2);
      const branchColor = Math.floor(colorRandom() * LEAF_COLORS.length);
      ctx.save();
      ctx.translate(side ? width : 0, section * BOTANICAL_SECTION_HEIGHT - scrollTop);
      ctx.scale(side ? -1 : 1, 1);
      // Each trunk segment meets the next at exactly the same edge coordinate.
      ctx.globalAlpha = 0.05;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(8, 0);
      ctx.bezierCurveTo(32, 150, -16, 320, 8, 480);
      ctx.stroke();
      // One generous sprig per edge, staggered rather than mirrored rows.
      {
        const base = (side ? 400 : 300) + random() * 50;
        const length = reach * (0.65 + random() * 0.35);
        const rise = 200 + random() * 55;
        const bend = 0.3 + random() * 0.4;
        const leafCount = 4;
        ctx.globalAlpha = 0.14;
        ctx.beginPath();
        ctx.moveTo(8, base);
        ctx.quadraticCurveTo(length * bend, base - rise * 0.15, length, base - rise);
        ctx.stroke();
        for (let leaf = 0; leaf < leafCount; leaf++) {
          const t = (leaf + 0.8 + random() * 0.3) / (leafCount + 1);
          const x = (1 - t) ** 2 * 8 + 2 * (1 - t) * t * length * bend + t * t * length;
          const y = base - 2 * (1 - t) * t * rise * 0.15 - t * t * rise;
          const angle = (leaf % 2 ? -1.7 : 0.05) + (random() - 0.5) * 0.35;
          const size = (72 + random() * 28) * Math.min(1, width / 650);
          const fullness = 0.16 + random() * 0.08;
          const bounds = leafBounds(x, y, size, angle, fullness);
          if (side) {
            const left = width - bounds.right;
            bounds.right = width - bounds.left;
            bounds.left = left;
          }
          // Keep an airy gap, including between neighboring scroll sections.
          // Omit a crowded leaf rather than shrinking it into visual noise.
          const gap = 12;
          if (bounds.top < gap || bounds.bottom > BOTANICAL_SECTION_HEIGHT - gap ||
              bounds.left < 4 || bounds.right > width - 4 ||
              occupied.some(other => bounds.left < other.right + gap &&
                bounds.right > other.left - gap && bounds.top < other.bottom + gap &&
                bounds.bottom > other.top - gap)) continue;
          occupied.push(bounds);
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(angle);
          const leafColor = LEAF_COLORS[(branchColor + (colorRandom() > 0.85 ? 1 : 0)) % LEAF_COLORS.length];
          ctx.fillStyle = leafColor;
          ctx.strokeStyle = leafColor;
          ctx.globalAlpha = 0.14 + random() * 0.035;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.bezierCurveTo(size * 0.2, -size * fullness, size * 0.72, -size * fullness * 1.15, size, 0);
          ctx.bezierCurveTo(size * 0.65, size * fullness * 0.85, size * 0.24, size * fullness, 0, 0);
          ctx.fill();
          ctx.globalAlpha = 0.18;
          ctx.lineWidth = 0.6;
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(size * 0.9, 0);
          for (let vein = 1; vein < 4; vein++) {
            const vx = size * vein / 6;
            ctx.moveTo(vx, 0);
            ctx.lineTo(vx + size * 0.13, -size * 0.12);
            ctx.moveTo(vx, 0);
            ctx.lineTo(vx + size * 0.1, size * 0.1);
          }
          ctx.stroke();
          ctx.restore();
        }
      }
      ctx.restore();
    }
  }
}
