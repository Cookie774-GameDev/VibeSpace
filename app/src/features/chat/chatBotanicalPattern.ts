export const BOTANICAL_SECTION_HEIGHT = 480;

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
    for (const side of [0, 1]) {
      const random = botanicalRandom(chatId, section, side);
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
        const base = (side ? 400 : 270) + random() * 65;
        const length = reach * (0.65 + random() * 0.35);
        const rise = 140 + random() * 85;
        const bend = 0.3 + random() * 0.4;
        const leafCount = 4 + Math.floor(random() * 3);
        ctx.globalAlpha = 0.14;
        ctx.beginPath();
        ctx.moveTo(8, base);
        ctx.quadraticCurveTo(length * bend, base - rise * 0.15, length, base - rise);
        ctx.stroke();
        for (let leaf = 0; leaf < leafCount; leaf++) {
          const t = (leaf + 0.8 + random() * 0.3) / (leafCount + 1);
          const x = (1 - t) ** 2 * 8 + 2 * (1 - t) * t * length * bend + t * t * length;
          const y = base - 2 * (1 - t) * t * rise * 0.15 - t * t * rise;
          const angle = (leaf % 2 ? -1.65 : -0.12) + (random() - 0.5) * 0.7;
          const size = (55 + random() * 45) * Math.min(1, width / 650);
          const fullness = 0.17 + random() * 0.19;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(angle);
          ctx.globalAlpha = 0.07 + random() * 0.035;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.bezierCurveTo(size * 0.2, -size * fullness, size * 0.72, -size * fullness * 1.15, size, 0);
          ctx.bezierCurveTo(size * 0.65, size * fullness * 0.85, size * 0.24, size * fullness, 0, 0);
          ctx.fill();
          ctx.globalAlpha = 0.13;
          ctx.lineWidth = 0.6;
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(size * 0.9, 0);
          for (let vein = 1; vein < 5; vein++) {
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
